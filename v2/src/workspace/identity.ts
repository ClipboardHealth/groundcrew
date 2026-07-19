/**
 * Identity and naming (contracts §1). These are the single source of truth for
 * the task slug, canonical id, and uniform task branch; they MUST agree with the
 * e2e harness reference implementation (`e2e/harness/identity.ts`).
 *
 * Slug rule: canonical id lowercased, every run of characters outside `[a-z0-9]`
 * collapsed to a single `-`, leading/trailing `-` trimmed. Run-collapsing (not
 * per-character replacement) is the deliberate reading — it keeps `--` out of git
 * branch and tmux session names; the two readings agree for every id without
 * consecutive separators, including the pinned `fixture:TASK_1.x` example.
 */

const DEFAULT_BRANCH_PREFIX = "crew";

/** Canonical task id: `<sourceName>:<sourceLocalId>` (contracts §1). */
export function canonicalTaskId(input: {
  readonly sourceName: string;
  readonly localId: string;
}): string {
  return `${input.sourceName}:${input.localId}`;
}

/**
 * Task slug: canonical id lowercased, runs of non-`[a-z0-9]` collapsed to `-`,
 * leading/trailing `-` trimmed. Used in paths, branches, and session names.
 */
export function taskSlug(input: { readonly taskId: string }): string {
  return input.taskId
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
}

/** Uniform task branch (every worktree of the task): `<branchPrefix>/<slug>`. */
export function taskBranch(input: {
  readonly taskId: string;
  readonly branchPrefix?: string;
}): string {
  const prefix = input.branchPrefix ?? DEFAULT_BRANCH_PREFIX;
  return `${prefix}/${taskSlug({ taskId: input.taskId })}`;
}

export { DEFAULT_BRANCH_PREFIX };
