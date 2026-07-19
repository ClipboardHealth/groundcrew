/**
 * Path derivation from a config-shaped input (contracts §2). Every workspace,
 * worktree, and marker location is computed here from the task slug — never read
 * back out of git — so the e2e suite and the core agree on layout.
 */

import path from "node:path";

import { DEFAULT_BRANCH_PREFIX, taskSlug } from "./identity.js";

/** Per-repo overrides from `workspace.repositories[<name>]` (contracts §5). */
export interface RepositoryOverride {
  readonly prepareWorktree?: string;
}

/**
 * The slice of `crew.config.jsonc` the workspace module needs: the base
 * directory (the repo universe), the optional worktrees root, and the git
 * naming knobs. Callers map the parsed config onto this shape.
 */
export interface WorkspaceConfig {
  /** The only required key: repos are resolved as `<baseDirectory>/<repo>`. */
  readonly baseDirectory: string;
  /** Workspaces root; default `<baseDirectory>/.groundcrew/worktrees`. */
  readonly worktreeDirectory?: string;
  /** Branch prefix; default `crew`. */
  readonly branchPrefix?: string;
  /** Git remote name; default `origin`. */
  readonly remote?: string;
  /** Fallback default branch when the remote HEAD cannot be read; default `main`. */
  readonly defaultBranch?: string;
  readonly repositories?: Readonly<Record<string, RepositoryOverride>>;
}

const MARKER_DIRECTORY = ".groundcrew";
const MARKER_FILENAME = "task.json";
const DEFAULT_WORKTREES_SUBPATH = [MARKER_DIRECTORY, "worktrees"] as const;
const DEFAULT_REMOTE = "origin";
const DEFAULT_BRANCH = "main";

/** The root under which every task workspace directory lives (contracts §2). */
export function worktreesRoot(input: { readonly config: WorkspaceConfig }): string {
  const { config } = input;
  return (
    config.worktreeDirectory ??
    path.join(config.baseDirectory, ...DEFAULT_WORKTREES_SUBPATH)
  );
}

/** The task workspace directory: `<worktreesRoot>/<taskSlug>`. */
export function workspacePath(input: {
  readonly config: WorkspaceConfig;
  readonly taskId: string;
}): string {
  return path.join(worktreesRoot({ config: input.config }), taskSlug({ taskId: input.taskId }));
}

/** A repo's worktree: `<workspace>/<repo>`. */
export function worktreePath(input: {
  readonly config: WorkspaceConfig;
  readonly taskId: string;
  readonly repo: string;
}): string {
  return path.join(workspacePath({ config: input.config, taskId: input.taskId }), input.repo);
}

/** The workspace marker file: `<workspace>/.groundcrew/task.json`. */
export function markerPath(input: {
  readonly config: WorkspaceConfig;
  readonly taskId: string;
}): string {
  return markerFilePath({
    workspaceDirectory: workspacePath({ config: input.config, taskId: input.taskId }),
  });
}

/** The marker file inside a given workspace directory. */
export function markerFilePath(input: { readonly workspaceDirectory: string }): string {
  return path.join(input.workspaceDirectory, MARKER_DIRECTORY, MARKER_FILENAME);
}

/** The local clone a worktree is cut from: `<baseDirectory>/<repo>`. */
export function clonePath(input: {
  readonly config: WorkspaceConfig;
  readonly repo: string;
}): string {
  return path.join(input.config.baseDirectory, input.repo);
}

/** Effective branch prefix. */
export function branchPrefixOf(input: { readonly config: WorkspaceConfig }): string {
  return input.config.branchPrefix ?? DEFAULT_BRANCH_PREFIX;
}

/** Effective git remote name. */
export function remoteOf(input: { readonly config: WorkspaceConfig }): string {
  return input.config.remote ?? DEFAULT_REMOTE;
}

/** Effective fallback default branch. */
export function defaultBranchOf(input: { readonly config: WorkspaceConfig }): string {
  return input.config.defaultBranch ?? DEFAULT_BRANCH;
}
