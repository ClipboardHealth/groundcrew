import type { ResolvedConfig } from "./config.ts";
import { readRunState, removeRunState } from "./runState.ts";
import { debug, errorMessage } from "./util.ts";
import { reclaimStackParentBranch, type WorktreeEntry } from "./worktrees.ts";

/**
 * Drops each removed task's run state, then reclaims the parent branch a
 * stacked child was pinning: `removeWorktree` preserved it while the child's
 * run state referenced it, and nothing else revisits it once that state is
 * gone.
 */
export async function recordCleanedUpRuns(
  config: ResolvedConfig,
  entries: readonly WorktreeEntry[],
): Promise<void> {
  for (const entry of entries) {
    try {
      const runState = readRunState(config, entry.task);
      removeRunState(config, entry.task);
      if (runState?.baseBranch !== undefined && runState.parentTask !== undefined) {
        // oxlint-disable-next-line no-await-in-loop -- few stacked tasks per teardown; sequential keeps git load predictable.
        await reclaimStackParentBranch(config, {
          repository: entry.repository,
          parentTask: runState.parentTask,
          branchName: runState.baseBranch,
        });
      }
    } catch (error) {
      debug(`Run state cleanup failed for ${entry.task}: ${errorMessage(error)}`);
    }
  }
}
