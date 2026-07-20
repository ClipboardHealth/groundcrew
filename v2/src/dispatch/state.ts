/**
 * The dispatch-owned state map — `dispatch.json` (contracts §3.3, design doc
 * §10.4). It makes the flow model's "visible skip reason" promise renderable by
 * `crew status` for queued tasks that never started (and so have no run record).
 * The whole verdict map is rewritten each poll: a task that dispatches, goes
 * live, or drops off the queue simply stops appearing.
 */

import * as fs from "node:fs";
import path from "node:path";

import { z } from "zod";

import type { DispatchState, DispatchVerdict } from "./types.js";
import { SKIP_REASONS } from "./types.js";

const DISPATCH_STATE_VERSION = 1 as const;

const verdictSchema = z.object({
  skipReason: z.enum(SKIP_REASONS),
  detail: z.string().optional(),
  ts: z.string(),
});

const dispatchStateSchema = z.object({
  version: z.literal(1),
  verdicts: z.record(z.string(), verdictSchema),
});

/** `<stateRoot>/dispatch.json`. */
export function dispatchStatePath(input: { stateRoot: string }): string {
  return path.join(input.stateRoot, "dispatch.json");
}

/** Reads the verdict map; an absent or unreadable file yields an empty map. */
export function readDispatchState(input: { path: string }): DispatchState {
  let raw: string;
  try {
    raw = fs.readFileSync(input.path, "utf8");
  } catch {
    return { version: DISPATCH_STATE_VERSION, verdicts: {} };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { version: DISPATCH_STATE_VERSION, verdicts: {} };
  }

  const result = dispatchStateSchema.safeParse(parsed);
  if (!result.success) {
    return { version: DISPATCH_STATE_VERSION, verdicts: {} };
  }

  const verdicts: Record<string, DispatchVerdict> = {};
  for (const [taskId, verdict] of Object.entries(result.data.verdicts)) {
    verdicts[taskId] = {
      skipReason: verdict.skipReason,
      ts: verdict.ts,
      ...(verdict.detail === undefined ? {} : { detail: verdict.detail }),
    };
  }

  return { version: DISPATCH_STATE_VERSION, verdicts };
}

/** Atomic write: serialize to a sibling temp file, then rename over the target. */
export function writeDispatchState(input: { path: string; state: DispatchState }): void {
  fs.mkdirSync(path.dirname(input.path), { recursive: true });
  const document: DispatchState = {
    version: DISPATCH_STATE_VERSION,
    verdicts: input.state.verdicts,
  };
  const temporaryPath = `${input.path}.${String(process.pid)}.${randomSuffix()}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(document, undefined, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporaryPath, input.path);
}

/**
 * Replaces the whole verdict map (a poll recomputes it for every queued task).
 */
export function persistVerdicts(input: {
  stateRoot: string;
  verdicts: Record<string, DispatchVerdict>;
}): void {
  writeDispatchState({
    path: dispatchStatePath({ stateRoot: input.stateRoot }),
    state: { version: DISPATCH_STATE_VERSION, verdicts: input.verdicts },
  });
}

/** Merges a single task's verdict (or clears it) — the single-task `start` path. */
export function upsertVerdict(input: {
  stateRoot: string;
  taskId: string;
  verdict: DispatchVerdict | undefined;
}): void {
  const statePath = dispatchStatePath({ stateRoot: input.stateRoot });
  const state = readDispatchState({ path: statePath });
  const verdicts = Object.fromEntries(
    Object.entries(state.verdicts).filter(([key]) => key !== input.taskId),
  );
  if (input.verdict !== undefined) {
    verdicts[input.taskId] = input.verdict;
  }

  writeDispatchState({ path: statePath, state: { version: 1, verdicts } });
}

function randomSuffix(): string {
  return Math.random().toString(16).slice(2, 10);
}
