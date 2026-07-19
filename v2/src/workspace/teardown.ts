/**
 * Teardown (`crew cleanup`, launch-failure rollback). Removes worktrees, deletes
 * the task branch in each clone, and deletes the workspace directory. A dirty
 * worktree is refused by name unless `force` (CRASH-03, COMPLETE-08). An orphan
 * directory at the expected path — no marker, not a registered worktree — is
 * removed only under `force` and only when its path matches the workspace shape
 * (CRASH-02); anything else is refused.
 */

import * as fs from "node:fs";
import path from "node:path";

import type { Logger } from "../logging/index.js";
import { DirtyWorktreeError, WorkspaceError } from "./errors.js";
import { deleteBranch, dirtyFiles, isDirectory, removeWorktree } from "./git.js";
import { taskSlug } from "./identity.js";
import { readMarker, type WorkspaceMarker } from "./marker.js";
import { clonePath, worktreePath, worktreesRoot, workspacePath, type WorkspaceConfig } from "./paths.js";

const MODULE = "workspace";

export async function removeWorkspace(input: {
  readonly config: WorkspaceConfig;
  readonly taskId: string;
  readonly force?: boolean;
  readonly logger?: Logger;
}): Promise<void> {
  const { config, taskId } = input;
  const force = input.force ?? false;
  const workspaceDirectory = workspacePath({ config, taskId });

  if (!fs.existsSync(workspaceDirectory)) {
    return;
  }

  const marker = readMarker({ workspaceDirectory });
  if (marker === undefined) {
    removeOrphan({ config, taskId, workspaceDirectory, force, logger: input.logger });
    return;
  }

  await removeRegistered({ config, taskId, workspaceDirectory, marker, force, logger: input.logger });
}

async function removeRegistered(input: {
  readonly config: WorkspaceConfig;
  readonly taskId: string;
  readonly workspaceDirectory: string;
  readonly marker: WorkspaceMarker;
  readonly force: boolean;
  readonly logger: Logger | undefined;
}): Promise<void> {
  const { config, taskId, workspaceDirectory, marker, force } = input;
  const repos = discoverRepos({ config, taskId, marker });

  if (!force) {
    const dirty = await collectDirty({ config, taskId, repos });
    if (dirty.length > 0) {
      throw new DirtyWorktreeError({ files: dirty });
    }
  }

  for (const repo of repos) {
    const cloneDirectory = clonePath({ config, repo });
    if (!isDirectory({ directory: cloneDirectory })) {
      continue;
    }

    // eslint-disable-next-line no-await-in-loop -- worktree removals are ordered per clone
    await removeWorktree({
      repoDirectory: cloneDirectory,
      worktreePath: worktreePath({ config, taskId, repo }),
    });
    // eslint-disable-next-line no-await-in-loop -- and the branch delete follows its worktree removal
    await deleteBranch({ repoDirectory: cloneDirectory, branch: marker.branch });
    input.logger?.log({
      level: "info",
      module: MODULE,
      event: "worktree_removed",
      taskId,
      repo,
      msg: `removed worktree for ${repo}`,
    });
  }

  fs.rmSync(workspaceDirectory, { recursive: true, force: true });
  input.logger?.log({
    level: "info",
    module: MODULE,
    event: "workspace_removed",
    taskId,
    msg: `removed workspace ${workspaceDirectory}`,
  });
}

/**
 * The repos to tear down: those the marker records plus any child directory that
 * is itself a git worktree (a half-created acquisition the marker never caught).
 */
function discoverRepos(input: {
  readonly config: WorkspaceConfig;
  readonly taskId: string;
  readonly marker: WorkspaceMarker;
}): string[] {
  const repos = new Set(input.marker.repos);
  const workspaceDirectory = workspacePath({ config: input.config, taskId: input.taskId });
  for (const child of childDirectories({ directory: workspaceDirectory })) {
    if (fs.existsSync(path.join(workspaceDirectory, child, ".git"))) {
      repos.add(child);
    }
  }

  return [...repos].toSorted();
}

async function collectDirty(input: {
  readonly config: WorkspaceConfig;
  readonly taskId: string;
  readonly repos: readonly string[];
}): Promise<string[]> {
  const perRepo = await Promise.all(
    input.repos.map(async (repo) => {
      const worktree = worktreePath({ config: input.config, taskId: input.taskId, repo });
      if (!fs.existsSync(path.join(worktree, ".git"))) {
        return [];
      }

      const files = await dirtyFiles({ worktreePath: worktree });
      return files.map((file) => `${repo}/${file}`);
    }),
  );
  return perRepo.flat();
}

function removeOrphan(input: {
  readonly config: WorkspaceConfig;
  readonly taskId: string;
  readonly workspaceDirectory: string;
  readonly force: boolean;
  readonly logger: Logger | undefined;
}): void {
  if (!input.force) {
    throw new WorkspaceError(
      `refusing to remove ${input.workspaceDirectory}: not a registered workspace (no marker). Re-run with --force.`,
    );
  }

  if (!matchesWorkspaceShape({ config: input.config, taskId: input.taskId, candidate: input.workspaceDirectory })) {
    throw new WorkspaceError(
      `refusing to remove ${input.workspaceDirectory}: path does not match the expected workspace shape.`,
    );
  }

  fs.rmSync(input.workspaceDirectory, { recursive: true, force: true });
  input.logger?.log({
    level: "info",
    module: MODULE,
    event: "workspace_orphan_removed",
    taskId: input.taskId,
    msg: `removed orphan workspace directory ${input.workspaceDirectory}`,
  });
}

/** True when `candidate` is exactly `<worktreesRoot>/<taskSlug>` with a non-empty slug. */
function matchesWorkspaceShape(input: {
  readonly config: WorkspaceConfig;
  readonly taskId: string;
  readonly candidate: string;
}): boolean {
  const slug = taskSlug({ taskId: input.taskId });
  if (slug === "") {
    return false;
  }

  const resolved = path.resolve(input.candidate);
  const root = path.resolve(worktreesRoot({ config: input.config }));
  return path.dirname(resolved) === root && path.basename(resolved) === slug;
}

function childDirectories(input: { readonly directory: string }): string[] {
  return fs
    .readdirSync(input.directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name);
}
