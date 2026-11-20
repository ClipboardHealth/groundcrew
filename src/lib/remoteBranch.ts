import { runCommandAsync } from "./commandRunner.ts";
import type { ResolvedConfig } from "./config.ts";
import { debug, errorMessage, log } from "./util.ts";
import { resolveRepoDir } from "./worktrees.ts";

type RemoteBranchAssessment =
  | { kind: "absent" }
  | { kind: "carries-work"; reason: string }
  | { kind: "empty" };

async function assessRemoteBranch(arguments_: {
  repoDir: string;
  remote: string;
  defaultBranch: string;
  branchName: string;
}): Promise<RemoteBranchAssessment> {
  const { repoDir, remote, defaultBranch, branchName } = arguments_;
  let listing: string;
  try {
    listing = await runCommandAsync("git", [
      "-C",
      repoDir,
      "ls-remote",
      "--heads",
      remote,
      `refs/heads/${branchName}`,
    ]);
  } catch (error) {
    return {
      kind: "carries-work",
      reason: `could not read its tip from ${remote}: ${errorMessage(error)}`,
    };
  }
  const [tip] = listing.trim().split(/\s+/);
  if (tip === undefined || tip.length === 0) {
    return { kind: "absent" };
  }
  try {
    await runCommandAsync("git", ["-C", repoDir, "cat-file", "-e", `${tip}^{commit}`]);
  } catch {
    return { kind: "carries-work", reason: `its tip ${tip} is not available locally` };
  }
  try {
    await runCommandAsync("git", [
      "-C",
      repoDir,
      "merge-base",
      "--is-ancestor",
      tip,
      `${remote}/${defaultBranch}`,
    ]);
  } catch {
    return {
      kind: "carries-work",
      reason: `its tip ${tip} is not contained in ${remote}/${defaultBranch}`,
    };
  }
  return { kind: "empty" };
}

/**
 * Deletes the remote branch only when it carries no work: its tip is already
 * contained in the remote's default branch. A branch with extra commits may be
 * the only copy of an agent's unpublished work, or a pre-existing branch this
 * run merely re-pushed, so every doubt keeps it.
 */
export async function deleteRemoteBranchBestEffort(arguments_: {
  config: ResolvedConfig;
  repository: string;
  branchName: string;
}): Promise<void> {
  const { config, repository, branchName } = arguments_;
  const repoDir = resolveRepoDir(config, repository);
  const assessment = await assessRemoteBranch({
    repoDir,
    remote: config.git.remote,
    defaultBranch: config.git.defaultBranch,
    branchName,
  });
  if (assessment.kind === "absent") {
    debug(`Remote branch ${branchName} is not on ${config.git.remote}; nothing to delete.`);
    return;
  }
  if (assessment.kind === "carries-work") {
    log(`Kept remote branch ${branchName}; ${assessment.reason}.`);
    return;
  }
  try {
    await runCommandAsync("git", [
      "-C",
      repoDir,
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
