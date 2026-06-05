import type { LinearClient } from "@linear/sdk";

import type { MarkInReviewResult } from "../../ticketSource.ts";
import { debug } from "../../util.ts";

interface LinearIssueReference {
  id: string;
  uuid: string;
  teamId: string;
}

interface LinearIssueStatusUpdater {
  markInProgress(issue: LinearIssueReference): Promise<void>;
  markInReview(issue: LinearIssueReference): Promise<MarkInReviewResult>;
}

// Linear maps every `started` workflow state to canonical in-progress today,
// so it cannot prove a successful in-review transition. Report unsupported
// until read/write sides can distinguish "In Review" from generic started.
async function markInReviewUnsupported(issue: LinearIssueReference): Promise<MarkInReviewResult> {
  debug(`markInReview is unsupported for ${issue.id} (Linear in-review not yet implemented)`);
  return {
    outcome: "unsupported",
    reason: "Linear in-review writeback is not implemented",
  };
}

export function createLinearIssueStatusUpdater(arguments_: {
  client: LinearClient;
}): LinearIssueStatusUpdater {
  const { client } = arguments_;
  // Positive cache only. Keyed by teamId because the in-progress-state
  // resolution yields a single stateId per team — independent of which
  // project the ticket belongs to. State ids don't change for misconfig
  // reasons, so caching successful resolutions is safe across the process.
  //
  // No negative cache: a missing "started" workflow state is a Linear-side
  // config issue the operator can correct mid-session, and a negative cache
  // would mask that recovery until process restart. Slot count caps
  // markInProgress calls per tick at 1-5, so re-fetching team states on
  // every failing attempt costs at most a handful of extra Linear API calls
  // per tick.
  const inProgressStateByTeam = new Map<string, string>();

  async function getInProgressStateId(teamId: string): Promise<string | undefined> {
    if (teamId.length === 0) {
      return undefined;
    }
    const cached = inProgressStateByTeam.get(teamId);
    if (cached !== undefined) {
      return cached;
    }
    const team = await client.team(teamId);
    const states = await team.states();
    // Linear's default workflow has MULTIPLE `started`-type states — both
    // "In Progress" and "In Review" are `started`. `team.states()` orders by
    // updatedAt (the connection has no position ordering), so array order
    // can't disambiguate them. Prefer the state literally named "In Progress";
    // otherwise fall back to the lowest-position (leftmost) `started` column,
    // which by Linear convention is the in-progress one. This survives teams
    // that rename the column ("Doing", "WIP", ...).
    const startedStates = states.nodes.filter((state) => state.type === "started");
    const inProgress =
      startedStates.find((state) => state.name.trim().toLowerCase() === "in progress") ??
      startedStates.toSorted((a, b) => a.position - b.position).at(0);
    if (inProgress?.id === undefined) {
      return undefined;
    }
    inProgressStateByTeam.set(teamId, inProgress.id);
    return inProgress.id;
  }

  async function markInProgress(issue: LinearIssueReference): Promise<void> {
    const stateId = await getInProgressStateId(issue.teamId);
    if (stateId === undefined) {
      throw new Error(
        `Could not find a workflow state with type "started" for ${issue.id} (team ${issue.teamId.length > 0 ? issue.teamId : "?"}). Confirm the team's Linear workflow has an in-progress column.`,
      );
    }
    await client.updateIssue(issue.uuid, { stateId });
    debug(`Marked ${issue.id} as in progress`);
  }

  return { markInProgress, markInReview: markInReviewUnsupported };
}
