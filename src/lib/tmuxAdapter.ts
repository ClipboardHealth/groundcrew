/**
 * tmux Workspace backend. Workspaces live as windows inside one dedicated
 * `groundcrew` tmux session; the window name is the ticket id. tmux can't
 * paint status pills, so `open` silently drops `spec.status`. This is the
 * Linux/WSL path where cmux is unavailable.
 */

import { mkdirSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

import type { ResolvedConfig } from "./config.ts";
import { shellSingleQuote } from "./shell.ts";
import {
  type Adapter,
  isSignalAborted,
  type OpenSpec,
  runWorkspaceCommand,
  type Workspace,
} from "./workspaceAdapter.ts";
import { errorMessage, log, readEnvironmentVariable, writeError } from "./util.ts";

const TMUX_SESSION = "groundcrew";

// `tmux new-session -d -s …` always creates one initial window. Without
// `-n`, that window is named after the running shell (e.g. "0" / "zsh") and
// would surface from `list()` as a phantom workspace. We name it with this
// sentinel and filter it out — it stays around as a placeholder so the
// session doesn't collapse when the last ticket window closes.
const TMUX_IDLE_WINDOW = "_groundcrew_idle";

export const tmuxAdapter: Adapter = {
  async open(config, spec, signal) {
    await ensureTmuxSession(signal);
    const keepDeadWindowsEnv = readEnvironmentVariable("GROUNDCREW_KEEP_DEAD_WINDOWS");
    const keepDeadWindows = keepDeadWindowsEnv !== undefined && keepDeadWindowsEnv.length > 0;
    const agentLog = prepareAgentLog(resolveAgentLogTarget(config, spec.name), spec.command);
    await runWorkspaceCommand(
      "tmux",
      buildTmuxOpenArgv({
        sessionName: TMUX_SESSION,
        spec,
        remainOnExit: keepDeadWindows ? "on" : "off",
        agentLog,
      }),
      signal,
    );
    // tmux can't paint status pills; spec.status is silently dropped.
    return agentLog.kind === "active" ? { agentLogPath: agentLog.displayPath } : {};
  },
  async list(signal) {
    const probe = await probeTmuxList("#{window_name}\t#{pane_dead}", signal);
    if (probe.status === "missing") {
      return [];
    }
    if (probe.status === "failed") {
      log(`tmux list-windows failed: ${probe.reason}`);
      // oxlint-disable-next-line unicorn/no-useless-undefined -- undefined marks the workspace backend as unavailable.
      return undefined;
    }
    return parseTmuxWindows(probe.output);
  },
  async close(name, signal) {
    try {
      await runWorkspaceCommand("tmux", ["kill-window", "-t", tmuxTarget(name)], signal);
      return { kind: "closed" };
    } catch (error) {
      if (isSignalAborted(signal)) {
        throw error;
      }
      if (isTmuxNotFoundError(error)) {
        return { kind: "missing" };
      }
      throw error;
    }
  },
  accessHint(name) {
    return { kind: "attachCommand", command: `tmux attach -t ${tmuxTarget(name)}` };
  },
};

function tmuxTarget(name: string): string {
  return `${TMUX_SESSION}:${name}`;
}

function isTmuxNotFoundError(error: unknown): boolean {
  // runCommand surfaces the child's stderr in error.message, so the "no
  // server" / "missing session" / "can't find window" signatures are visible
  // without a separate stderr probe.
  const message = errorMessage(error);
  return (
    message.includes("no server running") ||
    message.includes("can't find session") ||
    message.includes("can't find window")
  );
}

type TmuxListProbe =
  | { status: "ok"; output: string }
  | { status: "missing" }
  | { status: "failed"; reason: string };

async function probeTmuxList(format: string, signal?: AbortSignal): Promise<TmuxListProbe> {
  try {
    return {
      status: "ok",
      output: await runWorkspaceCommand(
        "tmux",
        ["list-windows", "-t", TMUX_SESSION, "-F", format],
        signal,
      ),
    };
  } catch (error) {
    if (isSignalAborted(signal)) {
      throw error;
    }
    if (isTmuxNotFoundError(error)) {
      return { status: "missing" };
    }
    return { status: "failed", reason: errorMessage(error) };
  }
}

async function ensureTmuxSession(signal?: AbortSignal): Promise<void> {
  try {
    await runWorkspaceCommand("tmux", ["has-session", "-t", TMUX_SESSION], signal);
    return;
  } catch (error) {
    if (isSignalAborted(signal)) {
      throw error;
    }
    /* session missing or server down; create it */
  }
  try {
    await runWorkspaceCommand(
      "tmux",
      ["new-session", "-d", "-s", TMUX_SESSION, "-n", TMUX_IDLE_WINDOW],
      signal,
    );
  } catch (error) {
    if (isSignalAborted(signal)) {
      throw error;
    }
    try {
      await runWorkspaceCommand("tmux", ["has-session", "-t", TMUX_SESSION], signal);
    } catch {
      throw error;
    }
  }
}

function parseTmuxWindows(output: string): Workspace[] {
  const items: Workspace[] = [];
  for (const line of output.split("\n")) {
    if (line.length === 0) {
      continue;
    }
    const [name, deadFlag] = line.split("\t");
    /* v8 ignore next 3 @preserve -- split on a non-empty string always yields a non-empty first element */
    if (name === undefined || name.length === 0) {
      continue;
    }
    if (name === TMUX_IDLE_WINDOW) {
      continue;
    }
    // pane_dead != 0 means the command exited and the window is a zombie
    // (only happens when remain-on-exit is on; defense in depth in case a
    // user-globally-set value beats our per-window override).
    if (deadFlag !== undefined && deadFlag !== "0") {
      continue;
    }
    items.push({ name });
  }
  return items;
}

export type AgentLogTarget =
  | { kind: "disabled" }
  | { kind: "active"; logPath: string; latestSymlink: string };

function padTwo(n: number): string {
  return String(n).padStart(2, "0");
}

function formatUtcStamp(date: Date): string {
  return (
    `${date.getUTCFullYear()}${padTwo(date.getUTCMonth() + 1)}${padTwo(date.getUTCDate())}` +
    `-${padTwo(date.getUTCHours())}${padTwo(date.getUTCMinutes())}${padTwo(date.getUTCSeconds())}`
  );
}

/**
 * Pure: resolves where a per-launch agent log would live. Does not touch
 * the filesystem. `prepareAgentLog` does that.
 */
export function resolveAgentLogTarget(config: ResolvedConfig, ticketName: string): AgentLogTarget {
  if (config.logging.agentLogDir === false) {
    return { kind: "disabled" };
  }
  const stamp = formatUtcStamp(new Date());
  const logPath = resolve(config.logging.agentLogDir, `${ticketName}-${stamp}.log`);
  const latestSymlink = resolve(config.logging.agentLogDir, `${ticketName}.log`);
  return { kind: "active", logPath, latestSymlink };
}

const HEADER_COMMAND_MAX_LENGTH = 120;

function renderHeaderLine(ticketName: string, command: string): string {
  const summary = command.replaceAll(/\s+/g, " ").slice(0, HEADER_COMMAND_MAX_LENGTH);
  return `[groundcrew] ${ticketName} launch at ${new Date().toISOString()} backend=tmux command=${summary}\n`;
}

/**
 * Atomically point `linkPath` at `targetBasename` by creating a fresh
 * symlink at `linkPath.tmp` and renaming over `linkPath`. Throws if the
 * filesystem doesn't support symlinks; caller decides whether to fail
 * or continue without the convenience symlink.
 */
function atomicSymlink(linkPath: string, targetBasename: string): void {
  const tmpPath = `${linkPath}.tmp`;
  try {
    unlinkSync(tmpPath);
  } catch {
    // Tmp file didn't exist — normal case.
  }
  symlinkSync(targetBasename, tmpPath);
  renameSync(tmpPath, linkPath);
}

export type PreparedAgentLog =
  | { kind: "disabled" }
  | {
      kind: "active";
      /** Path pipe-pane writes to (always the timestamped file). */
      logPath: string;
      /**
       * Path to advertise to the user. Equals `latestSymlink` when the
       * symlink was refreshed successfully, otherwise falls back to
       * `logPath` so the user gets a path that actually exists.
       */
      displayPath: string;
    };

/**
 * Performs the filesystem side of agent-log setup: mkdir the directory,
 * write a one-line header to the timestamped log, refresh the
 * `<ticket>.log` symlink atomically. Soft-fails: on any mkdir/write
 * error the function returns `{ kind: "disabled" }` so the caller can
 * skip the pipe-pane chunk without aborting the workspace open.
 *
 * @param target  - From `resolveAgentLogTarget`.
 * @param command - The `OpenSpec.command` string, used only for the
 *                  header summary (truncated to 120 chars).
 */
export function prepareAgentLog(target: AgentLogTarget, command: string): PreparedAgentLog {
  if (target.kind === "disabled") {
    return { kind: "disabled" };
  }
  const ticketName = basename(target.latestSymlink, ".log");
  try {
    mkdirSync(dirname(target.logPath), { recursive: true });
    writeFileSync(target.logPath, renderHeaderLine(ticketName, command));
  } catch (error) {
    writeError(
      `groundcrew: disabling agent log capture for ${ticketName} — ${errorMessage(error)}`,
    );
    return { kind: "disabled" };
  }
  let displayPath = target.latestSymlink;
  try {
    atomicSymlink(target.latestSymlink, basename(target.logPath));
  } catch (error) {
    writeError(
      `groundcrew: could not refresh ${ticketName}.log symlink — ${errorMessage(error)}. ` +
        `Capture still active at ${target.logPath}.`,
    );
    // Symlink failure does NOT disable capture; advertise the
    // timestamped file directly so the user doesn't follow a
    // missing symlink.
    displayPath = target.logPath;
  }
  return { kind: "active", logPath: target.logPath, displayPath };
}

/**
 * Shell command used as the pipe-pane sink to capture pane output into
 * the per-launch agent log file. Each captured line is prefixed with a
 * local-time `HH:MM:SS ` stamp. `BEGIN { $|=1 }` is perl's autoflush so
 * lines land in the file as they arrive, not just on perl exit.
 *
 * Why perl: macOS's BSD `/usr/bin/awk` lacks `strftime` (a gawk
 * extension); `/usr/bin/perl` is in both macOS base and every Linux
 * distro groundcrew targets, so this is the universal choice with no
 * new dependency. If `/usr/bin/perl` is somehow absent, pipe-pane's
 * child dies on first output and the log stays empty — accept that
 * failure mode for now.
 */
export const AGENT_LOG_PIPE_COMMAND = `perl -ne 'BEGIN { $|=1; use POSIX qw(strftime) } print strftime("%H:%M:%S", localtime), " ", $_'`;

/**
 * Build the argv for the atomic tmux `new-window … ; set-window-option … ; …`
 * chain that opens a workspace window. Pure function — extracted from
 * `tmuxAdapter.open` so the integration test can drive it with a sandbox
 * session name. No tmux process is invoked here.
 *
 * @param arguments_.agentLog - `{ kind: "active", logPath }` appends a
 *   `pipe-pane -o -t <target> '<AGENT_LOG_PIPE_COMMAND> >> <logPath>'`
 *   chunk that timestamps every captured line with HH:MM:SS (local time).
 *   `{ kind: "disabled" }` omits the chunk entirely.
 */
export function buildTmuxOpenArgv(arguments_: {
  sessionName: string;
  spec: OpenSpec;
  remainOnExit: "on" | "off";
  agentLog: PreparedAgentLog;
}): string[] {
  const target = `${arguments_.sessionName}:${arguments_.spec.name}`;
  const argv: string[] = [
    "new-window",
    "-d",
    "-t",
    arguments_.sessionName,
    "-n",
    arguments_.spec.name,
    "-c",
    arguments_.spec.cwd,
    arguments_.spec.command,
    ";",
    "set-window-option",
    "-t",
    target,
    "remain-on-exit",
    arguments_.remainOnExit,
    ";",
    "set-window-option",
    "-t",
    target,
    "allow-rename",
    "off",
  ];
  if (arguments_.agentLog.kind === "active") {
    argv.push(
      ";",
      "pipe-pane",
      "-o",
      "-t",
      target,
      `${AGENT_LOG_PIPE_COMMAND} >> ${shellSingleQuote(arguments_.agentLog.logPath)}`,
    );
  }
  return argv;
}
