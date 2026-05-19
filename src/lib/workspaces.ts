/**
 * Workspace adapter — opens/lists/closes the host-side terminal session
 * that runs an agent for one ticket. `Workspace.name` is the ticket id;
 * callers key on it. Adapters do their own internal lookup when their
 * backend uses opaque refs.
 */

import { runCommandAsync } from "./commandRunner.ts";
import type { ResolvedConfig, WorkspaceKindSetting } from "./config.ts";
import { detectHostCapabilities, type HostCapabilities } from "./host.ts";
import { shellSingleQuote } from "./shell.ts";
import { errorMessage, log, readEnvironmentVariable } from "./util.ts";

export type WorkspaceKind = "cmux" | "tmux";

export interface Workspace {
  /** Ticket id; the join key callers use. */
  name: string;
}

export interface WorkspaceStatus {
  text: string;
  color?: string;
  icon?: string;
}

export interface WorkspaceAccessHint {
  kind: "attachCommand";
  command: string;
}

export interface OpenSpec {
  /** Ticket id; becomes the workspace's name. */
  name: string;
  /** Working directory the workspace runs in. */
  cwd: string;
  /** Shell string the workspace executes (host setup + agent exec). */
  command: string;
  /** Optional status painting. Adapters that can't paint silently drop it. */
  status?: WorkspaceStatus;
}

/**
 * `unavailable` is "we don't know" — never treat it as "empty," or callers
 * would close every live workspace by deduction.
 */
export type WorkspaceProbe =
  | { kind: "ok"; names: Set<string> }
  | { kind: "unavailable"; error?: unknown };

interface Adapter {
  open(spec: OpenSpec, signal?: AbortSignal): Promise<void>;
  /**
   * Live workspaces only. Returns:
   * - `Workspace[]` when the adapter probe succeeded (may be empty).
   * - `undefined` when the adapter binary failed in a way that doesn't
   *   distinguish "no live workspaces" from "couldn't ask".
   */
  list(signal?: AbortSignal): Promise<Workspace[] | undefined>;
  /** No-op when no workspace exists for `name`. */
  close(name: string, signal?: AbortSignal): Promise<void>;
  /**
   * User-facing way to reach the workspace, or `undefined` when the backend
   * has no concise external hint.
   */
  accessHint(name: string): WorkspaceAccessHint | undefined;
}

async function runWorkspaceCommand(
  command: string,
  arguments_: readonly string[],
  signal?: AbortSignal,
): Promise<string> {
  return signal === undefined
    ? await runCommandAsync(command, arguments_)
    : await runCommandAsync(command, arguments_, { signal });
}

function isSignalAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

interface CmuxRawWorkspace {
  title: string;
  /** Stable UUID handle. v2 RPC requires this for workspace.close / etc. */
  id: string;
}

function parseCmuxList(output: string): CmuxRawWorkspace[] {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- cmux --json list-workspaces always emits this shape
  const parsed = JSON.parse(output) as {
    workspaces?: { title?: string; ref?: string; id?: string }[];
  };
  const items: CmuxRawWorkspace[] = [];
  /* v8 ignore next @preserve -- cmux always emits a workspaces field; default keeps the loop safe */
  for (const ws of parsed.workspaces ?? []) {
    if (typeof ws.title !== "string" || ws.title.length === 0) {
      continue;
    }
    const id = pickCmuxId(ws);
    if (id === undefined) {
      log(
        `cmux list-workspaces returned workspace "${ws.title}" without a usable id or ref; skipping`,
      );
      continue;
    }
    items.push({ title: ws.title, id });
  }
  return items;
}

/**
 * The stable workspace handle cmux v2 expects in JSON-RPC params. Prefer
 * the UUID; fall back to the legacy `workspace:N` short ref when older
 * cmux builds don't surface it. Returns `undefined` when neither is
 * available — cmux v2 `workspace.close` rejects titles, so we must never
 * forward `title` as a workspace handle.
 */
function pickCmuxId(ws: { ref?: string; id?: string }): string | undefined {
  if (typeof ws.id === "string" && ws.id.length > 0) {
    return ws.id;
  }
  if (typeof ws.ref === "string" && ws.ref.length > 0) {
    return ws.ref;
  }
  return undefined;
}

async function listCmuxRaw(signal?: AbortSignal): Promise<CmuxRawWorkspace[] | undefined> {
  try {
    return parseCmuxList(await runWorkspaceCommand("cmux", ["--json", "list-workspaces"], signal));
  } catch (error) {
    if (isSignalAborted(signal)) {
      throw error;
    }
    log(`cmux list-workspaces failed: ${errorMessage(error)}`);
    return undefined;
  }
}

