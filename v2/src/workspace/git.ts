/**
 * Credential-free git plumbing over execa (design §12.1). The workspace module
 * depends on git and nothing else in `src`; every git fact — branches, commits,
 * dirty state — is read here. Git inherits the orchestrator's environment (PATH,
 * HOME, sandbox), so no env is threaded through.
 */

import * as fs from "node:fs";

import { execa } from "execa";

interface GitResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/** A worktree as reported by `git worktree list --porcelain`. */
export interface WorktreeEntry {
  readonly path: string;
  readonly branch?: string;
}

/** True when `directory` exists and is a directory. */
export function isDirectory(input: { readonly directory: string }): boolean {
  try {
    return fs.statSync(input.directory).isDirectory();
  } catch {
    return false;
  }
}

/** True when a local branch `refs/heads/<branch>` exists in the repo. */
export async function localBranchExists(input: {
  readonly repoDirectory: string;
  readonly branch: string;
}): Promise<boolean> {
  const result = await git({
    repoDirectory: input.repoDirectory,
    args: ["rev-parse", "--verify", "--quiet", `refs/heads/${input.branch}`],
  });
  return result.exitCode === 0;
}

/** True when `ref` resolves to a commit in the repo. */
export async function refExists(input: {
  readonly repoDirectory: string;
  readonly ref: string;
}): Promise<boolean> {
  const result = await git({
    repoDirectory: input.repoDirectory,
    args: ["rev-parse", "--verify", "--quiet", `${input.ref}^{commit}`],
  });
  return result.exitCode === 0;
}

/**
 * The commit a new task branch should be cut from: `<remote>/<defaultBranch>`
 * when it exists, else the branch named by the remote's HEAD symbolic ref, else
 * `HEAD`. Best-effort — a fresh cut always resolves to something reasonable.
 */
export async function resolveStartPoint(input: {
  readonly repoDirectory: string;
  readonly remote: string;
  readonly defaultBranch: string;
}): Promise<string> {
  const { repoDirectory, remote, defaultBranch } = input;
  const configured = `${remote}/${defaultBranch}`;
  if (await refExists({ repoDirectory, ref: configured })) {
    return configured;
  }

  const resolved = await resolveDefaultBranch({ repoDirectory, remote });
  if (resolved !== undefined) {
    const candidate = `${remote}/${resolved}`;
    if (await refExists({ repoDirectory, ref: candidate })) {
      return candidate;
    }
  }

  return "HEAD";
}

/**
 * Adds a worktree at `worktreePath` on `branch`. With `startPoint` the branch is
 * created there (`-b`); without it the existing branch is reused, re-attaching
 * to its prior commits (DISPATCH-08).
 */
export async function addWorktree(input: {
  readonly repoDirectory: string;
  readonly worktreePath: string;
  readonly branch: string;
  readonly startPoint?: string;
}): Promise<void> {
  const args =
    input.startPoint === undefined
      ? ["worktree", "add", input.worktreePath, input.branch]
      : ["worktree", "add", "-b", input.branch, input.worktreePath, input.startPoint];
  await gitOrThrow({ repoDirectory: input.repoDirectory, args });
}

/**
 * Removes a worktree. Prefers `git worktree remove --force`; when git refuses
 * (e.g. an unregistered or half-created directory) it deletes the directory and
 * prunes the administrative entry so the clone is left consistent.
 */
export async function removeWorktree(input: {
  readonly repoDirectory: string;
  readonly worktreePath: string;
}): Promise<void> {
  const result = await git({
    repoDirectory: input.repoDirectory,
    args: ["worktree", "remove", "--force", input.worktreePath],
  });
  if (result.exitCode !== 0) {
    fs.rmSync(input.worktreePath, { recursive: true, force: true });
  }

  await git({ repoDirectory: input.repoDirectory, args: ["worktree", "prune"] });
}

/** Deletes a local branch (force). Best-effort: a missing branch is not an error. */
export async function deleteBranch(input: {
  readonly repoDirectory: string;
  readonly branch: string;
}): Promise<void> {
  await git({ repoDirectory: input.repoDirectory, args: ["branch", "-D", input.branch] });
}

