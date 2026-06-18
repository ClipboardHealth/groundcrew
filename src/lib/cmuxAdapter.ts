/**
 * cmux Workspace backend. cmux is the macOS TUI; workspaces surface in its
 * own app, so `accessHint` has nothing concise to emit. cmux can paint a
 * per-workspace status pill, which `open` applies best-effort.
 */

import {
  type Adapter,
  isSignalAborted,
  runWorkspaceCommand,
  type WorkspaceCloseResult,
  type WorkspaceProgress,
  type WorkspaceStatus,
} from "./workspaceAdapter.ts";
import { debug, errorMessage, log, logEvent } from "./util.ts";

export const cmuxAdapter: Adapter = {
  async open(spec, signal) {
    let output: string;
    try {
      output = await runWorkspaceCommand(
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
          "--description",
          cmuxDescriptionFor(spec.name),
        ],
        signal,
      );
    } catch (error) {
      await closeWorkspaceLeakedByFailedOpen(error, spec.name, signal);
      throw error;
    }
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
          debug(`cmux set-status failed for ${spec.name} (continuing): ${errorMessage(error)}`);
        }
      }
    }
  },
  async list(signal) {
    const raw = await listCmuxRaw(signal);
    return raw?.map((ws) => ({ name: cmuxTaskId(ws) }));
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
    const matches = raw.filter((ws) => cmuxTaskId(ws) === name);
    if (matches.length === 0) {
      return { kind: "missing" };
    }
    if (matches.length > 1) {
      // A single task id maps to many cmux workspaces only after a leaked launch
      // or session-restore duplication. Surface the leak so it's observable
      // rather than silently reconciled away.
      logEvent("cmux_close", {
        outcome: "duplicate_markers",
        task: name,
        duplicates: matches.length,
      });
    }
    return await closeAllCmuxMatches(matches, signal);
  },
  accessHint(_name) {
    // cmux is a TUI; users surface workspaces by launching the cmux app,
    // not a shell command. No useful hint to emit.
    // oxlint-disable-next-line unicorn/no-useless-undefined -- explicit signal that the backend has no hint
    return undefined;
  },
  async reportProgress(name, progress, signal) {
    const raw = await listCmuxRaw(signal);
    if (raw === undefined) {
      debug(`cmux set-progress skipped for ${name}: list-workspaces failed, no usable id`);
      return;
    }
    const match = raw.find((ws) => cmuxTaskId(ws) === name);
    if (match === undefined) {
      debug(`cmux set-progress skipped for ${name}: no live workspace`);
      return;
    }
    await applyCmuxProgress(match.id, progress, signal);
  },
};

/**
 * Stable per-workspace task-id marker stamped into cmux's `description` at
 * creation. Identity keys on this, not the title — a user renaming a panel
 * must not make crew lose track of the workspace. cmux exposes no
 * set-description RPC (settable only at creation), so legacy workspaces carry
 * `description: null`; `cmuxTaskId` falls back to the title for those.
 */
const CMUX_DESCRIPTION_MARKER_PREFIX = "groundcrew:";

function cmuxDescriptionFor(taskId: string): string {
  return `${CMUX_DESCRIPTION_MARKER_PREFIX}${taskId}`;
}

function cmuxTaskId(ws: CmuxRawWorkspace): string {
  if (ws.description !== null && ws.description.startsWith(CMUX_DESCRIPTION_MARKER_PREFIX)) {
    const marked = ws.description.slice(CMUX_DESCRIPTION_MARKER_PREFIX.length);
    if (marked.length > 0) {
      return marked;
    }
  }
  return ws.title;
}

interface CmuxRawWorkspace {
  title: string;
  /** Stable UUID handle. v2 RPC requires this for workspace.close / etc. */
  id: string;
  /** cmux per-workspace description; carries the task-id marker, or null for legacy workspaces. */
  description: string | null;
}

