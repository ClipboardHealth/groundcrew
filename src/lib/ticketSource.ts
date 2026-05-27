/**
 * Pluggable ticket-source interface. Adapters (Linear, shell, future Jira)
 * implement `TicketSource`; the `Board` composer (`./board.ts`) fans calls
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
 * - `todo` / `in-progress` / `done`: the only canonical states the built-in
 *   Linear adapter produces today (mapped from Linear's workflow `state.type`).
 * - `in-review`: produced only by adapters whose schema declares an in-review
 *   mapping. The shell adapter's JSON contract accepts it; the built-in Linear
 *   adapter does not yet map any native state to it. Reserved here so
 *   consumers' branch logic doesn't change when that follow-up lands.
 * - `other`: anything an adapter sees but can't classify (Linear tickets in
 *   `backlog`/`triage`, blockers with no resolvable state).
 */
export type CanonicalStatus = "todo" | "in-progress" | "in-review" | "done" | "other";

export interface Blocker {
  /** Canonical (source-prefixed) id of the blocking ticket. */
  id: string;
  title: string;
  status: CanonicalStatus;
  /**
   * When `status === "other"`, adapters MUST set this to explain why
   * they couldn't classify. Consumers (specifically `ticketDoctor`) render
   * this verbatim to give users an actionable next step.
   *
   * - `"missing"`: the source returned no status for this blocker
   *   (e.g., Linear had no state on the blocker; shell script omitted
   *   the field).
   * - `"unmapped"`: the source returned a status that isn't in the
   *   source's known mapping (e.g., a Linear column not in
   *   `linear.projects[*].statuses`, or an unrecognized shell value).
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
  /** `undefined` when the ticket is not dispatchable to a repository. */
  repository: string | undefined;
  /** Parsed agent model when the source can resolve one; may be present on non-Todo tickets for logs. */
  model: string | undefined;
  assignee: string;
  updatedAt: string;
  blockers: Blocker[];
  hasMoreBlockers: boolean;
  /** Adapter-private. Consumers MUST NOT inspect; only the producing adapter reads it. */
  sourceRef: unknown;
}

/** Narrowed form: an Issue confirmed to be groundcrew-eligible. */
export type GroundcrewIssue = Issue & { model: string; repository: string };

export function isGroundcrewIssue(issue: Issue): issue is GroundcrewIssue {
  return issue.model !== undefined && issue.repository !== undefined;
}

/**
 * A parent ticket that was dropped from the fetch result because it has
 * sub-issues. Surfaced separately so the dispatcher can log WHY a
 * Todo+labelled ticket wasn't picked up (PR #80 behavior).
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
  /** Parent tickets skipped because they have sub-issues. */
  parentSkips: readonly ParentSkip[];
}

export interface TicketSource {
  /** Stable identifier used as the id prefix and in log lines. Equal to the source's config `name`. */
  readonly name: string;
  /** One-time startup check. Throws with a user-facing message on misconfig. */
  verify(): Promise<void>;
  /** Per-tick snapshot. `id` on each Issue is already canonical (source-prefixed). */
  fetch(): Promise<Issue[]>;
  /** Per-ticket lookup. `naturalId` is unprefixed (no `<name>:` prefix). */
  resolveOne(naturalId: string): Promise<Issue | undefined>;
  /** Writeback. The adapter downcasts `issue.sourceRef` internally. */
  markInProgress(issue: Issue): Promise<void>;

  /**
   * Optional: return parent tickets that were excluded from `fetch()` because
   * they have sub-issues. Board surfaces these so the dispatcher can log WHY
   * a Todo+labelled ticket was skipped (PR #80 behavior). Adapters that
   * don't distinguish parents simply omit this method; Board returns [].
   */
  fetchParentSkips?(): Promise<readonly ParentSkip[]>;
}

export class RepositoryResolutionError extends Error {
  public constructor(arguments_: { ticket: string; repositories: readonly string[] }) {
    const { ticket, repositories } = arguments_;
    super(
      `No known repository found in ticket ${ticket} description. Add one of workspace.knownRepositories: ${repositories.join(", ")}`,
    );
    this.name = "RepositoryResolutionError";
  }
}

export class AmbiguousTicketError extends Error {
  public constructor(arguments_: { naturalId: string; matches: readonly string[] }) {
    const { naturalId, matches } = arguments_;
    super(
      `Ticket id "${naturalId}" is ambiguous; matched in multiple sources: ${matches.join(", ")}. Re-invoke with one of those canonical ids.`,
    );
    this.name = "AmbiguousTicketError";
  }
}

/**
 * Build a canonical source-prefixed id from a source name and a natural
 * (possibly mixed-case) id. Lower-cases the natural part so the same
 * ticket always produces the same canonical id regardless of which code
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
 * `WorktreeEntry.ticket` or filesystem directory names.
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
