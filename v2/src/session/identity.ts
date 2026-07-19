/**
 * Session-name derivation (contracts §1). The presenter session name is
 * `crew-<taskSlug>`, one session per task. This is a deliberate COPY of the
 * shared slug rule (also implemented in the e2e harness `identity.ts` and by
 * Workspace); Session can import neither, so it mirrors the rule. If the tool
 * and the harness disagree, that is the bug — keep this in lockstep with
 * `e2e/harness/identity.ts`.
 */

/** Fixed prefix on every groundcrew-managed presenter session name. */
export const SESSION_NAME_PREFIX = "crew-";

/**
 * Task slug: canonical id lowercased, every run of characters outside
 * `[a-z0-9]` collapsed to a single `-`, leading/trailing `-` trimmed.
 * `fixture:TASK-1` → `fixture-task-1`.
 */
export function taskSlug(input: { taskId: string }): string {
  return input.taskId
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
}

/** Presenter session name for a task: `crew-<taskSlug>` (contracts §1). */
export function sessionNameFor(input: { taskId: string }): string {
  return `${SESSION_NAME_PREFIX}${taskSlug({ taskId: input.taskId })}`;
}

/** Whether a session name follows the groundcrew presenter naming scheme. */
export function isManagedSessionName(name: string): boolean {
  return name.startsWith(SESSION_NAME_PREFIX);
}