function extractCmuxOpenId(output: string): string | undefined {
  try {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- cmux --json prints a workspace_id/ref object
    const parsed = JSON.parse(output) as {
      workspace_id?: string;
      workspace_ref?: string;
      id?: string;
      ref?: string;
    };
    const uuid = parsed.workspace_id ?? parsed.id ?? "";
    if (uuid.length > 0) {
      return uuid;
    }
    const ref = parsed.workspace_ref ?? parsed.ref ?? "";
    if (ref.length > 0) {
      return ref;
    }
  } catch {
    /* not JSON; fall through to regex */
  }
  const match = /workspace:\d+/.exec(output);
  return match ? match[0] : undefined;
}

interface CmuxCurrentRemote {
  destination: string;
  port?: number;
  identity_file?: string;
  ssh_options?: string[];
}

/**
 * Inspect `cmux current-workspace`. When groundcrew is itself launched
 * inside a cmux SSH workspace, `workspace.create` lands the new workspace
 * on the local (macOS) cmux app rather than the remote where the agent's
 * worktree lives. We can't replicate cmux's full SSH bootstrap
 * (relay_port, daemon, etc.) from the remote side, so we instead wrap the
 * agent launch command in a plain `ssh` to the same destination. Returns
 * `undefined` when there is nothing to inherit, leaving callers free to
 * launch locally as usual.
 */
