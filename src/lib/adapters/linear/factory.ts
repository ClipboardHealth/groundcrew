/**
 * Linear `TicketSource` factory. Wraps the existing boardSource.ts machinery
 * (createBoardSource, fetchResolvedIssue, createLinearIssueStatusUpdater) and
 * converts the Linear-native `Issue`/`Blocker` shapes into the canonical
 * `Issue`/`Blocker` shapes consumers (via `Board`) speak.
 *
 * Status mapping is driven entirely by Linear's workflow `state.type`
 * (`unstarted` → todo, `started` → in-progress,
 * `completed`/`canceled`/`duplicate` → done) so renamed columns are classified
 * correctly without any per-team config.
 *
 * Description is not populated on `fetch()` Issues (boardSource's snapshot
 * doesn't include it); `resolveOne()` Issues carry the full description
 * because `fetchResolvedIssue` fetches it explicitly.
 */

import type { AdapterContext } from "../../adapterDefinition.ts";
import {
  type Blocker as LinearBlocker,
  createBoardSource,
  fetchResolvedIssue,
  type Issue as LinearIssue,
  isTerminalStateType,
} from "../../boardSource.ts";
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
  nativeStatus: string;
}

export function canonicalStatusFromStateType(stateType: string | undefined): CanonicalStatus {
  if (stateType === "unstarted") {
    return "todo";
  }
  if (stateType === "started") {
    return "in-progress";
  }
  if (isTerminalStateType(stateType)) {
    return "done";
  }
  return "other";
}

function toCanonicalBlocker(blocker: LinearBlocker, sourceName: string): CanonicalBlocker {
  return {
    id: `${sourceName}:${blocker.id}`,
    title: blocker.title,
    status: canonicalStatusFromStateType(blocker.stateType),
  };
}

export function toCanonicalIssue(linearIssue: LinearIssue, sourceName: string): CanonicalIssue {
  const sourceRef: LinearSourceRef = {
    uuid: linearIssue.uuid,
    statusId: linearIssue.statusId,
    teamId: linearIssue.teamId,
    nativeStatus: linearIssue.status,
  };
  return {
    id: `${sourceName}:${linearIssue.id}`,
    source: sourceName,
    title: linearIssue.title,
    // Board snapshot doesn't carry description; resolveOne() populates it.
    description: "",
    status: canonicalStatusFromStateType(linearIssue.stateType),
    repository: linearIssue.repository,
    model: linearIssue.model,
    assignee: linearIssue.assignee,
    updatedAt: linearIssue.updatedAt,
    blockers: linearIssue.blockers.map((b) => toCanonicalBlocker(b, sourceName)),
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
  const issueStatusUpdater = createLinearIssueStatusUpdater({ client });

  return {
    name: sourceName,
    async verify(): Promise<void> {
      await boardSource.verify();
    },
    async fetch(): Promise<CanonicalIssue[]> {
      const state = await boardSource.fetch();
      return state.issues.map((linearIssue) => toCanonicalIssue(linearIssue, sourceName));
    },
    async resolveOne(naturalId: string): Promise<CanonicalIssue | undefined> {
      // fetchResolvedIssue throws on missing repo; we let those propagate.
      // Returning `undefined` is reserved for "ticket genuinely doesn't
      // exist," which fetchResolvedIssue surfaces as an Error too — for now
      // we let any error bubble up rather than swallow.
      const resolved = await fetchResolvedIssue({
        client,
        config: globalConfig,
        ticket: naturalId,
      });
      // fetchResolvedIssue doesn't return the native status name (it's
      // already been resolved through workflow state lookup). We surface
      // "other" until the consumer needs the canonical status, which is fine
      // because `crew setup` doesn't branch on it.
      const sourceRef: LinearSourceRef = {
        uuid: resolved.uuid,
        statusId: "",
        teamId: resolved.teamId,
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
      });
    },
  };
}
