/**
 * Resolve the default branch of a local clone from `refs/remotes/<remote>/HEAD`.
 *
 * `git clone` sets this symbolic ref to the remote's default branch (the one
 * GitHub/GitLab marks as default), so a repo cloned with `master` as its
 * primary branch reports `<remote>/master` and one on `main` reports
 * `<remote>/main`. Reading it locally means no network round-trip and no
 * per-repo config to maintain.
 *
 * Best-effort: when the HEAD ref is unset (rare — e.g. an out-of-band clone or
 * a `git remote set-head --delete`) or git otherwise fails, fall back to the
 * caller-supplied default so worktree creation and branch probes keep working.
 * Abort signals still propagate so a cancelled run doesn't waste time on the
 * fallback path.
 */

import { runCommandAsync } from "./commandRunner.ts";

interface ResolveDefaultBranchInput {
  repoDir: string;
  remote: string;
  fallback: string;
  signal?: AbortSignal;
}

export async function resolveDefaultBranch(input: ResolveDefaultBranchInput): Promise<string> {
  const remoteHeadRef = `refs/remotes/${input.remote}/HEAD`;
  const remotePrefix = `${input.remote}/`;
  const options = input.signal === undefined ? {} : { signal: input.signal };
  let output: string;
  try {
    output = await runCommandAsync(
      "git",
      ["-C", input.repoDir, "symbolic-ref", "--short", remoteHeadRef],
      options,
    );
  } catch (error) {
    if (input.signal?.aborted === true) {
      throw error;
    }
    return input.fallback;
  }
  const trimmed = output.trim();
  if (trimmed.startsWith(remotePrefix)) {
    const branch = trimmed.slice(remotePrefix.length);
    if (branch.length > 0) {
      return branch;
    }
  }
  return input.fallback;
}
