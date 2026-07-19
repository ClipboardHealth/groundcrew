/**
 * Typed workspace errors (design §12.1: plain exceptions + typed classes).
 * Shell maps `RepoNotOnDiskError` → exit 2 and `NoTaskContextError` → exit 3
 * (contracts §7); `DirtyWorktreeError` is a generic guard failure (nonzero).
 */

export class WorkspaceError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "WorkspaceError";
  }
}

/** A designated/requested repo is not cloned under the base directory (exit 2). */
export class RepoNotOnDiskError extends WorkspaceError {
  public readonly repo: string;
  public readonly baseDirectory: string;

  public constructor(input: { readonly repo: string; readonly baseDirectory: string }) {
    super(`repository "${input.repo}" is not cloned under base directory ${input.baseDirectory}`);
    this.name = "RepoNotOnDiskError";
    this.repo = input.repo;
    this.baseDirectory = input.baseDirectory;
  }
}

/** No task context could be resolved for an in-session command (exit 3). */
export class NoTaskContextError extends WorkspaceError {
  public constructor() {
    super(
      "no task context: pass --task <id>, set $GROUNDCREW_WORKSPACE, or run inside a task workspace",
    );
    this.name = "NoTaskContextError";
  }
}

/** A teardown was refused because a worktree has uncommitted changes. */
export class DirtyWorktreeError extends WorkspaceError {
  public readonly files: readonly string[];

  public constructor(input: { readonly files: readonly string[] }) {
    super(
      `refusing to remove: uncommitted changes in the workspace (${input.files.join(", ")}). Re-run with --force to discard them.`,
    );
    this.name = "DirtyWorktreeError";
    this.files = input.files;
  }
}

/** A repo's `prepareWorktree` hook exited nonzero. */
export class PrepareWorktreeError extends WorkspaceError {
  public readonly repo: string;
  public readonly command: string;
  public readonly exitCode: number;

  public constructor(input: {
    readonly repo: string;
    readonly command: string;
    readonly exitCode: number;
    readonly stderr: string;
  }) {
    super(
      `prepareWorktree hook for "${input.repo}" failed (exit ${String(input.exitCode)}): ${input.command}\n${input.stderr}`,
    );
    this.name = "PrepareWorktreeError";
    this.repo = input.repo;
    this.command = input.command;
    this.exitCode = input.exitCode;
  }
}
