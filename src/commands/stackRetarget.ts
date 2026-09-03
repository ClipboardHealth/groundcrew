/**
 * Per-tick pass that keeps a stacked child's PR base and branch in sync with
 * its parent, per the stacked-PRs design (spec section 5). Runs from within
 * the reviewer, once per task whose run state carries `baseBranch`:
 *
 * - Parent still open, child PR based on something other than the parent →
 *   `gh pr edit --base <parent>`.
 * - Parent merged (its PR is `merged`, or its issue is canonically `done`)
 *   and the child PR is still based on the parent (or GitHub already moved
 *   it to the default branch itself) → `gh pr edit --base <default>`, then
 *   rebase onto the default branch and force-push when the worktree is
 *   clean, or flag `needsRebase` when it isn't.
 *
 * A task with no `baseBranch` in run state, or no open PR yet, is left
 * alone — there is nothing to correct. Every git/gh failure is caught,
 * logged, and left for the next tick; one task's failure never blocks
 * another's.
 */

import { runCommandAsync } from "../lib/commandRunner.ts";
import type { ResolvedConfig } from "../lib/config.ts";
import type { PullRequestSummary } from "../lib/pullRequests.ts";
import { clearBaseBranch, readRunState, type RunState, updateRunState } from "../lib/runState.ts";
import {
  type BoardState,
  type CanonicalStatus,
  naturalIdFromCanonical,
} from "../lib/taskSource.ts";
import { debug, errorMessage, log, logEvent } from "../lib/util.ts";
import { effectiveBranchName } from "../lib/worktreeRunState.ts";
import type { WorktreeEntry } from "../lib/worktrees.ts";
import type { FindPullRequests } from "./reviewer.ts";

type StackRetargetOutcome =
  | "retargeted_to_parent"
  | "rebased_onto_default"
  | "rebase_conflict"
  | "retargeted_needs_rebase"
  | "retarget_failed"
  // Not one of spec section 8's named outcomes: `--force-with-lease` was
  // rejected after a successful rebase, distinct from a rebase conflict.
  | "push_rejected";

const TERMINAL_MESSAGES: Record<StackRetargetOutcome, string> = {
  retargeted_to_parent: "Stack retarget corrected the PR base to the parent branch",
  rebased_onto_default: "Stack retarget rebased the branch onto the default branch and pushed",
  rebase_conflict: "Stack retarget hit a rebase conflict; aborted and left for manual resolution",
  retargeted_needs_rebase:
    "Stack retarget corrected the PR base; rebase deferred until the worktree is clean",
  retarget_failed: "Stack retarget could not edit the pull request's base; will retry next tick",
  push_rejected: "Stack retarget's force-push was rejected; will retry next tick",
};

export type RunGitCommand = (arguments_: {
  cwd: string;
  args: readonly string[];
  signal?: AbortSignal;
}) => Promise<string>;

export type RunGhCommand = (arguments_: {
  cwd: string;
  args: readonly string[];
  signal?: AbortSignal;
}) => Promise<string>;

const runGitCommand: RunGitCommand = async ({ cwd, args, signal }) =>
  await runCommandAsync("git", args, signal === undefined ? { cwd } : { cwd, signal });

const runGhCommand: RunGhCommand = async ({ cwd, args, signal }) =>
  await runCommandAsync("gh", args, signal === undefined ? { cwd } : { cwd, signal });

export interface StackRetargetDeps {
  findPullRequests: FindPullRequests;
  runGit?: RunGitCommand;
  runGh?: RunGhCommand;
}

interface StackRetargetArguments {
  config: ResolvedConfig;
  state: BoardState;
  worktreeEntries: readonly WorktreeEntry[];
  dryRun: boolean;
  signal?: AbortSignal;
}

export interface StackRetarget {
  runOnce: (arguments_: StackRetargetArguments) => Promise<void>;
}

function findParentStatus(state: BoardState, parentTask: string): CanonicalStatus | undefined {
  return state.issues.find((issue) => naturalIdFromCanonical(issue.id) === parentTask)?.status;
}

function logContextFor(input: { task: string; parentTask: string; baseBranch: string }): {
  flow: "stack-retarget";
  task: string;
  parentTask: string;
  baseBranch: string;
} {
  return { flow: "stack-retarget", ...input };
}

function logTerminal(
  logContext: ReturnType<typeof logContextFor>,
  outcome: StackRetargetOutcome,
): void {
  log(TERMINAL_MESSAGES[outcome]);
  logEvent("stack-retarget", { ...logContext, outcome });
}

