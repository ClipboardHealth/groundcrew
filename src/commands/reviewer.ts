/**
 * Per-iteration scanner that advances in-progress tickets to in-review once
 * their worktree has an open (or merged) pull request. Sits between the cleaner
 * and the dispatcher in each `orchestrate()` tick. A successfully-applied
 * transition frees a dispatch slot (the slot math counts only in-progress)
 * while leaving the worktree intact for review, since the cleaner only tears
 * down `done` tickets.
 *
 * The write-back lands in the ticket source, not the in-memory `BoardState`, so
 * the dispatcher in the SAME tick still sees the ticket as in-progress; the slot
 * frees on the NEXT tick's `board.fetch()`. That one-tick latency is deliberate
 * — it keeps the reviewer from mutating shared `BoardState` mid-tick. One per
 * `orchestrate()`; stateless across iterations. Mirrors `Cleaner`.
 *
 * "Worktree has an open PR" is a v1 proxy for "the implementation is finished
 * and up for review". The detection + the open/merged condition live here in
 * the core reviewer (a push model) rather than inside any adapter, so a future
 * per-adapter `shouldAdvanceToReview` predicate is a clean additive change.
 */

import type { Board } from "../lib/board.ts";
import type { PullRequestSummary } from "../lib/pullRequests.ts";
import { type BoardState, type Issue, naturalIdFromCanonical } from "../lib/ticketSource.ts";
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
  runOnce(arguments_: ReviewArguments): Promise<void>;
}

// A PR whose lifecycle means the work is up for (or past) review. `merged`
// catches a PR that merged between ticks, so we still free the slot.
function isReviewablePullRequest(pr: PullRequestSummary): boolean {
  return pr.state === "open" || pr.state === "merged";
}

function matchingWorktreeEntries(arguments_: {
  issue: Issue;
  worktreeEntries: readonly WorktreeEntry[];
  ticket: string;
}): WorktreeEntry[] {
  const { issue, worktreeEntries, ticket } = arguments_;
  if (issue.repository === undefined) {
    return [];
  }
  return worktreeEntries.filter(
    (entry) => entry.ticket === ticket && entry.repository === issue.repository,
  );
}

export function createReviewer(deps: ReviewerDeps): Reviewer {
  const { board, findPullRequests } = deps;

  async function runOnce(arguments_: ReviewArguments): Promise<void> {
    const { state, worktreeEntries, dryRun, signal } = arguments_;

    const inProgress = state.issues.filter((issue) => issue.status === "in-progress");
    if (inProgress.length === 0) {
      return;
    }

    for (const issue of inProgress) {
      // oxlint-disable-next-line no-await-in-loop -- at most maximumInProgress (1-5) issues per tick; sequential keeps gh load low.
      await advanceIfReviewable({
        issue,
        worktreeEntries,
        dryRun,
        ...(signal === undefined ? {} : { signal }),
      });
    }
  }

  // Idempotent after an applied transition: once advanced, the issue leaves
  // `in-progress`, so it never reaches this scan again. Unsupported writebacks
  // are skipped without claiming success and may retry on later ticks.
  async function advanceIfReviewable(arguments_: {
    issue: Issue;
    worktreeEntries: readonly WorktreeEntry[];
    dryRun: boolean;
    signal?: AbortSignal;
  }): Promise<void> {
    const { issue, worktreeEntries, dryRun, signal } = arguments_;
    const ticket = naturalIdFromCanonical(issue.id);
    const entries = matchingWorktreeEntries({ issue, worktreeEntries, ticket });

    for (const entry of entries) {
      // The injected lookup is contracted never to reject (failures resolve to
      // []), but we still guard it so one bad lookup can never abort the tick
      // and starve the other in-progress issues. A failure means "can't tell
      // yet" → skip this worktree and retry next tick.
      let pullRequests: readonly PullRequestSummary[];
      try {
        // oxlint-disable-next-line no-await-in-loop -- a ticket almost always has one worktree; sequential lookups are fine.
        pullRequests = await findPullRequests({
          cwd: entry.dir,
          branchName: entry.branchName,
          ...(signal === undefined ? {} : { signal }),
        });
      } catch (error) {
        debug(`PR lookup failed for ${ticket} (${entry.branchName}): ${errorMessage(error)}`);
        continue;
      }
      const reviewable = pullRequests.find(isReviewablePullRequest);
      if (reviewable === undefined) {
        continue;
      }
      if (dryRun) {
        log(`[dry-run] Would advance ${ticket} to in-review (PR ${reviewable.url})`);
        logEvent("review", { outcome: "skipped", reason: "dry_run", ticket, pr: reviewable.url });
        return;
      }
      // oxlint-disable-next-line no-await-in-loop -- single write-back then return; never iterates past the first reviewable worktree.
      await advance({ issue, ticket, pullRequest: reviewable });
      return;
    }
  }

  // A writeback failure (shell/Linear error) is logged and swallowed: the
  // ticket stays in-progress and is retried next tick, exactly like a failed
  // lookup. We never let one ticket's writeback abort the others' reviews.
  async function advance(arguments_: {
    issue: Issue;
    ticket: string;
    pullRequest: PullRequestSummary;
  }): Promise<void> {
    const { issue, ticket, pullRequest } = arguments_;
    try {
      const result = await board.markInReview(issue);
      if (result.outcome === "unsupported") {
        log(`Skipped advancing ${ticket} to in-review: ${result.reason}`);
        logEvent("review", {
          outcome: "skipped",
          reason: "unsupported",
          ticket,
        });
        return;
      }
      log(`Advanced ${ticket} to in-review (PR ${pullRequest.url})`);
      logEvent("review", {
        outcome: "advanced",
        ticket,
        pr: pullRequest.url,
        state: pullRequest.state,
      });
    } catch (error) {
      log(`Failed to advance ${ticket} to in-review: ${errorMessage(error)}`);
      logEvent("review", { outcome: "failed", reason: "writeback_failed", ticket });
    }
  }

  return { runOnce };
}
