/**
 * `crew start [task]`: reconcile on startup, then dispatch (design §7.1,
 * contracts §7). Without a task: poll every source and dispatch the eligible
 * ready tasks (`--watch` polls continuously until a signal). With a task:
 * dispatch just that one (`--force` bypasses eligibility but never the
 * repo-on-disk gate, which surfaces as exit 2; `--agent` overrides routing).
 */
import type { StartTaskReport, TickReport } from "../../dispatch/index.js";
import {
  dispatchPlan,
  dispatchReconcile,
  dispatchStartTask,
  dispatchTick,
  dispatchWatch,
} from "../dispatchAdapter.js";
import type { Context } from "../context.js";
import type { Io } from "../io.js";
import { summarizePlan } from "../render/plan.js";
import { summarizeTick } from "../render/tick.js";

export interface StartOptions {
  readonly watch?: boolean;
  readonly force?: boolean;
  readonly agent?: string;
  readonly dryRun?: boolean;
}

export async function runStart(input: {
  readonly context: Context;
  readonly task?: string;
  readonly options: StartOptions;
  readonly io: Io;
}): Promise<void> {
  const { context, options, io } = input;

  if (options.dryRun === true) {
    // The dispatch plan: the same poll + eligibility pass a tick runs, with
    // nothing claimed, provisioned, or launched (contracts §7).
    const plan = await dispatchPlan({ context });
    for (const line of summarizePlan(plan)) {
      io.out(line);
    }
    return;
  }

  if (input.task !== undefined) {
    // Reconcile-on-startup, then the single-task dispatch (repo gate → exit 2).
    await dispatchReconcile({ context });
    const report = await dispatchStartTask({
      context,
      taskId: input.task,
      ...(options.force === undefined ? {} : { force: options.force }),
      ...(options.agent === undefined ? {} : { agent: options.agent }),
    });
    renderStartTask(report, io);
    return;
  }

  if (options.watch === true) {
    await runWatch({ context, io });
    return;
  }

  // A one-shot tick reconciles first (design §10.5).
  const report = await dispatchTick({ context, reconcile: true });
  renderTick(report, io);
}

async function runWatch(input: { readonly context: Context; readonly io: Io }): Promise<void> {
  const controller = new AbortController();
  const stop = (): void => {
    controller.abort();
  };

  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    await dispatchWatch({
      context: input.context,
      signal: controller.signal,
      onTick: (report) => {
        renderTick(report, input.io);
      },
    });
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

function renderTick(report: TickReport, io: Io): void {
  for (const line of summarizeTick(report)) {
    io.out(line);
  }
}

function renderStartTask(report: StartTaskReport, io: Io): void {
  if (report.dispatched) {
    io.out(`Started ${report.taskId}${report.runId === undefined ? "" : ` (run ${report.runId})`}.`);
    return;
  }

  const verdict = report.verdict;
  io.out(
    `Did not start ${report.taskId}` +
      (verdict === undefined ? "." : `: ${verdict.skipReason}${detailOf(verdict.detail)}`),
  );
}

function detailOf(detail: string | undefined): string {
  return detail === undefined ? "" : ` (${detail})`;
}
