import type { ResolvedConfig } from "../lib/config.ts";
import type {
  FailureObservation,
  FailureOccurrence,
  RepeatedFailureLog,
} from "../lib/repeatedFailures.ts";
import { recordCleanedUpRuns } from "../lib/runStateCleanup.ts";
import { debug, errorMessage, log, logEvent, okMark } from "../lib/util.ts";
import {
  type TeardownFailure,
  type TeardownResult,
  type WorktreeEntry,
  worktrees,
} from "../lib/worktrees.ts";

export interface TeardownReportOptions {
  signal?: AbortSignal | undefined;
  /**
   * Recurrence tracker shared across polls. Omit it — as one-shot callers do —
   * to report every occurrence verbatim.
   */
  failureLog?: RepeatedFailureLog | undefined;
}

export function logTeardown(
  result: TeardownResult,
  observations?: ReadonlyMap<string, FailureObservation>,
): void {
  if (
    result.workspaceProbe.kind === "unavailable" &&
    result.workspaceProbe.error !== undefined &&
    observationFor(observations, WORKSPACE_LIST_KEY).recurrence !== "suppressed"
  ) {
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
    const { recurrence, repeats } = observationFor(observations, failureKey(failure));
    if (recurrence === "suppressed") {
      continue;
    }

    log(failureLine({ failure, message, ongoing: recurrence === "ongoing", repeats }));
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
  options: TeardownReportOptions = {},
): Promise<TeardownResult> {
  const { signal, failureLog } = options;
  const result =
    signal === undefined
      ? await worktrees.teardown(config, entries)
      : await worktrees.teardown(config, entries, { signal });
  recordCleanedUpRuns(config, result.removed);
  const observations = failureLog?.observeAll({ occurrences: failureOccurrences(result) });
  logTeardown(result, observations);
  recordTeardownEvents(result, observations);
  return result;
}

export function recordTeardownEvents(
  result: TeardownResult,
  observations?: ReadonlyMap<string, FailureObservation>,
): void {
  if (result.workspaceProbe.kind === "unavailable") {
    const { recurrence, repeats } = observationFor(observations, WORKSPACE_LIST_KEY);
    if (recurrence !== "suppressed") {
      logEvent("cleanup", {
        outcome: "failed",
        reason: "workspace_list_failed",
        ...(result.workspaceProbe.error === undefined
          ? {}
          : { error: errorMessage(result.workspaceProbe.error) }),
        repeats,
      });
    }
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
    const { recurrence, repeats } = observationFor(observations, failureKey(failure));
    if (recurrence === "suppressed") {
      continue;
    }

    if (failure.step === "workspace_close") {
      logEvent("cleanup", {
        outcome: "failed",
        reason: "workspace_close_failed",
        task: failure.entry.task,
        error: message,
        repeats,
      });
    } else {
      logEvent("cleanup", {
        outcome: "failed",
        task: failure.entry.task,
        repository: failure.entry.repository,
        kind: failure.entry.kind,
        error: message,
        repeats,
      });
    }
  }
}

const WORKSPACE_LIST_KEY = "workspace_list";

const untrackedFailure: FailureObservation = { recurrence: "first", repeats: 1 };

function observationFor(
  observations: ReadonlyMap<string, FailureObservation> | undefined,
  key: string,
): FailureObservation {
  return observations?.get(key) ?? untrackedFailure;
}

function failureKey(failure: TeardownFailure): string {
  const { entry, step } = failure;
  return `${step}:${entry.repository}:${entry.task}:${entry.kind}`;
}

function failureOccurrences(result: TeardownResult): FailureOccurrence[] {
  const occurrences: FailureOccurrence[] = [];
  if (result.workspaceProbe.kind === "unavailable") {
    occurrences.push({
      key: WORKSPACE_LIST_KEY,
      message:
        result.workspaceProbe.error === undefined ? "" : errorMessage(result.workspaceProbe.error),
    });
  }

  for (const failure of result.failures) {
    occurrences.push({ key: failureKey(failure), message: errorMessage(failure.error) });
  }

  return occurrences;
}

function failureLine(arguments_: {
  failure: TeardownFailure;
  message: string;
  ongoing: boolean;
  repeats: number;
}): string {
  const { failure, message, ongoing, repeats } = arguments_;
  const { entry, step } = failure;
  if (step === "workspace_close") {
    return ongoing
      ? `workspace close still failing for ${entry.task} after ${repeats} attempts: ${message}`
      : `workspace close failed for ${entry.task}: ${message}`;
  }

  return ongoing
    ? `Cleanup still blocked for ${entry.task} (${entry.kind}) after ${repeats} attempts: ${message}`
    : `Cleanup failed for ${entry.task} (${entry.kind}): ${message}`;
}
