/**
 * tmux Workspace backend. Two layouts, chosen by the caller via
 * `createTmuxAdapter({ sessionPerTask })`. `workspaces.ts` resolves the flag
 * from the `GROUNDCREW_TMUX_SESSION_PER_TASK` env var.
 *
 * - Window model (`sessionPerTask: false`): workspaces live as windows inside
 *   one dedicated `groundcrew` tmux session; the window name is the task id.
 * - Session model (`sessionPerTask: true`): each workspace is its own dedicated
 *   tmux session named after the task id, so windows act as tabs and panes as
 *   splits without polluting a shared session. Sessions we create are tagged
 *   with the `@groundcrew_managed` user option so `list`/`close` ignore the
 *   user's own same-named sessions.
 *
 * Either way tmux can't paint status pills, so `open` silently drops
 * `spec.status`. This is the Linux/WSL path where cmux is unavailable.
 */

import {
  type Adapter,
  isSignalAborted,
  type OpenSpec,
  runWorkspaceCommand,
  type Workspace,
  type WorkspaceCloseResult,
} from "./workspaceAdapter.ts";
import { debug, errorMessage, readEnvironmentVariable } from "./util.ts";

const TMUX_SESSION = "groundcrew";

// `tmux new-session -d -s …` always creates one initial window. Without
// `-n`, that window is named after the running shell (e.g. "0" / "zsh") and
// would surface from `list()` as a phantom workspace. We name it with this
// sentinel and filter it out — it stays around as a placeholder so the
// session doesn't collapse when the last task window closes.
const TMUX_IDLE_WINDOW = "_groundcrew_idle";

// User option stamped on every session we create in the session model, so
// `list`/`close` can tell our sessions apart from the user's own (task-id
// session names carry no prefix and could collide).
const MANAGED_OPTION = "@groundcrew_managed";

// One row per window across every session: session name, our managed tag
// (empty for sessions we didn't create), and the active pane's dead flag.
const SESSION_PROBE_FORMAT = `#{session_name}\t#{${MANAGED_OPTION}}\t#{pane_dead}`;

/**
 * Builds the tmux adapter for the resolved layout. `sessionPerTask` is decided
 * by `workspaces.ts` from the `GROUNDCREW_TMUX_SESSION_PER_TASK` env var, so
 * the adapter itself stays config-agnostic.
 */
export function createTmuxAdapter({ sessionPerTask }: { sessionPerTask: boolean }): Adapter {
  return {
    async open(spec, signal) {
      await (sessionPerTask ? openSession(spec, signal) : openWindow(spec, signal));
      // tmux can't paint status pills; spec.status is silently dropped.
    },
    async list(signal) {
      return await (sessionPerTask ? listSessions(signal) : listWindows(signal));
    },
    async close(name, signal) {
      return await (sessionPerTask ? closeSession(name, signal) : closeWindow(name, signal));
    },
    accessHint(name) {
      const target = sessionPerTask ? name : tmuxTarget(name);
      return { kind: "attachCommand", command: `tmux attach -t ${target}` };
    },
  };
}

function shouldKeepDeadWindows(): boolean {
  const keepDeadWindowsEnv = readEnvironmentVariable("GROUNDCREW_KEEP_DEAD_WINDOWS");
  return keepDeadWindowsEnv === "1";
}

// ---------------------------------------------------------------------------
// Window model (default): one window per task inside the `groundcrew` session.
// ---------------------------------------------------------------------------

async function openWindow(spec: OpenSpec, signal?: AbortSignal): Promise<void> {
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
}

async function listWindows(signal?: AbortSignal): Promise<Workspace[] | undefined> {
  const probe = await probeTmuxCommand(
    ["list-windows", "-t", TMUX_SESSION, "-F", "#{window_name}\t#{pane_dead}"],
    signal,
  );
  if (probe.status === "missing") {
    return [];
  }
  if (probe.status === "failed") {
    debug(`tmux list-windows failed: ${probe.reason}`);
    return undefined;
  }
  return parseTmuxWindows(probe.output, { includeExited: shouldKeepDeadWindows() });
}

async function closeWindow(name: string, signal?: AbortSignal): Promise<WorkspaceCloseResult> {
  return await killTmuxTarget(["kill-window", "-t", tmuxTarget(name)], signal);
}

