/**
 * Pluggable task-source interface. Adapters (Linear, shell, future Jira)
 * implement `TaskSource`; the `Board` composer (`./board.ts`) fans calls
 * across N sources and presents a unified `BoardState` to consumers.
 *
 * Canonical Issue type: source-prefixed ids (e.g. `linear:eng-220`), opaque
 * `sourceRef` for adapter-private extras, canonical `CanonicalStatus` enum.
 * Consumers branch on the enum, never on native status names.
 */

/**
 * Source-neutral status enum every adapter normalises its native vocabulary
 * to. Consumers branch on these values, never on a source's native names.
 *
 * - `todo` / `in-progress` / `done`: broad lifecycle states mapped from each
 *   source's native vocabulary.
 * - `in-review`: review-stage work that should no longer consume a dispatch
 *   slot but should not be cleaned up as terminal. The built-in Linear adapter
 *   maps default/configured review status names here; the shell adapter's JSON
 *   contract accepts it directly.
 * - `other`: anything an adapter sees but can't classify (Linear tasks in
 *   `backlog`/`triage`, blockers with no resolvable state).
 */
export type CanonicalStatus = "todo" | "in-progress" | "in-review" | "done" | "other";

export interface Blocker {
  /** Canonical (source-prefixed) id of the blocking task. */
  id: string;
  title: string;
  status: CanonicalStatus;
  /**
   * When `status === "other"`, adapters MUST set this to explain why
   * they couldn't classify. Consumers (specifically `taskDoctor`) render
   * this verbatim to give users an actionable next step.
   *
   * - `"missing"`: the source returned no status for this blocker
   *   (e.g., Linear had no state on the blocker; shell script omitted
   *   the field).
   * - `"unmapped"`: the source returned a status that isn't in the
   *   source's known mapping (e.g., a Linear column not covered by
   *   `sources[*].statuses`, or an unrecognized shell value).
   *
   * MUST be undefined when `status !== "other"`.
   */
  statusReason?: "missing" | "unmapped";
  /**
   * Human-readable native status from the source, when available.
   * Used for diagnostic display only — never branched on. Adapters SHOULD
   * populate this when `statusReason === "unmapped"` so users can see
   * which status name to add to their config; MAY populate for mapped
   * statuses too if the source's native vocabulary differs usefully
   * from `CanonicalStatus`.
   */
  nativeStatus?: string;
}

export interface Issue {
  /** Canonical, source-prefixed id, e.g. "linear:eng-220" or "shell-jira:hrd-1". */
  id: string;
  /** Source name (the adapter's `name`, defaulting to its `kind`). */
  source: string;
  title: string;
  description: string;
  status: CanonicalStatus;
  /** `undefined` when the task is not dispatchable to a repository. */
  repository: string | undefined;
  /** Parsed agent model when the source can resolve one; may be present on non-Todo tasks for logs. */
  model: string | undefined;
  assignee: string;
  updatedAt: string;
  blockers: Blocker[];
  hasMoreBlockers: boolean;
  /**
   * Direct web URL for the task on the source system, when the adapter
   * knows one. `undefined` when the source can't produce a public URL (e.g.,
   * a shell script that omits the `url` field). Display-only — never
   * branched on.
   */
  url?: string;
  /**
   * Source-native priority. Lower values sort first; `undefined` means no
   * priority and sorts last. Dispatcher uses this to order Todo tasks before
   * slot assignment.
   */
  priority?: number;
  /** Adapter-private. Consumers MUST NOT inspect; only the producing adapter reads it. */
  sourceRef: unknown;
}

/** Narrowed form: an Issue confirmed to be groundcrew-eligible. */
export type GroundcrewIssue = Issue & { model: string; repository: string };

export function isGroundcrewIssue(issue: Issue): issue is GroundcrewIssue {
  return issue.model !== undefined && issue.repository !== undefined;
}

/**
 * A parent task that was dropped from the fetch result because it has
 * sub-issues. Surfaced separately so the dispatcher can log WHY a
 * Todo+labelled task wasn't picked up (PR #80 behavior).
 */
export interface ParentSkip {
  /**
   * Canonical, source-prefixed id, e.g. "linear:eng-220". Matches the form
   * used by `Issue.id` so consumers can treat all ids uniformly and strip
   * the prefix with `naturalIdFromCanonical` when displaying to operators.
   */
  id: string;
  title: string;
  childCount: number;
}

