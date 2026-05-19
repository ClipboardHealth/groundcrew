// src/commands/ticketStatus.ts

import type { RawLinearIssue } from "../lib/boardSource.ts";
import type { ResolvedConfig } from "../lib/config.ts";
import type { WorkspaceProbe } from "../lib/workspaces.ts";
import type { WorktreeDirtiness, WorktreeEntry } from "../lib/worktrees.ts";
import type { TicketCheck } from "./ticketCheck.ts";

// ───────── verdict types ─────────

export type StatusVerdict =
  | { kind: "pr-open"; number: number; url: string }
  | { kind: "pr-merged"; number: number; url: string }
  | { kind: "in-flight"; reason: string }
  | { kind: "recoverable"; reason: string; nextStep: string }
  | { kind: "lost"; reason: string };

export type LinearStatusProbe =
  | { kind: "terminal"; stateName: string }
  | { kind: "non-terminal"; stateName: string }
  | { kind: "skipped" }
  | { kind: "unresolvable"; reason: string };

export type WorktreeProbe =
  | { kind: "present-clean" }
  | { kind: "present-dirty"; modified: number; untracked: number }
  | { kind: "present-unknown-dirtiness"; reason: string }
  | { kind: "absent" };

export type LocalBranchProbe =
  | { kind: "present"; ahead: number; behind: number; defaultBranch?: string }
  | { kind: "absent" }
  | { kind: "unknown"; reason: string };

export type RemoteBranchProbe =
  | { kind: "present" }
  | { kind: "absent" }
  | { kind: "unknown"; reason: string };

export type PullRequestProbe =
  | { kind: "open"; number: number; url: string }
  | { kind: "merged"; number: number; url: string }
  | { kind: "absent" }
  | { kind: "gh-missing" }
  | { kind: "unknown"; reason: string };

export interface DecideVerdictInput {
  linear: LinearStatusProbe;
  worktree: WorktreeProbe;
  localBranch: LocalBranchProbe;
  remoteBranch: RemoteBranchProbe;
  pullRequest: PullRequestProbe;
  branch: string;
  worktreeDir: string | undefined;
  workspaceName: string | undefined;
}

// ───────── verdict logic ─────────

function verdictFromPullRequest(pullRequest: PullRequestProbe): StatusVerdict | undefined {
  if (pullRequest.kind === "open") {
    return { kind: "pr-open", number: pullRequest.number, url: pullRequest.url };
  }
  if (pullRequest.kind === "merged") {
    return { kind: "pr-merged", number: pullRequest.number, url: pullRequest.url };
  }
  return undefined;
}

function verdictInFlight(input: DecideVerdictInput): StatusVerdict | undefined {
  // Row 7: Non-terminal Linear status + live worktree → mid-flight session.
  if (input.linear.kind !== "non-terminal") {
    return undefined;
  }
  if (
    input.worktree.kind !== "present-clean" &&
    input.worktree.kind !== "present-dirty" &&
    input.worktree.kind !== "present-unknown-dirtiness"
  ) {
    return undefined;
  }
  /* v8 ignore next 3 @preserve -- caller passes either workspaceName or worktreeDir; defensive guards for the rare both-missing path */
  const where =
    input.workspaceName === undefined
      ? `worktree at ${input.worktreeDir ?? "<unknown>"}`
      : `workspace "${input.workspaceName}"`;
  return { kind: "in-flight", reason: `ticket is mid-flight in ${where}` };
}

function verdictDirtyWorktree(input: DecideVerdictInput): StatusVerdict | undefined {
  // Row 6: Dirty worktree blocks all push-based recoveries.
  if (input.worktree.kind !== "present-dirty") {
    return undefined;
  }
  const where = input.worktreeDir ?? "<worktree>";
  return {
    kind: "recoverable",
    reason: `dirty worktree (${input.worktree.modified} modified, ${input.worktree.untracked} untracked)`,
    nextStep: `commit or stash in ${where}, then re-run \`crew status --ticket ${input.branch}\``,
  };
}