async function probeCurrentCmuxRemote(
  signal?: AbortSignal,
): Promise<CmuxCurrentRemote | undefined> {
  if (readEnvironmentVariable("CMUX_WORKSPACE_ID") === undefined) {
    return undefined;
  }
  let output: string;
  try {
    output = await runWorkspaceCommand("cmux", ["--json", "current-workspace"], signal);
  } catch (error) {
    if (isSignalAborted(signal)) {
      throw error;
    }
    // CMUX_WORKSPACE_ID is set, so we are inside a cmux workspace and a
    // probe failure means we cannot tell whether this is an SSH context.
    // Silently degrading to the local path would point cmux at a working
    // directory that lives on a remote host; surface the failure instead
    // so the caller can roll the worktree back rather than launch into
    // the void.
    throw new Error(
      `cmux current-workspace probe failed while CMUX_WORKSPACE_ID is set: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  try {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- cmux --json current-workspace shape per v2 API
    const parsed = JSON.parse(output) as {
      workspace?: {
        remote?: {
          connected?: boolean;
          transport?: string;
          destination?: string | null;
          port?: number | null;
          identity_file?: string | null;
          ssh_options?: string[] | null;
        };
      };
    };
    const remote = parsed.workspace?.remote;
    if (
      remote === undefined ||
      remote.connected !== true ||
      remote.transport !== "ssh" ||
      typeof remote.destination !== "string" ||
      remote.destination.length === 0
    ) {
      return undefined;
    }
    const inherited: CmuxCurrentRemote = { destination: remote.destination };
    if (typeof remote.port === "number") {
      inherited.port = remote.port;
    }
    if (typeof remote.identity_file === "string" && remote.identity_file.length > 0) {
      inherited.identity_file = remote.identity_file;
    }
    if (Array.isArray(remote.ssh_options) && remote.ssh_options.length > 0) {
      inherited.ssh_options = remote.ssh_options;
    }
    return inherited;
  } catch (error) {
    // Same reasoning as the command-failure branch above: with
    // CMUX_WORKSPACE_ID set, malformed JSON means we cannot decide
    // between local and SSH context, so refuse rather than silently
    // launching at the wrong working directory.
    throw new Error(
      `cmux current-workspace returned malformed output while CMUX_WORKSPACE_ID is set: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

/**
 * Compose an `ssh -t <destination> -- <cd && cmd>` invocation that lands
 * a new cmux workspace's terminal on the same SSH remote where
 * groundcrew is running. Path-bearing fields (`cwd`, the launch script
 * inside `command`) stay valid because the remote shell evaluates them.
 * The outermost return value is a single shell string suitable for
 * `cmux new-workspace --command`.
 */
function buildSshWrappedCommand(spec: OpenSpec, remote: CmuxCurrentRemote): string {
  const remoteShell = `cd ${shellSingleQuote(spec.cwd)} && ${spec.command}`;
  const sshTokens: string[] = ["ssh", "-t"];
  if (remote.port !== undefined) {
    sshTokens.push("-p", String(remote.port));
  }
  if (remote.identity_file !== undefined) {
    sshTokens.push("-i", shellSingleQuote(remote.identity_file));
  }
  for (const option of remote.ssh_options ?? []) {
    sshTokens.push("-o", shellSingleQuote(option));
  }
  sshTokens.push(shellSingleQuote(remote.destination), "--", shellSingleQuote(remoteShell));
  return sshTokens.join(" ");
}

async function applyCmuxStatus(
  workspaceId: string,
  status: WorkspaceStatus,
  signal?: AbortSignal,
): Promise<void> {
  const arguments_ = ["set-status", "model", status.text];
  if (status.icon !== undefined) {
    arguments_.push("--icon", status.icon);
  }
  if (status.color !== undefined) {
    arguments_.push("--color", status.color);
  }
  arguments_.push("--workspace", workspaceId);
  await runWorkspaceCommand("cmux", arguments_, signal);
}

async function closeCmuxWorkspace(workspaceId: string, signal?: AbortSignal): Promise<void> {
  await runWorkspaceCommand("cmux", ["close-workspace", "--workspace", workspaceId], signal);
}

function isCmuxSetStatusUnsupported(error: unknown): boolean {
  return errorMessage(error).includes('unknown command "set-status"');
}

const cmuxAdapter: Adapter = {
  async open(spec, signal) {
    const inheritedRemote = await probeCurrentCmuxRemote(signal);
    const newWorkspaceArguments = ["--json", "new-workspace", "--name", spec.name];
    if (inheritedRemote === undefined) {
      newWorkspaceArguments.push("--working-directory", spec.cwd, "--command", spec.command);
    } else {
      // Skip --working-directory: the path is on the SSH remote and would
      // fall back to $HOME (macOS) when cmux tries to chdir locally. The
      // wrapped ssh command does its own `cd` on the remote side.
      newWorkspaceArguments.push("--command", buildSshWrappedCommand(spec, inheritedRemote));
    }
    const output = await runWorkspaceCommand("cmux", newWorkspaceArguments, signal);
    const workspaceId = extractCmuxOpenId(output);
    if (workspaceId === undefined) {
      log(
        `cmux new-workspace returned unrecognized output for ${spec.name}; if a workspace was created, run \`cmux close-workspace\` manually.`,
      );
      throw new Error(`Unexpected cmux output: ${output}`);
    }
    if (spec.status !== undefined) {
      try {
        await applyCmuxStatus(workspaceId, spec.status, signal);
      } catch (error) {
        // Status pills are best-effort. cmux v2+ dropped `set-status` entirely,
        // so swallow that specific gap silently; surface anything else so a real
        // regression doesn't hide behind the same swallow.
        if (!isCmuxSetStatusUnsupported(error)) {
          log(`cmux set-status failed for ${spec.name} (continuing): ${errorMessage(error)}`);
        }
      }
    }
  },
  async list(signal) {
    const raw = await listCmuxRaw(signal);
    return raw?.map((ws) => ({ name: ws.title }));
  },
  async close(name, signal) {
    const raw = await listCmuxRaw(signal);
    if (raw === undefined) {
      // cmux v2 `workspace.close` rejects titles, so forwarding `name`
      // would always fail. The list failure has already been logged by
      // `listCmuxRaw`; bail rather than guarantee a downstream error.
      log(`cmux close-workspace skipped for ${name}: list-workspaces failed, no usable id`);
      return;
    }
    const match = raw.find((ws) => ws.title === name);
    if (match === undefined) {
      return;
    }
    try {
      await closeCmuxWorkspace(match.id, signal);
    } catch (error) {
      if (isSignalAborted(signal)) {
        throw error;
      }
      const remaining = await listCmuxRaw(signal);
      if (remaining !== undefined) {
        const isStillPresent = remaining.some((ws) => ws.title === name);
        if (!isStillPresent) {
          return;
        }
      }
      throw error;
    }
  },
  accessHint(_name) {
    // cmux is a TUI; users surface workspaces by launching the cmux app,
    // not a shell command. No useful hint to emit.
    // oxlint-disable-next-line unicorn/no-useless-undefined -- explicit signal that the backend has no hint
    return undefined;
  },
};

export interface WorkspaceResolution {
  requested: WorkspaceKindSetting;
  resolved: WorkspaceKind;
  /** One-line explanation of why `resolved` was chosen. */
  reason: string;
}

interface ResolveArguments {
  config: ResolvedConfig;
  host: HostCapabilities;
}

export function resolveWorkspaceKind(arguments_: ResolveArguments): WorkspaceResolution {
  const { config, host } = arguments_;
  const requested = config.workspaceKind;

  if (requested === "cmux" || requested === "tmux") {
    failIfBinaryUnavailable(requested, host);
    return { requested, resolved: requested, reason: `workspaceKind set to ${requested}` };
  }

  return resolveAuto({ requested, host });
}

function resolveAuto(arguments_: {
  requested: WorkspaceKindSetting;
  host: HostCapabilities;
}): WorkspaceResolution {
  const { requested, host } = arguments_;
  if (host.hasCmux) {
    return { requested, resolved: "cmux", reason: "auto: cmux available" };
  }
  if (host.hasTmux) {
    return {
      requested,
      resolved: "tmux",
      reason: "auto: cmux unavailable, falling back to tmux",
    };
  }
  throw new Error(
    "workspaceKind 'auto' could not pick a backend: neither cmux nor tmux is on PATH. Install one or set workspaceKind explicitly.",
  );
}

const HOST_CAPABILITY_BY_KIND: Record<WorkspaceKind, "hasCmux" | "hasTmux"> = {
  cmux: "hasCmux",
  tmux: "hasTmux",
};

function failIfBinaryUnavailable(kind: WorkspaceKind, host: HostCapabilities): void {
  if (!host[HOST_CAPABILITY_BY_KIND[kind]]) {
    throw new Error(
      `workspaceKind '${kind}' is set but the ${kind} binary is not on PATH. Install ${kind} or change the setting.`,
    );
  }
}

const TMUX_SESSION = "groundcrew";

// `tmux new-session -d -s …` always creates one initial window. Without
// `-n`, that window is named after the running shell (e.g. "0" / "zsh") and
// would surface from `list()` as a phantom workspace. We name it with this
// sentinel and filter it out — it stays around as a placeholder so the
// session doesn't collapse when the last ticket window closes.
const TMUX_IDLE_WINDOW = "_groundcrew_idle";

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

const tmuxAdapter: Adapter = {
  async open(spec, signal) {
    await ensureTmuxSession(signal);
    const target = tmuxTarget(spec.name);
    const keepDeadWindowsEnv = readEnvironmentVariable("GROUNDCREW_KEEP_DEAD_WINDOWS");
    const keepDeadWindows = keepDeadWindowsEnv !== undefined && keepDeadWindowsEnv.length > 0;
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
      log(`tmux list-windows failed: ${probe.reason}`);
      // oxlint-disable-next-line unicorn/no-useless-undefined -- undefined marks the workspace backend as unavailable.
      return undefined;
    }
    return parseTmuxWindows(probe.output);
  },
  async close(name, signal) {
    try {
      await runWorkspaceCommand("tmux", ["kill-window", "-t", tmuxTarget(name)], signal);
    } catch (error) {
      if (isSignalAborted(signal)) {
        throw error;
      }
      if (isTmuxNotFoundError(error)) {
        return;
      }
      throw error;
    }
  },
  accessHint(name) {
    return { kind: "attachCommand", command: `tmux attach -t ${tmuxTarget(name)}` };
  },
};

// Per-config cache: production resolves the adapter once at first use
// (loadConfig returns a frozen, cached instance); each test uses a fresh
// config object so the cache invalidates naturally between tests.
const adapterCache = new WeakMap<ResolvedConfig, Adapter>();

async function adapterFor(config: ResolvedConfig, signal?: AbortSignal): Promise<Adapter> {
  const cached = adapterCache.get(config);
  if (cached !== undefined) {
    return cached;
  }
  const { resolved } = resolveWorkspaceKind({
    config,
    host: await detectHostCapabilities(signal),
  });
  const adapter = resolved === "cmux" ? cmuxAdapter : tmuxAdapter;
  adapterCache.set(config, adapter);
  return adapter;
}

async function probeWorkspaces(
  config: ResolvedConfig,
  signal?: AbortSignal,
): Promise<WorkspaceProbe> {
  let raw: Workspace[] | undefined;
  try {
    const adapter = await adapterFor(config, signal);
    raw = await adapter.list(signal);
  } catch (error) {
    if (isSignalAborted(signal)) {
      throw error;
    }
    return { kind: "unavailable", error };
  }
  if (raw === undefined) {
    return { kind: "unavailable" };
  }
  return { kind: "ok", names: new Set(raw.map((ws) => ws.name)) };
}

export const workspaces = {
  async open(config: ResolvedConfig, spec: OpenSpec, signal?: AbortSignal): Promise<void> {
    const adapter = await adapterFor(config, signal);
    await adapter.open(spec, signal);
  },
  probe: probeWorkspaces,
  async close(config: ResolvedConfig, name: string, signal?: AbortSignal): Promise<void> {
    const adapter = await adapterFor(config, signal);
    await adapter.close(name, signal);
  },
  async accessHint(
    config: ResolvedConfig,
    name: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceAccessHint | undefined> {
    const adapter = await adapterFor(config, signal);
    return adapter.accessHint(name);
  },
};
