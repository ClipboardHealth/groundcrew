import type { LinearClient } from "@linear/sdk";

import type { ResolvedConfig } from "./config.ts";
import { log } from "./util.ts";

interface LinearIssueReference {
  id: string;
  uuid: string;
  teamId: string;
}

interface LinearIssueStatusUpdater {
  markInProgress(issue: LinearIssueReference): Promise<void>;
  resetMissingInProgressCache(): void;
}

export function createLinearIssueStatusUpdater(arguments_: {
  config: ResolvedConfig;
  client: LinearClient;
}): LinearIssueStatusUpdater {
  const { config, client } = arguments_;
  const inProgressStateByTeam = new Map<string, string>();
  let teamsMissingInProgress = new Set<string>();

  async function getInProgressStateId(teamId: string): Promise<string | undefined> {
    if (teamId.length === 0) {
      return undefined;
    }
    const cached = inProgressStateByTeam.get(teamId);
    if (cached !== undefined) {
      return cached;
    }
    // Negative cache is reset by dispatcher each iteration so a team that's
    // fixed in Linear during a watch session auto-recovers on the next tick.
    if (teamsMissingInProgress.has(teamId)) {
      return undefined;
    }

    const team = await client.team(teamId);
    const states = await team.states();
    const inProgress = states.nodes.find(
      (state) => state.name === config.linear.statuses.inProgress,
    );
    if (inProgress?.id === undefined) {
      teamsMissingInProgress.add(teamId);
      return undefined;
    }
    inProgressStateByTeam.set(teamId, inProgress.id);
    return inProgress.id;
  }

  async function markInProgress(issue: LinearIssueReference): Promise<void> {
    const stateId = await getInProgressStateId(issue.teamId);
    if (stateId === undefined) {
      throw new Error(
        `Could not find "${config.linear.statuses.inProgress}" state for ${issue.id} (team ${issue.teamId.length > 0 ? issue.teamId : "?"}). Verify the status name in linear.statuses.inProgress matches the team's workflow.`,
      );
    }
    await client.updateIssue(issue.uuid, { stateId });
    log(`Marked ${issue.id} as ${config.linear.statuses.inProgress}`);
  }

  function resetMissingInProgressCache(): void {
    teamsMissingInProgress = new Set();
  }

  return { markInProgress, resetMissingInProgressCache };
}
