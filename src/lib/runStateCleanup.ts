import type { ResolvedConfig } from "./config.ts";
import { removeRunState } from "./runState.ts";
import { debug, errorMessage } from "./util.ts";
import type { WorktreeEntry } from "./worktrees.ts";

export interface RunStateCleanupFailure {
  task: string;
  error: unknown;
}

export function recordCleanedUpRuns(
  config: ResolvedConfig,
  entries: readonly WorktreeEntry[],
): RunStateCleanupFailure[] {
  const failures: RunStateCleanupFailure[] = [];
  for (const entry of entries) {
    try {
      removeRunState(config, entry.task);
    } catch (error) {
      debug(`Run state cleanup failed for ${entry.task}: ${errorMessage(error)}`);
      failures.push({ task: entry.task, error });
    }
  }
  return failures;
}
