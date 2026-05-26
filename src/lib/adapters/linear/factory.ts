import type { AdapterContext } from "../../adapterDefinition.ts";
import {
  type Blocker as LinearBlocker,
  createBoardSource,
  fetchResolvedIssue,
  type Issue as LinearIssue,
  isTerminalStatusForBlocker,
} from "../../boardSource.ts";
import { findProjectBySlugId, type ResolvedConfig } from "../../config.ts";
import { createLinearIssueStatusUpdater } from "../../linearIssueStatus.ts";
import type {
  Blocker as CanonicalBlocker,
  CanonicalStatus,
  Issue as CanonicalIssue,
  TicketSource,
} from "../../ticketSource.ts";
import { getLinearClient } from "../../util.ts";
import type { LinearAdapterConfig } from "./schema.ts";

interface LinearSourceRef {
  uuid: string;
  statusId: string;
  teamId: string;
  projectSlugId: string;
  nativeStatus: string;
}

function isViewMode(config: ResolvedConfig): boolean {
  return (config.linear.views ?? []).length > 0;
}

function canonicalStatusForStateType(stateType: string): CanonicalStatus {
  if (stateType === "unstarted") {
    return "todo";
  }
  if (stateType === "started") {
    return "in-progress";
  }
  if (stateType === "completed" || stateType === "canceled") {
    return "done";
  }
  return "other";
}

export function canonicalIssueStatus(issue: LinearIssue, config: ResolvedConfig): CanonicalStatus {
  if (isViewMode(config)) {
    return canonicalStatusForStateType(issue.stateType);
  }
  const project = findProjectBySlugId(config, issue.projectSlugId);
  /* v8 ignore next 5 @preserve -- fetchBoard's slugId filter and issueStatusBelongsToOwnProject guarantee project is configured by the time we get here */
  if (project === undefined) {
    throw new Error(
      `Linear adapter: issue ${issue.id} carries unknown projectSlugId "${issue.projectSlugId}"`,
    );
  }
  const { statuses } = project;
  if (statuses.todo === issue.status) {
    return "todo";
  }
  if (statuses.inProgress === issue.status) {
    return "in-progress";
  }
  if (statuses.done === issue.status || statuses.terminal.includes(issue.status)) {
    return "done";
  }
  return "other";
}

export function canonicalBlockerStatus(
  blocker: LinearBlocker,
  config: ResolvedConfig,
): CanonicalStatus {
  if (isViewMode(config)) {
    /* v8 ignore next @preserve -- view-mode queries always select state.type for blockers, so stateType is defined in real runs */
    return canonicalStatusForStateType(blocker.stateType ?? "");
  }
  if (blocker.status === undefined) {
    return "other";
  }
  if (isTerminalStatusForBlocker(blocker, config)) {
    return "done";
  }
  if (blocker.projectSlugId !== undefined) {
    const project = findProjectBySlugId(config, blocker.projectSlugId);
    if (project !== undefined) {
      const { statuses } = project;
      if (statuses.todo === blocker.status) {
        return "todo";
      }
      if (statuses.inProgress === blocker.status) {
        return "in-progress";
      }
    }
  }
  return "other";
}

export function toCanonicalIssue(
  linearIssue: LinearIssue,
  config: ResolvedConfig,
  sourceName: string,
): CanonicalIssue {
  const sourceRef: LinearSourceRef = {
    uuid: linearIssue.uuid,
    statusId: linearIssue.statusId,
    teamId: linearIssue.teamId,
    projectSlugId: linearIssue.projectSlugId,
    nativeStatus: linearIssue.status,
  };
  return {
    id: `${sourceName}:${linearIssue.id}`,
    source: sourceName,
    title: linearIssue.title,
    description: "",
    status: canonicalIssueStatus(linearIssue, config),
    repository: linearIssue.repository,
    model: linearIssue.model,
    assignee: linearIssue.assignee,
    updatedAt: linearIssue.updatedAt,
    blockers: linearIssue.blockers.map<CanonicalBlocker>((blocker) => ({
      id: `${sourceName}:${blocker.id}`,
      title: blocker.title,
      status: canonicalBlockerStatus(blocker, config),
    })),
    hasMoreBlockers: linearIssue.hasMoreBlockers,
    sourceRef,
  };
}

export function createLinearTicketSource(
  config: LinearAdapterConfig,
  context: AdapterContext,
): TicketSource {
  const sourceName = config.name ?? "linear";
  const { globalConfig } = context;
  const client = getLinearClient();
  const boardSource = createBoardSource({ config: globalConfig, client });
  const issueStatusUpdater = createLinearIssueStatusUpdater({ config: globalConfig, client });

  return {
    name: sourceName,
    async verify(): Promise<void> {
      await boardSource.verify();
    },
    async fetch(): Promise<CanonicalIssue[]> {
      const state = await boardSource.fetch();
      return state.issues.map((linearIssue) =>
        toCanonicalIssue(linearIssue, globalConfig, sourceName),
      );
    },
    async resolveOne(naturalId: string): Promise<CanonicalIssue | undefined> {
      const resolved = await fetchResolvedIssue({
        client,
        config: globalConfig,
        ticket: naturalId,
      });
      const sourceRef: LinearSourceRef = {
        uuid: resolved.uuid,
        statusId: "",
        teamId: resolved.teamId,
        projectSlugId: resolved.projectSlugId,
        nativeStatus: "",
      };
      return {
        id: `${sourceName}:${naturalId.toLowerCase()}`,
        source: sourceName,
        title: resolved.title,
        description: resolved.description,
        status: "other",
        repository: resolved.repository,
        model: resolved.model,
        assignee: "Unassigned",
        updatedAt: new Date().toISOString(),
        blockers: [],
        hasMoreBlockers: false,
        sourceRef,
      };
    },
    async markInProgress(issue: CanonicalIssue): Promise<void> {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- by the Linear adapter's contract, every Issue it produces carries a LinearSourceRef in sourceRef
      const ref = issue.sourceRef as LinearSourceRef;
      await issueStatusUpdater.markInProgress({
        id: issue.id,
        uuid: ref.uuid,
        teamId: ref.teamId,
        projectSlugId: ref.projectSlugId,
      });
    },
  };
}
