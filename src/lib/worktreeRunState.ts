import path from "node:path";

import { runCommandAsync } from "./commandRunner.ts";
import type { ResolvedConfig } from "./config.ts";
import { readRunState, type RunState } from "./runState.ts";
import type { WorktreeEntry } from "./worktrees.ts";

type RunStateMatchEntry = Pick<WorktreeEntry, "repository" | "task" | "dir">;

interface ReadMatchingRunStateInput {
  config: ResolvedConfig;
  entry: RunStateMatchEntry;
}

function readMatchingRunState(input: ReadMatchingRunStateInput): RunState | undefined {
  const runState = readRunState(input.config, input.entry.task);
  if (runStateMatchesEntry({ runState, entry: input.entry })) {
    return runState;
  }
  return undefined;
}

interface RunStateMatchesEntryInput {
  runState: RunState | undefined;
  entry: Pick<WorktreeEntry, "repository" | "dir">;
}

function runStateMatchesEntry(input: RunStateMatchesEntryInput): boolean {
  const { runState, entry } = input;
  if (runState === undefined) {
    return false;
  }
  return (
    runState.repository === entry.repository &&
    path.resolve(runState.worktreeDir) === path.resolve(entry.dir)
  );
}

interface EffectiveBranchNameInput {
  config: ResolvedConfig;
  entry: Pick<WorktreeEntry, "repository" | "task" | "branchName" | "dir">;
}

export async function effectiveBranchName(input: EffectiveBranchNameInput): Promise<string> {
  return await effectiveBranchNameFromRunState({
    entry: input.entry,
    runState: readMatchingRunState(input),
  });
}

interface EffectiveBranchNameFromRunStateInput {
  entry: Pick<WorktreeEntry, "repository" | "branchName" | "dir">;
  runState: RunState | undefined;
}

/**
 * Resolves the worktree's checked-out branch name. Git is the source of truth:
 * run state records the branch we *requested* at creation, but a template hook
 * or manual rename can drift the actual branch (e.g. flawless-inventory prefixes
 * with the GitHub username). Downstream callers — `gh pr list --head <name>`,
 * the displayed `branch:` row, `git push` — need what git has now, not what we
 * once asked for. Falls back to run state / entry when git can't answer
 * (detached HEAD, worktree not yet provisioned, git failure).
 */
export async function effectiveBranchNameFromRunState(
  input: EffectiveBranchNameFromRunStateInput,
): Promise<string> {
  const checkedOut = await resolveCheckedOutBranch(input.entry.dir);
  if (checkedOut !== undefined) {
    return checkedOut;
  }
  if (input.runState !== undefined && runStateMatchesEntry(input)) {
    return input.runState.branchName;
  }
  return input.entry.branchName;
}

async function resolveCheckedOutBranch(dir: string): Promise<string | undefined> {
  try {
    const output = await runCommandAsync("git", ["branch", "--show-current"], { cwd: dir });
    return output === "" ? undefined : output;
  } catch {
    return undefined;
  }
}

interface HasAdoptedBranchInput {
  config: ResolvedConfig;
  entry: Pick<WorktreeEntry, "repository" | "task" | "dir" | "adoptedBranch">;
}

export function hasAdoptedBranch(input: HasAdoptedBranchInput): boolean {
  if (input.entry.adoptedBranch === true) {
    return true;
  }
  return readMatchingRunState(input)?.adoptedBranch === true;
}
