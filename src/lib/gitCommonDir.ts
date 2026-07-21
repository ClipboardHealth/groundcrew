import { runCommand } from "./commandRunner.ts";

/**
 * Resolve the worktree's shared git directory from the checkout itself.
 * This supports both native worktrees and externally provisioned worktrees
 * whose git storage lives outside the checkout tree.
 */
export function resolveGitCommonDir(worktreeDir: string): string {
  return runCommand("git", [
    "-C",
    worktreeDir,
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
}
