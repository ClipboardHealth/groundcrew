/**
 * Batched GitHub PR detail lookup for `pr-stage-sync`: one GraphQL call per
 * tick covers every tracked PR, each resolved through an aliased
 * `resource(url:)` field with the url passed as a `URI!` variable (never
 * interpolated into the query body). Mirrors the standalone
 * `crew-pr-stages` poller's single-batch query shape.
 */

import { runCommandAsync } from "./commandRunner.ts";
import type {
  PrStageInput,
  PullRequestLifecycleState,
  PullRequestReviewDecision,
} from "./prStageRules.ts";

export type PullRequestDetail = PrStageInput & { url: string };

interface FetchPullRequestDetailsArgs {
  urls: readonly string[];
  signal?: AbortSignal;
  timeoutMs?: number;
}

const DEFAULT_GRAPHQL_TIMEOUT_MS = 60_000;

function resourceAlias(index: number): string {
  return `p${index}`;
}

function variableName(index: number): string {
  return `u${index}`;
}

function buildQuery(urls: readonly string[]): string {
  const variableDefs = urls.map((_, index) => `$${variableName(index)}:URI!`).join(",");
  const resources = urls
    .map(
      (_, index) =>
        `${resourceAlias(index)}: resource(url: $${variableName(index)}) { ... on PullRequest { url state isDraft reviewDecision labels(first:20){nodes{name}} commits(last:1){nodes{commit{statusCheckRollup{state}}}} } }`,
    )
    .join(" ");
  return `query(${variableDefs}){${resources} }`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isLifecycleState(value: unknown): value is PullRequestLifecycleState {
  return value === "OPEN" || value === "CLOSED" || value === "MERGED";
}

function isReviewDecision(value: unknown): value is PullRequestReviewDecision {
  return (
    value === null ||
    value === "APPROVED" ||
    value === "CHANGES_REQUESTED" ||
    value === "REVIEW_REQUIRED"
  );
}

function parseLabels(node: Record<string, unknown>): string[] {
  const labelsNode = node["labels"];
  const nodes: unknown[] =
    isRecord(labelsNode) && Array.isArray(labelsNode["nodes"]) ? labelsNode["nodes"] : [];
  const names: string[] = [];
  for (const entry of nodes) {
    const name = isRecord(entry) ? entry["name"] : undefined;
    if (typeof name === "string") {
      names.push(name);
    }
  }
  return names;
}

function parseChecks(node: Record<string, unknown>): string | null {
  const commitsNode = node["commits"];
  const commitNodes: unknown[] =
    isRecord(commitsNode) && Array.isArray(commitsNode["nodes"]) ? commitsNode["nodes"] : [];
  const firstCommit = commitNodes[0];
  if (!isRecord(firstCommit)) {
    return null;
  }
  const commit = firstCommit["commit"];
  if (!isRecord(commit)) {
    return null;
  }
  const rollup = commit["statusCheckRollup"];
  const state = isRecord(rollup) ? rollup["state"] : undefined;
  return typeof state === "string" ? state : null;
}

function parsePullRequestDetail(node: unknown): PullRequestDetail | undefined {
  if (!isRecord(node)) {
    return undefined;
  }
  const { url, state, isDraft } = node;
  if (typeof url !== "string" || !isLifecycleState(state) || typeof isDraft !== "boolean") {
    return undefined;
  }
  const reviewDecision = node["reviewDecision"];
  return {
    url,
    state,
    isDraft,
    labels: parseLabels(node),
    reviewDecision: isReviewDecision(reviewDecision) ? reviewDecision : null,
    checks: parseChecks(node),
  };
}

/**
 * Resolves every url to its detail, or to `undefined` when the GraphQL
 * response has no matching resource (deleted, inaccessible, or not a PR).
 * Throws only when the whole batch failed (gh missing, unauthenticated,
 * network error, malformed response) — callers treat that as "couldn't
 * refresh this tick", never as "no PRs".
 */
export async function fetchPullRequestDetails(
  args: FetchPullRequestDetailsArgs,
): Promise<Map<string, PullRequestDetail | undefined>> {
  const { urls, signal, timeoutMs } = args;
  const result = new Map<string, PullRequestDetail | undefined>();
  if (urls.length === 0) {
    return result;
  }

  const ghArguments = ["api", "graphql"];
  urls.forEach((url, index) => {
    ghArguments.push("-f", `${variableName(index)}=${url}`);
  });
  ghArguments.push("-f", `query=${buildQuery(urls)}`);

  const output = await runCommandAsync("gh", ghArguments, {
    timeoutMs: timeoutMs ?? DEFAULT_GRAPHQL_TIMEOUT_MS,
    ...(signal === undefined ? {} : { signal }),
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    throw new Error("gh api graphql returned non-JSON output", { cause: error });
  }
  const data = isRecord(parsed) && isRecord(parsed["data"]) ? parsed["data"] : {};
  urls.forEach((url, index) => {
    result.set(url, parsePullRequestDetail(data[resourceAlias(index)]));
  });
  return result;
}
