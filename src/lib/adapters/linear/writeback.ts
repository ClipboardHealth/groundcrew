import type { LinearClient } from "@linear/sdk";

import type { MarkInReviewResult } from "../../taskSource.ts";
import { debug } from "../../util.ts";
import {
  DEFAULT_LINEAR_STATUS_NAMES,
  findLinearWorkflowStateByName,
  formatLinearStatusNames,
  type LinearStatusNames,
  type LinearWorkflowState,
} from "./statusNames.ts";

interface LinearIssueReference {
  id: string;
  uuid: string;
  teamId: string;
}

interface LinearIssueStatusUpdater {
  markInProgress: (issue: LinearIssueReference) => Promise<void>;
  markInReview: (issue: LinearIssueReference) => Promise<MarkInReviewResult>;
}

export function createLinearIssueStatusUpdater(arguments_: {
  client: LinearClient;
  statusNames?: LinearStatusNames;
}): LinearIssueStatusUpdater {
  const { client, statusNames = DEFAULT_LINEAR_STATUS_NAMES } = arguments_;
  // Positive cache only. Keyed by teamId because the in-progress-state
  // resolution yields a single stateId per team — independent of which
  // project the task belongs to. State ids don't change for misconfig
  // reasons, so caching successful resolutions is safe across the process.
  //
  // No negative cache: a missing "started" workflow state is a Linear-side
  // config issue the operator can correct mid-session, and a negative cache
  // would mask that recovery until process restart. Slot count caps
  // markInProgress calls per tick at 1-5, so re-fetching team states on
  // every failing attempt costs at most a handful of extra Linear API calls
  // per tick.
  const inProgressStateByTeam = new Map<string, string>();
  const inReviewStateByTeam = new Map<string, string>();

  async function fetchWorkflowStates(teamId: string): Promise<readonly LinearWorkflowState[]> {
    const team = await client.team(teamId);
    const states = await team.states();
    return states.nodes;
  }

  async function getInProgressStateId(teamId: string): Promise<string | undefined> {
    if (teamId.length === 0) {
      return undefined;
    }
    const cached = inProgressStateByTeam.get(teamId);
    if (cached !== undefined) {
      return cached;
    }
    // Linear's default workflow has MULTIPLE `started`-type states — both
    // "In Progress" and "In Review" are `started`. `team.states()` orders by
    // updatedAt (the connection has no position ordering), so array order
    // can't disambiguate them. Prefer configured/default in-progress names;
    // otherwise fall back to the lowest-position (leftmost) `started` column.
    const states = await fetchWorkflowStates(teamId);
    const startedStates = states.filter((state) => state.type === "started");
    const inProgress =
      findLinearWorkflowStateByName(startedStates, statusNames.inProgress) ??
      startedStates.toSorted((a, b) => a.position - b.position).at(0);
    if (inProgress?.id === undefined) {
      return undefined;
    }
    inProgressStateByTeam.set(teamId, inProgress.id);
    return inProgress.id;
  }

  async function getInReviewStateId(teamId: string): Promise<string | undefined> {
    if (teamId.length === 0) {
      return undefined;
    }
    const cached = inReviewStateByTeam.get(teamId);
    if (cached !== undefined) {
      return cached;
    }
    const states = await fetchWorkflowStates(teamId);
    const startedStates = states.filter((state) => state.type === "started");
    const inReview = findLinearWorkflowStateByName(startedStates, statusNames.inReview);
    if (inReview?.id === undefined) {
      return undefined;
    }
    inReviewStateByTeam.set(teamId, inReview.id);
    return inReview.id;
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

  async function markInReview(issue: LinearIssueReference): Promise<MarkInReviewResult> {
    const stateId = await getInReviewStateId(issue.teamId);
    if (stateId === undefined) {
      return {
        outcome: "unsupported",
        reason: `Could not find a Linear workflow state named ${formatLinearStatusNames(statusNames.inReview)} for team ${issue.teamId.length > 0 ? issue.teamId : "?"}`,
      };
    }
    await client.updateIssue(issue.uuid, { stateId });
    debug(`Marked ${issue.id} as in review`);
    return { outcome: "applied" };
  }

  return { markInProgress, markInReview };
}
