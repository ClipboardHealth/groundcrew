/**
 * Provisioning: create a task workspace of worktrees. Two entry points share one
 * mechanism (design §4) — `provisionWorkspace` (dispatch-time, whole designation)
 * and `acquireWorktree` (also `crew repo add` at runtime).
 */

import * as fs from "node:fs";
import path from "node:path";

import type { Logger } from "../logging/index.js";
import { RepoNotOnDiskError } from "./errors.js";
import { addWorktree, isDirectory, localBranchExists, resolveStartPoint } from "./git.js";
import { runPrepareWorktree } from "./hooks.js";
import { taskBranch } from "./identity.js";
import { addRepoToMarker, writeMarker } from "./marker.js";
import {
  branchPrefixOf,
  clonePath,
  defaultBranchOf,
  markerFilePath,
  remoteOf,
  worktreePath,
  workspacePath,
  type WorkspaceConfig,
} from "./paths.js";

const MODULE = "workspace";

export interface ProvisionResult {
  readonly workspaceDirectory: string;
  readonly branch: string;
  readonly repos: readonly string[];
}

export interface AcquireResult {
  readonly worktreePath: string;
  readonly branch: string;
  /** True when the worktree already existed and was not re-created. */
  readonly reused: boolean;
}

/**
 * Provisions the workspace for a task: gate the whole designation first, then
 * create the workspace directory, write the marker, and acquire each worktree.
 *
 * Repo gate FIRST (MULTI-02): if ANY designated repo is not a directory under
 * the base directory, throw `RepoNotOnDiskError` and provision NOTHING. An empty
 * designation yields an empty workspace (a marker with `repos: []`).
 */
export async function provisionWorkspace(input: {
  readonly config: WorkspaceConfig;
  readonly taskId: string;
  readonly repos?: readonly string[];
  readonly logger?: Logger;
}): Promise<ProvisionResult> {
  const { config, taskId } = input;
  const repos = input.repos ?? [];

  for (const repo of repos) {
    if (!isDirectory({ directory: clonePath({ config, repo }) })) {
      throw new RepoNotOnDiskError({ repo, baseDirectory: config.baseDirectory });
    }
  }

  const workspaceDirectory = workspacePath({ config, taskId });
  const branch = taskBranch({ taskId, branchPrefix: branchPrefixOf({ config }) });

  fs.mkdirSync(path.dirname(markerFilePath({ workspaceDirectory })), { recursive: true });
  writeMarker({
    workspaceDirectory,
    marker: { version: 1, taskId, branch, repos: [] },
  });
  input.logger?.log({
    level: "info",
    module: MODULE,
    event: "workspace_provisioned",
    taskId,
    msg: `provisioned workspace ${workspaceDirectory}`,
  });

  for (const repo of repos) {
    // eslint-disable-next-line no-await-in-loop -- git worktree adds must be ordered against one clone at a time
    await acquireWorktree({ config, taskId, repo, ...forwardLogger(input.logger) });
  }

  return { workspaceDirectory, branch, repos: [...repos].toSorted() };
}

/**
 * Acquires one repo's worktree onto the uniform task branch. Reuses the branch
 * when it already exists (prior commits preserved, DISPATCH-08), else creates it
 * from the resolved start point. Runs the repo's `prepareWorktree` hook (cwd =
 * the new worktree) and records the repo in the marker. Idempotent: an existing
 * worktree is left in place, only the marker is reconciled.
 */
export async function acquireWorktree(input: {
  readonly config: WorkspaceConfig;
  readonly taskId: string;
  readonly repo: string;
  readonly logger?: Logger;
}): Promise<AcquireResult> {
  const { config, taskId, repo } = input;
  const cloneDirectory = clonePath({ config, repo });
  if (!isDirectory({ directory: cloneDirectory })) {
    throw new RepoNotOnDiskError({ repo, baseDirectory: config.baseDirectory });
  }

  const workspaceDirectory = workspacePath({ config, taskId });
  const worktree = worktreePath({ config, taskId, repo });
  const branch = taskBranch({ taskId, branchPrefix: branchPrefixOf({ config }) });

  if (fs.existsSync(worktree)) {
    addRepoToMarker({ workspaceDirectory, taskId, branch, repo });
    return { worktreePath: worktree, branch, reused: true };
  }

  if (await localBranchExists({ repoDirectory: cloneDirectory, branch })) {
    await addWorktree({ repoDirectory: cloneDirectory, worktreePath: worktree, branch });
  } else {
    const startPoint = await resolveStartPoint({
      repoDirectory: cloneDirectory,
      remote: remoteOf({ config }),
      defaultBranch: defaultBranchOf({ config }),
    });
    await addWorktree({ repoDirectory: cloneDirectory, worktreePath: worktree, branch, startPoint });
  }

  await runPrepareWorktree({
    worktreeDirectory: worktree,
    repo,
    ...(config.repositories?.[repo]?.prepareWorktree === undefined
      ? {}
      : { perRepoHook: config.repositories[repo]?.prepareWorktree }),
  });

  addRepoToMarker({ workspaceDirectory, taskId, branch, repo });
  input.logger?.log({
    level: "info",
    module: MODULE,
    event: "worktree_acquired",
    taskId,
    repo,
    msg: `acquired worktree ${worktree} on ${branch}`,
  });

  return { worktreePath: worktree, branch, reused: false };
}

function forwardLogger(logger: Logger | undefined): { logger?: Logger } {
  return logger === undefined ? {} : { logger };
}