function tmuxTarget(name: string): string {
  return `${TMUX_SESSION}:${name}`;
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

// ---------------------------------------------------------------------------
// Session model: one dedicated session per task, tagged @groundcrew_managed.
// ---------------------------------------------------------------------------

async function openSession(spec: OpenSpec, signal?: AbortSignal): Promise<void> {
  try {
    await createSession(spec, signal);
  } catch (error) {
    if (isSignalAborted(signal)) {
      throw error;
    }
    if (!isTmuxDuplicateSessionError(error)) {
      throw error;
    }
    // A session of this name already exists. Only recreate it if it's one of
    // ours; never clobber a same-named session the user opened themselves.
    const probe = await probeManagedSessions(signal);
    if (probe.status !== "ok" || !probe.sessions.has(spec.name)) {
      throw error;
    }
    await runWorkspaceCommand("tmux", ["kill-session", "-t", spec.name], signal);
    try {
      await createSession(spec, signal);
    } catch (recreateError) {
      if (isSignalAborted(signal)) {
        throw recreateError;
      }
      // We already killed a stale copy; a failure here (e.g. the session was
      // recreated in the gap) is unexpected, so surface it with context rather
      // than a bare tmux message or an unbounded kill/recreate loop.
      throw new Error(
        `Failed to recreate tmux session "${spec.name}" after killing a stale copy: ${errorMessage(recreateError)}`,
        { cause: recreateError },
      );
    }
  }
}

async function createSession(spec: OpenSpec, signal?: AbortSignal): Promise<void> {
  const keepDeadWindows = shouldKeepDeadWindows();
  await runWorkspaceCommand(
    "tmux",
    [
      "new-session",
      "-d",
      "-s",
      spec.name,
      "-c",
      spec.cwd,
      spec.command,
      ";",
      "set-option",
      "-t",
      spec.name,
      MANAGED_OPTION,
      "1",
      ";",
      "set-window-option",
      "-t",
      spec.name,
      "remain-on-exit",
      keepDeadWindows ? "on" : "off",
      ";",
      "set-window-option",
      "-t",
      spec.name,
      "allow-rename",
      "off",
    ],
    signal,
  );
}

async function listSessions(signal?: AbortSignal): Promise<Workspace[] | undefined> {
  const probe = await probeManagedSessions(signal);
  if (probe.status === "missing") {
    return [];
  }
  if (probe.status === "failed") {
    debug(`tmux list-windows -a failed: ${probe.reason}`);
    return undefined;
  }
  const includeExited = shouldKeepDeadWindows();
  const items: Workspace[] = [];
  for (const [name, hasLivePane] of probe.sessions) {
    if (hasLivePane) {
      items.push({ name });
      continue;
    }
    // No live pane left: the agent command exited but the session lingers
    // because remain-on-exit kept the dead pane around. Mirror the window
    // model and only surface it when callers opted into keeping dead windows.
    if (includeExited) {
      items.push({ name, state: "exited" });
    }
  }
  return items;
}

async function closeSession(name: string, signal?: AbortSignal): Promise<WorkspaceCloseResult> {
  const probe = await probeManagedSessions(signal);
  if (probe.status === "missing") {
    return { kind: "missing" };
  }
  if (probe.status === "failed") {
    // Can't confirm ownership; refuse rather than risk killing a user session.
    debug(`tmux kill-session skipped for ${name}: list-windows -a failed: ${probe.reason}`);
    return { kind: "unavailable" };
  }
  if (!probe.sessions.has(name)) {
    return { kind: "missing" };
  }
  return await killTmuxTarget(["kill-session", "-t", name], signal);
}

// `sessions` maps a managed session name to whether it still has a live pane.
type ManagedSessionProbe = TmuxProbe<{ sessions: Map<string, boolean> }>;

async function probeManagedSessions(signal?: AbortSignal): Promise<ManagedSessionProbe> {
  const probe = await probeTmuxCommand(["list-windows", "-a", "-F", SESSION_PROBE_FORMAT], signal);
  if (probe.status === "ok") {
    return { status: "ok", sessions: parseManagedSessions(probe.output) };
  }
  return probe;
}

function parseManagedSessions(output: string): Map<string, boolean> {
  const sessions = new Map<string, boolean>();
  for (const line of output.split("\n")) {
    if (line.length === 0) {
      continue;
    }
    const [name, managedFlag, deadFlag] = line.split("\t");
    /* v8 ignore next 3 @preserve -- split on a non-empty string always yields a non-empty first element */
    if (name === undefined || name.length === 0) {
      continue;
    }
    // Only sessions we stamped carry the tag; everything else is the user's.
    if (managedFlag !== "1") {
      continue;
    }
    // Mirror parseTmuxWindows: a pane is live unless tmux explicitly reports it
    // dead. A missing field (malformed row) counts as live, not exited, so both
    // models read identical output the same way.
    const isDeadPane = deadFlag !== undefined && deadFlag !== "0";
    sessions.set(name, (sessions.get(name) ?? false) || !isDeadPane);
  }
  return sessions;
}

// ---------------------------------------------------------------------------
// Shared tmux helpers.
// ---------------------------------------------------------------------------

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

function isTmuxDuplicateSessionError(error: unknown): boolean {
  return errorMessage(error).includes("duplicate session");
}

// Runs a tmux kill-* command and maps the outcome: success closes, a
// not-found signature means it was already gone, and the shutdown signal
// rethrows so callers can abort.
async function killTmuxTarget(
  arguments_: readonly string[],
  signal?: AbortSignal,
): Promise<WorkspaceCloseResult> {
  try {
    await runWorkspaceCommand("tmux", arguments_, signal);
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
}

// Result of a tmux probe command: `ok` carries the command-specific payload,
// `missing` means no server/session/window, `failed` means an unexpected error.
type TmuxProbe<T> =
  | ({ status: "ok" } & T)
  | { status: "missing" }
  | { status: "failed"; reason: string };

type TmuxListProbe = TmuxProbe<{ output: string }>;

async function probeTmuxCommand(
  arguments_: readonly string[],
  signal?: AbortSignal,
): Promise<TmuxListProbe> {
  try {
    return { status: "ok", output: await runWorkspaceCommand("tmux", arguments_, signal) };
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
