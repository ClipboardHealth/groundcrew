/**
 * cmux Workspace backend. cmux is the macOS TUI; workspaces surface in its
 * own app, so `accessHint` has nothing concise to emit. cmux can paint a
 * per-workspace status pill, which `open` applies best-effort.
 *
 * Reboot liveness: cmux persists and restores workspace tabs across a reboot,
 * but the agent process inside a restored tab is dead. `cmux list-workspaces`
 * has no per-workspace local-liveness field (`remote.active_terminal_sessions`
 * covers SSH sessions only), so it would report every restored tab as live and
 * wrongly block `crew resume`. To distinguish a live workspace from a
 * restored-empty one, `open` stamps a per-workspace marker with the host boot
 * epoch and `list` compares it: a marker that predates the current boot means
 * the machine rebooted since the agent launched, so the workspace is reported
 * `exited` (see WorkspaceProbe in `workspaceAdapter.ts`). This mirrors the
 * zellij exit-marker approach, keyed to boot identity rather than command exit.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, uptime } from "node:os";
import path from "node:path";

import {
  type Adapter,
  isSignalAborted,
  runWorkspaceCommand,
  type Workspace,
  type WorkspaceStatus,
} from "./workspaceAdapter.ts";
import { debug, errorMessage, log, readEnvironmentVariable } from "./util.ts";

export const cmuxAdapter: Adapter = {
  async open(spec, signal) {
    const output = await runWorkspaceCommand(
      "cmux",
      [
        "--json",
        "new-workspace",
        "--name",
        spec.name,
        "--cwd",
        spec.cwd,
        "--command",
        spec.command,
      ],
      signal,
    );
    const workspaceId = extractCmuxOpenId(output);
    if (workspaceId === undefined) {
      log(
        `cmux new-workspace returned unrecognized output for ${spec.name}; if a workspace was created, run \`cmux close-workspace\` manually.`,
      );
      throw new Error(`Unexpected cmux output: ${output}`);
    }
    recordLiveness(spec.name);
    if (spec.status !== undefined) {
      try {
        await applyCmuxStatus(workspaceId, spec.status, signal);
      } catch (error) {
        // Status pills are best-effort. cmux v2+ dropped `set-status` entirely,
        // so swallow that specific gap silently; surface anything else so a real
        // regression doesn't hide behind the same swallow.
        if (!isCmuxSetStatusUnsupported(error)) {
          debug(`cmux set-status failed for ${spec.name} (continuing): ${errorMessage(error)}`);
        }
      }
    }
  },
  async list(signal) {
    const raw = await listCmuxRaw(signal);
    return raw?.map(
      (ws): Workspace =>
        isRestoredAfterReboot(ws.title) ? { name: ws.title, state: "exited" } : { name: ws.title },
    );
  },
  async close(name, signal) {
    const raw = await listCmuxRaw(signal);
    if (raw === undefined) {
      // cmux v2 `workspace.close` rejects titles, so forwarding `name`
      // would always fail. The list failure has already been logged by
      // `listCmuxRaw`; bail rather than guarantee a downstream error.
      debug(`cmux close-workspace skipped for ${name}: list-workspaces failed, no usable id`);
      return { kind: "unavailable" };
    }
    const match = raw.find((ws) => ws.title === name);
    if (match === undefined) {
      return { kind: "missing" };
    }
    try {
      await closeCmuxWorkspace(match.id, signal);
      clearLiveness(name);
      return { kind: "closed" };
    } catch (error) {
      if (isSignalAborted(signal)) {
        throw error;
      }
      const remaining = await listCmuxRaw(signal);
      if (remaining === undefined) {
        return { kind: "unavailable", error };
      }
      const isStillPresent = remaining.some((ws) => ws.title === name);
      if (!isStillPresent) {
        clearLiveness(name);
        return { kind: "closed" };
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
      debug(
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
    debug(`cmux list-workspaces failed: ${errorMessage(error)}`);
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

async function applyCmuxStatus(
  workspaceId: string,
  status: WorkspaceStatus,
  signal?: AbortSignal,
): Promise<void> {
  const arguments_ = ["set-status", "agent", status.text];
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

// --- reboot liveness markers -------------------------------------------------

// A reboot shifts the boot epoch by far more than this; the only drift within a
// single boot is sub-second Date.now()/uptime rounding jitter, so the tolerance
// just prevents a 1s rounding difference from flagging a live workspace as dead.
const BOOT_EPOCH_TOLERANCE_SECONDS = 5;

// One marker file per workspace title, under a tmpdir the macOS launchd cleaner
// leaves intact across a reboot (so the pre-reboot boot epoch survives to be
// compared). Overridable via env so tests can isolate it.
function livenessDir(): string {
  return (
    readEnvironmentVariable("GROUNDCREW_CMUX_LIVENESS_DIR") ??
    path.join(tmpdir(), "groundcrew-cmux-liveness")
  );
}

function livenessPath(name: string): string {
  return path.join(livenessDir(), name.replaceAll(/[^a-zA-Z0-9_-]/g, "_"));
}

// Host boot time in whole seconds, derived from uptime to stay cross-platform
// and subprocess-free.
function hostBootEpochSeconds(): number {
  return Math.round(Date.now() / 1000 - uptime());
}

function recordLiveness(name: string): void {
  try {
    mkdirSync(livenessDir(), { recursive: true });
    writeFileSync(livenessPath(name), String(hostBootEpochSeconds()));
  } catch (error) {
    // Best-effort: a failed marker only disables reboot detection, leaving the
    // prior "every restored workspace counts as live" behavior intact.
    debug(`cmux: failed to record liveness for ${name}: ${errorMessage(error)}`);
  }
}

function clearLiveness(name: string): void {
  rmSync(livenessPath(name), { force: true });
}

/**
 * Whether the workspace's recorded boot epoch predates the current boot — i.e.
 * cmux restored the tab after a reboot and the agent inside it is dead. A
 * missing or unparseable marker means we have no liveness record (the workspace
 * wasn't opened by this groundcrew, or the marker was lost): treat it as live
 * so a running agent's slot is never wrongly freed.
 */
function isRestoredAfterReboot(name: string): boolean {
  let recorded: number;
  try {
    recorded = Number(readFileSync(livenessPath(name), "utf8").trim());
  } catch {
    return false;
  }
  if (!Number.isFinite(recorded)) {
    return false;
  }
  return Math.abs(hostBootEpochSeconds() - recorded) > BOOT_EPOCH_TOLERANCE_SECONDS;
}
