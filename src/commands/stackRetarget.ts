/**
 * Per-tick pass that keeps a stacked child's PR base and branch in sync with
 * its parent, per the stacked-PRs design (spec section 5). Runs from within
 * the reviewer, once per task whose run state carries `baseBranch`:
 *
 * - Parent still open, child PR based on something other than the parent →
 *   `gh pr edit --base <parent>`.
 * - Parent merged (a PR on the parent's branch has state `merged` — the
 *   parent issue's canonical `done` status is never on its own proof of a
 *   merge: a ticket closed as duplicate, or completed via `crew task done`
 *   with an unmerged/closed PR, is `done` but not merged) and the child PR
 *   is still based on the parent (or GitHub already moved it to the default
 *   branch itself) → `gh pr edit --base <default>`, then rebase onto the
 *   default branch and force-push when the worktree is clean, or flag
 *   `needsRebase` when it isn't. A successful rebase also tries to reclaim
 *   the parent's now-unreferenced branch (spec section 6) — `worktrees.teardown`
 *   only checks this at the moment the parent's own worktree is torn down,
 *   which is usually before this rebase runs.
 * - Parent not merged, and the parent issue is done (or its worktree is
 *   gone) — the parent will never merge, so retargeting onto or rebasing
 *   onto a branch that is about to vanish would be wrong. Leave the child
 *   untouched (`parent_done_unmerged`).
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
import {
  localBranchExists,
  reclaimStackParentBranch,
  signalProperty,
  worktrees,
  type WorktreeEntry,
} from "../lib/worktrees.ts";
import type { FindPullRequests } from "./reviewer.ts";

type StackRetargetOutcome =
  | "retargeted_to_parent"
  | "rebased_onto_default"
  | "rebase_conflict"
  | "retargeted_needs_rebase"
  | "retarget_failed"
  // Not one of spec section 8's named outcomes: `--force-with-lease` was
  // rejected after a successful rebase, distinct from a rebase conflict.
  | "push_rejected"
  // The parent issue is done (or its worktree is gone) but no PR on its
  // branch ever merged — the parent will never merge, so the child is left
  // untouched rather than retargeted onto or rebased onto a dead branch.
  | "parent_done_unmerged"
  // The child's own PR lookup, or branch resolution, failed.
  | "lookup_failed"
  // Post-merge, the child PR's base is neither the parent nor the default
  // branch — someone retargeted it elsewhere; outside the spec's covered
  // cases, left alone rather than forced back.
  | "base_drifted"
  // The combined fetch failed and its default-branch-only fallback
  // succeeded, but the local parent ref it was counting on doesn't exist.
  | "parent_ref_missing";

const TERMINAL_MESSAGES: Record<StackRetargetOutcome, string> = {
  retargeted_to_parent: "Stack retarget corrected the PR base to the parent branch",
  rebased_onto_default: "Stack retarget rebased the branch onto the default branch and pushed",
  rebase_conflict: "Stack retarget hit a rebase conflict; aborted and left for manual resolution",
  retargeted_needs_rebase:
    "Stack retarget corrected the PR base; rebase deferred until the worktree is clean",
  retarget_failed: "Stack retarget could not edit the pull request's base; will retry next tick",
  push_rejected: "Stack retarget's force-push was rejected; will retry next tick",
  parent_done_unmerged:
    "Stack retarget left the pull request alone: the parent task is done but its pull request never merged",
  lookup_failed:
    "Stack retarget could not look up the pull request for this task; will retry next tick",
  base_drifted:
    "Stack retarget left the pull request alone: its base is neither the parent nor the default branch",
  parent_ref_missing:
    "Stack retarget could not find the parent branch locally after the fetch fell back; flagged for rebase next tick",
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
  await runCommandAsync("git", args, { cwd, ...signalProperty(signal) });

const runGhCommand: RunGhCommand = async ({ cwd, args, signal }) =>
  await runCommandAsync("gh", args, { cwd, ...signalProperty(signal) });

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

/** Per-`runOnce`-call cache of a parent branch's pull requests, keyed by branch. */
type ParentPullRequestCache = Map<string, Promise<readonly PullRequestSummary[]>>;

async function fetchParentPullRequests(arguments_: {
  cache: ParentPullRequestCache;
  findPullRequests: FindPullRequests;
  cwd: string;
  baseBranch: string;
  signal?: AbortSignal;
}): Promise<readonly PullRequestSummary[]> {
  const { cache, findPullRequests, cwd, baseBranch, signal } = arguments_;
  const cached = cache.get(baseBranch);
  if (cached !== undefined) {
    return await cached;
  }
  const pullRequests = findPullRequests({
    cwd,
    branchName: baseBranch,
    ...signalProperty(signal),
  }).catch(() => [] as readonly PullRequestSummary[]);
  cache.set(baseBranch, pullRequests);
  return await pullRequests;
}

/**
 * Parent-merged is PR-state-only: a PR on the parent's branch with state
 * `merged`. The parent issue's canonical `done` status is deliberately not
 * treated as proof — a ticket closed as duplicate, or completed via
 * `crew task done` with an unmerged/closed PR, is `done` without ever having
 * merged, and rebasing the child onto the default branch in that case would
 * strip the parent's commits out from under it.
 */
