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
import {
  createStacksClient,
  type GitHubStack,
  type StackListing,
  type StacksClient,
} from "../lib/githubStacks.ts";
import {
  type CountMergeCommits,
  countMergeCommits as countMergeCommitsForPullRequest,
  type PullRequestSummary,
} from "../lib/pullRequests.ts";
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
  // `push_rejected` this many times in a row, so the task is left for a
  // human instead of re-running the rebase every tick. Counted per watcher
  // process: a restart gives the task another round of attempts.
  | "push_retries_exhausted"
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
  | "parent_ref_missing"
  // The parent merged while the pair was registered as a GitHub stack, so
  // GitHub retargeted and rebased the child itself; nothing left to do but
  // stop tracking the parent branch.
  | "restacked_by_github";

const TERMINAL_MESSAGES: Record<StackRetargetOutcome, string> = {
  retargeted_to_parent: "Stack retarget corrected the PR base to the parent branch",
  rebased_onto_default: "Stack retarget rebased the branch onto the default branch and pushed",
  rebase_conflict: "Stack retarget hit a rebase conflict; aborted and left for manual resolution",
  retargeted_needs_rebase:
    "Stack retarget corrected the PR base; rebase deferred until the worktree is clean",
  retarget_failed: "Stack retarget could not edit the pull request's base; will retry next tick",
  push_rejected: "Stack retarget's force-push was rejected; will retry next tick",
  push_retries_exhausted:
    "Stack retarget's force-push keeps being rejected; leaving the branch for a manual rebase and push",
  parent_done_unmerged:
    "Stack retarget left the pull request alone: the parent task is done but its pull request never merged",
  lookup_failed:
    "Stack retarget could not look up the pull request for this task; will retry next tick",
  base_drifted:
    "Stack retarget left the pull request alone: its base is neither the parent nor the default branch",
  parent_ref_missing:
    "Stack retarget could not find the parent branch locally after the fetch fell back; flagged for rebase next tick",
  restacked_by_github:
    "Stack retarget left the branch alone: GitHub restacked the pull request when its parent merged",
};

type StackRegisterOutcome = "created" | "extended" | "failed";

const REGISTER_MESSAGES: Record<StackRegisterOutcome, string> = {
  created: "Stack register created a GitHub stack for this pull request and its parent",
  extended: "Stack register added this pull request to its parent's GitHub stack",
  failed: "Stack register could not register the pull request as a GitHub stack",
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
  stacks?: StacksClient;
  countMergeCommits?: CountMergeCommits;
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

/** Per-`runOnce`-call cache of a repository's GitHub stacks, keyed by repository. */
type StacksCache = Map<string, Promise<StackListing>>;

/** Consecutive force-push rejections per task, for the life of this process. */
type PushRejectionCounts = Map<string, number>;

/** Merge-commit count already reported per task, for the life of this process. */
type MergeCommitWarnings = Map<string, number>;

const MAX_PUSH_REJECTIONS = 3;

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
  });
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

async function listStacks(arguments_: {
  stacks: StacksClient;
  stacksCache: StacksCache;
  entry: WorktreeEntry;
  signal?: AbortSignal;
}): Promise<StackListing> {
  const { stacks, stacksCache, entry, signal } = arguments_;
  const cached = stacksCache.get(entry.repository);
  if (cached !== undefined) {
    return await cached;
  }
  const pending = stacks.listStacks({
    cwd: entry.dir,
    repository: entry.repository,
    ...signalProperty(signal),
  });
  stacksCache.set(entry.repository, pending);
  return await pending;
}

async function stackContaining(arguments_: {
  stacks: StacksClient;
  stacksCache: StacksCache;
  entry: WorktreeEntry;
  pullRequestNumber: number;
  signal?: AbortSignal;
}): Promise<GitHubStack | undefined> {
  const { pullRequestNumber, ...listArguments } = arguments_;
  const listing = await listStacks(listArguments);
  return listing.stacks.find((stack) => stack.pullRequests.includes(pullRequestNumber));
}

/**
 * Registers the child and its parent as a GitHub stack (spec section 5a), the
 * API behind the pull request page's "Create stack" button. Silent on every
 * no-op path — this runs each tick for the life of a stacked pair, so only a
 * state change is worth a log line.
 */
