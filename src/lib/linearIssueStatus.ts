import type { LinearClient } from "@linear/sdk";

import type { ResolvedConfig } from "./config.ts";
import { log } from "./util.ts";

interface LinearIssueReference {
  id: string;
  uuid: string;
  teamId: string;
  /**
   * Snapshot of label names currently on the issue (as seen during the
   * board fetch). `addLabels` uses this to skip labels that are already
   * applied, sparing the Linear API from no-op mutations.
   */
  labels: readonly string[];
}

interface LinearIssueStatusUpdater {
  markInProgress(issue: LinearIssueReference): Promise<void>;
  markTodo(issue: LinearIssueReference): Promise<void>;
  /**
   * Apply each label name to the issue. Names already present on `issue.labels`
   * are skipped. Labels missing from the team are auto-created so operational
   * tags like `agent-retried` don't require a one-time manual setup.
   */
  addLabels(issue: LinearIssueReference, names: readonly string[]): Promise<void>;
  /**
   * Reset the negative cache of teams that lack the configured status state
   * names. Called once per dispatcher tick so a fix in Linear during a watch
   * session is picked up on the next iteration.
   */
  resetMissingStateCache(): void;
}

interface TeamLabelEntry {
  id: string;
  name: string;
}

export function createLinearIssueStatusUpdater(arguments_: {
  config: ResolvedConfig;
  client: LinearClient;
}): LinearIssueStatusUpdater {
  const { config, client } = arguments_;
  const inProgressStateByTeam = new Map<string, string>();
  const todoStateByTeam = new Map<string, string>();
  const labelsByTeam = new Map<string, Map<string, string>>();
  let teamsMissingInProgress = new Set<string>();
  let teamsMissingTodo = new Set<string>();

  async function getStateIdByName(stateArguments: {
    teamId: string;
    name: string;
    cache: Map<string, string>;
    negativeCache: Set<string>;
  }): Promise<string | undefined> {
    const { teamId, name, cache, negativeCache } = stateArguments;
    if (teamId.length === 0) {
      return undefined;
    }
    const cached = cache.get(teamId);
    if (cached !== undefined) {
      return cached;
    }
    // Negative cache is reset by dispatcher each iteration so a team that's
    // fixed in Linear during a watch session auto-recovers on the next tick.
    if (negativeCache.has(teamId)) {
      return undefined;
    }

    const team = await client.team(teamId);
    const states = await team.states();
    const match = states.nodes.find((state) => state.name === name);
    if (match?.id === undefined) {
      negativeCache.add(teamId);
      return undefined;
    }
    cache.set(teamId, match.id);
    return match.id;
  }

  async function markInProgress(issue: LinearIssueReference): Promise<void> {
    const stateId = await getStateIdByName({
      teamId: issue.teamId,
      name: config.linear.statuses.inProgress,
      cache: inProgressStateByTeam,
      negativeCache: teamsMissingInProgress,
    });
    if (stateId === undefined) {
      throw new Error(
        `Could not find "${config.linear.statuses.inProgress}" state for ${issue.id} (team ${issue.teamId.length > 0 ? issue.teamId : "?"}). Verify the status name in linear.statuses.inProgress matches the team's workflow.`,
      );
    }
    await client.updateIssue(issue.uuid, { stateId });
    log(`Marked ${issue.id} as ${config.linear.statuses.inProgress}`);
  }

  async function markTodo(issue: LinearIssueReference): Promise<void> {
    const stateId = await getStateIdByName({
      teamId: issue.teamId,
      name: config.linear.statuses.todo,
      cache: todoStateByTeam,
      negativeCache: teamsMissingTodo,
    });
    if (stateId === undefined) {
      /* v8 ignore next @preserve -- ternary's empty-teamId branch only fires for malformed issues that fail upstream validation */
      const teamLabel = issue.teamId.length > 0 ? issue.teamId : "?";
      throw new Error(
        `Could not find "${config.linear.statuses.todo}" state for ${issue.id} (team ${teamLabel}). Verify the status name in linear.statuses.todo matches the team's workflow.`,
      );
    }
    await client.updateIssue(issue.uuid, { stateId });
    log(`Marked ${issue.id} as ${config.linear.statuses.todo}`);
  }

  async function loadTeamLabels(teamId: string): Promise<Map<string, string>> {
    const cached = labelsByTeam.get(teamId);
    if (cached !== undefined) {
      return cached;
    }
    const team = await client.team(teamId);
    const labels = await team.labels();
    const byName = new Map<string, string>();
    for (const label of labels.nodes as TeamLabelEntry[]) {
      byName.set(label.name, label.id);
    }
    labelsByTeam.set(teamId, byName);
    return byName;
  }

  async function ensureLabel(teamId: string, name: string): Promise<string | undefined> {
    const labels = await loadTeamLabels(teamId);
    const existing = labels.get(name);
    if (existing !== undefined) {
      return existing;
    }
    const payload = await client.createIssueLabel({ name, teamId });
    const createdLabel = await payload.issueLabel;
    if (createdLabel?.id === undefined) {
      log(`Could not create label "${name}" for team ${teamId}; skipping`);
      return undefined;
    }
    labels.set(name, createdLabel.id);
    return createdLabel.id;
  }

  async function addLabels(issue: LinearIssueReference, names: readonly string[]): Promise<void> {
    const pending = names.filter((name) => !issue.labels.includes(name));
    for (const name of pending) {
      // oxlint-disable-next-line no-await-in-loop -- Linear mutations are serial per ticket to avoid label-cache races
      const labelId = await ensureLabel(issue.teamId, name);
      if (labelId === undefined) {
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop -- same reason as above
      await client.issueAddLabel(issue.uuid, labelId);
      log(`Added label "${name}" to ${issue.id}`);
    }
  }

  function resetMissingStateCache(): void {
    teamsMissingInProgress = new Set();
    teamsMissingTodo = new Set();
  }

  return { markInProgress, markTodo, addLabels, resetMissingStateCache };
}