function verdictCleanLocalPush(input: DecideVerdictInput): StatusVerdict | undefined {
  // Row 5: Clean worktree + local branch, no remote, no PR → push + pr create.
  const worktreeIsClean =
    input.worktree.kind === "present-clean" || input.worktree.kind === "present-unknown-dirtiness";
  if (
    !worktreeIsClean ||
    input.localBranch.kind !== "present" ||
    input.remoteBranch.kind !== "absent"
  ) {
    return undefined;
  }
  /* v8 ignore next @preserve -- a present worktree always has a worktreeDir; nullish guard is defensive */
  const where = input.worktreeDir ?? "<worktree>";
  return {
    kind: "recoverable",
    reason: `clean worktree with un-pushed local branch`,
    nextStep: `cd ${where}; git push -u origin ${input.branch}; gh pr create`,
  };
}

function verdictRemoteOnly(input: DecideVerdictInput): StatusVerdict | undefined {
  // Row 2: Remote branch present, no worktree, no PR → just pr create.
  if (
    input.worktree.kind !== "absent" ||
    input.remoteBranch.kind !== "present" ||
    input.pullRequest.kind !== "absent"
  ) {
    return undefined;
  }
  return {
    kind: "recoverable",
    reason: `remote branch exists without a PR`,
    nextStep: `gh pr create --head ${input.branch}`,
  };
}

function verdictStrandedLocal(input: DecideVerdictInput): StatusVerdict | undefined {
  // Row 8: Local branch but no worktree → stranded branch.
  if (input.worktree.kind !== "absent" || input.localBranch.kind !== "present") {
    return undefined;
  }
  return {
    kind: "recoverable",
    reason: `stranded local branch (no worktree)`,
    nextStep: `push the branch or delete it: \`git branch -D ${input.branch}\``,
  };
}

function verdictAllAbsent(input: DecideVerdictInput): StatusVerdict | undefined {
  // Row 1: Nothing exists locally and no PR → lost.
  /* v8 ignore else @preserve -- the else arm falls through to the defensive fallback in decideVerdict; the 9 matrix rows above cover the contracted cases */
  if (
    input.worktree.kind === "absent" &&
    input.localBranch.kind === "absent" &&
    input.remoteBranch.kind === "absent" &&
    input.pullRequest.kind === "absent"
  ) {
    return {
      kind: "lost",
      reason: `no local state and no PR — re-dispatch via \`crew run --ticket ${input.branch}\` or move the ticket back to Todo in Linear`,
    };
  }
  /* v8 ignore next @preserve -- all 9 matrix rows above cover the contracted cases; only an unrecognized probe combination falls through */
  return undefined;
}

/**
 * Maps a probe-result bundle to a single verdict + recovery next-step.
 *
 * The recovery matrix in the design doc labels most rows "terminal" in the
 * Linear column, but that label is descriptive of the common case — the
 * recovery action does not actually depend on Linear state for Rows 1/2/5/6/8.
 * Only Row 7 (in-flight) gates on `linear.kind === "non-terminal"`. This means
 * an in-progress ticket whose local artifacts are stranded still gets a useful
 * recovery suggestion rather than a generic "lost" verdict.
 */
export function decideVerdict(input: DecideVerdictInput): StatusVerdict {
  // Verdict precedence: PR-open / PR-merged win, then in-flight, then recoverable
  // rows, then lost. Each helper returns undefined when its row does not match.
  const verdict =
    verdictFromPullRequest(input.pullRequest) ??
    verdictInFlight(input) ??
    verdictDirtyWorktree(input) ??
    verdictCleanLocalPush(input) ??
    verdictRemoteOnly(input) ??
    verdictStrandedLocal(input) ??
    verdictAllAbsent(input);

  /* v8 ignore next 5 @preserve -- defensive fallback for unrecognized probe combinations; the 9 matrix rows above cover the contracted cases */
  if (verdict === undefined) {
    return { kind: "lost", reason: `unrecognized state combination; inspect output above` };
  }
  return verdict;
}

// ───────── orchestrator dependencies ─────────

