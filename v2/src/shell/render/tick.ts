/**
 * Console rendering for a dispatch tick (`crew start` / `crew start --watch`).
 *
 * A watch loop polls every source on a cadence, and a full queue produces a
 * `slots-full` verdict for *every* task that could not claim a slot this
 * tick — dozens of lines per poll for a busy board. This summarizer keeps the
 * signal and drops that noise: dispatches, reaps, and the *interesting* skips
 * (repo-not-on-disk, claim-rejected, ineligible — the ones a human can act on)
 * are itemized; `slots-full` collapses to a single `N queued (slots full)`
 * line; a tick with nothing new prints one minimal heartbeat line.
 */

import type { TickReport } from "../../dispatch/index.js";

/** Render a tick report to the lines Shell prints (one `io.out` per line). */
export function summarizeTick(report: TickReport): string[] {
  const lines: string[] = [];

  for (const taskId of report.dispatched) {
    lines.push(`Dispatched ${taskId}.`);
  }

  for (const taskId of report.reaped) {
    lines.push(`Reaped ${taskId}.`);
  }

  let slotsFull = 0;
  for (const [taskId, verdict] of Object.entries(report.skipped)) {
    if (verdict.skipReason === "slots-full") {
      slotsFull += 1;
      continue;
    }
    lines.push(`Skipped ${taskId}: ${verdict.skipReason}${detailOf(verdict.detail)}.`);
  }

  if (slotsFull > 0) {
    lines.push(`${String(slotsFull)} queued (slots full).`);
  }

  // Nothing actionable and no queue pressure: one quiet heartbeat, not silence,
  // so `--watch` shows it is alive between polls.
  if (lines.length === 0) {
    lines.push("Nothing to dispatch.");
  }

  return lines;
}

function detailOf(detail: string | undefined): string {
  return detail === undefined ? "" : ` (${detail})`;
}
