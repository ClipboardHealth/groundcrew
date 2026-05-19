// src/commands/ticketStatus.ts

import { existsSync } from "node:fs";

import { fetchRawLinearIssue, type RawLinearIssue } from "../lib/boardSource.ts";
import { runCommandAsync } from "../lib/commandRunner.ts";
import { loadConfig, type ResolvedConfig } from "../lib/config.ts";
import { which } from "../lib/host.ts";
import { getLinearClient, lazyLinearClient, readTicketArgument, writeOutput } from "../lib/util.ts";
import { workspaces, type WorkspaceProbe } from "../lib/workspaces.ts";
import { worktrees, type WorktreeDirtiness, type WorktreeEntry } from "../lib/worktrees.ts";
import { renderTicketCheckResult, type Section, type TicketCheck } from "./ticketCheck.ts";

/**
 * Placeholder state name passed to `decideVerdict` when the Linear section is
 * skipped via `--no-linear`. Synthesizing a `non-terminal` kind keeps the
 * verdict logic from falsely concluding `lost` simply because Linear status
 * was not consulted. The actual stateName value is not user-facing — verdicts
 * read `linear.kind` only, never `linear.stateName`.
 */
const LINEAR_SKIPPED_STATE_NAME = "(linear skipped)";

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

interface WorktreeSectionOutput {
  checks: TicketCheck[];
  status: WorktreeProbe;
  entry: WorktreeEntry | undefined;
}

async function probeWorktreeSection(
  deps: TicketStatusDependencies,
  ticket: string,
): Promise<WorktreeSectionOutput> {
  const entry = deps.findWorktree(ticket);
  if (entry === undefined) {
    return {
      checks: [
        {
          name: "Host worktree exists",
          status: "fail",
          detail: "no worktree found for this ticket",
        },
      ],
      status: { kind: "absent" },
      entry: undefined,
    };
  }
  const dirtiness = await deps.probeWorkingTree({ worktreeDir: entry.dir });
  const checks: TicketCheck[] = [{ name: "Host worktree exists", status: "ok", detail: entry.dir }];
  let status: WorktreeProbe;
  if (dirtiness.kind === "clean") {
    checks.push({ name: "Working tree clean", status: "ok" });
    status = { kind: "present-clean" };
  } else if (dirtiness.kind === "dirty") {
    checks.push({
      name: "Working tree clean",
      status: "fail",
      detail: `${dirtiness.modified} modified, ${dirtiness.untracked} untracked`,
    });
    status = {
      kind: "present-dirty",
      modified: dirtiness.modified,
      untracked: dirtiness.untracked,
    };
  } else {
    // dirtiness.kind === "unknown" — the third and final variant of WorktreeDirtiness.
    checks.push({ name: "Working tree clean", status: "skipped", detail: "could not inspect" });
    status = { kind: "present-unknown-dirtiness", reason: "git status failed" };
  }
  checks.push({ name: "Branch checked out", status: "ok", detail: entry.branchName });
  return { checks, status, entry };
}

interface WorkspaceSectionOutput {
  checks: TicketCheck[];
  workspaceName: string | undefined;
}

async function probeWorkspaceSection(
  deps: TicketStatusDependencies,
  ticket: string,
): Promise<WorkspaceSectionOutput> {
  const probe = await deps.probeWorkspaces();
  if (probe.kind === "unavailable") {
    return {
      checks: [
        { name: "Workspace pane open", status: "skipped", detail: "workspace probe unavailable" },
      ],
      workspaceName: undefined,
    };
  }
  if (probe.names.has(ticket)) {
    return {
      checks: [{ name: "Workspace pane open", status: "ok", detail: ticket }],
      workspaceName: ticket,
    };
  }
  return {
    checks: [
      { name: "Workspace pane open", status: "fail", detail: "no pane found for this ticket" },
    ],
    workspaceName: undefined,
  };
}