async function registerStack(arguments_: {
  entry: WorktreeEntry;
  childPullRequest: PullRequestSummary;
  baseBranch: string;
  parentTask: string;
  findPullRequests: FindPullRequests;
  parentPullRequestCache: ParentPullRequestCache;
  stacks: StacksClient;
  stacksCache: StacksCache;
  dryRun: boolean;
  signal?: AbortSignal;
}): Promise<void> {
  const {
    entry,
    childPullRequest,
    baseBranch,
    parentTask,
    findPullRequests,
    parentPullRequestCache,
    stacks,
    stacksCache,
    dryRun,
    signal,
  } = arguments_;
  const signalOption = signalProperty(signal);
  const task = entry.task;

  const listing = await listStacks({ stacks, stacksCache, entry, ...signalOption });
  if (!listing.available) {
    debug(`GitHub stacks are unavailable for ${entry.repository}; leaving ${task} unregistered`);
    return;
  }
  if (listing.stacks.some((stack) => stack.pullRequests.includes(childPullRequest.number))) {
    return;
  }

  const parentPullRequests = await fetchParentPullRequests({
    cache: parentPullRequestCache,
    findPullRequests,
    cwd: entry.dir,
    baseBranch,
    ...signalOption,
  });
  const parentPullRequest = parentPullRequests.find((pr) => pr.state === "open");
  if (parentPullRequest === undefined) {
    debug(`No open parent pull request for ${task}; leaving it unregistered`);
    return;
  }

  const parentStack = listing.stacks.find(
    (stack) => stack.open && stack.pullRequests.includes(parentPullRequest.number),
  );
  const logContext = {
    flow: "stack-register" as const,
    task,
    parentTask,
    pullRequest: childPullRequest.number,
    parentPullRequest: parentPullRequest.number,
  };
  if (dryRun) {
    log("Stack register dry run: would register the pull request as a GitHub stack");
    logEvent("stack-register", { ...logContext, outcome: "skipped", reason: "dry_run" });
    return;
  }

  const succeeded =
    parentStack === undefined
      ? await stacks.createStack({
          cwd: entry.dir,
          repository: entry.repository,
          pullRequests: [parentPullRequest.number, childPullRequest.number],
          ...signalOption,
        })
      : await stacks.addToStack({
          cwd: entry.dir,
          repository: entry.repository,
          stackNumber: parentStack.number,
          pullRequests: [childPullRequest.number],
          ...signalOption,
        });
  // The cached listing no longer describes the repository, and a sibling task
  // in the same repository may still be registered this tick.
  stacksCache.delete(entry.repository);

  const outcome: StackRegisterOutcome = succeeded
    ? parentStack === undefined
      ? "created"
      : "extended"
    : "failed";
  log(REGISTER_MESSAGES[outcome]);
  logEvent("stack-register", { ...logContext, outcome });
}

/**
 * Parent still open: keep the child's base pointing at the parent branch, then
 * make sure the pair is registered as a GitHub stack.
 */
async function trackOpenParent(arguments_: {
  entry: WorktreeEntry;
  childPullRequest: PullRequestSummary;
  baseBranch: string;
  parentTask: string;
  logContext: ReturnType<typeof logContextFor>;
  findPullRequests: FindPullRequests;
  parentPullRequestCache: ParentPullRequestCache;
  stacks: StacksClient;
  stacksCache: StacksCache;
  countMergeCommits: CountMergeCommits;
  mergeCommitWarnings: MergeCommitWarnings;
  runGh: RunGhCommand;
  dryRun: boolean;
  signal?: AbortSignal;
}): Promise<void> {
  const {
    entry,
    childPullRequest,
    baseBranch,
    parentTask,
    logContext,
    findPullRequests,
    parentPullRequestCache,
    stacks,
    stacksCache,
    countMergeCommits,
    mergeCommitWarnings,
    runGh,
    dryRun,
    signal,
  } = arguments_;
  const signalOption = signalProperty(signal);

  if (childPullRequest.baseRefName !== baseBranch) {
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
    if (!succeeded) {
      return;
    }
  }

  await registerStack({
    entry,
    childPullRequest,
    baseBranch,
    parentTask,
    findPullRequests,
    parentPullRequestCache,
    stacks,
    stacksCache,
    dryRun,
    ...signalOption,
  });
  await guardMergeCommits({
    entry,
    childPullRequest,
    parentTask,
    countMergeCommits,
    mergeCommitWarnings,
    ...signalOption,
  });
}

/**
 * GitHub stacks are rebase-only: a merge commit on a stacked child is replayed
 * as duplicate commits when the parent merges and GitHub restacks it, and
 * merging the default branch directly drags into the child everything the
 * parent lacks. This cannot be prevented from here (the agent owns the
 * branch), so it is surfaced instead — once per change in the count, not
 * every tick.
 */
