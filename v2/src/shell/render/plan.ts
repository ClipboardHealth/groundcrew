/**
 * Console rendering for a dry-run dispatch plan (`crew start --dry-run`). Unlike
 * a live tick, a plan claims/provisions/launches nothing, so every task is shown
 * with its verdict — the would-dispatch list first, then each skip with its
 * reason. `slots-full` is itemized here (a dry run is a deliberate inspection,
 * not a busy watch loop, so the collapsing that keeps `--watch` quiet is unwanted).
 */

import type { DispatchPlan } from "../../dispatch/index.js";

/** Render a dispatch plan to the lines Shell prints (one `io.out` per line). */
export function summarizePlan(plan: DispatchPlan): string[] {
  const lines = ["Dry run: no tasks are dispatched."];

  if (plan.wouldDispatch.length === 0) {
    lines.push("Would dispatch: nothing.");
  } else {
    lines.push(`Would dispatch (${String(plan.wouldDispatch.length)}):`);
    for (const taskId of plan.wouldDispatch) {
      lines.push(`  ${taskId}`);
    }
  }

  const skipped = Object.entries(plan.skipped);
  if (skipped.length > 0) {
    lines.push(`Would skip (${String(skipped.length)}):`);
    for (const [taskId, verdict] of skipped) {
      lines.push(`  ${taskId}: ${verdict.skipReason}${detailOf(verdict.detail)}`);
    }
  }

  return lines;
}

function detailOf(detail: string | undefined): string {
  return detail === undefined ? "" : ` (${detail})`;
}
