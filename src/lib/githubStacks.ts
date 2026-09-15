/**
 * Client for GitHub's stacked-pull-request REST API (public preview), the
 * thing behind the "Create stack" button. A stack is what makes GitHub itself
 * rebase and retarget the pull requests above one that merges, so a child
 * registered here needs no local rebase or force-push when its parent lands.
 *
 * Every call goes through `gh api` with the worktree as `cwd`, which supplies
 * auth and resolves `{owner}/{repo}` from that checkout's own remote, so a bare
 * config repository name works the same as a full slug. A repository whose
 * organisation has the preview off answers 404, so `listStacks` reports itself
 * unavailable rather than returning an empty list — the caller falls back to
 * the local retarget path instead of trying to create a stack every tick.
 */

import { runCommandAsync } from "./commandRunner.ts";
import { debug, errorMessage, isRecord } from "./util.ts";

const STACKS_API_VERSION = "2026-03-10";

export interface GitHubStack {
  number: number;
  open: boolean;
  pullRequests: readonly number[];
}

export type RunGhApi = (arguments_: {
  cwd: string;
  args: readonly string[];
  signal?: AbortSignal;
}) => Promise<string>;

const runGhApiCommand: RunGhApi = async ({ cwd, args, signal }) =>
  await runCommandAsync("gh", args, { cwd, ...(signal === undefined ? {} : { signal }) });

interface RepositoryCall {
  cwd: string;
  repository: string;
  signal?: AbortSignal;
}

export interface StackListing {
  /** False when the stacks API answered with an error: the preview is off for the repository, or the token cannot see it. */
  available: boolean;
  stacks: readonly GitHubStack[];
}

export interface StacksClient {
  listStacks: (arguments_: RepositoryCall) => Promise<StackListing>;
  /** Creates a stack from `pullRequests`, ordered bottom to top. */
  createStack: (
    arguments_: RepositoryCall & { pullRequests: readonly number[] },
  ) => Promise<boolean>;
  /** Appends `pullRequests` to the top of an existing stack. */
  addToStack: (
    arguments_: RepositoryCall & { stackNumber: number; pullRequests: readonly number[] },
  ) => Promise<boolean>;
}

function apiArguments(path: string, rest: readonly string[] = []): readonly string[] {
  return ["api", "-H", `X-GitHub-Api-Version: ${STACKS_API_VERSION}`, path, ...rest];
}

function pullRequestFields(pullRequests: readonly number[]): readonly string[] {
  return pullRequests.flatMap((number) => ["-F", `pull_requests[]=${number}`]);
}

function parseStacks(output: string): readonly GitHubStack[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const stacks: GitHubStack[] = [];
  for (const entry of parsed) {
    const stack = toStack(entry);
    if (stack !== undefined) {
      stacks.push(stack);
    }
  }
  return stacks;
}

function toStack(value: unknown): GitHubStack | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const { number: stackNumber, open, pull_requests: rawPullRequests } = value;
  if (typeof stackNumber !== "number" || !Array.isArray(rawPullRequests)) {
    return undefined;
  }
  const pullRequests: number[] = [];
  for (const entry of rawPullRequests) {
    const pullRequestNumber = pullRequestNumberOf(entry);
    if (pullRequestNumber !== undefined) {
      pullRequests.push(pullRequestNumber);
    }
  }
  return { number: stackNumber, open: open !== false, pullRequests };
}

function pullRequestNumberOf(value: unknown): number | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return typeof value["number"] === "number" ? value["number"] : undefined;
}

export function createStacksClient(runGhApi: RunGhApi = runGhApiCommand): StacksClient {
  async function post(
    arguments_: RepositoryCall & { path: string; pullRequests: readonly number[] },
  ): Promise<boolean> {
    const { cwd, path, pullRequests, signal } = arguments_;
    try {
      await runGhApi({
        cwd,
        args: apiArguments(path, ["--method", "POST", ...pullRequestFields(pullRequests)]),
        ...(signal === undefined ? {} : { signal }),
      });
      return true;
    } catch (error) {
      debug(`GitHub stacks API POST of ${path} failed: ${errorMessage(error)}`);
      return false;
    }
  }

  return {
    listStacks: async ({ cwd, repository, signal }) => {
      try {
        const output = await runGhApi({
          cwd,
          args: apiArguments("repos/{owner}/{repo}/stacks"),
          ...(signal === undefined ? {} : { signal }),
        });
        return { available: true, stacks: parseStacks(output) };
      } catch (error) {
        debug(`GitHub stacks listing failed for ${repository}: ${errorMessage(error)}`);
        return { available: false, stacks: [] };
      }
    },
    createStack: async ({ cwd, repository, pullRequests, signal }) =>
      await post({
        cwd,
        repository,
        path: "repos/{owner}/{repo}/stacks",
        pullRequests,
        ...(signal === undefined ? {} : { signal }),
      }),
    addToStack: async ({ cwd, repository, stackNumber, pullRequests, signal }) =>
      await post({
        cwd,
        repository,
        path: `repos/{owner}/{repo}/stacks/${stackNumber}/add`,
        pullRequests,
        ...(signal === undefined ? {} : { signal }),
      }),
  };
}