function logDryRun(logContext: ReturnType<typeof logContextFor>, action: string): void {
  log(`Stack retarget dry run: would ${action}`);
  logEvent("stack-retarget", { ...logContext, outcome: "skipped", reason: "dry_run" });
}

async function isParentMerged(arguments_: {
  entry: WorktreeEntry;
  baseBranch: string;
  parentStatus: CanonicalStatus | undefined;
  findPullRequests: FindPullRequests;
  signal?: AbortSignal;
}): Promise<boolean> {
  const { entry, baseBranch, parentStatus, findPullRequests, signal } = arguments_;
  if (parentStatus === "done") {
    return true;
  }
  let parentPullRequests: readonly PullRequestSummary[];
  try {
    parentPullRequests = await findPullRequests({
      cwd: entry.dir,
      branchName: baseBranch,
      ...(signal === undefined ? {} : { signal }),
    });
  } catch {
    return false;
  }
  return parentPullRequests.some((pr) => pr.state === "merged");
}

async function editPrBase(arguments_: {
  runGh: RunGhCommand;
  entry: WorktreeEntry;
  prNumber: number;
  base: string;
  signal?: AbortSignal;
}): Promise<boolean> {
  const { runGh, entry, prNumber, base, signal } = arguments_;
  try {
    await runGh({
      cwd: entry.dir,
      args: ["pr", "edit", String(prNumber), "--base", base],
      ...(signal === undefined ? {} : { signal }),
    });
    return true;
  } catch (error) {
    debug(
      `gh pr edit failed for ${entry.task} (PR #${prNumber} -> ${base}): ${errorMessage(error)}`,
    );
    return false;
  }
}

function markNeedsRebase(config: ResolvedConfig, runState: RunState): void {
  updateRunState({
    config,
    task: runState.task,
    patch: { state: runState.state, needsRebase: true },
  });
}

async function rebaseOntoDefault(arguments_: {
  config: ResolvedConfig;
  entry: WorktreeEntry;
  runState: RunState;
  baseBranch: string;
  defaultBranch: string;
  remote: string;
  runGit: RunGitCommand;
  signal?: AbortSignal;
}): Promise<StackRetargetOutcome> {
  const { config, entry, runState, baseBranch, defaultBranch, remote, runGit, signal } = arguments_;
  const task = entry.task;
  const signalOption = signal === undefined ? {} : { signal };

  let statusOutput: string;
  try {
    statusOutput = await runGit({
      cwd: entry.dir,
      args: ["--no-optional-locks", "status", "--porcelain"],
      ...signalOption,
    });
  } catch (error) {
    // A failed probe is treated as dirty: safer to defer the rebase than
    // force-push over a working tree we can't confirm is clean.
    debug(`Stack retarget status check failed for ${task}: ${errorMessage(error)}`);
    markNeedsRebase(config, runState);
    return "retargeted_needs_rebase";
  }
  if (statusOutput.trim().length > 0) {
    markNeedsRebase(config, runState);
    return "retargeted_needs_rebase";
  }

  let parentRef = `${remote}/${baseBranch}`;
  try {
    await runGit({
      cwd: entry.dir,
      args: ["fetch", remote, defaultBranch, baseBranch],
      ...signalOption,
    });
  } catch (error) {
    debug(
      `Fetch of ${defaultBranch}+${baseBranch} failed for ${task}, falling back to the local parent ref: ${errorMessage(error)}`,
    );
    try {
      await runGit({ cwd: entry.dir, args: ["fetch", remote, defaultBranch], ...signalOption });
      parentRef = baseBranch;
    } catch (fallbackError) {
      debug(`Fetch of ${defaultBranch} failed for ${task}: ${errorMessage(fallbackError)}`);
      markNeedsRebase(config, runState);
      return "retargeted_needs_rebase";
    }
  }

  try {
    await runGit({
      cwd: entry.dir,
      args: ["rebase", "--onto", `${remote}/${defaultBranch}`, parentRef],
      ...signalOption,
    });
  } catch (error) {
    debug(`Rebase onto ${defaultBranch} failed for ${task}: ${errorMessage(error)}`);
    try {
      await runGit({ cwd: entry.dir, args: ["rebase", "--abort"], ...signalOption });
    } catch (abortError) {
      debug(`git rebase --abort failed for ${task}: ${errorMessage(abortError)}`);
    }
    markNeedsRebase(config, runState);
    return "rebase_conflict";
  }

  try {
    await runGit({ cwd: entry.dir, args: ["push", "--force-with-lease"], ...signalOption });
  } catch (error) {
    debug(`Force-push failed for ${task}: ${errorMessage(error)}`);
    markNeedsRebase(config, runState);
    return "push_rejected";
  }

  clearBaseBranch(config, task);
  return "rebased_onto_default";
}

