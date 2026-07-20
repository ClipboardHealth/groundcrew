/**
 * Dispatch: the per-tick picker — poll, eligibility, claim, provision, and the
 * terminal-status sweep; persists per-task skip verdicts. Wires the Writeback
 * adapter into Run (design doc §9.3). Shell is Dispatch's only consumer; this
 * `index.ts` is the module's whole interface. Dispatch imports Acquisition,
 * Workspace, Session, Run, and the logging lib through their own surfaces only
 * (§9.4) — never Sandbox.
 */
export const MODULE = "dispatch";

// The picker: one poll cycle, its single-task sibling, the dry-run planner, and
// the `--watch` loop.
export { tick, startTask, planTick } from "./pipeline.js";
export { watchLoop } from "./watch.js";
export type { WatchLoopInput } from "./watch.js";

// Reconcile — the idempotent GC library (Shell calls it on startup; tick calls it too).
export { reconcile } from "./reconcile.js";

// The Writeback adapter builder — Dispatch injects it at launch; Shell rebuilds
// it for `crew done` (Shell → Run runs in a fresh process).
export { createSourceWriteback, localIdOf } from "./writeback.js";

// Skip-verdict state (`dispatch.json`) — Shell's `status` renders it (§10.4).
export {
  dispatchStatePath,
  persistVerdicts,
  readDispatchState,
  upsertVerdict,
  writeDispatchState,
} from "./state.js";

// Routing — exported so Shell can resolve an agent for its own surfaces if needed.
export { resolveAgent, orderByPriority } from "./routing.js";
export type { ResolvedAgent } from "./routing.js";

export { SKIP_REASONS } from "./types.js";
export type {
  AgentRouting,
  DispatchDeps,
  DispatchPlan,
  DispatchSource,
  DispatchState,
  DispatchVerdict,
  LaunchPolicy,
  LaunchWrapCommand,
  ReconcileInput,
  ReconcileReport,
  SkipReason,
  SourcedTask,
  StartTaskInput,
  StartTaskReport,
  TickInput,
  TickReport,
} from "./types.js";
