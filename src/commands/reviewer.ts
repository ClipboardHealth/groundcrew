/**
 * Per-iteration scanner that advances a task based on its worktree's pull
 * request state. Sits between the cleaner and the dispatcher in each
 * `orchestrate()` tick.
 *
 * - An **open** PR on an **in-progress** task → `markInReview`: frees a
 *   dispatch slot (slot math counts only in-progress) while leaving the
 *   worktree intact for review, since the cleaner only tears down `done`.
 * - A **merged** PR (on an in-progress or in-review task) → `markDone`:
 *   the work has landed, so the task is terminal and the cleaner tears the
 *   worktree down on a later tick. `merged` never routes to `in-review`.
 *
 * Sources that don't implement `markDone` (e.g. Linear) return `unsupported`;
 * the reviewer logs the skip and does nothing — there is no in-review
 * fallback. (Linear's own GitHub integration moves merged issues to Done,
 * which groundcrew observes via `fetch()`.)
 *
 * The write-back lands in the task source, not the in-memory `BoardState`,
 * so the dispatcher in the SAME tick still sees prior state; the slot frees on
 * the NEXT tick's `board.fetch()`. That one-tick latency is deliberate. One
 * per `orchestrate()`; stateless across iterations. Mirrors `Cleaner`.
 */

import type { Board } from "../lib/board.ts";
import type { PullRequestSummary } from "../lib/pullRequests.ts";
import {
  type BoardState,
  type CanonicalStatus,
  type Issue,
  naturalIdFromCanonical,
} from "../lib/taskSource.ts";
import { debug, errorMessage, log, logEvent } from "../lib/util.ts";
import type { WorktreeEntry } from "../lib/worktrees.ts";

/**
 * Injected PR lookup. Matches `findPullRequestsForBranch`'s shape: best-effort,
 * never rejects — a failed lookup (gh missing, unauthenticated, non-GitHub
 * remote, network error) resolves to an empty list, indistinguishable from
 * "no PR yet". Both outcomes mean "skip this issue, retry next tick".
 */
export type FindPullRequests = (arguments_: {
  cwd: string;
  branchName: string;
  signal?: AbortSignal;
}) => Promise<readonly PullRequestSummary[]>;

interface ReviewerDeps {
  board: Board;
  findPullRequests: FindPullRequests;
}

/** Per-tick inputs, mirroring the other orchestrator steps' shape. */
interface ReviewArguments {
  state: BoardState;
  worktreeEntries: readonly WorktreeEntry[];
  dryRun: boolean;
  signal?: AbortSignal;
}

export interface Reviewer {
  runOnce: (arguments_: ReviewArguments) => Promise<void>;
}

type Transition = "done" | "in-review";

// Maps a worktree's PRs to the transition its task should make. A merged PR
// means the work landed → done; an open PR on an in-progress task means it's
// up for review. `merged` wins over `open`. An open PR on an already in-review
// task is a no-op (returns undefined). Closed-only PRs are ignored.
function intendedTransition(
  pullRequests: readonly PullRequestSummary[],
  status: CanonicalStatus,
): Transition | undefined {
  if (pullRequests.some((pr) => pr.state === "merged")) {
    return "done";
  }
  if (status === "in-progress" && pullRequests.some((pr) => pr.state === "open")) {
    return "in-review";
  }
  return undefined;
}

// The PR to name in logs for a transition: the merged one for `done`, the open
// one for `in-review`. Guaranteed to exist because intendedTransition only
// returns a transition when a PR of the matching state is present.
function pullRequestForTransition(
  pullRequests: readonly PullRequestSummary[],
  transition: Transition,
): PullRequestSummary {
  const state = transition === "done" ? "merged" : "open";
  // oxlint-disable-next-line typescript/no-non-null-assertion -- intendedTransition guarantees a PR of this state exists
  return pullRequests.find((pr) => pr.state === state)!;
}

function matchingWorktreeEntries(arguments_: {
  issue: Issue;
  worktreeEntries: readonly WorktreeEntry[];
  task: string;
}): WorktreeEntry[] {
  const { issue, worktreeEntries, task } = arguments_;
  if (issue.repository === undefined) {
    return [];
  }
  return worktreeEntries.filter(
    (entry) => entry.task === task && entry.repository === issue.repository,
  );
}

