import type { AdapterContext } from "../../adapterDefinition.ts";
import {
  type Blocker as LinearBlocker,
  createBoardSource,
  fetchResolvedIssue,
  type Issue as LinearIssue,
  isTerminalStatusForBlocker,
} from "../../boardSource.ts";
import { findProjectBySlugId, type ResolvedProjectConfig } from "../../config.ts";
import { createLinearIssueStatusUpdater } from "../../linearIssueStatus.ts";
import type {
  Blocker as CanonicalBlocker,
  CanonicalStatus,
  Issue as CanonicalIssue,
  TicketSource,
} from "../../ticketSource.ts";
import { getLinearClient } from "../../util.ts";
import {
  buildLinearCanonicalIssue,
  buildResolvedLinearCanonicalIssue,
  type LinearSourceRef,
} from "./canonical.ts";
import type { LinearAdapterConfig } from "./schema.ts";
import { createLinearViewTicketSource } from "./viewSource.ts";

export function canonicalStatusForProject(
  nativeStatus: string,
  project: ResolvedProjectConfig,
): CanonicalStatus {
  if (project.statuses.todo === nativeStatus) {
    return "todo";
  }
  if (project.statuses.inProgress === nativeStatus) {
    return "in-progress";
  }
  if (project.statuses.done === nativeStatus) {
    return "done";
  }
  if (project.statuses.terminal.includes(nativeStatus)) {
    return "done";
  }
  return "other";
}

export function canonicalBlockerStatus(
  blocker: LinearBlocker,
  globalConfig: AdapterContext["globalConfig"],
): CanonicalStatus {
  if (blocker.status === undefined) {
    return "other";
  }
  if (isTerminalStatusForBlocker(blocker, globalConfig)) {
    return "done";
  }
  if (blocker.projectSlugId !== undefined) {
    const project = findProjectBySlugId(globalConfig, blocker.projectSlugId);
    if (project !== undefined) {
      return canonicalStatusForProject(blocker.status, project);
    }
  }
  return "other";
}

function toCanonicalBlocker(
  blocker: LinearBlocker,
  globalConfig: AdapterContext["globalConfig"],
  sourceName: string,
): CanonicalBlocker {
  return {
    id: `${sourceName}:${blocker.id}`,
    title: blocker.title,
    status: canonicalBlockerStatus(blocker, globalConfig),
  };
}

export function toCanonicalIssue(
  linearIssue: LinearIssue,
  globalConfig: AdapterContext["globalConfig"],
  sourceName: string,
): CanonicalIssue {
  const project = findProjectBySlugId(globalConfig, linearIssue.projectSlugId);
  /* v8 ignore next 5 @preserve -- fetchBoard's slugId filter and issueStatusBelongsToOwnProject guarantee project is configured by the time we get here */
  if (project === undefined) {
    throw new Error(
      `Linear adapter: issue ${linearIssue.id} carries unknown projectSlugId "${linearIssue.projectSlugId}"`,
    );
  }
  return buildLinearCanonicalIssue({
    linearIssue,
    sourceName,
    status: canonicalStatusForProject(linearIssue.status, project),
    blockers: linearIssue.blockers.map((b) => toCanonicalBlocker(b, globalConfig, sourceName)),
  });
}

export function createLinearTicketSource(
  config: LinearAdapterConfig,
  context: AdapterContext,
): TicketSource {
  const sourceName = config.name ?? "linear";
  const { globalConfig } = context;
  const client = getLinearClient();

  const [view] = globalConfig.linear.views ?? [];
  if (view !== undefined) {
    return createLinearViewTicketSource({
      client,
      config: globalConfig,
      view,
      sourceName,
    });
  }

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
      const project = findProjectBySlugId(globalConfig, resolved.projectSlugId);
      /* v8 ignore next 5 @preserve -- fetchResolvedIssue already throws UnknownProjectError before reaching this guard */
      if (project === undefined) {
        throw new Error(
          `Linear adapter: resolved issue ${naturalId} carries unknown projectSlugId "${resolved.projectSlugId}"`,
        );
      }
      return buildResolvedLinearCanonicalIssue({
        sourceName,
        ticketIdentifier: naturalId,
        resolved,
      });
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