async function guardMergeCommits(arguments_: {
  entry: WorktreeEntry;
  childPullRequest: PullRequestSummary;
  parentTask: string;
  countMergeCommits: CountMergeCommits;
  mergeCommitWarnings: MergeCommitWarnings;
  signal?: AbortSignal;
}): Promise<void> {
  const { entry, childPullRequest, parentTask, countMergeCommits, mergeCommitWarnings, signal } =
    arguments_;
  const task = entry.task;
  const mergeCommits = await countMergeCommits({
    cwd: entry.dir,
    pullRequestNumber: childPullRequest.number,
    ...signalProperty(signal),
  });
  if (mergeCommits === undefined || mergeCommits === (mergeCommitWarnings.get(task) ?? 0)) {
    return;
  }
  const logContext = {
    flow: "stack-guard" as const,
    task,
    parentTask,
    pullRequest: childPullRequest.number,
    mergeCommits,
  };
  if (mergeCommits > 0) {
    mergeCommitWarnings.set(task, mergeCommits);
    log(
      "Stack guard found merge commits on a stacked branch; GitHub stacks are rebase-only, so the branch should be rebased onto its parent instead",
    );
    logEvent("stack-guard", { ...logContext, outcome: "merge_commits_on_stack" });
    return;
  }
  mergeCommitWarnings.delete(task);
  log("Stack guard: the stacked branch no longer carries merge commits");
  logEvent("stack-guard", { ...logContext, outcome: "merge_commits_cleared" });
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
      // `--no-verify`: the commits were already verified when the agent shipped
      // them and the rebase changes only their base, but a repository's
      // pre-push hook runs a full local gate that cannot pass here (no
      // installed dependencies in a rebase-only push), rejecting every attempt.
      args: ["push", "--force-with-lease", "--no-verify", remote, "HEAD"],
      ...signalOption,
    });
  } catch (error) {
    debug(`Force-push failed for ${task}: ${errorMessage(error)}`);
    markNeedsRebase(config, runState);
    return "push_rejected";
  }

  await releaseParentBranch({ config, entry, parentTask, baseBranch, ...signalOption });
  return "rebased_onto_default";
}

/**
 * The child no longer references the parent; if no sibling still does either,
 * and the parent's own worktree is already gone (the common case — it tore
 * down as soon as its PR merged), nothing else will ever revisit its
 * preserved branch. Reclaim it now.
 */
async function releaseParentBranch(arguments_: {
  config: ResolvedConfig;
  entry: WorktreeEntry;
  parentTask: string;
  baseBranch: string;
  signal?: AbortSignal;
}): Promise<void> {
  const { config, entry, parentTask, baseBranch, signal } = arguments_;
  clearBaseBranch(config, entry.task);
  try {
    await reclaimStackParentBranch(config, {
      repository: entry.repository,
      parentTask,
      branchName: baseBranch,
      ...signalProperty(signal),
    });
  } catch (error) {
    debug(`Stack parent branch reclaim failed for ${parentTask}: ${errorMessage(error)}`);
  }
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
  stacks: StacksClient;
  stacksCache: StacksCache;
  countMergeCommits: CountMergeCommits;
  mergeCommitWarnings: MergeCommitWarnings;
  pushRejections: PushRejectionCounts;
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
    stacks,
    stacksCache,
    countMergeCommits,
    mergeCommitWarnings,
    pushRejections,
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
    await trackOpenParent({
      entry,
      childPullRequest,
      baseBranch,
      parentTask,
      logContext,
      findPullRequests,
      parentPullRequestCache,
      stacks,
      stacksCache,
      countMergeCommits,
      mergeCommitWarnings,
      runGh,
      dryRun,
      ...signalOption,
    });
    return;
  }

  const childStack = await stackContaining({
    stacks,
    stacksCache,
    entry,
    pullRequestNumber: childPullRequest.number,
    ...signalOption,
  });
  if (childStack !== undefined) {
    // GitHub rebases and retargets every pull request above a stack layer that
    // merges, so a stacked child needs no local rebase or force-push.
    if (childPullRequest.baseRefName === defaultBranch) {
      await releaseParentBranch({ config, entry, parentTask, baseBranch, ...signalOption });
      logTerminal(logContext, "restacked_by_github");
    }
    return;
  }

  const priorPushRejections = pushRejections.get(task) ?? 0;
  if (priorPushRejections >= MAX_PUSH_REJECTIONS) {
    debug(`Stack retarget skipping ${task}: ${priorPushRejections} force-pushes rejected already`);
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
  if (rebaseOutcome === "push_rejected") {
    const rejections = priorPushRejections + 1;
    pushRejections.set(task, rejections);
    logTerminal(
      logContext,
      rejections >= MAX_PUSH_REJECTIONS ? "push_retries_exhausted" : "push_rejected",
    );
    return;
  }
  pushRejections.delete(task);
  logTerminal(logContext, rebaseOutcome);
}

export function createStackRetarget(deps: StackRetargetDeps): StackRetarget {
  const {
    findPullRequests,
    runGit = runGitCommand,
    runGh = runGhCommand,
    stacks = createStacksClient(),
    countMergeCommits = countMergeCommitsForPullRequest,
  } = deps;
  const pushRejections: PushRejectionCounts = new Map();
  const mergeCommitWarnings: MergeCommitWarnings = new Map();

  async function runOnce(arguments_: StackRetargetArguments): Promise<void> {
    const { config, state, worktreeEntries, dryRun, signal } = arguments_;
    const signalOption = signalProperty(signal);
    const seenTasks = new Set<string>();
    const parentPullRequestCache: ParentPullRequestCache = new Map();
    const stacksCache: StacksCache = new Map();

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
        stacks,
        stacksCache,
        countMergeCommits,
        mergeCommitWarnings,
        pushRejections,
        runGit,
        runGh,
        dryRun,
        ...signalOption,
      });
    }
  }

  return { runOnce };
}