function repoDirFromEntry(entry: WorktreeEntry, deps: TicketStatusDependencies): string {
  return `${deps.config.workspace.projectDir}/${entry.repository}`;
}

interface LocalBranchSectionOutput {
  checks: TicketCheck[];
  skipReason: string;
  probe: LocalBranchProbe;
  branch: string | undefined;
}

async function probeLocalBranchSection(
  deps: TicketStatusDependencies,
  entry: WorktreeEntry | undefined,
): Promise<LocalBranchSectionOutput> {
  if (entry === undefined) {
    return {
      checks: [],
      skipReason: "repo dir unresolved",
      probe: { kind: "absent" },
      branch: undefined,
    };
  }
  const repoDir = repoDirFromEntry(entry, deps);
  const probe = await deps.probeLocalBranch({
    repoDir,
    branch: entry.branchName,
    defaultBranch: deps.config.git.defaultBranch,
  });
  if (probe.kind === "present") {
    const defaultBranchName = probe.defaultBranch ?? deps.config.git.defaultBranch;
    return {
      checks: [
        {
          name: "Local branch exists",
          status: "ok",
          detail: `${entry.branchName}, ${probe.ahead} ahead / ${probe.behind} behind origin/${defaultBranchName}`,
        },
      ],
      skipReason: "",
      probe,
      branch: entry.branchName,
    };
  }
  if (probe.kind === "absent") {
    return {
      checks: [{ name: "Local branch exists", status: "fail", detail: "branch not in git" }],
      skipReason: "",
      probe,
      branch: entry.branchName,
    };
  }
  // probe.kind === "unknown"
  return {
    checks: [{ name: "Local branch exists", status: "skipped", detail: probe.reason }],
    skipReason: "",
    probe,
    branch: entry.branchName,
  };
}

interface RemoteBranchSectionOutput {
  checks: TicketCheck[];
  skipReason: string;
  probe: RemoteBranchProbe;
}

async function probeRemoteBranchSection(
  deps: TicketStatusDependencies,
  entry: WorktreeEntry | undefined,
): Promise<RemoteBranchSectionOutput> {
  if (entry === undefined) {
    return { checks: [], skipReason: "repo dir unresolved", probe: { kind: "absent" } };
  }
  const repoDir = repoDirFromEntry(entry, deps);
  const probe = await deps.probeRemoteBranch({
    repoDir,
    branch: entry.branchName,
    doFetch: deps.doFetch,
  });
  if (probe.kind === "present") {
    return { checks: [{ name: "Branch present on origin", status: "ok" }], skipReason: "", probe };
  }
  if (probe.kind === "absent") {
    return {
      checks: [{ name: "Branch present on origin", status: "fail", detail: "not pushed" }],
      skipReason: "",
      probe,
    };
  }
  // probe.kind === "unknown"
  return {
    checks: [{ name: "Branch present on origin", status: "skipped", detail: probe.reason }],
    skipReason: "",
    probe,
  };
}

interface PullRequestSectionOutput {
  checks: TicketCheck[];
  skipReason: string;
  probe: PullRequestProbe;
}

async function probePullRequestSection(
  deps: TicketStatusDependencies,
  entry: WorktreeEntry | undefined,
): Promise<PullRequestSectionOutput> {
  if (entry === undefined) {
    return { checks: [], skipReason: "repo dir unresolved", probe: { kind: "absent" } };
  }
  const repoDir = repoDirFromEntry(entry, deps);
  const probe = await deps.probePullRequest({ repoDir, branch: entry.branchName });
  if (probe.kind === "open" || probe.kind === "merged") {
    return {
      checks: [
        {
          name: "Open PR for this branch",
          status: "ok",
          detail: `#${probe.number} ${probe.url}`,
        },
      ],
      skipReason: "",
      probe,
    };
  }
  if (probe.kind === "absent") {
    return {
      checks: [{ name: "Open PR for this branch", status: "fail", detail: "none found" }],
      skipReason: "",
      probe,
    };
  }
  if (probe.kind === "gh-missing") {
    return {
      checks: [
        { name: "Open PR for this branch", status: "skipped", detail: "gh CLI not on PATH" },
      ],
      skipReason: "",
      probe,
    };
  }
  // probe.kind === "unknown"
  return {
    checks: [{ name: "Open PR for this branch", status: "skipped", detail: probe.reason }],
    skipReason: "",
    probe,
  };
}

