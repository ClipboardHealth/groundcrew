import type { LinearSourceRef } from "../adapters/linear/index.ts";
import { type Blocker, type Issue, toCanonicalId } from "../taskSource.ts";

export function canonicalLinearIssue(overrides: Partial<Issue> & { naturalId: string }): Issue {
  const { naturalId, sourceRef: refOverride, ...rest } = overrides;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test fixture; sourceRef is opaque unknown in the Issue contract; we reinterpret it here only for fixture construction
  const refPartial = (refOverride as Partial<LinearSourceRef> | undefined) ?? {};
  const sourceRef: LinearSourceRef = {
    uuid: refPartial.uuid ?? `uuid-${naturalId}`,
    statusId: refPartial.statusId ?? "statusId-default",
    teamId: refPartial.teamId ?? "team-default",
    stateType: refPartial.stateType ?? "unstarted",
    nativeStatus: refPartial.nativeStatus ?? "Todo",
  };
  return {
    id: toCanonicalId("linear", naturalId),
    source: "linear",
    title: `Title for ${naturalId}`,
    description: "",
    status: "todo",
    repository: undefined,
    agent: undefined,
    assignee: "Unassigned",
    updatedAt: "2026-01-01T00:00:00.000Z",
    blockers: [],
    hasMoreBlockers: false,
    ...rest,
    sourceRef,
  };
}

export function canonicalBlocker(overrides: Partial<Blocker> & { naturalId: string }): Blocker {
  const { naturalId, ...rest } = overrides;
  return {
    id: toCanonicalId("linear", naturalId),
    title: `Title for ${naturalId}`,
    status: "todo",
    ...rest,
  };
}

/**
 * Canonical Issue fixture for a non-Linear source. Default source name is
 * "shell-test"; override via `sourceName`. Mirrors `canonicalLinearIssue`'s
 * defaults except `sourceRef` is an empty opaque object (no LinearSourceRef
 * shape, since this is meant to stand in for any non-Linear adapter — the
 * shell adapter, future Jira adapter, etc.).
 */
export function canonicalShellIssue(
  overrides: Partial<Issue> & { naturalId: string; sourceName?: string },
): Issue {
  const { naturalId, sourceName = "shell-test", sourceRef, ...rest } = overrides;
  return {
    id: toCanonicalId(sourceName, naturalId),
    source: sourceName,
    title: `Title for ${naturalId}`,
    description: "",
    status: "todo",
    repository: undefined,
    agent: undefined,
    assignee: "Unassigned",
    updatedAt: "2026-01-01T00:00:00.000Z",
    blockers: [],
    hasMoreBlockers: false,
    sourceRef: sourceRef ?? {},
    ...rest,
  };
}
