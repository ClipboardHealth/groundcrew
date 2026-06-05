/**
 * Linear `TicketSource` factory. Assembles the adapter from sibling modules
 * (createBoardSource + fetchResolvedIssue from ./fetch.ts;
 * createLinearIssueStatusUpdater from ./writeback.ts; getLinearClient from
 * ./client.ts) and converts Linear-specific shapes into the canonical
 * Issue/Blocker types consumers (via Board) speak.
 *
 * Status names disambiguate Linear's multiple `started` states ("In Progress"
 * vs "In Review"). Unmatched statuses fall back to workflow `state.type` so
 * renamed or custom columns still preserve the broad lifecycle behavior.
 *
 * Description is populated on both `fetch()` Issues and `resolveOne()` Issues.
 */

import type { AdapterContext } from "../../adapterDefinition.ts";
import {
  toCanonicalId,
  type Blocker as CanonicalBlocker,
  type CanonicalStatus,
  type Issue as CanonicalIssue,
  type MarkInReviewResult,
  type ParentSkip as CanonicalParentSkip,
  type TicketSource,
} from "../../ticketSource.ts";
import type { LinearAdapterConfig } from "./schema.ts";
import { getLinearClient, lazyLinearClient } from "./client.ts";
import {
  type Blocker as LinearBlocker,
  createBoardSource,
  fetchResolvedIssue,
  type Issue as LinearIssue,
  type ParentSkip as LinearParentSkip,
} from "./fetch.ts";
import {
  canonicalStatusFromLinearState,
  DEFAULT_LINEAR_STATUS_NAMES,
  resolveLinearStatusNames,
  type LinearStatusNames,
} from "./statusNames.ts";
import { createLinearIssueStatusUpdater } from "./writeback.ts";

/**
 * Adapter-private payload threaded through `Issue.sourceRef`. Consumers
 * MUST NOT inspect; only the Linear adapter reads it.
 */
export interface LinearSourceRef {
  uuid: string;
  statusId: string;
  teamId: string;
  /** Linear workflow `state.type` for the issue at fetch time. */
  stateType: string;
  /** Human-readable native status name, e.g. "In Progress", "Shipped". Diagnostic display only. */
  nativeStatus: string;
}

function canonicalBlockerStatus(
  blocker: LinearBlocker,
  statusNames: LinearStatusNames,
): {
  status: CanonicalStatus;
  statusReason?: "missing" | "unmapped";
  nativeStatus?: string;
} {
  const status = canonicalStatusFromLinearState({
    nativeStatus: blocker.status,
    stateType: blocker.stateType,
    statusNames,
  });
  if (status !== "other") {
    return {
      status,
      ...(blocker.status !== undefined && { nativeStatus: blocker.status }),
    };
  }
  return {
    status,
    statusReason: blocker.stateType === undefined ? "missing" : "unmapped",
    ...(blocker.status !== undefined && { nativeStatus: blocker.status }),
  };
}

function toCanonicalBlocker(
  blocker: LinearBlocker,
  sourceName: string,
  statusNames: LinearStatusNames,
): CanonicalBlocker {
  const { status, statusReason, nativeStatus } = canonicalBlockerStatus(blocker, statusNames);
  return {
    id: toCanonicalId(sourceName, blocker.id),
    title: blocker.title,
    status,
    ...(statusReason !== undefined && { statusReason }),
    ...(nativeStatus !== undefined && { nativeStatus }),
  };
}

function toCanonicalParentSkip(skip: LinearParentSkip, sourceName: string): CanonicalParentSkip {
  return {
    id: toCanonicalId(sourceName, skip.id),
    title: skip.title,
    childCount: skip.childCount,
  };
}

export function toCanonicalIssue(
  linearIssue: LinearIssue,
  sourceName: string,
  statusNames: LinearStatusNames = DEFAULT_LINEAR_STATUS_NAMES,
): CanonicalIssue {
  const sourceRef: LinearSourceRef = {
    uuid: linearIssue.uuid,
    statusId: linearIssue.statusId,
    teamId: linearIssue.teamId,
    stateType: linearIssue.stateType,
    nativeStatus: linearIssue.status,
  };
  return {
    id: toCanonicalId(sourceName, linearIssue.id),
    source: sourceName,
    title: linearIssue.title,
    description: linearIssue.description,
    status: canonicalStatusFromLinearState({
      nativeStatus: linearIssue.status,
      stateType: linearIssue.stateType,
      statusNames,
    }),
    repository: linearIssue.repository,
    model: linearIssue.model,
    assignee: linearIssue.assignee,
    updatedAt: linearIssue.updatedAt,
    blockers: linearIssue.blockers.map((b) => toCanonicalBlocker(b, sourceName, statusNames)),
    hasMoreBlockers: linearIssue.hasMoreBlockers,
    url: linearIssue.url,
    ...(linearIssue.priority === 0 ? {} : { priority: linearIssue.priority }),
    sourceRef,
  };
}

