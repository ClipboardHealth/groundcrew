import type { ResolvedConfig } from "../lib/config.ts";
import { recordCleanedUpRuns } from "../lib/runStateCleanup.ts";
import { debug, errorMessage, log, logEvent, okMark } from "../lib/util.ts";
import { type TeardownResult, type WorktreeEntry, worktrees } from "../lib/worktrees.ts";

export function logTeardown(result: TeardownResult): void {
  if (result.workspaceProbe.kind === "unavailable" && result.workspaceProbe.error !== undefined) {
    log(`workspace list failed: ${errorMessage(result.workspaceProbe.error)}`);
  }
  for (const task of result.closed) {
    debug(`Closed workspace ${task}`);
  }
  for (const entry of result.removed) {
    log(`${okMark()} Cleanup complete for ${entry.task} (${entry.kind})`);
    debug(`  Worktree: ${entry.dir} (removed)`);
  }
  for (const failure of result.failures) {
    const message = errorMessage(failure.error);
    if (failure.step === "workspace_close") {
      log(`workspace close failed for ${failure.entry.task}: ${message}`);
    } else {
      log(`Cleanup failed for ${failure.entry.task} (${failure.entry.kind}): ${message}`);
    }
  }
}

/**
 * Shared helper: runs `worktrees.teardown` then records run-state cleanup,
 * logs the result, and emits telemetry events. Used by both the cleaner and
 * the reviewer fast-path so the sequence is never duplicated.
 */
export async function reapWorktrees(
  config: ResolvedConfig,
  entries: readonly WorktreeEntry[],
  signal?: AbortSignal,
): Promise<TeardownResult> {
  const result =
    signal === undefined
      ? await worktrees.teardown(config, entries)
      : await worktrees.teardown(config, entries, { signal });
  recordCleanedUpRuns(config, result.removed);
  logTeardown(result);
  recordTeardownEvents(result);
  return result;
}

export function recordTeardownEvents(result: TeardownResult): void {
  if (result.workspaceProbe.kind === "unavailable") {
    logEvent("cleanup", {
      outcome: "failed",
      reason: "workspace_list_failed",
      ...(result.workspaceProbe.error === undefined
        ? {}
        : { error: errorMessage(result.workspaceProbe.error) }),
    });
  }
  for (const task of result.closed) {
    logEvent("cleanup", { outcome: "workspace_closed", task });
  }
  for (const entry of result.removed) {
    logEvent("cleanup", {
      outcome: "cleaned",
      task: entry.task,
      repository: entry.repository,
      kind: entry.kind,
    });
  }
  for (const failure of result.failures) {
    const message = errorMessage(failure.error);
    if (failure.step === "workspace_close") {
      logEvent("cleanup", {
        outcome: "failed",
        reason: "workspace_close_failed",
        task: failure.entry.task,
        error: message,
      });
    } else {
      logEvent("cleanup", {
        outcome: "failed",
        task: failure.entry.task,
        repository: failure.entry.repository,
        kind: failure.entry.kind,
        error: message,
      });
    }
  }
}
