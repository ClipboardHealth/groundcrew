import type { CanonicalStatus } from "../../taskSource.ts";
import type { LinearAdapterConfig } from "./schema.ts";

export interface LinearStatusNames {
  inProgress: readonly string[];
  inReview: readonly string[];
}

export interface LinearWorkflowState {
  id: string;
  name: string;
  type: string;
  position: number;
}

export const DEFAULT_LINEAR_STATUS_NAMES = {
  inProgress: ["In Progress"],
  inReview: ["In Review"],
} as const satisfies LinearStatusNames;

export function resolveLinearStatusNames(
  config: LinearAdapterConfig["statuses"] | undefined,
): LinearStatusNames {
  return {
    inProgress: config?.inProgress ?? DEFAULT_LINEAR_STATUS_NAMES.inProgress,
    inReview: config?.inReview ?? DEFAULT_LINEAR_STATUS_NAMES.inReview,
  };
}

export function canonicalStatusFromLinearState(arguments_: {
  nativeStatus: string | undefined;
  stateType: string | undefined;
  statusNames: LinearStatusNames;
}): CanonicalStatus {
  const { nativeStatus, stateType, statusNames } = arguments_;
  if (stateType === "started") {
    if (matchesLinearStatusName(nativeStatus, statusNames.inReview)) {
      return "in-review";
    }
    if (matchesLinearStatusName(nativeStatus, statusNames.inProgress)) {
      return "in-progress";
    }
  }
  return canonicalStatusFromStateType(stateType);
}

export function findLinearWorkflowStateByName(
  states: readonly LinearWorkflowState[],
  names: readonly string[],
): LinearWorkflowState | undefined {
  return states.find((state) => matchesLinearStatusName(state.name, names));
}

export function formatLinearStatusNames(names: readonly string[]): string {
  return names.map((name) => `"${name}"`).join(" or ");
}

function canonicalStatusFromStateType(stateType: string | undefined): CanonicalStatus {
  /* v8 ignore next 3 @preserve -- LinearIssue.stateType is non-optional; this guard is defensive for the resolveOne path */
  if (stateType === undefined) {
    return "other";
  }
  switch (stateType) {
    case "unstarted": {
      return "todo";
    }
    case "started": {
      return "in-progress";
    }
    case "completed":
    case "canceled":
    case "duplicate": {
      return "done";
    }
    default: {
      return "other";
    }
  }
}

function matchesLinearStatusName(
  nativeStatus: string | undefined,
  configuredNames: readonly string[],
): boolean {
  if (nativeStatus === undefined) {
    return false;
  }
  const normalizedStatus = normalizeStatusName(nativeStatus);
  return configuredNames.some((name) => normalizeStatusName(name) === normalizedStatus);
}

function normalizeStatusName(name: string): string {
  return name.trim().toLowerCase();
}
