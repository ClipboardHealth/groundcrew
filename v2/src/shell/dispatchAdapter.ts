/**
 * The thin wiring over the Dispatch module (design §9.4: only Shell imports
 * Dispatch). Shell builds {@link Context.dispatchDeps} and calls Dispatch's
 * entry points — `tick`, `startTask`, `reconcile`, `watchLoop` — so `start` and
 * `cleanup` stay declarative and the config → deps mapping lives in one place.
 */
import {
  type DispatchPlan,
  type ReconcileReport,
  type StartTaskReport,
  type TickReport,
  planTick,
  reconcile,
  startTask,
  tick,
  watchLoop,
} from "../dispatch/index.js";
import type { Context } from "./context.js";

export async function dispatchTick(input: {
  readonly context: Context;
  readonly reconcile?: boolean;
}): Promise<TickReport> {
  return await tick({
    ...input.context.dispatchDeps(),
    ...(input.reconcile === undefined ? {} : { reconcile: input.reconcile }),
  });
}

export async function dispatchPlan(input: { readonly context: Context }): Promise<DispatchPlan> {
  return await planTick(input.context.dispatchDeps());
}

export async function dispatchStartTask(input: {
  readonly context: Context;
  readonly taskId: string;
  readonly force?: boolean;
  readonly agent?: string;
}): Promise<StartTaskReport> {
  return await startTask({
    ...input.context.dispatchDeps(),
    taskId: input.taskId,
    ...(input.force === undefined ? {} : { force: input.force }),
    ...(input.agent === undefined ? {} : { agent: input.agent }),
  });
}

export async function dispatchReconcile(input: {
  readonly context: Context;
}): Promise<ReconcileReport> {
  const deps = input.context.dispatchDeps();
  return await reconcile({
    stateRoot: deps.stateRoot,
    workspaceConfig: deps.workspaceConfig,
    presenter: deps.presenter,
    ...(deps.logger === undefined ? {} : { logger: deps.logger }),
  });
}

export async function dispatchWatch(input: {
  readonly context: Context;
  readonly signal: AbortSignal;
  readonly onTick?: (report: TickReport) => void;
}): Promise<void> {
  await watchLoop({
    ...input.context.dispatchDeps(),
    pollIntervalMilliseconds: input.context.pollIntervalMilliseconds(),
    signal: input.signal,
    ...(input.onTick === undefined ? {} : { onTick: input.onTick }),
  });
}