export function createReviewer(deps: ReviewerDeps): Reviewer {
  const { board, findPullRequests } = deps;

  async function runOnce(arguments_: ReviewArguments): Promise<void> {
    const { state, worktreeEntries, dryRun, signal } = arguments_;

    const candidates = state.issues.filter(
      (issue) => issue.status === "in-progress" || issue.status === "in-review",
    );
    if (candidates.length === 0) {
      return;
    }

    for (const issue of candidates) {
      // oxlint-disable-next-line no-await-in-loop -- few candidates per tick; sequential keeps gh load low.
      await advanceIfReviewable({
        issue,
        worktreeEntries,
        dryRun,
        ...(signal === undefined ? {} : { signal }),
      });
    }
  }

  // Idempotent after an applied transition: once advanced, the issue leaves the
  // in-progress/in-review candidate set, so it never reaches this scan again.
  // Unsupported writebacks are skipped without claiming success and may retry
  // on later ticks.
  async function advanceIfReviewable(arguments_: {
    issue: Issue;
    worktreeEntries: readonly WorktreeEntry[];
    dryRun: boolean;
    signal?: AbortSignal;
  }): Promise<void> {
    const { issue, worktreeEntries, dryRun, signal } = arguments_;
    const task = naturalIdFromCanonical(issue.id);
    const entries = matchingWorktreeEntries({ issue, worktreeEntries, task });

    for (const entry of entries) {
      // The injected lookup is contracted never to reject (failures resolve to
      // []), but we still guard it so one bad lookup can never abort the tick
      // and starve the other candidates. A failure means "can't tell yet" →
      // skip this worktree and retry next tick.
      let pullRequests: readonly PullRequestSummary[];
      try {
        // oxlint-disable-next-line no-await-in-loop -- a task almost always has one worktree; sequential lookups are fine.
        pullRequests = await findPullRequests({
          cwd: entry.dir,
          branchName: entry.branchName,
          ...(signal === undefined ? {} : { signal }),
        });
      } catch (error) {
        debug(`PR lookup failed for ${task} (${entry.branchName}): ${errorMessage(error)}`);
        continue;
      }
      const transition = intendedTransition(pullRequests, issue.status);
      if (transition === undefined) {
        continue;
      }
      const pullRequest = pullRequestForTransition(pullRequests, transition);
      if (dryRun) {
        log(`[dry-run] Would advance ${task} to ${transition} (PR ${pullRequest.url})`);
        logEvent("review", {
          outcome: "skipped",
          reason: "dry_run",
          task,
          pr: pullRequest.url,
          to: transition,
        });
        return;
      }
      // oxlint-disable-next-line no-await-in-loop -- single write-back then return; never iterates past the first actionable worktree.
      await advance({ issue, task, pullRequest, transition });
      return;
    }
  }

  // A writeback failure (shell/Linear error) is logged and swallowed: the
  // task keeps its status and is retried next tick, exactly like a failed
  // lookup. We never let one task's writeback abort the others' reviews.
  async function advance(arguments_: {
    issue: Issue;
    task: string;
    pullRequest: PullRequestSummary;
    transition: Transition;
  }): Promise<void> {
    const { issue, task, pullRequest, transition } = arguments_;
    try {
      const result =
        transition === "done" ? await board.markDone(issue) : await board.markInReview(issue);
      if (result.outcome === "unsupported") {
        log(`Skipped advancing ${task} to ${transition}: ${result.reason}`);
        logEvent("review", {
          outcome: "skipped",
          reason: "unsupported",
          task,
          to: transition,
        });
        return;
      }
      log(`Advanced ${task} to ${transition} (PR ${pullRequest.url})`);
      logEvent("review", {
        outcome: "advanced",
        task,
        pr: pullRequest.url,
        state: pullRequest.state,
        to: transition,
      });
    } catch (error) {
      log(`Failed to advance ${task} to ${transition}: ${errorMessage(error)}`);
      logEvent("review", {
        outcome: "failed",
        reason: "writeback_failed",
        task,
        to: transition,
      });
    }
  }

  return { runOnce };
}