/**
 * Pure-with-async orchestrator that gathers per-section checks and a single
 * recovery verdict for a ticket. All I/O happens via injected probes — the
 * function itself does no filesystem, network, or stdout work.
 */
export async function ticketStatus(deps: TicketStatusDependencies): Promise<TicketStatusResult> {
  // The Linear probe wants the uppercase form (Linear's API treats ticket ids
  // as uppercase canonically). All local-state probes — worktree dirs,
  // workspace pane names, and branch-name fallbacks — are derived from the
  // lowercase ticket convention used by `setupWorkspaceCli` (it passes
  // `ticket.toLowerCase()` to `setupWorkspace`, which becomes both the worktree
  // dir suffix and the workspace `name`). Mixing cases here is the root cause
  // of the "no worktree found" bug when the user types `--ticket HRD-442`.
  const upperTicket = deps.ticket.toUpperCase();
  const lowerTicket = deps.ticket.toLowerCase();
  const skipReasons = emptySkipReasons();

  const linearResult = await probeLinear(deps, upperTicket);
  skipReasons.linear = linearResult.skipReason;

  const worktreeResult = await probeWorktreeSection(deps, lowerTicket);
  const workspaceResult = await probeWorkspaceSection(deps, lowerTicket);
  const localResult = await probeLocalBranchSection(deps, worktreeResult.entry);
  const remoteResult = await probeRemoteBranchSection(deps, worktreeResult.entry);
  const prResult = await probePullRequestSection(deps, worktreeResult.entry);
  skipReasons.localBranch = localResult.skipReason;
  skipReasons.remoteBranch = remoteResult.skipReason;
  skipReasons.pullRequest = prResult.skipReason;

  // Mapping `skipped → non-terminal (LINEAR_SKIPPED_STATE_NAME)` is intentional:
  // when `--no-linear` suppresses the Linear probe we do not want the verdict
  // logic to falsely conclude `lost` simply because Linear status was not
  // consulted. `decideVerdict` reads `linear.kind` only — the placeholder
  // stateName is never surfaced to the user.
  const linearForVerdict: LinearStatusProbe =
    linearResult.status.kind === "skipped"
      ? { kind: "non-terminal", stateName: LINEAR_SKIPPED_STATE_NAME }
      : linearResult.status;

  const verdict = decideVerdict({
    linear: linearForVerdict,
    worktree: worktreeResult.status,
    localBranch: localResult.probe,
    remoteBranch: remoteResult.probe,
    pullRequest: prResult.probe,
    branch: worktreeResult.entry?.branchName ?? lowerTicket,
    worktreeDir: worktreeResult.entry?.dir,
    workspaceName: workspaceResult.workspaceName,
  });

  return {
    ticket: upperTicket,
    ...(linearResult.title === undefined ? {} : { title: linearResult.title }),
    linear: linearResult.checks,
    worktree: worktreeResult.checks,
    workspace: workspaceResult.checks,
    localBranch: localResult.checks,
    remoteBranch: remoteResult.checks,
    pullRequest: prResult.checks,
    skipReasons,
    verdict,
  };
}

// ───────── CLI surface ─────────

export interface StatusArguments {
  ticket: string;
  doLinear: boolean;
  doFetch: boolean;
}

