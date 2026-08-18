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
 *
 * Whatever GitHub returns is returned verbatim. We do not filter by commit
 * history: the branch name on the remote (which `gh pr list --head` matches)
 * is already a strong identifier for "the PR(s) for this checkout". Stale
 * PRs from a long-dead branch with a reused name surface as `(merged)` or
 * `(closed)` in the status output, which is more informative than silently
 * dropping them. Decision-making callers (e.g. `crew task done`) filter by
 * lifecycle state instead.
 */

import { runCommandAsync } from "./commandRunner.ts";
import { errorMessage } from "./util.ts";

export interface PullRequestSummary {
  url: string;
  number: number;
  /** Lowercased lifecycle: "open" | "merged" | "closed". */
  state: string;
  title: string;
}

const PULL_REQUEST_PROBE_PROBLEMS = new WeakMap<readonly PullRequestSummary[], string>();

export interface PullRequestProbeProblemInput {
  pullRequests: readonly PullRequestSummary[];
}

export interface PullRequestProbeProblemResult {
  message?: string | undefined;
}

/**
 * Returns the command failure hidden by the best-effort PR lookup. Status uses
 * this to distinguish "no pull requests" from "GitHub could not be probed"
 * without changing the lookup's long-standing never-throw contract.
 */
export function pullRequestProbeProblem(
  input: PullRequestProbeProblemInput,
): PullRequestProbeProblemResult {
  return { message: PULL_REQUEST_PROBE_PROBLEMS.get(input.pullRequests) };
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
}

interface ParsePullRequestsResult {
  pullRequests: PullRequestSummary[];
  problem?: string | undefined;
}

function parsePullRequests(output: string): ParsePullRequestsResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return {
      pullRequests: [],
      problem: "Unexpected non-JSON response from 'gh pr list'.",
    };
  }
  if (!Array.isArray(parsed)) {
    return {
      pullRequests: [],
      problem: "Unexpected response shape from 'gh pr list'.",
    };
  }
  const summaries: PullRequestSummary[] = [];
  let hasInvalidEntry = false;
  for (const entry of parsed) {
    if (!isRawPullRequest(entry)) {
      hasInvalidEntry = true;
      continue;
    }
    summaries.push({
      url: entry.url,
      number: entry.number,
      state: STATE_MAP[entry.state] ?? entry.state.toLowerCase(),
      title: entry.title,
    });
  }
  return {
    pullRequests: summaries,
    ...(hasInvalidEntry
      ? { problem: "Some pull requests from 'gh pr list' had an unexpected shape." }
      : {}),
  };
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

export interface ResolvedPullRequest {
  number: number;
  /** Head branch name the PR is built from (`headRefName`). */
  branch: string;
  title: string;
  url: string;
  /** Lowercased lifecycle: "open" | "merged" | "closed". */
  state: string;
  /** True when the head branch lives on a fork rather than the base repo. */
  isCrossRepository: boolean;
}

interface ResolvePullRequestArgs {
  /** Clone directory used as `gh`'s cwd so it resolves the GitHub repo from its remote. */
  repoDir: string;
  /** PR number or URL accepted by `gh pr view`. */
  pr: string;
  signal?: AbortSignal;
}

interface RawResolvedPullRequest {
  number: number;
  headRefName: string;
  title: string;
  url: string;
  state: string;
  isCrossRepository: boolean;
}

function isRawResolvedPullRequest(value: unknown): value is RawResolvedPullRequest {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- narrowing untyped JSON.parse output to a record so we can probe its keys
  const record = value as Record<string, unknown>;
  return (
    typeof record["number"] === "number" &&
    typeof record["headRefName"] === "string" &&
    typeof record["title"] === "string" &&
    typeof record["url"] === "string" &&
    typeof record["state"] === "string" &&
    typeof record["isCrossRepository"] === "boolean"
  );
}

/**
 * Resolve a single pull request to the metadata `crew open` needs (head branch,
 * title, url, fork flag) via `gh pr view`. Unlike `findPullRequestsForBranch`,
 * the caller named a specific PR, so failures are fatal: a missing `gh`, an
 * unauthenticated host, or an unknown PR all throw with a clear message rather
 * than degrading to "no PR info".
 */
export async function resolvePullRequest(
  arguments_: ResolvePullRequestArgs,
): Promise<ResolvedPullRequest> {
  const { repoDir, pr, signal } = arguments_;
  const options = signal === undefined ? { cwd: repoDir } : { cwd: repoDir, signal };
  let output: string;
  try {
    output = await runCommandAsync(
      "gh",
      ["pr", "view", pr, "--json", "number,headRefName,title,url,state,isCrossRepository"],
      options,
    );
  } catch (error) {
    if (signal?.aborted === true) {
      throw error;
    }
    throw new Error(
      `Could not look up pull request ${pr} from ${repoDir}. Ensure 'gh' is installed and authenticated (gh auth status) and the PR exists.`,
      { cause: error },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    throw new Error(`Unexpected non-JSON response from 'gh pr view' for ${pr} from ${repoDir}.`, {
      cause: error,
    });
  }
  if (!isRawResolvedPullRequest(parsed)) {
    throw new Error(`Unexpected response shape from 'gh pr view' for ${pr} from ${repoDir}.`);
  }
  return {
    number: parsed.number,
    branch: parsed.headRefName,
    title: parsed.title,
    url: parsed.url,
    state: STATE_MAP[parsed.state] ?? parsed.state.toLowerCase(),
    isCrossRepository: parsed.isCrossRepository,
  };
}

export async function findPullRequestsForBranch(
  arguments_: LookupArgs,
): Promise<readonly PullRequestSummary[]> {
  const { cwd, branchName, signal } = arguments_;
  const options = signal === undefined ? { cwd } : { cwd, signal };
  try {
    const output = await runCommandAsync(
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
        "url,number,state,title",
      ],
      options,
    );
    const parsed = parsePullRequests(output);
    if (parsed.problem !== undefined) {
      PULL_REQUEST_PROBE_PROBLEMS.set(parsed.pullRequests, parsed.problem);
    }
    return parsed.pullRequests;
  } catch (error) {
    if (signal?.aborted === true) {
      throw error;
    }
    // gh not installed / not authenticated / non-GitHub remote / network
    // error / etc. All resolve to "no PR info available" for legacy callers;
    // status can still expose the failure through pullRequestProbeProblem.
    const pullRequests: PullRequestSummary[] = [];
    PULL_REQUEST_PROBE_PROBLEMS.set(pullRequests, errorMessage(error));
    return pullRequests;
  }
}