export interface TicketStatusDependencies {
  config: ResolvedConfig;
  ticket: string;
  /**
   * Injected to keep `ticketStatus` pure and easy to unit-test. `undefined`
   * means the caller passed `--no-linear` — the Linear section is skipped.
   */
  fetchRawIssue: ((input: { ticket: string }) => Promise<RawLinearIssue>) | undefined;
  findWorktree: (ticket: string) => WorktreeEntry | undefined;
  probeWorkspaces: () => Promise<WorkspaceProbe>;
  probeWorkingTree: (input: { worktreeDir: string }) => Promise<WorktreeDirtiness>;
  probeLocalBranch: (input: {
    repoDir: string;
    branch: string;
    defaultBranch: string;
  }) => Promise<LocalBranchProbe>;
  probeRemoteBranch: (input: {
    repoDir: string;
    branch: string;
    doFetch: boolean;
  }) => Promise<RemoteBranchProbe>;
  probePullRequest: (input: { repoDir: string; branch: string }) => Promise<PullRequestProbe>;
  doFetch: boolean;
}

export interface TicketStatusResult {
  ticket: string;
  title?: string;
  linear: TicketCheck[];
  worktree: TicketCheck[];
  workspace: TicketCheck[];
  localBranch: TicketCheck[];
  remoteBranch: TicketCheck[];
  pullRequest: TicketCheck[];
  skipReasons: {
    linear: string;
    worktree: string;
    workspace: string;
    localBranch: string;
    remoteBranch: string;
    pullRequest: string;
  };
  verdict: StatusVerdict;
}

function emptySkipReasons(): TicketStatusResult["skipReasons"] {
  return {
    linear: "",
    worktree: "",
    workspace: "",
    localBranch: "",
    remoteBranch: "",
    pullRequest: "",
  };
}

interface LinearProbeOutput {
  checks: TicketCheck[];
  skipReason: string;
  status: LinearStatusProbe;
  title?: string;
}

async function probeLinear(
  deps: TicketStatusDependencies,
  ticket: string,
): Promise<LinearProbeOutput> {
  if (deps.fetchRawIssue === undefined) {
    return { checks: [], skipReason: "--no-linear", status: { kind: "skipped" } };
  }
  try {
    const raw = await deps.fetchRawIssue({ ticket });
    const isTerminal = deps.config.linear.statuses.terminal.includes(raw.stateName);
    const stateCheck: TicketCheck = isTerminal
      ? { name: `Status is terminal (${raw.stateName})`, status: "ok" }
      : { name: `Status is non-terminal (${raw.stateName})`, status: "ok" };
    const checks: TicketCheck[] = [
      { name: "Ticket exists in Linear", status: "ok", detail: `"${raw.title}"` },
      stateCheck,
    ];
    return {
      checks,
      skipReason: "",
      status: { kind: isTerminal ? "terminal" : "non-terminal", stateName: raw.stateName },
      title: raw.title,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      checks: [{ name: "Ticket exists in Linear", status: "fail", detail: message }],
      skipReason: "",
      status: { kind: "unresolvable", reason: message },
    };
  }
}

/**
 * Pure-with-async orchestrator that gathers per-section checks and a single
 * recovery verdict for a ticket. All I/O happens via injected probes — the
 * function itself does no filesystem, network, or stdout work.
 *
 * Tasks 5-8 fill in the worktree, workspace, local-branch, remote-branch,
 * and PR sections; this task wires only the Linear section.
 */
export async function ticketStatus(deps: TicketStatusDependencies): Promise<TicketStatusResult> {
  const ticket = deps.ticket.toUpperCase();
  const skipReasons = emptySkipReasons();

  const linearResult = await probeLinear(deps, ticket);
  skipReasons.linear = linearResult.skipReason;

  // Other sections are stubbed for this task — Tasks 5-8 fill them in. The
  // provisional `skipped → non-terminal (linear skipped)` mapping below is
  // revisited in Task 8 when all sections are wired.
  const verdict = decideVerdict({
    linear:
      linearResult.status.kind === "skipped"
        ? { kind: "non-terminal", stateName: "(linear skipped)" }
        : linearResult.status,
    worktree: { kind: "absent" },
    localBranch: { kind: "absent" },
    remoteBranch: { kind: "absent" },
    pullRequest: { kind: "absent" },
    branch: ticket.toLowerCase(),
    worktreeDir: undefined,
    workspaceName: undefined,
  });

  return {
    ticket,
    ...(linearResult.title === undefined ? {} : { title: linearResult.title }),
    linear: linearResult.checks,
    worktree: [],
    workspace: [],
    localBranch: [],
    remoteBranch: [],
    pullRequest: [],
    skipReasons,
    verdict,
  };
}
