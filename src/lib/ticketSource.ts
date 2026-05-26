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
}

export interface Issue {
  /** Canonical, source-prefixed id, e.g. "linear:eng-220" or "shell-jira:HRD-1". */
  id: string;
  /** Source name (the adapter's `name`, defaulting to its `kind`). */
  source: string;
  title: string;
  description: string;
  status: CanonicalStatus;
  /** `undefined` when the ticket isn't groundcrew-eligible (no agent label / no repo match). */
  repository: string | undefined;
  /** `undefined` when the ticket isn't groundcrew-eligible. */
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

export interface BoardState {
  timestamp: string;
  issues: Issue[];
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