export function createLinearTicketSource(
  config: LinearAdapterConfig,
  context: AdapterContext,
): TicketSource {
  const sourceName = config.name ?? "linear";
  const statusNames = resolveLinearStatusNames(config.statuses);
  const { globalConfig } = context;
  // Lazy: deferring `getLinearClient()` (and the sub-modules that depend on
  // it) until first method use means `createLinearTicketSource` can be
  // constructed without a Linear API key in env. Callers that only ever
  // touch a sibling source — `crew doctor --ticket <shell-id>`,
  // `crew run` with the multi-source Board's `Promise.allSettled` fan-out
  // tolerating a Linear-side rejection — no longer crash at config-load
  // time on a missing key.
  const getClient = lazyLinearClient(getLinearClient);

  let cachedBoardSource: ReturnType<typeof createBoardSource> | undefined;
  function getBoardSource(): ReturnType<typeof createBoardSource> {
    cachedBoardSource ??= createBoardSource({ config: globalConfig, client: getClient() });
    return cachedBoardSource;
  }

  let cachedIssueStatusUpdater: ReturnType<typeof createLinearIssueStatusUpdater> | undefined;
  function getIssueStatusUpdater(): ReturnType<typeof createLinearIssueStatusUpdater> {
    cachedIssueStatusUpdater ??= createLinearIssueStatusUpdater({
      client: getClient(),
      statusNames,
    });
    return cachedIssueStatusUpdater;
  }

  let lastParentSkips: readonly CanonicalParentSkip[] = [];

  return {
    name: sourceName,
    async verify(): Promise<void> {
      await getBoardSource().verify();
    },
    async fetch(): Promise<CanonicalIssue[]> {
      const state = await getBoardSource().fetch();
      lastParentSkips = state.parentSkips.map((skip) => toCanonicalParentSkip(skip, sourceName));
      return state.issues.map((linearIssue) =>
        toCanonicalIssue(linearIssue, sourceName, statusNames),
      );
    },
    async fetchParentSkips(): Promise<readonly CanonicalParentSkip[]> {
      return lastParentSkips;
    },
    async resolveOne(naturalId: string): Promise<CanonicalIssue | undefined> {
      const resolved = await fetchResolvedIssue({
        client: getClient(),
        config: globalConfig,
        ticket: naturalId,
      });
      const sourceRef: LinearSourceRef = {
        uuid: resolved.uuid,
        statusId: resolved.statusId,
        teamId: resolved.teamId,
        stateType: resolved.stateType,
        nativeStatus: resolved.status,
      };
      return {
        id: toCanonicalId(sourceName, naturalId),
        source: sourceName,
        title: resolved.title,
        description: resolved.description,
        status: canonicalStatusFromLinearState({
          nativeStatus: resolved.status,
          stateType: resolved.stateType,
          statusNames,
        }),
        repository: resolved.repository,
        model: resolved.model,
        assignee: "Unassigned",
        updatedAt: new Date().toISOString(),
        blockers: [],
        hasMoreBlockers: false,
        url: resolved.url,
        sourceRef,
      };
    },
    async markInProgress(issue: CanonicalIssue): Promise<void> {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- by the Linear adapter's contract, every Issue it produces carries a LinearSourceRef in sourceRef
      const ref = issue.sourceRef as LinearSourceRef;
      await getIssueStatusUpdater().markInProgress({
        id: issue.id,
        uuid: ref.uuid,
        teamId: ref.teamId,
      });
    },
    async markInReview(issue: CanonicalIssue): Promise<MarkInReviewResult> {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- by the Linear adapter's contract, every Issue it produces carries a LinearSourceRef in sourceRef
      const ref = issue.sourceRef as LinearSourceRef;
      return await getIssueStatusUpdater().markInReview({
        id: issue.id,
        uuid: ref.uuid,
        teamId: ref.teamId,
      });
    },
  };
}
