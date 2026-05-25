/**
 * Linear `TicketSource` factory. Wraps the existing boardSource.ts machinery
 * (createBoardSource, fetchResolvedIssue, createLinearIssueStatusUpdater) and
 * converts the legacy Linear-specific `Issue`/`Blocker` shapes into the
 * canonical `Issue`/`Blocker` shapes consumers (via `Board`) speak.
 *
 * Per-project canonical-status mapping lives here: each `Issue` is mapped
 * against its own project's `statuses` block (the multi-project semantics
 * shipped in PR #75). Off-config blockers fall back to the union of all
 * configured projects' status sets — preserving today's
 * `isTerminalStatusForBlocker` behavior.
 *
 * Description is not populated on `fetch()` Issues (boardSource's snapshot
 * doesn't include it); `resolveOne()` Issues carry the full description
 * because `fetchResolvedIssue` fetches it explicitly. Phase 6 can lift
 * description onto the board snapshot when it refactors setupWorkspace.
 */

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
  // Terminal first — handles off-config blockers via the union fallback that
  // isTerminalStatusForBlocker already implements.
  if (isTerminalStatusForBlocker(blocker, globalConfig)) {
    return "done";
  }
  // Non-terminal: if the blocker's project is configured, use its statuses to
  // distinguish todo vs in-progress. For off-config blockers we collapse to
  // "other" — eligibility only cares whether the blocker is terminal, so the
  // distinction is informational at most.
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
      viewSlug: view.viewSlug,
      viewSlugId: view.slugId,
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
      // fetchResolvedIssue throws on unknown project / missing repo; we let
      // those propagate. Returning `undefined` is reserved for "ticket genuinely
      // doesn't exist," which fetchResolvedIssue surfaces as an Error too —
      // for now we let any error bubble up rather than swallow.
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
      // fetchResolvedIssue doesn't return the native status name (it's
      // already been resolved through workflow state lookup). We surface
      // "other" until the consumer needs the canonical status, which is fine
      // because `crew setup` doesn't branch on it.
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
