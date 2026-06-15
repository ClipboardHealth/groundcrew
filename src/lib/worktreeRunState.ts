import path from "node:path";

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

export function effectiveBranchName(input: EffectiveBranchNameInput): string {
  return effectiveBranchNameFromRunState({
    entry: input.entry,
    runState: readMatchingRunState(input),
  });
}

interface EffectiveBranchNameFromRunStateInput {
  entry: Pick<WorktreeEntry, "repository" | "branchName" | "dir">;
  runState: RunState | undefined;
}

export function effectiveBranchNameFromRunState(
  input: EffectiveBranchNameFromRunStateInput,
): string {
  if (input.runState !== undefined && runStateMatchesEntry(input)) {
    return input.runState.branchName;
  }
  return input.entry.branchName;
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
