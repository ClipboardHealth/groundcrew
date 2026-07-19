/**
 * Workspace: worktrees, branches, the observed layer (credential-free git
 * facts), `.groundcrew/task.json` and the task-identity resolver; typed errors
 * that Shell maps to exit codes 2/3. Owns the workspace marker-file format
 * (spec §9.3, contracts §1–§3).
 *
 * A Workspace is the per-task directory set — the worktrees a task's agent works
 * over (possibly zero). Never a terminal pane. This `index.ts` is the module's
 * only interface; other modules import from here alone.
 */

export const MODULE = "workspace";

export { canonicalTaskId, taskBranch, taskSlug, DEFAULT_BRANCH_PREFIX } from "./identity.js";

export {
  branchPrefixOf,
  clonePath,
  defaultBranchOf,
  markerFilePath,
  markerPath,
  remoteOf,
  worktreePath,
  worktreesRoot,
  workspacePath,
} from "./paths.js";
export type { RepositoryOverride, WorkspaceConfig } from "./paths.js";

export {
  DirtyWorktreeError,
  NoTaskContextError,
  PrepareWorktreeError,
  RepoNotOnDiskError,
  WorkspaceError,
} from "./errors.js";

export { addRepoToMarker, markerSchema, readMarker, writeMarker } from "./marker.js";
export type { WorkspaceMarker } from "./marker.js";

export { acquireWorktree, provisionWorkspace } from "./provision.js";
export type { AcquireResult, ProvisionResult } from "./provision.js";

export { isWorktreeDirty, observeWorkspace } from "./observe.js";
export type { RepoObservation, WorkspaceObservation } from "./observe.js";

export { resolveTaskContext } from "./context.js";
export type { TaskContext } from "./context.js";

export { removeWorkspace } from "./teardown.js";
