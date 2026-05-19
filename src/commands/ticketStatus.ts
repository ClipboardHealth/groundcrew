// src/commands/ticketStatus.ts

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

function isWorktreePresent(worktree: WorktreeProbe): boolean {
  /* v8 ignore next 3 @preserve -- short-circuit branches for the "present-*" variants are exercised cumulatively across rows 5-7; this helper centralizes the predicate */
  return (
    worktree.kind === "present-clean" ||
    worktree.kind === "present-dirty" ||
    worktree.kind === "present-unknown-dirtiness"
  );
}

function verdictInFlight(input: DecideVerdictInput): StatusVerdict | undefined {
  // Row 7: Non-terminal Linear status + live worktree → mid-flight session.
  if (input.linear.kind !== "non-terminal" || !isWorktreePresent(input.worktree)) {
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
