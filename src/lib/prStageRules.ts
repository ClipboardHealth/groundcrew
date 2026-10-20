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

/**
 * Most urgent to least urgent, mirroring the sidebar's section order
 * (`contrib/cmux/groundcrew.swift`) for the stages this module derives —
 * `merged`/`closed` sit last since a shown closed PR only appears when the
 * task has no open or merged PR, and a shown merged PR only appears
 * alongside PRs this urgent or less. Defined once here so `prStageSync.ts`
 * (picking the task's single most urgent stage across its shown PRs) and any
 * other ranking need share the same order instead of re-deriving it.
 */
export const PR_STAGE_URGENCY_ORDER: readonly PrStage[] = [
  "my_review",
  "ci_failing",
  "changes_requested",
  "needs_testing",
  "ready_to_merge",
  "ci_running",
  "peer_review",
  "merged",
  "closed",
];

/** The most urgent stage present in `stages`, per `PR_STAGE_URGENCY_ORDER`. */
export function mostUrgentStage(stages: readonly PrStage[]): PrStage | undefined {
  return PR_STAGE_URGENCY_ORDER.find((stage) => stages.includes(stage));
}

export interface TaskPullRequestRef {
  headRefName: string;
  baseRefName: string;
}

/** A task's PRs: its exact branch, plus every branch stacked off it (`<taskBranch>-*`). */
export function isTaskBranch(headRefName: string, taskBranch: string): boolean {
  return headRefName === taskBranch || headRefName.startsWith(`${taskBranch}-`);
}

/**
 * Which of a task's matched pull requests the sidebar shows: every open or
 * merged one, falling back to closed ones only when none are open or
 * merged — a closed PR superseded by a later stack split is noise once the
 * replacement stack exists, but is the only signal left once it's all that
 * remains.
 */
export function selectShownPullRequests<T extends { state: string }>(
  pullRequests: readonly T[],
): T[] {
  const openOrMerged = pullRequests.filter((pr) => pr.state === "open" || pr.state === "merged");
  if (openOrMerged.length > 0) {
    return openOrMerged;
  }
  return pullRequests.filter((pr) => pr.state === "closed");
}

/**
 * Orders a task's shown PRs bottom-of-stack to top when they chain cleanly
 * through baseRefName -> headRefName (each PR's base is either outside the
 * shown set — the bottom — or exactly one other shown PR's head, and no two
 * PRs share a base); falls back to ascending PR number for anything that
 * doesn't form that single linear chain (a fork, a gap, or a cycle).
 */
export function orderPullRequestStack<T extends TaskPullRequestRef & { number: number }>(
  pullRequests: readonly T[],
): T[] {
  if (pullRequests.length <= 1) {
    return [...pullRequests];
  }

  const byHead = new Map(pullRequests.map((pr) => [pr.headRefName, pr]));
  const childByParentHead = new Map<string, T>();
  const roots: T[] = [];
  for (const pr of pullRequests) {
    const parent = byHead.get(pr.baseRefName);
    if (parent === undefined) {
      roots.push(pr);
      continue;
    }
    if (childByParentHead.has(parent.headRefName)) {
      return pullRequests.toSorted((a, b) => a.number - b.number);
    }
    childByParentHead.set(parent.headRefName, pr);
  }
  if (roots.length !== 1) {
    return pullRequests.toSorted((a, b) => a.number - b.number);
  }

  const ordered: T[] = [];
  let current: T | undefined = roots[0];
  while (current !== undefined) {
    ordered.push(current);
    current = childByParentHead.get(current.headRefName);
  }
  if (ordered.length !== pullRequests.length) {
    return pullRequests.toSorted((a, b) => a.number - b.number);
  }
  return ordered;
}

/** Shown PRs for a task, in display order: `selectShownPullRequests` then `orderPullRequestStack`. */
export function selectTaskPullRequests<
  T extends TaskPullRequestRef & { number: number; state: string },
>(pullRequests: readonly T[], taskBranch: string): T[] {
  const matched = pullRequests.filter((pr) => isTaskBranch(pr.headRefName, taskBranch));
  return orderPullRequestStack(selectShownPullRequests(matched));
}

export interface PrStatusEntry {
  number: number;
  stage: PrStage;
  url: string;
}

const PR_ENTRY_SEPARATOR = ";";
const PR_FIELD_SEPARATOR = ",";

/** The `crew_prs` sidebar value: `<number>,<stage>,<url>` entries joined by `;`. */
export function encodePrStatuses(entries: readonly PrStatusEntry[]): string {
  return entries
    .map((entry) => [entry.number, entry.stage, entry.url].join(PR_FIELD_SEPARATOR))
    .join(PR_ENTRY_SEPARATOR);
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
