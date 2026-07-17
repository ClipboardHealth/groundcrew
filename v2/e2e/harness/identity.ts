/**
 * Identity and naming computations, mirroring contracts §1.
 *
 * These are pure functions the suite uses to predict the paths, branches, and
 * session names the `crew` binary will produce, so scenarios can assert against
 * an independently-computed expectation rather than reading them back out of
 * the tool. If the tool and these functions disagree, that is the bug.
 *
 * AMBIGUITY (flagged to scenario writers): contracts §1 says the slug collapses
 * "every character outside [a-z0-9]" to `-`. The wording is compatible with two
 * readings — replace each character, or collapse each *run* of such characters
 * to a single `-`. This harness implements run-collapsing (the conventional
 * slug behavior, and the reading that keeps `--` out of git branch and tmux
 * session names). The two readings agree for every id without consecutive
 * separators (including the pinned example `fixture:TASK_1.x`). The core
 * implementation must match this; if it does not, change it in one place here.
 */

const DEFAULT_BRANCH_PREFIX = "crew";

/** Canonical task id: `<sourceName>:<sourceLocalId>` (contracts §1). */
export function canonicalTaskId(input: {
  readonly sourceName: string;
  readonly localId: string;
}): string {
  const { sourceName, localId } = input;
  return `${sourceName}:${localId}`;
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

/** Uniform task branch: `<branchPrefix>/<taskSlug>` (contracts §1). */
export function branchFor(input: {
  readonly taskId: string;
  readonly branchPrefix?: string;
}): string {
  const prefix = input.branchPrefix ?? DEFAULT_BRANCH_PREFIX;
  return `${prefix}/${taskSlug({ taskId: input.taskId })}`;
}

/** Presenter session name: `crew-<taskSlug>` (contracts §1). */
export function sessionFor(input: { readonly taskId: string }): string {
  return `crew-${taskSlug({ taskId: input.taskId })}`;
}

export { DEFAULT_BRANCH_PREFIX };
