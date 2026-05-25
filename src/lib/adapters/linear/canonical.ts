/**
 * Shared canonical-issue builders for the Linear adapter. Used by both
 * project-mode (`factory.ts`) and view-mode (`viewSource.ts`) so the
 * `TicketSource` shape stays in lockstep across modes — only the
 * canonical-status mapping and resolved-metadata source differ.
 */

import type { Issue as LinearIssue } from "../../boardSource.ts";
import type {
  Blocker as CanonicalBlocker,
  CanonicalStatus,
  Issue as CanonicalIssue,
} from "../../ticketSource.ts";

export interface LinearSourceRef {
  uuid: string;
  statusId: string;
  teamId: string;
  projectSlugId: string;
  nativeStatus: string;
}

/**
 * Build the canonical `Issue` returned from a Linear adapter `fetch()`.
 * Shared by project mode and view mode so they emit the same shape; only
 * the canonical-status mapping differs.
 */
export function buildLinearCanonicalIssue(arguments_: {
  linearIssue: LinearIssue;
  sourceName: string;
  status: CanonicalStatus;
  blockers: CanonicalBlocker[];
}): CanonicalIssue {
  const { linearIssue, sourceName, status, blockers } = arguments_;
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
    // Board snapshot doesn't carry description; resolveOne() populates it.
    description: "",
    status,
    repository: linearIssue.repository,
    model: linearIssue.model,
    assignee: linearIssue.assignee,
    updatedAt: linearIssue.updatedAt,
    blockers,
    hasMoreBlockers: linearIssue.hasMoreBlockers,
    sourceRef,
  };
}

/**
 * Build the canonical `Issue` returned from a Linear adapter `resolveOne()`.
 * Shared by project mode and view mode. `description` is populated from
 * the resolved metadata; `status` defaults to `"other"` until the consumer
 * needs the canonical status (currently no caller branches on it).
 */
export interface ResolvedLinearIssueShape {
  uuid: string;
  title: string;
  description: string;
  repository: string;
  model: string;
  teamId: string;
  projectSlugId: string;
}

export function buildResolvedLinearCanonicalIssue(arguments_: {
  sourceName: string;
  ticketIdentifier: string;
  resolved: ResolvedLinearIssueShape;
}): CanonicalIssue {
  const { sourceName, ticketIdentifier, resolved } = arguments_;
  const sourceRef: LinearSourceRef = {
    uuid: resolved.uuid,
    statusId: "",
    teamId: resolved.teamId,
    projectSlugId: resolved.projectSlugId,
    nativeStatus: "",
  };
  return {
    id: `${sourceName}:${ticketIdentifier.toLowerCase()}`,
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
}