async function isParentMerged(arguments_: {
  cache: ParentPullRequestCache;
  entry: WorktreeEntry;
  baseBranch: string;
  findPullRequests: FindPullRequests;
  signal?: AbortSignal;
}): Promise<boolean> {
  const { cache, entry, baseBranch, findPullRequests, signal } = arguments_;
  const parentPullRequests = await fetchParentPullRequests({
    cache,
    findPullRequests,
    cwd: entry.dir,
    baseBranch,
    ...signalProperty(signal),
  });
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
      ...signalProperty(signal),
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
  parentTask: string;
  defaultBranch: string;
  remote: string;
  runGit: RunGitCommand;
  signal?: AbortSignal;
}): Promise<StackRetargetOutcome> {
  const { config, entry, runState, baseBranch, parentTask, defaultBranch, remote, runGit, signal } =
    arguments_;
  const task = entry.task;
  const signalOption = signalProperty(signal);

  const dirtiness = await worktrees.probeWorkingTree({ worktreeDir: entry.dir, ...signalOption });
  // A failed probe ("unknown") is treated as dirty: safer to defer the
  // rebase than force-push over a working tree we can't confirm is clean.
  if (dirtiness.kind !== "clean") {
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
    } catch (fallbackError) {
      debug(`Fetch of ${defaultBranch} failed for ${task}: ${errorMessage(fallbackError)}`);
      markNeedsRebase(config, runState);
      return "retargeted_needs_rebase";
    }
    if (!(await localBranchExists(entry.dir, baseBranch, signal))) {
      markNeedsRebase(config, runState);
      return "parent_ref_missing";
    }
    parentRef = baseBranch;
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
    await runGit({
      cwd: entry.dir,
      args: ["push", "--force-with-lease", remote, "HEAD"],
      ...signalOption,
    });
  } catch (error) {
    debug(`Force-push failed for ${task}: ${errorMessage(error)}`);
    markNeedsRebase(config, runState);
    return "push_rejected";
  }

  clearBaseBranch(config, task);
  // The child no longer references the parent; if no sibling still does
  // either, and the parent's own worktree is already gone (the common case —
  // it tore down as soon as its PR merged, well before this rebase ran),
  // nothing else will ever revisit its preserved branch. Reclaim it now.
  try {
    await reclaimStackParentBranch(config, {
      repository: entry.repository,
      parentTask,
      branchName: baseBranch,
      ...signalOption,
    });
  } catch (error) {
    debug(`Stack parent branch reclaim failed for ${parentTask}: ${errorMessage(error)}`);
  }
  return "rebased_onto_default";
}

async function retargetTask(arguments_: {
  config: ResolvedConfig;
  entry: WorktreeEntry;
  runState: RunState;
  baseBranch: string;
  parentTask: string;
  parentStatus: CanonicalStatus | undefined;
  parentWorktreeExists: boolean;
  findPullRequests: FindPullRequests;
  parentPullRequestCache: ParentPullRequestCache;
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
    parentWorktreeExists,
    findPullRequests,
    parentPullRequestCache,
    runGit,
    runGh,
    dryRun,
    signal,
  } = arguments_;
  const task = entry.task;
  const signalOption = signalProperty(signal);
  const logContext = logContextFor({ task, parentTask, baseBranch });

  let childPullRequests: readonly PullRequestSummary[];
  try {
    const branchName = await effectiveBranchName({ config, entry });
    childPullRequests = await findPullRequests({ cwd: entry.dir, branchName, ...signalOption });
  } catch (error) {
    debug(`Stack retarget PR lookup failed for ${task}: ${errorMessage(error)}`);
    logTerminal(logContext, "lookup_failed");
    return;
  }
  const childPullRequest = childPullRequests.find((pr) => pr.state === "open");
  if (childPullRequest === undefined) {
    return;
  }

  const parentMerged = await isParentMerged({
    cache: parentPullRequestCache,
    entry,
    baseBranch,
    findPullRequests,
    ...signalOption,
  });
  const { defaultBranch, remote } = config.git;

  if (!parentMerged) {
    if (parentStatus === "done" || !parentWorktreeExists) {
      logTerminal(logContext, "parent_done_unmerged");
      return;
    }
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
    // GitHub's own auto-retarget (fires when the parent's remote branch is
    // deleted) may already have moved the base here; proceed straight to rebase.
    if (dryRun) {
      logDryRun(logContext, "rebase the branch onto the default branch");
      return;
    }
    log("Stack retarget starting: parent merged, rebasing onto the default branch");
    logEvent("stack-retarget", logContext);
  } else if (childPullRequest.baseRefName === baseBranch) {
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
  } else {
    logTerminal(logContext, "base_drifted");
    return;
  }

  const rebaseOutcome = await rebaseOntoDefault({
    config,
    entry,
    runState,
    baseBranch,
    parentTask,
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
    const signalOption = signalProperty(signal);
    const seenTasks = new Set<string>();
    const parentPullRequestCache: ParentPullRequestCache = new Map();

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
        parentWorktreeExists: worktreeEntries.some((candidate) => candidate.task === parentTask),
        findPullRequests,
        parentPullRequestCache,
        runGit,
        runGh,
        dryRun,
        ...signalOption,
      });
    }
  }

  return { runOnce };
}
