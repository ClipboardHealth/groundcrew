import type { ResolvedConfig } from "./config.ts";
import { listPullRequestsForBranch } from "./pullRequests.ts";
import { readRunState, removeRunState, wasLaunchedInCloud, type RunState } from "./runState.ts";
import { deleteRemoteBranchBestEffort } from "./remoteBranch.ts";
import { debug, errorMessage, log } from "./util.ts";
import { reclaimStackParentBranch, resolveRepoDir, type WorktreeEntry } from "./worktrees.ts";

/**
 * Drops each removed task's run state, then reclaims the parent branch a
 * stacked child was pinning: `removeWorktree` preserved it while the child's
 * run state referenced it, and nothing else revisits it once that state is
 * gone. A cloud-launched run's pushed branch is deleted from the remote only when it
 * never produced a PR.
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
        await reclaimStackParentBranch(config, {
          repository: entry.repository,
          parentTask: runState.parentTask,
          branchName: runState.baseBranch,
        });
      }
      if (runState !== undefined && wasLaunchedInCloud(runState)) {
        await deleteUnpublishedRemoteBranch({ config, entry, runState });
      }
    } catch (error) {
      debug(`Run state cleanup failed for ${entry.task}: ${errorMessage(error)}`);
    }
  }
}

async function deleteUnpublishedRemoteBranch(arguments_: {
  config: ResolvedConfig;
  entry: WorktreeEntry;
  runState: RunState;
}): Promise<void> {
  const { config, entry, runState } = arguments_;
  const repoDir = resolveRepoDir(config, entry.repository);
  const { branchName } = runState;
  try {
    const pullRequests = await listPullRequestsForBranch({ cwd: repoDir, branchName });
    if (pullRequests.length > 0) {
      return;
    }
  } catch (error) {
    log(`Kept remote branch ${branchName}; could not check for pull requests.`);
    debug(`Pull request lookup failed for ${branchName}: ${errorMessage(error)}`);
    return;
  }
  await deleteRemoteBranchBestEffort({ config, repository: entry.repository, branchName });
}
