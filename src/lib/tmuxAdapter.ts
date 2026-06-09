/**
 * tmux Workspace backend. Workspaces live as windows inside one dedicated
 * `groundcrew` tmux session; the window name is the task id. tmux can't
 * paint status pills, so `open` silently drops `spec.status`. This is the
 * Linux/WSL path where cmux is unavailable.
 */

import {
  type Adapter,
  isSignalAborted,
  runWorkspaceCommand,
  type Workspace,
} from "./workspaceAdapter.ts";
import { debug, errorMessage, readEnvironmentVariable } from "./util.ts";

const TMUX_SESSION = "groundcrew";

// `tmux new-session -d -s …` always creates one initial window. Without
// `-n`, that window is named after the running shell (e.g. "0" / "zsh") and
// would surface from `list()` as a phantom workspace. We name it with this
// sentinel and filter it out — it stays around as a placeholder so the
// session doesn't collapse when the last task window closes.
const TMUX_IDLE_WINDOW = "_groundcrew_idle";

export const tmuxAdapter: Adapter = {
  async open(spec, signal) {
    await ensureTmuxSession(signal);
    const target = tmuxTarget(spec.name);
    const keepDeadWindows = shouldKeepDeadWindows();
    await runWorkspaceCommand(
      "tmux",
      [
        "new-window",
        "-d",
        "-t",
        TMUX_SESSION,
        "-n",
        spec.name,
        "-c",
        spec.cwd,
        spec.command,
        ";",
        "set-window-option",
        "-t",
        target,
        "remain-on-exit",
        keepDeadWindows ? "on" : "off",
        ";",
        "set-window-option",
        "-t",
        target,
        "allow-rename",
        "off",
      ],
      signal,
    );
    // tmux can't paint status pills; spec.status is silently dropped.
  },
  async list(signal) {
    const probe = await probeTmuxList("#{window_name}\t#{pane_dead}", signal);
    if (probe.status === "missing") {
      return [];
    }
    if (probe.status === "failed") {
      debug(`tmux list-windows failed: ${probe.reason}`);
      // oxlint-disable-next-line unicorn/no-useless-undefined -- undefined marks the workspace backend as unavailable.
      return undefined;
    }
    return parseTmuxWindows(probe.output, { includeExited: shouldKeepDeadWindows() });
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

function shouldKeepDeadWindows(): boolean {
  const keepDeadWindowsEnv = readEnvironmentVariable("GROUNDCREW_KEEP_DEAD_WINDOWS");
  return keepDeadWindowsEnv === "1";
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

function parseTmuxWindows(output: string, options: { includeExited?: boolean } = {}): Workspace[] {
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
    const isExited = deadFlag !== undefined && deadFlag !== "0";
    if (isExited && options.includeExited !== true) {
      continue;
    }
    items.push(isExited ? { name, state: "exited" } : { name });
  }
  return items;
}
