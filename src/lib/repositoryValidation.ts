/**
 * Host-level repository validation for canonical Issues. Adapters produce
 * Issue.repository based on their own signal (Linear: agent-* label parse;
 * shell: script JSON output). The host (dispatcher) decides whether that
 * repository is configured for this crew via workspace.knownRepositories.
 *
 * WARN+skip on unknown repo is a deliberate behavior choice (P-refined in
 * the MVP-2 plan): one badly-labelled task should not throw and abort
 * the tick across N sources.
 */

import type { Issue } from "./taskSource.ts";

export function dispatchableRepository(
  issue: Issue,
  knownRepositories: readonly string[],
  log: (message: string) => void,
): string | undefined {
  if (issue.repository === undefined) {
    return undefined;
  }
  if (!knownRepositories.includes(issue.repository)) {
    log(
      `issue ${issue.id} references unknown repository ${issue.repository}; configured workspace.knownRepositories: ${knownRepositories.join(", ") || "(none)"}`,
    );
    return undefined;
  }
  return issue.repository;
}
