/**
 * The observed layer (design §9.3, spec §5): credential-free git facts `status`
 * renders. Owned by Workspace; never invents anything a repo does not show.
 */

import * as fs from "node:fs";

import {
  commitSubjectsAhead,
  currentBranch,
  dirtyFiles,
  refExists,
} from "./git.js";
import { readMarker } from "./marker.js";
import {
  defaultBranchOf,
  remoteOf,
  worktreePath,
  workspacePath,
  type WorkspaceConfig,
} from "./paths.js";

/** Per-repo observed git facts. */
export interface RepoObservation {
  readonly repo: string;
  readonly worktreePath: string;
  readonly branch: string;
  /** Commit subjects on the task branch beyond its fork point, newest first. */
  readonly commitsAhead: readonly string[];
  /** Uncommitted-change paths, worktree-relative. */
  readonly dirtyFiles: readonly string[];
}

export interface WorkspaceObservation {
  readonly taskId: string;
  readonly branch: string;
  readonly repos: readonly RepoObservation[];
}

/**
 * Observes a task workspace from its marker: for each recorded repo whose
 * worktree exists on disk, its current branch, commits ahead of the default
 * branch, and dirty files. `undefined` when the workspace has no marker.
 */
export async function observeWorkspace(input: {
  readonly config: WorkspaceConfig;
  readonly taskId: string;
}): Promise<WorkspaceObservation | undefined> {
  const { config, taskId } = input;
  const workspaceDirectory = workspacePath({ config, taskId });
  const marker = readMarker({ workspaceDirectory });
  if (marker === undefined) {
    return undefined;
  }

  const base = `${remoteOf({ config })}/${defaultBranchOf({ config })}`;
  const observed = await Promise.all(
    marker.repos.map(async (repo) => await observeRepo({ config, taskId, repo, base })),
  );

  return {
    taskId: marker.taskId,
    branch: marker.branch,
    repos: observed.filter((entry): entry is RepoObservation => entry !== undefined),
  };
}

/** True when a repo's worktree has uncommitted changes. */
export async function isWorktreeDirty(input: {
  readonly worktreePath: string;
}): Promise<boolean> {
  const files = await dirtyFiles({ worktreePath: input.worktreePath });
  return files.length > 0;
}

async function observeRepo(input: {
  readonly config: WorkspaceConfig;
  readonly taskId: string;
  readonly repo: string;
  readonly base: string;
}): Promise<RepoObservation | undefined> {
  const worktree = worktreePath({
    config: input.config,
    taskId: input.taskId,
    repo: input.repo,
  });
  if (!fs.existsSync(worktree)) {
    return undefined;
  }

  const hasBase = await refExists({ repoDirectory: worktree, ref: input.base });
  const [branch, commitsAhead, files] = await Promise.all([
    currentBranch({ worktreePath: worktree }),
    hasBase ? commitSubjectsAhead({ worktreePath: worktree, base: input.base }) : Promise.resolve([]),
    dirtyFiles({ worktreePath: worktree }),
  ]);

  return {
    repo: input.repo,
    worktreePath: worktree,
    branch,
    commitsAhead,
    dirtyFiles: files,
  };
}