export function parseStatusArguments(argv: string[]): StatusArguments {
  let ticket: string | undefined;
  let doLinear = true;
  let doFetch = true;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--ticket") {
      ticket = readTicketArgument(argv, index, "status");
      index += 1;
      continue;
    }
    if (argument === "--no-linear") {
      doLinear = false;
      continue;
    }
    if (argument === "--no-fetch") {
      doFetch = false;
      continue;
    }
    /* v8 ignore next @preserve -- index < argv.length guarantees argument is defined; nullish guard satisfies the TS string|undefined index type */
    throw new Error(`crew status: unknown argument: ${argument ?? "<empty>"}`);
  }
  if (ticket === undefined) {
    throw new Error("crew status: --ticket <ticket> is required");
  }
  return { ticket, doLinear, doFetch };
}

function formatVerdict(verdict: StatusVerdict): string {
  switch (verdict.kind) {
    case "pr-open": {
      return `→ pr-open: ${verdict.url} (#${verdict.number})`;
    }
    case "pr-merged": {
      return `→ pr-merged: ${verdict.url} (#${verdict.number})`;
    }
    case "in-flight": {
      return `→ in-flight: ${verdict.reason}`;
    }
    case "recoverable": {
      return `→ recoverable: ${verdict.reason}; ${verdict.nextStep}`;
    }
    case "lost": {
      return `→ lost: ${verdict.reason}`;
    }
    /* v8 ignore next 3 @preserve -- exhaustive over StatusVerdict.kind */
    default: {
      return `→ ${(verdict satisfies never as StatusVerdict).kind}`;
    }
  }
}

export function renderTicketStatusResult(result: TicketStatusResult): string[] {
  const sections: Section[] = [
    {
      name: "Linear",
      checks: result.linear,
      ...(result.skipReasons.linear === "" ? {} : { skipReason: result.skipReasons.linear }),
    },
    {
      name: "Worktree",
      checks: result.worktree,
      ...(result.skipReasons.worktree === "" ? {} : { skipReason: result.skipReasons.worktree }),
    },
    {
      name: "Workspace",
      checks: result.workspace,
      ...(result.skipReasons.workspace === "" ? {} : { skipReason: result.skipReasons.workspace }),
    },
    {
      name: "Local branch",
      checks: result.localBranch,
      ...(result.skipReasons.localBranch === ""
        ? {}
        : { skipReason: result.skipReasons.localBranch }),
    },
    {
      name: "Remote branch",
      checks: result.remoteBranch,
      ...(result.skipReasons.remoteBranch === ""
        ? {}
        : { skipReason: result.skipReasons.remoteBranch }),
    },
    {
      name: "Pull request",
      checks: result.pullRequest,
      ...(result.skipReasons.pullRequest === ""
        ? {}
        : { skipReason: result.skipReasons.pullRequest }),
    },
  ];
  return renderTicketCheckResult({
    command: "status",
    ticket: result.ticket,
    ...(result.title === undefined ? {} : { title: result.title }),
    sections,
    verdict: formatVerdict(result.verdict),
  });
}

/* v8 ignore start @preserve -- production wiring; covered indirectly by Task 11 smoke test */
export async function ticketStatusCli(argv: string[]): Promise<void> {
  const parsed = parseStatusArguments(argv);
  const ok = await runTicketStatus(parsed);
  if (!ok) {
    process.exitCode = 1;
  }
}

export async function runTicketStatus(parsed: StatusArguments): Promise<boolean> {
  const config = await loadConfig();
  const linearClient = lazyLinearClient(getLinearClient);
  const fetchRawIssue = parsed.doLinear
    ? async ({ ticket }: { ticket: string }) =>
        await fetchRawLinearIssue({ client: linearClient(), ticket })
    : undefined;

  const result = await ticketStatus({
    config,
    ticket: parsed.ticket,
    fetchRawIssue,
    findWorktree: (ticket) => worktrees.findByTicket(config, ticket)[0],
    probeWorkspaces: async () => await workspaces.probe(config),
    probeWorkingTree: async ({ worktreeDir }) => await worktrees.probeWorkingTree({ worktreeDir }),
    probeLocalBranch: probeLocalBranchImpl,
    probeRemoteBranch: probeRemoteBranchImpl,
    probePullRequest: probePullRequestImpl,
    doFetch: parsed.doFetch,
  });

  for (const line of renderTicketStatusResult(result)) {
    writeOutput(line);
  }
  return result.verdict.kind === "pr-open" || result.verdict.kind === "pr-merged";
}

