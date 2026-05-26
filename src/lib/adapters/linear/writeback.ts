import type { LinearClient } from "@linear/sdk";

import { log } from "../../util.ts";

interface LinearIssueReference {
  id: string;
  uuid: string;
  teamId: string;
}

interface LinearIssueStatusUpdater {
  markInProgress(issue: LinearIssueReference): Promise<void>;
}

export function createLinearIssueStatusUpdater(arguments_: {
  client: LinearClient;
}): LinearIssueStatusUpdater {
  const { client } = arguments_;
  // Positive cache only. Keyed by teamId because the workflow `state.type ===
  // "started"` lookup yields a single stateId per team — independent of which
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
    // Use the workflow state's `type` — Linear standardises on `started` for
    // in-progress columns regardless of how the user renames them, so this
    // works without any per-team status-name configuration.
    const inProgress = states.nodes.find((state) => state.type === "started");
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
    log(`Marked ${issue.id} as in progress`);
  }

  return { markInProgress };
}
