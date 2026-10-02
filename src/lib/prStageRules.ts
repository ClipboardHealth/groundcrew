/**
 * Pure PR-stage and ticket derivation rules, ported from the standalone
 * `crew-pr-stages.jq` / `crew-ticket.jq` poller this feature replaces. Keeping
 * these as pure functions (no I/O) is what makes the 17 stage fixtures and 8
 * ticket fixtures portable as plain unit tests.
 */

export type PullRequestLifecycleState = "OPEN" | "CLOSED" | "MERGED";

export type PullRequestReviewDecision = "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;

export interface PrStageInput {
  state: PullRequestLifecycleState;
  isDraft: boolean;
  labels: readonly string[];
  reviewDecision: PullRequestReviewDecision;
  /** `statusCheckRollup.state`, or `null` when the PR has no checks (treated as passing). */
  checks: string | null;
}

const PR_STAGES = [
  "merged",
  "closed",
  "ci_failing",
  "ci_running",
  "my_review",
  "needs_testing",
  "changes_requested",
  "ready_to_merge",
  "peer_review",
] as const;

export type PrStage = (typeof PR_STAGES)[number];

export interface PrStageLabelNames {
  selfReviewed: string;
  tested: string;
}

const FAILING_CHECK_STATES = new Set(["FAILURE", "ERROR"]);
const RUNNING_CHECK_STATES = new Set(["PENDING", "EXPECTED"]);

/**
 * Rule order is significant (first match wins) and mirrors the jq filter's
 * `if/elif` chain exactly: self-review and testing are explicit manual gates
 * (PR labels toggled from the sidebar), not proxies like draft state — a PR
 * sits at `my_review` until self-reviewed is applied (draft or not), and at
 * `needs_testing` until tested is applied, ahead of CI and review-decision.
 */
export function derivePrStage(input: PrStageInput, labelNames: PrStageLabelNames): PrStage {
  if (input.state === "MERGED") {
    return "merged";
  }
  if (input.state === "CLOSED") {
    return "closed";
  }
  if (input.checks !== null && FAILING_CHECK_STATES.has(input.checks)) {
    return "ci_failing";
  }
  if (input.checks !== null && RUNNING_CHECK_STATES.has(input.checks)) {
    return "ci_running";
  }
  if (input.isDraft || !input.labels.includes(labelNames.selfReviewed)) {
    return "my_review";
  }
  if (!input.labels.includes(labelNames.tested)) {
    return "needs_testing";
  }
  if (input.reviewDecision === "CHANGES_REQUESTED") {
    return "changes_requested";
  }
  if (input.reviewDecision === "APPROVED") {
    return "ready_to_merge";
  }
  return "peer_review";
}

/** The managed-label subset of a PR's labels, sorted and comma-joined — the `crew_labels` sidebar value. */
export function managedLabelsField(
  labels: readonly string[],
  labelNames: PrStageLabelNames,
): string {
  const managed = new Set([labelNames.selfReviewed, labelNames.tested]);
  return labels
    .filter((label) => managed.has(label))
    .toSorted((a, b) => a.localeCompare(b))
    .join(",");
}

const TICKET_PREFIX_RE = /^[A-Za-z]+$/;
const TICKET_NUMBER_RE = /^[0-9]+$/;
const TICKET_PREFIX_MAX_LENGTH = 5;

/**
 * Mirrors the retired sidebar `ticketOf`: a prefix must be 1-5 ASCII letters
 * and the trailing segment a plain integer.
 */
function ticketFromSegments(segments: readonly string[]): string | undefined {
  if (segments.length < 2) {
    return undefined;
  }
  const number = segments.at(-1);
  const prefix = segments.at(-2);
  /* v8 ignore next 3 @preserve -- segments.length >= 2 above guarantees both are defined; this only satisfies noUncheckedIndexedAccess */
  if (number === undefined || prefix === undefined) {
    return undefined;
  }
  if (
    TICKET_NUMBER_RE.test(number) &&
    prefix.length <= TICKET_PREFIX_MAX_LENGTH &&
    TICKET_PREFIX_RE.test(prefix)
  ) {
    return `${prefix}-${number}`.toUpperCase();
  }
  return undefined;
}

/** Worktree dirs are named `<repo>-<prefix>-<number>`; try the last two hyphen segments of the basename. */
function ticketFromDirectory(currentDirectory: string | null | undefined): string | undefined {
  /* v8 ignore next @preserve -- String.split always returns at least one element, so .at(-1) is never undefined here; the fallback only satisfies noUncheckedIndexedAccess */
  const base = (currentDirectory ?? "").split("/").at(-1) ?? "";
  if (base.length === 0) {
    return undefined;
  }
  return ticketFromSegments(base.split("-"));
}

/** A title must lead with exactly one `PREFIX-NUMBER` token to count, unlike the directory form. */
function ticketFromTitle(title: string | null | undefined): string | undefined {
  /* v8 ignore next @preserve -- String.split always returns at least one element, so index 0 is never undefined here; the fallback only satisfies noUncheckedIndexedAccess */
  const token = (title ?? "").split(" ")[0] ?? "";
  const segments = token.split("-");
  if (segments.length !== 2) {
    return undefined;
  }
  return ticketFromSegments(segments);
}

export interface TicketDerivationInput {
  title?: string | null;
  currentDirectory?: string | null;
}

/** Directory wins over title, matching the retired sidebar's precedence. */
export function deriveTicket(input: TicketDerivationInput): string | undefined {
  return ticketFromDirectory(input.currentDirectory) ?? ticketFromTitle(input.title);
}
