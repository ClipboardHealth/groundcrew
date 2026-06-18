import { normalizePlainTaskId } from "./taskId.ts";

/**
 * Placeholder users put in their agent `session.start` / `session.resume`
 * templates; replaced with the generated session id at launch time. Mirrors
 * the `{{worktree}}` / `{{sandbox}}` placeholders the `cmd` template accepts.
 */
export const SESSION_ID_PLACEHOLDER = "{{session}}";

/**
 * Derive the agent chat-session id groundcrew pins for a task: the normalized
 * task id followed by a compact UTC timestamp (e.g. `team-220-20260619t143000z`).
 * The timestamp drops the colons, dots, and milliseconds an ISO string carries so
 * the id is safe to embed in a shell argument and a filename. The id is stored
 * in run state at first launch and reused verbatim on `crew resume`.
 */
export function generateSessionId(task: string): string {
  const normalized = normalizePlainTaskId(task);
  // ISO `2026-06-19T14:30:00.000Z` → seconds precision → drop separators →
  // `20260619t143000` (8-digit date, `t`, 6-digit time).
  const timestamp =
    `${new Date().toISOString().slice(0, 19).replaceAll(/[:-]/g, "")}z`.toLowerCase();
  return `${normalized}-${timestamp}`;
}
