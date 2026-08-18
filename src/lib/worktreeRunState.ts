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

export interface EffectiveBranchNameProbe {
  branch: string;
  problem?: string | undefined;
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
  return (await probeEffectiveBranchNameFromRunState(input)).branch;
}

export async function probeEffectiveBranchNameFromRunState(
  input: EffectiveBranchNameFromRunStateInput,
): Promise<EffectiveBranchNameProbe> {
  const checkedOut = await probeCheckedOutBranch({ directory: input.entry.dir });
  if (checkedOut.kind === "found") {
    return { branch: checkedOut.branch };
  }
  const branch = fallbackBranch(input);
  const reason = checkedOut.kind === "detached" ? "HEAD is detached" : "git probe failed";
  return {
    branch,
    problem: `Could not determine the current branch for ${input.entry.dir}: ${reason}`,
  };
}

function fallbackBranch(input: EffectiveBranchNameFromRunStateInput): string {
  if (input.runState !== undefined && runStateMatchesEntry(input)) {
    return input.runState.branchName;
  }
  return input.entry.branchName;
}

type CheckedOutBranchProbe =
  | { kind: "found"; branch: string }
  | { kind: "detached" }
  | { kind: "failed" };

async function probeCheckedOutBranch(input: { directory: string }): Promise<CheckedOutBranchProbe> {
  const { directory } = input;
  try {
    const output = await runCommandAsync("git", ["branch", "--show-current"], {
      cwd: directory,
    });
    return output === "" ? { kind: "detached" } : { kind: "found", branch: output };
  } catch {
    return { kind: "failed" };
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