// ───── production probes ─────

async function probeLocalBranchImpl(input: {
  repoDir: string;
  branch: string;
  defaultBranch: string;
}): Promise<LocalBranchProbe> {
  if (!existsSync(input.repoDir)) {
    return { kind: "unknown", reason: `repo dir not found: ${input.repoDir}` };
  }

  // Does the branch exist locally? `rev-parse --verify -q` exits 0 if so.
  try {
    await runCommandAsync("git", [
      "-C",
      input.repoDir,
      "rev-parse",
      "--verify",
      "-q",
      input.branch,
    ]);
  } catch {
    return { kind: "absent" };
  }

  // ahead/behind vs origin/<defaultBranch>. Output format: "<ahead>\t<behind>".
  try {
    const output = await runCommandAsync("git", [
      "-C",
      input.repoDir,
      "rev-list",
      "--left-right",
      "--count",
      `${input.branch}...origin/${input.defaultBranch}`,
    ]);
    const [aheadString, behindString] = output.trim().split(/\s+/);
    const ahead = Number.parseInt(aheadString ?? "0", 10);
    const behind = Number.parseInt(behindString ?? "0", 10);
    return { kind: "present", ahead, behind, defaultBranch: input.defaultBranch };
  } catch {
    // origin/<defaultBranch> missing (no fetch yet) or other git error — the
    // branch IS present, we just cannot compute counts. Report 0/0.
    return { kind: "present", ahead: 0, behind: 0, defaultBranch: input.defaultBranch };
  }
}

async function probeRemoteBranchImpl(input: {
  repoDir: string;
  branch: string;
  doFetch: boolean;
}): Promise<RemoteBranchProbe> {
  if (!existsSync(input.repoDir)) {
    return { kind: "unknown", reason: `repo dir not found: ${input.repoDir}` };
  }

  if (input.doFetch) {
    try {
      await runCommandAsync("git", [
        "-C",
        input.repoDir,
        "fetch",
        "--quiet",
        "origin",
        input.branch,
      ]);
    } catch {
      // Best-effort fetch. ls-remote below is the authoritative check.
    }
  }

  // ls-remote --exit-code exits 0 if the ref exists, 2 otherwise.
  try {
    await runCommandAsync("git", [
      "-C",
      input.repoDir,
      "ls-remote",
      "--exit-code",
      "origin",
      `refs/heads/${input.branch}`,
    ]);
    return { kind: "present" };
  } catch {
    return { kind: "absent" };
  }
}

async function probePullRequestImpl(input: {
  repoDir: string;
  branch: string;
}): Promise<PullRequestProbe> {
  const ghPath = await which("gh");
  if (ghPath === undefined) {
    return { kind: "gh-missing" };
  }

  let output: string;
  try {
    output = await runCommandAsync(
      "gh",
      [
        "pr",
        "list",
        "--head",
        input.branch,
        "--state",
        "all",
        "--json",
        "number,url,state,mergedAt",
      ],
      { cwd: input.repoDir },
    );
  } catch (error) {
    return {
      kind: "unknown",
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  try {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- gh's --json schema is fixed by our request fields (number,url,state,mergedAt)
    const parsed = JSON.parse(output) as {
      number: number;
      url: string;
      state: string;
      mergedAt: string | null;
    }[];
    const [first] = parsed;
    if (first === undefined) {
      return { kind: "absent" };
    }
    if (first.mergedAt !== null && first.mergedAt !== undefined) {
      return { kind: "merged", number: first.number, url: first.url };
    }
    if (first.state === "OPEN") {
      return { kind: "open", number: first.number, url: first.url };
    }
    return { kind: "absent" };
  } catch (error) {
    return {
      kind: "unknown",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
/* v8 ignore stop @preserve */