async function retargetTask(arguments_: {
  config: ResolvedConfig;
  entry: WorktreeEntry;
  runState: RunState;
  baseBranch: string;
  parentTask: string;
  parentStatus: CanonicalStatus | undefined;
  findPullRequests: FindPullRequests;
  runGit: RunGitCommand;
  runGh: RunGhCommand;
  dryRun: boolean;
  signal?: AbortSignal;
}): Promise<void> {
  const {
    config,
    entry,
    runState,
    baseBranch,
    parentTask,
    parentStatus,
    findPullRequests,
    runGit,
    runGh,
    dryRun,
    signal,
  } = arguments_;
  const task = entry.task;
  const signalOption = signal === undefined ? {} : { signal };
  const logContext = logContextFor({ task, parentTask, baseBranch });

  let childPullRequests: readonly PullRequestSummary[];
  try {
    const branchName = await effectiveBranchName({ config, entry });
    childPullRequests = await findPullRequests({ cwd: entry.dir, branchName, ...signalOption });
  } catch (error) {
    debug(`Stack retarget PR lookup failed for ${task}: ${errorMessage(error)}`);
    return;
  }
  const childPullRequest = childPullRequests.find((pr) => pr.state === "open");
  if (childPullRequest === undefined) {
    return;
  }

  const parentMerged = await isParentMerged({
    entry,
    baseBranch,
    parentStatus,
    findPullRequests,
    ...signalOption,
  });
  const { defaultBranch, remote } = config.git;

  if (!parentMerged) {
    if (childPullRequest.baseRefName === baseBranch) {
      return;
    }
    if (dryRun) {
      logDryRun(logContext, "retarget the pull request onto the parent branch");
      return;
    }
    log("Stack retarget starting: parent still open, correcting the pull request's base");
    logEvent("stack-retarget", logContext);
    const succeeded = await editPrBase({
      runGh,
      entry,
      prNumber: childPullRequest.number,
      base: baseBranch,
      ...signalOption,
    });
    logTerminal(logContext, succeeded ? "retargeted_to_parent" : "retarget_failed");
    return;
  }

  if (childPullRequest.baseRefName === defaultBranch) {
    if (dryRun) {
      logDryRun(logContext, "rebase the branch onto the default branch");
      return;
    }
    log("Stack retarget starting: parent merged, rebasing onto the default branch");
    logEvent("stack-retarget", logContext);
  } else {
    if (dryRun) {
      logDryRun(logContext, "retarget the pull request onto the default branch and rebase");
      return;
    }
    log("Stack retarget starting: parent merged, retargeting onto the default branch");
    logEvent("stack-retarget", logContext);
    const succeeded = await editPrBase({
      runGh,
      entry,
      prNumber: childPullRequest.number,
      base: defaultBranch,
      ...signalOption,
    });
    if (!succeeded) {
      logTerminal(logContext, "retarget_failed");
      return;
    }
  }

  const rebaseOutcome = await rebaseOntoDefault({
    config,
    entry,
    runState,
    baseBranch,
    defaultBranch,
    remote,
    runGit,
    ...signalOption,
  });
  logTerminal(logContext, rebaseOutcome);
}

export function createStackRetarget(deps: StackRetargetDeps): StackRetarget {
  const { findPullRequests, runGit = runGitCommand, runGh = runGhCommand } = deps;

  async function runOnce(arguments_: StackRetargetArguments): Promise<void> {
    const { config, state, worktreeEntries, dryRun, signal } = arguments_;
    const signalOption = signal === undefined ? {} : { signal };
    const seenTasks = new Set<string>();

    for (const entry of worktreeEntries) {
      if (seenTasks.has(entry.task)) {
        continue;
      }
      seenTasks.add(entry.task);
      const runState = readRunState(config, entry.task);
      if (runState?.baseBranch === undefined || runState.parentTask === undefined) {
        continue;
      }
      const { baseBranch, parentTask } = runState;
      // oxlint-disable-next-line no-await-in-loop -- few stacked tasks per tick; sequential keeps git/gh load predictable.
      await retargetTask({
        config,
        entry,
        runState,
        baseBranch,
        parentTask,
        parentStatus: findParentStatus(state, parentTask),
        findPullRequests,
        runGit,
        runGh,
        dryRun,
        ...signalOption,
      });
    }
  }

  return { runOnce };
}