/** Parses `git worktree list --porcelain` for the repo. */
export async function listWorktrees(input: {
  readonly repoDirectory: string;
}): Promise<WorktreeEntry[]> {
  const result = await git({
    repoDirectory: input.repoDirectory,
    args: ["worktree", "list", "--porcelain"],
  });

  const entries: WorktreeEntry[] = [];
  let currentPath: string | undefined;
  let currentBranchRef: string | undefined;
  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      currentPath = line.slice("worktree ".length);
    } else if (line.startsWith("branch ")) {
      currentBranchRef = line.slice("branch ".length).replace(/^refs\/heads\//u, "");
    } else if (line.trim() === "" && currentPath !== undefined) {
      entries.push(toEntry({ path: currentPath, branch: currentBranchRef }));
      currentPath = undefined;
      currentBranchRef = undefined;
    }
  }

  if (currentPath !== undefined) {
    entries.push(toEntry({ path: currentPath, branch: currentBranchRef }));
  }

  return entries;
}

/** The short name of the branch currently checked out in a worktree. */
export async function currentBranch(input: {
  readonly worktreePath: string;
}): Promise<string> {
  const result = await gitOrThrow({
    repoDirectory: input.worktreePath,
    args: ["rev-parse", "--abbrev-ref", "HEAD"],
  });
  return result.stdout.trim();
}

/** Uncommitted-change paths in a worktree (`git status --porcelain`). */
export async function dirtyFiles(input: {
  readonly worktreePath: string;
}): Promise<string[]> {
  const result = await gitOrThrow({
    repoDirectory: input.worktreePath,
    args: ["status", "--porcelain"],
  });
  return result.stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => line.slice(3).trim())
    .filter((entry) => entry !== "");
}

/** Commit subjects reachable from `HEAD` but not `base`, newest first. */
export async function commitSubjectsAhead(input: {
  readonly worktreePath: string;
  readonly base: string;
}): Promise<string[]> {
  const result = await git({
    repoDirectory: input.worktreePath,
    args: ["log", "--format=%s", `${input.base}..HEAD`],
  });
  if (result.exitCode !== 0) {
    return [];
  }

  return result.stdout.split("\n").filter((line) => line.trim() !== "");
}

/**
 * Reads the remote's default branch from `refs/remotes/<remote>/HEAD` (set by
 * `git clone`); `undefined` when the symbolic ref is unset. Ported from v1's
 * `src/lib/defaultBranch.ts`, trimmed for the fixed-env v2 call sites.
 */
export async function resolveDefaultBranch(input: {
  readonly repoDirectory: string;
  readonly remote: string;
}): Promise<string | undefined> {
  const prefix = `${input.remote}/`;
  const result = await git({
    repoDirectory: input.repoDirectory,
    args: ["symbolic-ref", "--short", `refs/remotes/${input.remote}/HEAD`],
  });
  if (result.exitCode !== 0) {
    return undefined;
  }

  const trimmed = result.stdout.trim();
  if (trimmed.startsWith(prefix)) {
    const branch = trimmed.slice(prefix.length);
    return branch.length > 0 ? branch : undefined;
  }

  return undefined;
}

async function gitOrThrow(input: {
  readonly repoDirectory: string;
  readonly args: readonly string[];
}): Promise<GitResult> {
  const result = await git(input);
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${input.args.join(" ")} failed (exit ${String(result.exitCode)}) in ${input.repoDirectory}: ${result.stderr.trim()}`,
    );
  }

  return result;
}

async function git(input: {
  readonly repoDirectory: string;
  readonly args: readonly string[];
}): Promise<GitResult> {
  const result = await execa("git", ["-C", input.repoDirectory, ...input.args], {
    reject: false,
    stripFinalNewline: false,
  });
  return {
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    exitCode: typeof result.exitCode === "number" ? result.exitCode : 1,
  };
}

function toEntry(input: {
  readonly path: string;
  readonly branch: string | undefined;
}): WorktreeEntry {
  return {
    path: input.path,
    ...(input.branch === undefined ? {} : { branch: input.branch }),
  };
}
