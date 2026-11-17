import { runCommandAsync } from "./commandRunner.ts";
import type { ResolvedConfig } from "./config.ts";
import { debug, errorMessage } from "./util.ts";
import { resolveRepoDir } from "./worktrees.ts";

export async function deleteRemoteBranchBestEffort(arguments_: {
  config: ResolvedConfig;
  repository: string;
  branchName: string;
}): Promise<void> {
  const { config, repository, branchName } = arguments_;
  try {
    await runCommandAsync("git", [
      "-C",
      resolveRepoDir(config, repository),
      "push",
      "--no-verify",
      config.git.remote,
      "--delete",
      branchName,
    ]);
  } catch (error) {
    debug(`Remote branch cleanup failed for ${branchName}: ${errorMessage(error)}`);
  }
}
