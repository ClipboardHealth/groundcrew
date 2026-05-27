/**
 * Best-effort lookup of GitHub pull requests for a worktree branch via the
 * `gh` CLI. `crew status` uses this to surface PR links inline; failures
 * (gh not on PATH, not authenticated, non-GitHub remote) are silent — the
 * caller falls back to omitting the row.
 */

import { runCommandAsync } from "./commandRunner.ts";

export interface PullRequestSummary {
  url: string;
  number: number;
  /** Lowercased lifecycle: "open" | "merged" | "closed". */
  state: string;
  title: string;
}

const GH_PR_LIST_LIMIT = 5;
const STATE_MAP: Record<string, string> = {
  OPEN: "open",
  MERGED: "merged",
  CLOSED: "closed",
};

interface LookupArgs {
  /** GitHub `owner/repo` slug. */
  repository: string;
  /** Branch name to filter PRs by. */
  branchName: string;
  signal?: AbortSignal;
}

interface RawPullRequest {
  url: string;
  number: number;
  state: string;
  title: string;
}

function parsePullRequests(output: string): PullRequestSummary[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const summaries: PullRequestSummary[] = [];
  for (const entry of parsed) {
    if (!isRawPullRequest(entry)) {
      continue;
    }
    summaries.push({
      url: entry.url,
      number: entry.number,
      state: STATE_MAP[entry.state] ?? entry.state.toLowerCase(),
      title: entry.title,
    });
  }
  return summaries;
}

function isRawPullRequest(value: unknown): value is RawPullRequest {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- narrowing untyped JSON.parse output to a record so we can probe its keys
  const record = value as Record<string, unknown>;
  return (
    typeof record["url"] === "string" &&
    typeof record["number"] === "number" &&
    typeof record["state"] === "string" &&
    typeof record["title"] === "string"
  );
}

export async function findPullRequestsForBranch(
  arguments_: LookupArgs,
): Promise<readonly PullRequestSummary[]> {
  const { repository, branchName, signal } = arguments_;
  try {
    const output = await runCommandAsync(
      "gh",
      [
        "pr",
        "list",
        "--repo",
        repository,
        "--head",
        branchName,
        "--state",
        "all",
        "--limit",
        String(GH_PR_LIST_LIMIT),
        "--json",
        "url,number,state,title",
      ],
      signal === undefined ? {} : { signal },
    );
    return parsePullRequests(output);
  } catch {
    // gh not installed / not authenticated / non-GitHub remote / network
    // error / etc. All resolve to "no PR info available" for display.
    return [];
  }
}
