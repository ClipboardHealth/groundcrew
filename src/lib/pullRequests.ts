/**
 * Best-effort lookup of GitHub pull requests for a worktree branch via the
 * `gh` CLI. `crew status` uses this to surface PR links inline; failures
 * (gh not on PATH, not authenticated, non-GitHub remote) are silent — the
 * caller falls back to omitting the row.
 *
 * The lookup runs with `cwd` set to the worktree directory and lets `gh`
 * resolve the GitHub repo from that checkout's own `origin` remote. This
 * handles bare config names, full `owner/repo` slugs, forks, and SSH/HTTPS
 * remotes uniformly — we never reconstruct the slug ourselves.
 */

import { runCommandAsync } from "./commandRunner.ts";

export interface PullRequestSummary {
  url: string;
  number: number;
  /** Lowercased lifecycle: "open" | "merged" | "closed". */
  state: string;
  title: string;
  /** PR head commit SHA used to ignore historical PRs from reused branch names. */
  headRefOid: string;
}

const GH_PR_LIST_LIMIT = 5;
const STATE_MAP: Record<string, string> = {
  OPEN: "open",
  MERGED: "merged",
  CLOSED: "closed",
};

interface LookupArgs {
  /** Worktree directory; `gh` resolves the GitHub repo from its git remote. */
  cwd: string;
  /** Branch name to filter PRs by. */
  branchName: string;
  signal?: AbortSignal;
}

interface RawPullRequest {
  url: string;
  number: number;
  state: string;
  title: string;
  headRefOid: string;
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
      headRefOid: entry.headRefOid,
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
    typeof record["title"] === "string" &&
    typeof record["headRefOid"] === "string"
  );
}

export async function findPullRequestsForBranch(
  arguments_: LookupArgs,
): Promise<readonly PullRequestSummary[]> {
  const { cwd, branchName, signal } = arguments_;
  const options = signal === undefined ? { cwd } : { cwd, signal };
  try {
    const [output, currentHeadOid] = await Promise.all([
      runCommandAsync(
        "gh",
        [
          "pr",
          "list",
          "--head",
          branchName,
          "--state",
          "all",
          "--limit",
          String(GH_PR_LIST_LIMIT),
          "--json",
          "url,number,state,title,headRefOid",
        ],
        options,
      ),
      runCommandAsync("git", ["rev-parse", "HEAD"], options),
    ]);
    return parsePullRequests(output).filter((pr) => pr.headRefOid === currentHeadOid);
  } catch {
    // gh/git not installed / not authenticated / non-GitHub remote / network
    // error / etc. All resolve to "no PR info available" for display.
    return [];
  }
}