export interface BoardState {
  timestamp: string;
  issues: Issue[];
  /** Parent tasks skipped because they have sub-issues. */
  parentSkips: readonly ParentSkip[];
}

export type MarkInReviewResult =
  | { outcome: "applied" }
  | { outcome: "unsupported"; reason: string };

export type MarkDoneResult = { outcome: "applied" } | { outcome: "unsupported"; reason: string };

export interface TaskSource {
  /** Stable identifier used as the id prefix and in log lines. Equal to the source's config `name`. */
  readonly name: string;
  /** One-time startup check. Throws with a user-facing message on misconfig. */
  verify: () => Promise<void>;
  /** Per-tick snapshot. `id` on each Issue is already canonical (source-prefixed). */
  fetch: () => Promise<Issue[]>;
  /** Per-task lookup. `naturalId` is unprefixed (no `<name>:` prefix). */
  resolveOne: (naturalId: string) => Promise<Issue | undefined>;
  /** Writeback. The adapter downcasts `issue.sourceRef` internally. */
  markInProgress: (issue: Issue) => Promise<void>;
  /**
   * Writeback: advance a task from in-progress to in-review once its
   * worktree has an open PR. Frees a dispatch slot without tripping the
   * cleaner's done-only teardown, so the worktree survives for review. The
   * adapter downcasts `issue.sourceRef` internally. Adapters with no native
   * in-review concept (or no configured command) MUST report `unsupported`
   * rather than pretending the transition happened.
   */
  markInReview: (issue: Issue) => Promise<MarkInReviewResult>;

  /**
   * Optional writeback: advance a task to done once its PR has merged.
   * Sources without a native/configured done transition omit this method; the
   * Board treats an absent method as `{ outcome: "unsupported" }` so the
   * reviewer can log the skip without claiming a transition that never
   * happened. Linear omits it on purpose: on merge, Linear's own GitHub
   * integration moves the issue to Done, which groundcrew then observes via
   * `fetch()` and the cleaner tears down.
   */
  markDone?: (issue: Issue) => Promise<MarkDoneResult>;

  /**
   * Optional: return parent tasks that were excluded from `fetch()` because
   * they have sub-issues. Board surfaces these so the dispatcher can log WHY
   * a Todo+labelled task was skipped (PR #80 behavior). Adapters that
   * don't distinguish parents simply omit this method; Board returns [].
   */
  fetchParentSkips?: () => Promise<readonly ParentSkip[]>;
}

export class RepositoryResolutionError extends Error {
  public constructor(arguments_: { task: string; repositories: readonly string[] }) {
    const { task, repositories } = arguments_;
    super(
      `No known repository found in task ${task} description. Add one of workspace.knownRepositories: ${repositories.join(", ")}`,
    );
    this.name = "RepositoryResolutionError";
  }
}

export class AmbiguousTaskError extends Error {
  public constructor(arguments_: { naturalId: string; matches: readonly string[] }) {
    const { naturalId, matches } = arguments_;
    super(
      `Task id "${naturalId}" is ambiguous; matched in multiple sources: ${matches.join(", ")}. Re-invoke with one of those canonical ids.`,
    );
    this.name = "AmbiguousTaskError";
  }
}

/**
 * Build a canonical source-prefixed id from a source name and a natural
 * (possibly mixed-case) id. Lower-cases the natural part so the same
 * task always produces the same canonical id regardless of which code
 * path or adapter constructed it.
 *
 * All adapters MUST use this helper when constructing canonical ids
 * (rather than concatenating `${sourceName}:${naturalId}` inline) so
 * that `Board.resolveOne` lookups against lower-cased natural-id input
 * find the issue regardless of the casing the source emitted.
 */
export function toCanonicalId(sourceName: string, naturalId: string): string {
  return `${sourceName}:${naturalId.toLowerCase()}`;
}

/**
 * Strip the source prefix from a canonical id, yielding the natural id
 * the producing adapter exposed. Use at consumer boundaries where you
 * need to compare a canonical id against natural-id artifacts like
 * `WorktreeEntry.task` or filesystem directory names.
 *
 * Canonical ids always carry a `<source>:` prefix; the no-colon branch
 * is a defensive fallback that's unreachable in normal operation.
 */
export function naturalIdFromCanonical(id: string): string {
  const colonIndex = id.indexOf(":");
  /* v8 ignore next @preserve -- canonical ids always carry a source prefix; this branch is unreachable */
  if (colonIndex === -1) {
    return id;
  }
  return id.slice(colonIndex + 1);
}
