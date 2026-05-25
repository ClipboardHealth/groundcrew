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