function parseCmuxList(output: string): CmuxRawWorkspace[] {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- cmux --json list-workspaces always emits this shape
  const parsed = JSON.parse(output) as {
    workspaces?: Array<{ title?: string; ref?: string; id?: string; description?: string | null }>;
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
    items.push({ title: ws.title, id, description: ws.description ?? null });
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

/**
 * Closes every workspace sharing the requested marker. Closes run sequentially:
 * a failure path re-lists cmux to confirm the workspace is gone, and firing N
 * mutations plus N confirmation lists concurrently would race on that shared
 * state. Each match is attempted even when an earlier one fails, so a single
 * stuck duplicate can't orphan the rest; a confirmed-still-present failure is
 * collected and rethrown only after the loop (preserving single-match
 * semantics). A failure that cannot be confirmed yields `unavailable`; `closed`
 * wins only when every match is gone.
 */
async function closeAllCmuxMatches(
  matches: readonly CmuxRawWorkspace[],
  signal?: AbortSignal,
): Promise<WorkspaceCloseResult> {
  let unavailable: { kind: "unavailable"; error?: unknown } | undefined;
  const errors: unknown[] = [];
  for (const match of matches) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- sequential by design; failure re-lists shared cmux state
      const result = await closeCmuxMatch(match, signal);
      if (result.kind === "unavailable") {
        unavailable = result;
      }
    } catch (error) {
      if (isSignalAborted(signal)) {
        throw error;
      }
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw errors.length === 1 ? errors[0] : new AggregateError(errors);
  }
  return unavailable ?? { kind: "closed" };
}

async function closeCmuxMatch(
  match: CmuxRawWorkspace,
  signal?: AbortSignal,
): Promise<{ kind: "closed" } | { kind: "unavailable"; error?: unknown }> {
  try {
    await closeCmuxWorkspace(match.id, signal);
    return { kind: "closed" };
  } catch (error) {
    if (isSignalAborted(signal)) {
      throw error;
    }
    const remaining = await listCmuxRaw(signal);
    if (remaining === undefined) {
      return { kind: "unavailable", error };
    }
    const isStillPresent = remaining.some((ws) => ws.id === match.id);
    if (!isStillPresent) {
      return { kind: "closed" };
    }
    throw error;
  }
}

async function closeCmuxWorkspace(workspaceId: string, signal?: AbortSignal): Promise<void> {
  await runWorkspaceCommand("cmux", ["close-workspace", "--workspace", workspaceId], signal);
}

/**
 * cmux occasionally exits non-zero from `new-workspace` while still having
 * created the workspace (a known flake where it also lands in the wrong `--cwd`).
 * The id rides along in the failed command's captured output, so recover it and
 * close that exact workspace by id — a failed launch must not strand an orphan
 * tagged with the task's `groundcrew:<taskId>` marker. Closing by the recovered
 * id needs no `list-workspaces`, so it survives a concurrent list failure that
 * would defeat re-enumeration. Re-enumeration close is unsafe here anyway; we
 * hold the precise id cmux returned, so there is no same-named-sibling risk.
 */
async function closeWorkspaceLeakedByFailedOpen(
  error: unknown,
  name: string,
  signal?: AbortSignal,
): Promise<void> {
  if (isSignalAborted(signal)) {
    return;
  }
  const workspaceId = extractCmuxOpenIdFromFailure(error);
  if (workspaceId === undefined) {
    return;
  }
  try {
    await closeCmuxWorkspace(workspaceId, signal);
    debug(
      `cmux new-workspace for ${name} exited non-zero but had created ${workspaceId}; closed the leaked workspace.`,
    );
  } catch (closeError) {
    log(
      `cmux new-workspace for ${name} exited non-zero and left workspace ${workspaceId}; automatic close failed (${errorMessage(closeError)}). Run \`cmux close-workspace --workspace ${workspaceId}\` by hand.`,
    );
  }
}

/**
 * Recover the created workspace id from a failed `new-workspace`. Parse only
 * the captured stdout slice of the command error's message (see
 * `normalizeCommandError`), never the whole message — matching against stderr
 * or the echoed command line risks grabbing an unrelated `workspace:N` and
 * closing the wrong workspace. The slice is the same shape the success path
 * sees, so `extractCmuxOpenId` handles both the `--json` id object and a bare
 * `workspace:N` ref.
 */
function extractCmuxOpenIdFromFailure(error: unknown): string | undefined {
  const stdout = cmuxStdoutFromFailureMessage(errorMessage(error));
  return stdout === undefined ? undefined : extractCmuxOpenId(stdout);
}

function cmuxStdoutFromFailureMessage(message: string): string | undefined {
  return /\nStdout:\n([\s\S]*?)(?:\nCause: |$)/.exec(message)?.[1];
}

function clampProgressValue(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

async function applyCmuxProgress(
  workspaceId: string,
  progress: WorkspaceProgress,
  signal?: AbortSignal,
): Promise<void> {
  await runWorkspaceCommand(
    "cmux",
    [
      "set-progress",
      String(clampProgressValue(progress.value)),
      "--label",
      progress.label,
      "--workspace",
      workspaceId,
    ],
    signal,
  );
}

function isCmuxSetStatusUnsupported(error: unknown): boolean {
  return errorMessage(error).includes('unknown command "set-status"');
}
