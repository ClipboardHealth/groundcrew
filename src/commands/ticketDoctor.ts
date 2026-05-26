// src/commands/ticketDoctor.ts
//
// `crew doctor --ticket <TICKET>` — single per-ticket diagnostic that covers
// both the pre-dispatch question ("will this dispatch on the next tick?") and
// the post-dispatch question ("what's already happened and what's left to
// do?"). Verdict precedence starts with PR outcomes, then handles run-state
// exceptions before ordinary local recovery:
//
//   pr-open > pr-merged
//     > failed-launch
//     > interrupted (unless concrete recoverable git work exists)
//     > in-flight > recoverable
//     > unresolvable > ineligible > would-dispatch > lost
//
// When a post-dispatch verdict fires, the Resolution and Eligibility sections
// are skipped — they describe pre-dispatch state that no longer matters.

import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  fetchBlockersForTicket,
  fetchInProgressIssueCount,
  fetchRawLinearIssue,
  isTerminalStateType,
  resolveModelFor,
  resolveRepositoryFor,
  type Blocker,
  type GroundcrewIssue,
  type RawLinearIssue,
} from "../lib/boardSource.ts";
import { runCommandAsync } from "../lib/commandRunner.ts";
import { resolveDefaultBranch } from "../lib/defaultBranch.ts";
import { AGENT_ANY_MODEL, loadConfig, type ResolvedConfig } from "../lib/config.ts";
import { which } from "../lib/host.ts";
import { readRunState, type RunState } from "../lib/runState.ts";
import { getUsageByModel, type UsageByModel } from "../lib/usage.ts";
import { getLinearClient, lazyLinearClient, writeOutput } from "../lib/util.ts";
import { workspaces, type WorkspaceAccessHint, type WorkspaceProbe } from "../lib/workspaces.ts";
import { worktrees, type WorktreeDirtiness, type WorktreeEntry } from "../lib/worktrees.ts";
import {
  classifyBlockers,
  classifyUsageExhaustion,
  pickBestModel,
  type ModelUsageExhaustion,
} from "./eligibility.ts";
import { renderTicketCheckResult, type Section, type TicketCheck } from "./ticketCheck.ts";

/**
 * Placeholder Linear state name used when `--no-linear` suppresses the Linear
 * probe. The verdict decision reads `linear.kind` only — this name is never
 * surfaced to the user.
 */
const LINEAR_SKIPPED_STATE_NAME = "(linear skipped)";

// ───────── verdict types ─────────

export type TicketDoctorVerdict =
  | { kind: "pr-open"; number: number; url: string }
  | { kind: "pr-merged"; number: number; url: string }
  | { kind: "interrupted"; reason: string; nextStep: string }
  | { kind: "failed-launch"; reason: string; nextStep: string }
  | { kind: "in-flight"; reason: string }
  | { kind: "recoverable"; reason: string; nextStep: string }
  | { kind: "would-dispatch" }
  | { kind: "ineligible"; reason: string }
  | { kind: "unresolvable"; reason: string }
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
  runState: RunState | undefined;
}

// ───────── post-dispatch verdict (PR / in-flight / recoverable) ─────────

function verdictInFlight(input: DecideVerdictInput): TicketDoctorVerdict | undefined {
  if (input.linear.kind !== "non-terminal") {
    return undefined;
  }
  const worktreePresent =
    input.worktree.kind === "present-clean" ||
    input.worktree.kind === "present-dirty" ||
    input.worktree.kind === "present-unknown-dirtiness";
  if (!worktreePresent) {
    return undefined;
  }
  /* v8 ignore next 3 @preserve -- callers always pass workspaceName or worktreeDir; defensive guard for the rare both-missing path */
  const where =
    input.workspaceName === undefined
      ? `worktree at ${input.worktreeDir ?? "<unknown>"}`
      : `workspace "${input.workspaceName}"`;
  return { kind: "in-flight", reason: `ticket is mid-flight in ${where}` };
}

function verdictRecoverable(input: DecideVerdictInput): TicketDoctorVerdict | undefined {
  if (input.worktree.kind === "present-dirty") {
    /* v8 ignore next @preserve -- a present worktree always has a worktreeDir; nullish guard is defensive */
    const where = input.worktreeDir ?? "<worktree>";
    return {
      kind: "recoverable",
      reason: `dirty worktree (${input.worktree.modified} modified, ${input.worktree.untracked} untracked)`,
      nextStep: `commit or stash in ${where}, then re-run \`crew doctor --ticket ${input.branch}\``,
    };
  }
  const worktreeIsClean =
    input.worktree.kind === "present-clean" || input.worktree.kind === "present-unknown-dirtiness";
  if (
    worktreeIsClean &&
    input.localBranch.kind === "present" &&
    input.remoteBranch.kind === "absent"
  ) {
    /* v8 ignore next @preserve -- a present worktree always has a worktreeDir; nullish guard is defensive */
    const where = input.worktreeDir ?? "<worktree>";
    return {
      kind: "recoverable",
      reason: `clean worktree with un-pushed local branch`,
      nextStep: `cd ${where}; git push -u origin ${input.branch}; gh pr create`,
    };
  }
  if (
    input.worktree.kind === "absent" &&
    input.remoteBranch.kind === "present" &&
    input.pullRequest.kind === "absent"
  ) {
    return {
      kind: "recoverable",
      reason: `remote branch exists without a PR`,
      nextStep: `gh pr create --head ${input.branch}`,
    };
  }
  if (input.worktree.kind === "absent" && input.localBranch.kind === "present") {
    return {
      kind: "recoverable",
      reason: `stranded local branch (no worktree)`,
      nextStep: `push the branch or delete it: \`git branch -D ${input.branch}\``,
    };
  }
  return undefined;
}

/**
 * Returns a post-dispatch verdict if the probe bundle matches one of the
 * "ticket has moved past dispatch" cases. Returns `undefined` otherwise,
 * signalling that the caller should fall through to the pre-dispatch path.
 *
 * Precedence: PR verdicts always win. Failed launches report before ordinary
 * local recovery. Interrupted runs report concrete recoverable git work first
 * when it exists, then fall back to `interrupted`. Ordinary post-dispatch cases
 * report in-flight before recoverable. Inside `recoverable`, dirty worktree
 * beats clean-with-un-pushed-local beats remote-only beats stranded local.
 */
export function decidePostDispatchVerdict(
  input: DecideVerdictInput,
): TicketDoctorVerdict | undefined {
  if (input.pullRequest.kind === "open") {
    return { kind: "pr-open", number: input.pullRequest.number, url: input.pullRequest.url };
  }
  if (input.pullRequest.kind === "merged") {
    return { kind: "pr-merged", number: input.pullRequest.number, url: input.pullRequest.url };
  }
  const recoverable = verdictRecoverable(input);
  if (input.runState?.state === "interrupted") {
    if (recoverable !== undefined) {
      return recoverable;
    }
    const detail = input.runState.reason ?? input.runState.detail ?? "workspace stopped";
    return {
      kind: "interrupted",
      reason: detail,
      nextStep: `run \`crew resume ${input.runState.ticket}\` or inspect ${input.runState.worktreeDir}`,
    };
  }
  if (input.runState?.state === "failed-to-launch") {
    const detail = input.runState.detail ?? "workspace launch failed";
    return {
      kind: "failed-launch",
      reason: detail,
      nextStep: `fix the launch failure, then run \`crew resume ${input.runState.ticket}\` or \`crew cleanup ${input.runState.ticket}\``,
    };
  }
  return verdictInFlight(input) ?? recoverable;
}

// ───────── orchestrator dependencies ─────────

export interface TicketDoctorDependencies {
  config: ResolvedConfig;
  ticket: string;
  /**
   * Injected to keep `ticketDoctor` pure and easy to unit-test. `undefined`
   * means the caller passed `--no-linear` — the Linear-backed pre-dispatch
   * checks (status, label, repo, eligibility) are all skipped.
   */
  fetchRawIssue: ((input: { ticket: string }) => Promise<RawLinearIssue>) | undefined;
  fetchBlockersFor: (input: { ticket: string; uuid: string }) => Promise<readonly Blocker[]>;
  fetchUsage: () => Promise<UsageByModel>;
  countInProgress: () => Promise<number>;
  findWorktree: (ticket: string) => WorktreeEntry | undefined;
  probeWorkspaces: () => Promise<WorkspaceProbe>;
  workspaceAccessHint: (name: string) => Promise<WorkspaceAccessHint | undefined>;
  probeWorkingTree: (input: { worktreeDir: string }) => Promise<WorktreeDirtiness>;
  /**
   * Resolves the default branch for `repoDir` (e.g. "master" vs "main") from
   * the local clone's `refs/remotes/<remote>/HEAD`, falling back to
   * `config.git.defaultBranch`. Injected so probeLocalBranchSection can pass a
   * per-repo branch into `probeLocalBranch` without each probe needing to
   * shell out to git itself.
   */
  resolveDefaultBranch: (input: { repoDir: string }) => Promise<string>;
  probeLocalBranch: (input: {
    repoDir: string;
    branch: string;
    remote: string;
    defaultBranch: string;
  }) => Promise<LocalBranchProbe>;
  probeRemoteBranch: (input: {
    repoDir: string;
    branch: string;
    remote: string;
    doFetch: boolean;
  }) => Promise<RemoteBranchProbe>;
  probePullRequest: (input: { repoDir: string; branch: string }) => Promise<PullRequestProbe>;
  readRunState: (ticket: string) => RunState | undefined;
  doFetch: boolean;
}

export interface TicketDoctorResult {
  ticket: string;
  title?: string;
  resolution: TicketCheck[];
  eligibility: TicketCheck[];
  runState: TicketCheck[];
  worktree: TicketCheck[];
  workspace: TicketCheck[];
  localBranch: TicketCheck[];
  remoteBranch: TicketCheck[];
  pullRequest: TicketCheck[];
  skipReasons: {
    resolution: string;
    eligibility: string;
    worktree: string;
    runState: string;
    workspace: string;
    localBranch: string;
    remoteBranch: string;
    pullRequest: string;
  };
  verdict: TicketDoctorVerdict;
}

function emptySkipReasons(): TicketDoctorResult["skipReasons"] {
  return {
    resolution: "",
    eligibility: "",
    worktree: "",
    runState: "",
    workspace: "",
    localBranch: "",
    remoteBranch: "",
    pullRequest: "",
  };
}

// ───────── pre-dispatch helpers (resolution + eligibility) ─────────

interface ModelResolutionResult {
  resolvedModel: string;
  checks: TicketCheck[];
}

function buildModelChecks(raw: RawLinearIssue, config: ResolvedConfig): ModelResolutionResult {
  const modelResolution = resolveModelFor({ labels: raw.labels, config });
  const checks: TicketCheck[] = [];
  switch (modelResolution.kind) {
    case "no-label": {
      checks.push({
        name: "Has agent-* label",
        status: "fail",
        detail: "no agent-* label on this ticket",
        failureSummary: "ticket has no agent-* label",
      });
      checks.push({ name: "Model resolves from agent-* label", status: "skipped" });
      break;
    }
    case "agent-any": {
      checks.push({
        name: "Has agent-* label",
        status: "ok",
        detail: "agent-any",
      });
      checks.push({
        name: "Model resolves from agent-* label",
        status: "ok",
        detail: `model picked at dispatch time; defaults to "${config.models.default}" when usage ties`,
      });
      break;
    }
    case "matched": {
      checks.push({
        name: "Has agent-* label",
        status: "ok",
        detail: `agent-${modelResolution.model}`,
      });
      checks.push({
        name: "Model resolves from agent-* label",
        status: "ok",
        detail: `model "${modelResolution.model}"`,
      });
      break;
    }
    case "disabled-fallback": {
      checks.push({
        name: "Has agent-* label",
        status: "ok",
        detail: `agent-${modelResolution.requestedModel}`,
      });
      checks.push({
        name: "Model resolves from agent-* label",
        status: "ok",
        detail: `agent-${modelResolution.requestedModel} disabled; falling back to model "${modelResolution.fallbackModel}"`,
      });
      break;
    }
    /* v8 ignore next @preserve */
    default: {
      break;
    }
  }
  let resolvedModel = config.models.default;
  if (modelResolution.kind === "matched") {
    resolvedModel = modelResolution.model;
  } else if (modelResolution.kind === "agent-any") {
    resolvedModel = AGENT_ANY_MODEL;
  } else if (modelResolution.kind === "disabled-fallback") {
    resolvedModel = modelResolution.fallbackModel;
  }
  return { resolvedModel, checks };
}

interface RepoResolutionResult {
  resolvedRepository: string;
  checks: TicketCheck[];
}

function buildRepoChecks(
  raw: RawLinearIssue,
  config: ResolvedConfig,
  ticket: string,
): RepoResolutionResult {
  const repositoryResolution = resolveRepositoryFor({
    description: raw.description,
    config,
    ticket,
  });
  const checks: TicketCheck[] = [];
  if (repositoryResolution.kind === "ok") {
    checks.push({
      name: "Description mentions known repo",
      status: "ok",
      detail: repositoryResolution.repository,
    });
    const repoDir = join(config.workspace.projectDir, repositoryResolution.repository);
    if (existsSync(repoDir)) {
      checks.push({
        name: "Resolved repo is cloned locally",
        status: "ok",
        detail: repoDir,
      });
    } else {
      checks.push({
        name: "Resolved repo is cloned locally",
        status: "fail",
        detail: `${repositoryResolution.repository} not found at ${repoDir} — run \`crew setup repos ${repositoryResolution.repository}\``,
        failureSummary: `resolved repo ${repositoryResolution.repository} is not cloned locally`,
      });
    }
  } else {
    checks.push({
      name: "Description mentions known repo",
      status: "fail",
      detail: `no entry from workspace.knownRepositories (${config.workspace.knownRepositories.join(", ")}) appears in description`,
      failureSummary: "description does not mention a known repo",
    });
    checks.push({
      name: "Resolved repo is cloned locally",
      status: "skipped",
    });
  }
  /* v8 ignore else @preserve -- resolved repository is empty only on the fail branch above; the field is only consumed on the ok path */
  const resolvedRepository =
    repositoryResolution.kind === "ok" ? repositoryResolution.repository : "";
  return { resolvedRepository, checks };
}

function buildChildrenCheck(raw: RawLinearIssue): TicketCheck {
  if (raw.hasChildren) {
    return {
      name: "Has no sub-issues",
      status: "fail",
      detail:
        "parent ticket with sub-issues — groundcrew works sub-issues, not parents; label a sub-issue or detach the children",
      failureSummary: "parent ticket with sub-issues — groundcrew works sub-issues, not parents",
    };
  }
  return { name: "Has no sub-issues", status: "ok" };
}

interface EligibilityCheckArguments {
  ticket: string;
  raw: RawLinearIssue;
  config: ResolvedConfig;
  resolvedRepository: string;
  resolvedModel: string;
  dependencies: TicketDoctorDependencies;
  eligibility: TicketCheck[];
}

async function runEligibilityChecks(arguments_: EligibilityCheckArguments): Promise<boolean> {
  const { ticket, raw, config, resolvedRepository, resolvedModel, dependencies, eligibility } =
    arguments_;

  const blockers = await dependencies.fetchBlockersFor({ ticket, uuid: raw.uuid });
  const groundcrewIssue: GroundcrewIssue = {
    id: ticket,
    uuid: raw.uuid,
    title: raw.title,
    status: raw.stateName,
    statusId: "",
    assignee: "",
    updatedAt: "",
    teamId: raw.teamId,
    /* v8 ignore next @preserve -- fetchRawLinearIssue always populates stateType (defaults to "") so the ?? guard is belt-and-suspenders */
    stateType: raw.stateType ?? "",
    repository: resolvedRepository,
    model: resolvedModel,
    blockers: [...blockers],
    hasMoreBlockers: raw.hasMoreBlockers,
  };

  const blockerClassification = classifyBlockers([groundcrewIssue]);
  const [firstSkip] = blockerClassification.skips;
  if (firstSkip !== undefined) {
    if (firstSkip.eventReason === "blockers_paginated") {
      eligibility.push({
        name: "No active blockers",
        status: "fail",
        detail: "blockers exceeded the v1 relation page size",
        failureSummary: "blockers exceeded the v1 relation page size",
      });
      return false;
    }
    /* v8 ignore next @preserve -- firstSkip.blockers is always set for "blocked" and "blockers_paginated" skip reasons */
    const blockerIds = firstSkip.blockers ?? [];
    eligibility.push({
      name: "No active blockers",
      status: "fail",
      detail: blockerIds.join(", "),
      failureSummary: `blocked by ${blockerIds.join(", ")}`,
    });
    return false;
  }
  eligibility.push({ name: "No active blockers", status: "ok" });

  const usage = await dependencies.fetchUsage();
  const usageExhaustion = classifyUsageExhaustion(config, usage);
  const exhausted = new Set(usageExhaustion.map((exhaustion) => exhaustion.model));
  let model = resolvedModel;
  let resolvedFromAny = "";
  if (model === AGENT_ANY_MODEL) {
    const picked = pickBestModel(config, usage, exhausted);
    if (picked === undefined) {
      eligibility.push({
        name: "Model usage under sessionLimitPercentage",
        status: "fail",
        detail: "agent-any but no model has available capacity",
        failureSummary: "agent-any has no model with available capacity",
      });
      return false;
    }
    model = picked;
    resolvedFromAny = `; agent-any resolved to model "${picked}"`;
  }

  const exhaustedUsage = usageExhaustion.find((exhaustion) => exhaustion.model === model);
  eligibility.push(
    exhaustedUsage === undefined
      ? modelUsageOkCheck({ config, model, usage, resolvedFromAny })
      : usageExhaustionCheck(exhaustedUsage),
  );

  const inProgress = await dependencies.countInProgress();
  const cap = config.orchestrator.maximumInProgress;
  const capOk = inProgress < cap;
  const capCheck: TicketCheck = {
    name: "In-progress cap not hit",
    status: capOk ? "ok" : "fail",
    detail: `${inProgress}/${cap} used`,
  };
  if (!capOk) {
    capCheck.failureSummary = `in-progress cap is full (${inProgress}/${cap} used)`;
  }
  eligibility.push(capCheck);

  return eligibility.every((check) => check.status === "ok");
}

function modelUsageOkCheck(arguments_: {
  config: ResolvedConfig;
  model: string;
  usage: UsageByModel;
  resolvedFromAny: string;
}): TicketCheck {
  const { config, model, usage, resolvedFromAny } = arguments_;
  const sessionPercent = ((usage[model]?.session ?? 0) * 100).toFixed(0);
  return {
    name: `Model "${model}" usage under sessionLimitPercentage`,
    status: "ok",
    detail: `${sessionPercent}% (limit ${config.orchestrator.sessionLimitPercentage}%)${resolvedFromAny}`,
  };
}

function usageExhaustionCheck(exhaustion: ModelUsageExhaustion): TicketCheck {
  if (exhaustion.kind === "session") {
    return {
      name: `Model "${exhaustion.model}" usage under sessionLimitPercentage`,
      status: "fail",
      detail: `${exhaustion.usedPercentage.toFixed(0)}% (limit ${exhaustion.limitPercentage}%)`,
      failureSummary: `${exhaustion.model} session usage ${exhaustion.usedPercentage.toFixed(0)}% over ${exhaustion.limitPercentage}% limit`,
    };
  }
  return {
    name: `Model "${exhaustion.model}" weekly usage within paced budget`,
    status: "fail",
    detail: `${exhaustion.usedPercentage.toFixed(1)}% (paced budget ${exhaustion.allowedPercentage.toFixed(1)}%, resets in ${exhaustion.resetMinutes}m)`,
    failureSummary: `${exhaustion.model} weekly usage ${exhaustion.usedPercentage.toFixed(1)}% over ${exhaustion.allowedPercentage.toFixed(1)}% paced budget`,
  };
}

interface LinearProbeOutput {
  linearStatus: LinearStatusProbe;
  resolution: TicketCheck[];
  title?: string;
  raw?: RawLinearIssue;
}

/**
 * Fetches Linear and adds the "Ticket exists in Linear" + status checks to
 * the resolution section. Returns the raw issue on success so the orchestrator
 * can continue with label/repo/eligibility. On failure, returns enough
 * context to render an `unresolvable` verdict.
 */
async function probeLinear(
  deps: TicketDoctorDependencies,
  upperTicket: string,
): Promise<LinearProbeOutput> {
  if (deps.fetchRawIssue === undefined) {
    return { linearStatus: { kind: "skipped" }, resolution: [] };
  }
  try {
    const raw = await deps.fetchRawIssue({ ticket: upperTicket });
    /* v8 ignore next @preserve -- fetchRawLinearIssue always populates stateType (defaults to "") so the ?? guard is belt-and-suspenders */
    const stateType = raw.stateType ?? "";
    const isTerminal = isTerminalStateType(stateType);
    const resolution: TicketCheck[] = [
      { name: "Ticket exists in Linear", status: "ok", detail: `"${raw.title}"` },
    ];
    if (stateType === "unstarted") {
      resolution.push({ name: "Status is Todo", status: "ok" });
    } else {
      resolution.push({
        name: "Status is Todo",
        status: "fail",
        detail: `current: ${raw.stateName}`,
        failureSummary: `status is ${raw.stateName} (state.type=${stateType}, need unstarted)`,
      });
    }
    return {
      linearStatus: { kind: isTerminal ? "terminal" : "non-terminal", stateName: raw.stateName },
      resolution,
      title: raw.title,
      raw,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      linearStatus: { kind: "unresolvable", reason: message },
      resolution: [{ name: "Ticket exists in Linear", status: "fail", detail: message }],
    };
  }
}

// ───────── post-dispatch helpers (worktree/workspace/branch/PR) ─────────

interface WorktreeSectionOutput {
  checks: TicketCheck[];
  status: WorktreeProbe;
  entry: WorktreeEntry | undefined;
}

interface RunStateSectionOutput {
  checks: TicketCheck[];
  state: RunState | undefined;
}

function probeRunStateSection(
  deps: TicketDoctorDependencies,
  ticket: string,
): RunStateSectionOutput {
  const state = deps.readRunState(ticket);
  if (state === undefined) {
    return {
      checks: [{ name: "Local run state", status: "skipped", detail: "none found" }],
      state: undefined,
    };
  }
  const checks: TicketCheck[] = [
    { name: "Local run state", status: "ok", detail: state.state },
    { name: "Recorded model", status: "ok", detail: state.model },
    { name: "Recorded worktree", status: "ok", detail: state.worktreeDir },
    { name: "Recorded branch", status: "ok", detail: state.branchName },
    { name: "Resume count", status: "ok", detail: String(state.resumeCount) },
  ];
  if (state.reason !== undefined) {
    checks.push({ name: "Last reason", status: "ok", detail: state.reason });
  }
  if (state.detail !== undefined) {
    checks.push({ name: "Last detail", status: "ok", detail: state.detail });
  }
  return { checks, state };
}

async function probeWorktreeSection(
  deps: TicketDoctorDependencies,
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
    // dirtiness.kind === "unknown"
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
  deps: TicketDoctorDependencies,
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
    const hint = await deps.workspaceAccessHint(ticket);
    const detail = hint === undefined ? ticket : `${ticket} — attach: \`${hint.command}\``;
    return {
      checks: [{ name: "Workspace pane open", status: "ok", detail }],
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

function repoDirFromEntry(entry: WorktreeEntry, deps: TicketDoctorDependencies): string {
  return `${deps.config.workspace.projectDir}/${entry.repository}`;
}

interface LocalBranchSectionOutput {
  checks: TicketCheck[];
  skipReason: string;
  probe: LocalBranchProbe;
  branch: string | undefined;
}

async function probeLocalBranchSection(
  deps: TicketDoctorDependencies,
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
  const defaultBranch = await deps.resolveDefaultBranch({ repoDir });
  const probe = await deps.probeLocalBranch({
    repoDir,
    branch: entry.branchName,
    remote: deps.config.git.remote,
    defaultBranch,
  });
  if (probe.kind === "present") {
    const defaultBranchName = probe.defaultBranch ?? deps.config.git.defaultBranch;
    return {
      checks: [
        {
          name: "Local branch exists",
          status: "ok",
          detail: `${entry.branchName}, ${probe.ahead} ahead / ${probe.behind} behind ${deps.config.git.remote}/${defaultBranchName}`,
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
  deps: TicketDoctorDependencies,
  entry: WorktreeEntry | undefined,
): Promise<RemoteBranchSectionOutput> {
  if (entry === undefined) {
    return { checks: [], skipReason: "repo dir unresolved", probe: { kind: "absent" } };
  }
  const repoDir = repoDirFromEntry(entry, deps);
  const checkName = `Branch present on ${deps.config.git.remote}`;
  const probe = await deps.probeRemoteBranch({
    repoDir,
    branch: entry.branchName,
    remote: deps.config.git.remote,
    doFetch: deps.doFetch,
  });
  if (probe.kind === "present") {
    return { checks: [{ name: checkName, status: "ok" }], skipReason: "", probe };
  }
  if (probe.kind === "absent") {
    return {
      checks: [{ name: checkName, status: "fail", detail: "not pushed" }],
      skipReason: "",
      probe,
    };
  }
  // probe.kind === "unknown"
  return {
    checks: [{ name: checkName, status: "skipped", detail: probe.reason }],
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
  deps: TicketDoctorDependencies,
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

// ───────── orchestrator ─────────

interface PreDispatchInput {
  ticket: string;
  raw: RawLinearIssue;
  config: ResolvedConfig;
  dependencies: TicketDoctorDependencies;
  statusCheckFailed: boolean;
  statusFailureSummary: string | undefined;
}

interface PreDispatchOutput {
  resolutionExtra: TicketCheck[];
  eligibility: TicketCheck[];
  verdict: TicketDoctorVerdict;
}

async function runPreDispatch(input: PreDispatchInput): Promise<PreDispatchOutput> {
  const { ticket, raw, config, dependencies } = input;
  const resolutionExtra: TicketCheck[] = [];
  const eligibility: TicketCheck[] = [];

  const { resolvedModel, checks: modelChecks } = buildModelChecks(raw, config);
  resolutionExtra.push(...modelChecks);

  // Children check comes before repo checks: a parent ticket is a
  // structural property of the issue itself (filtered out by `fetchBoard`,
  // so the dispatcher will never act on it). Reporting that first beats
  // surfacing "your repo isn't cloned" for a ticket groundcrew won't pick
  // up either way.
  resolutionExtra.push(buildChildrenCheck(raw));

  const { resolvedRepository, checks: repoChecks } = buildRepoChecks(raw, config, ticket);
  resolutionExtra.push(...repoChecks);

  if (input.statusCheckFailed) {
    /* v8 ignore next @preserve -- statusFailureSummary is always set when statusCheckFailed is true; nullish fallback is defensive */
    const reason = input.statusFailureSummary ?? "status not Todo";
    return { resolutionExtra, eligibility, verdict: { kind: "ineligible", reason } };
  }
  const resolutionFail = resolutionExtra.find((check) => check.status === "fail");
  if (resolutionFail !== undefined) {
    /* v8 ignore next @preserve -- failureSummary is always set on resolution fail paths; .name fallback is defensive */
    const reason = resolutionFail.failureSummary ?? resolutionFail.name;
    return { resolutionExtra, eligibility, verdict: { kind: "ineligible", reason } };
  }

  const allEligibilityOk = await runEligibilityChecks({
    ticket,
    raw,
    config,
    resolvedRepository,
    resolvedModel,
    dependencies,
    eligibility,
  });
  if (!allEligibilityOk) {
    const firstEligibilityFail = eligibility.find((check) => check.status === "fail");
    /* v8 ignore next 4 @preserve -- firstEligibilityFail is always defined when allEligibilityOk is false; fallback is defensive */
    const reason =
      firstEligibilityFail?.failureSummary ??
      firstEligibilityFail?.name ??
      "eligibility check failed";
    return { resolutionExtra, eligibility, verdict: { kind: "ineligible", reason } };
  }
  return { resolutionExtra, eligibility, verdict: { kind: "would-dispatch" } };
}

/**
 * Pure-with-async orchestrator that gathers all sections plus the verdict.
 * All I/O happens via injected probes — the function itself does no
 * filesystem, network, or stdout work.
 */
export async function ticketDoctor(
  dependencies: TicketDoctorDependencies,
): Promise<TicketDoctorResult> {
  // Linear's GraphQL API treats ticket ids as uppercase. Local-state probes —
  // worktree dirs, workspace pane names, branch-name fallbacks — are derived
  // from the lowercase convention set by `setupWorkspaceCli`. Mixing cases is
  // the root cause of "no worktree found" when the user types `--ticket
  // HRD-442`.
  const upperTicket = dependencies.ticket.toUpperCase();
  const lowerTicket = dependencies.ticket.toLowerCase();
  const skipReasons = emptySkipReasons();

  const linearResult = await probeLinear(dependencies, upperTicket);
  const resolution: TicketCheck[] = [...linearResult.resolution];

  const runStateResult = probeRunStateSection(dependencies, lowerTicket);
  const worktreeResult = await probeWorktreeSection(dependencies, lowerTicket);
  const workspaceResult = await probeWorkspaceSection(dependencies, lowerTicket);
  const localResult = await probeLocalBranchSection(dependencies, worktreeResult.entry);
  const remoteResult = await probeRemoteBranchSection(dependencies, worktreeResult.entry);
  const prResult = await probePullRequestSection(dependencies, worktreeResult.entry);
  skipReasons.localBranch = localResult.skipReason;
  skipReasons.remoteBranch = remoteResult.skipReason;
  skipReasons.pullRequest = prResult.skipReason;

  // `--no-linear` synthesizes a non-terminal kind so the in-flight check can
  // still fire from local state alone. The placeholder name is read only by
  // `decidePostDispatchVerdict` and never surfaced to the user.
  const linearForVerdict: LinearStatusProbe =
    linearResult.linearStatus.kind === "skipped"
      ? { kind: "non-terminal", stateName: LINEAR_SKIPPED_STATE_NAME }
      : linearResult.linearStatus;

  const postVerdict = decidePostDispatchVerdict({
    linear: linearForVerdict,
    worktree: worktreeResult.status,
    localBranch: localResult.probe,
    remoteBranch: remoteResult.probe,
    pullRequest: prResult.probe,
    branch: worktreeResult.entry?.branchName ?? lowerTicket,
    worktreeDir: worktreeResult.entry?.dir,
    workspaceName: workspaceResult.workspaceName,
    runState: runStateResult.state,
  });

  if (postVerdict !== undefined) {
    skipReasons.resolution = "post-dispatch — pre-dispatch checks are irrelevant";
    skipReasons.eligibility = "post-dispatch — pre-dispatch checks are irrelevant";
    return buildResult({
      upperTicket,
      title: linearResult.title,
      resolution,
      eligibility: [],
      runStateResult,
      worktreeResult,
      workspaceResult,
      localResult,
      remoteResult,
      prResult,
      skipReasons,
      verdict: postVerdict,
    });
  }

  // No post-dispatch verdict. Decide pre-dispatch path.
  if (linearResult.linearStatus.kind === "skipped") {
    // --no-linear with nothing locally actionable → lost. We cannot reach
    // Linear, so the pre-dispatch resolution/eligibility checks are unavailable.
    skipReasons.resolution = "--no-linear";
    skipReasons.eligibility = "--no-linear";
    return buildResult({
      upperTicket,
      title: linearResult.title,
      resolution,
      eligibility: [],
      runStateResult,
      worktreeResult,
      workspaceResult,
      localResult,
      remoteResult,
      prResult,
      skipReasons,
      verdict: {
        kind: "lost",
        reason: `no local state and no PR — re-dispatch via \`crew run --ticket ${lowerTicket}\` or move the ticket back to Todo in Linear`,
      },
    });
  }

  if (linearResult.linearStatus.kind === "unresolvable") {
    const { reason } = linearResult.linearStatus;
    skipReasons.eligibility = "ticket unresolved";
    return buildResult({
      upperTicket,
      title: linearResult.title,
      resolution,
      eligibility: [],
      runStateResult,
      worktreeResult,
      workspaceResult,
      localResult,
      remoteResult,
      prResult,
      skipReasons,
      verdict: { kind: "unresolvable", reason },
    });
  }

  // After the skipped/unresolvable branches above, linearStatus.kind is either
  // "terminal" or "non-terminal", both of which carry the raw issue. TS can't
  // see the invariant through the union, so we narrow with an explicit guard.
  const { raw } = linearResult;
  /* v8 ignore next 3 @preserve -- raw is defined whenever linearStatus.kind is terminal/non-terminal; the guard is for type narrowing only */
  if (raw === undefined) {
    throw new Error(
      "ticketDoctor: invariant violated — raw Linear issue missing after status check",
    );
  }
  // The "Status is Todo" check was already pushed by `probeLinear`; surface it
  // as the verdict reason if it failed.
  const statusCheck = resolution.find((check) => check.name === "Status is Todo");
  const statusCheckFailed = statusCheck?.status === "fail";
  const preDispatch = await runPreDispatch({
    ticket: upperTicket,
    raw,
    config: dependencies.config,
    dependencies,
    statusCheckFailed,
    statusFailureSummary: statusCheck?.failureSummary,
  });
  resolution.push(...preDispatch.resolutionExtra);
  if (preDispatch.eligibility.length === 0 && preDispatch.verdict.kind === "ineligible") {
    skipReasons.eligibility = "resolution checks failed";
  }

  return buildResult({
    upperTicket,
    title: linearResult.title,
    resolution,
    eligibility: preDispatch.eligibility,
    runStateResult,
    worktreeResult,
    workspaceResult,
    localResult,
    remoteResult,
    prResult,
    skipReasons,
    verdict: preDispatch.verdict,
  });
}

interface BuildResultInput {
  upperTicket: string;
  title: string | undefined;
  resolution: TicketCheck[];
  eligibility: TicketCheck[];
  runStateResult: RunStateSectionOutput;
  worktreeResult: WorktreeSectionOutput;
  workspaceResult: WorkspaceSectionOutput;
  localResult: LocalBranchSectionOutput;
  remoteResult: RemoteBranchSectionOutput;
  prResult: PullRequestSectionOutput;
  skipReasons: TicketDoctorResult["skipReasons"];
  verdict: TicketDoctorVerdict;
}

function buildResult(input: BuildResultInput): TicketDoctorResult {
  return {
    ticket: input.upperTicket,
    ...(input.title === undefined ? {} : { title: input.title }),
    resolution: input.resolution,
    eligibility: input.eligibility,
    runState: input.runStateResult.checks,
    worktree: input.worktreeResult.checks,
    workspace: input.workspaceResult.checks,
    localBranch: input.localResult.checks,
    remoteBranch: input.remoteResult.checks,
    pullRequest: input.prResult.checks,
    skipReasons: input.skipReasons,
    verdict: input.verdict,
  };
}

// ───────── CLI surface ─────────

interface TicketDoctorArguments {
  ticket: string;
  doLinear: boolean;
  doFetch: boolean;
}

/**
 * Parses optional `--no-linear` and `--no-fetch` flags that follow
 * `crew doctor --ticket <id>`. The ticket id is consumed by `cli.ts` before
 * this point.
 */
export function parseTicketDoctorFlags(argv: string[]): { doLinear: boolean; doFetch: boolean } {
  let doLinear = true;
  let doFetch = true;
  for (const argument of argv) {
    if (argument === "--no-linear") {
      doLinear = false;
      continue;
    }
    if (argument === "--no-fetch") {
      doFetch = false;
      continue;
    }
    throw new Error(`crew doctor --ticket: unknown argument: ${argument}`);
  }
  return { doLinear, doFetch };
}

function formatVerdict(verdict: TicketDoctorVerdict): string {
  switch (verdict.kind) {
    case "pr-open": {
      return `→ pr-open: ${verdict.url} (#${verdict.number})`;
    }
    case "pr-merged": {
      return `→ pr-merged: ${verdict.url} (#${verdict.number})`;
    }
    case "interrupted": {
      return `→ interrupted: ${verdict.reason}; ${verdict.nextStep}`;
    }
    case "failed-launch": {
      return `→ failed-launch: ${verdict.reason}; ${verdict.nextStep}`;
    }
    case "in-flight": {
      return `→ in-flight: ${verdict.reason}`;
    }
    case "recoverable": {
      return `→ recoverable: ${verdict.reason}; ${verdict.nextStep}`;
    }
    case "would-dispatch": {
      return "→ would be dispatched on next tick";
    }
    case "ineligible": {
      return `→ ineligible: ${verdict.reason}`;
    }
    case "unresolvable": {
      return `→ unresolvable: ${verdict.reason}`;
    }
    case "lost": {
      return `→ lost: ${verdict.reason}`;
    }
    /* v8 ignore next 3 @preserve -- exhaustive over TicketDoctorVerdict.kind */
    default: {
      return `→ ${(verdict satisfies never as TicketDoctorVerdict).kind}`;
    }
  }
}

export function renderTicketDoctorResult(result: TicketDoctorResult): string[] {
  const sections: Section[] = [
    {
      name: "Resolution",
      checks: result.resolution,
      ...(result.skipReasons.resolution === ""
        ? {}
        : { skipReason: result.skipReasons.resolution }),
    },
    {
      name: "Eligibility",
      checks: result.eligibility,
      ...(result.skipReasons.eligibility === ""
        ? {}
        : { skipReason: result.skipReasons.eligibility }),
    },
    {
      name: "Run state",
      checks: result.runState,
      ...(result.skipReasons.runState === "" ? {} : { skipReason: result.skipReasons.runState }),
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
    command: "doctor --ticket",
    argument: result.ticket,
    ...(result.title === undefined ? {} : { title: result.title }),
    sections,
    verdict: formatVerdict(result.verdict),
  });
}

/* v8 ignore start @preserve -- production wiring; covered by integration smoke tests */
export async function runTicketDoctor(parsed: TicketDoctorArguments): Promise<boolean> {
  const config = await loadConfig();
  const linearClient = lazyLinearClient(getLinearClient);
  const fetchRawIssue = parsed.doLinear
    ? async ({ ticket }: { ticket: string }) =>
        await fetchRawLinearIssue({ client: linearClient(), ticket })
    : undefined;

  const result = await ticketDoctor({
    config,
    ticket: parsed.ticket,
    fetchRawIssue,
    fetchBlockersFor: async ({ ticket, uuid }) =>
      await fetchBlockersForTicket({ client: linearClient(), ticket, uuid }),
    fetchUsage: async () => await getUsageByModel(config),
    countInProgress: async () => await fetchInProgressIssueCount({ client: linearClient() }),
    findWorktree: (ticket) => worktrees.findByTicket(config, ticket)[0],
    probeWorkspaces: async () => await workspaces.probe(config),
    workspaceAccessHint: async (name) => await workspaces.accessHint(config, name),
    probeWorkingTree: async ({ worktreeDir }) => await worktrees.probeWorkingTree({ worktreeDir }),
    resolveDefaultBranch: async ({ repoDir }) =>
      await resolveDefaultBranch({
        repoDir,
        remote: config.git.remote,
        fallback: config.git.defaultBranch,
      }),
    probeLocalBranch: probeLocalBranchImpl,
    probeRemoteBranch: probeRemoteBranchImpl,
    probePullRequest: probePullRequestImpl,
    readRunState: (ticket) => readRunState(config, ticket),
    doFetch: parsed.doFetch,
  });

  for (const line of renderTicketDoctorResult(result)) {
    writeOutput(line);
  }
  return (
    result.verdict.kind === "would-dispatch" ||
    result.verdict.kind === "pr-open" ||
    result.verdict.kind === "pr-merged"
  );
}

// ───── production probes ─────

/**
 * Reads the numeric exit status that `normalizeCommandError` in
 * `commandRunner.ts` includes in failed-command error messages as
 * `Exit status: <N>`. Returns undefined when no such line is present.
 */
function parseExitStatus(error: unknown): number | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }
  const match = /Exit status: (\d+)/.exec(error.message);
  if (match === null || match[1] === undefined) {
    return undefined;
  }
  return Number.parseInt(match[1], 10);
}

async function probeLocalBranchImpl(input: {
  repoDir: string;
  branch: string;
  remote: string;
  defaultBranch: string;
}): Promise<LocalBranchProbe> {
  if (!existsSync(input.repoDir)) {
    return { kind: "unknown", reason: `repo dir not found: ${input.repoDir}` };
  }

  try {
    await runCommandAsync("git", [
      "-C",
      input.repoDir,
      "rev-parse",
      "--verify",
      "-q",
      input.branch,
    ]);
  } catch (error) {
    if (parseExitStatus(error) === 1) {
      return { kind: "absent" };
    }
    return {
      kind: "unknown",
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  try {
    const output = await runCommandAsync("git", [
      "-C",
      input.repoDir,
      "rev-list",
      "--left-right",
      "--count",
      `${input.branch}...${input.remote}/${input.defaultBranch}`,
    ]);
    const [aheadString, behindString] = output.trim().split(/\s+/);
    const ahead = Number.parseInt(aheadString ?? "0", 10);
    const behind = Number.parseInt(behindString ?? "0", 10);
    return { kind: "present", ahead, behind, defaultBranch: input.defaultBranch };
  } catch {
    return { kind: "present", ahead: 0, behind: 0, defaultBranch: input.defaultBranch };
  }
}

async function probeRemoteBranchImpl(input: {
  repoDir: string;
  branch: string;
  remote: string;
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
        input.remote,
        input.branch,
      ]);
    } catch {
      // Best-effort fetch; ls-remote below is the authoritative check.
    }
  }

  try {
    await runCommandAsync("git", [
      "-C",
      input.repoDir,
      "ls-remote",
      "--exit-code",
      input.remote,
      `refs/heads/${input.branch}`,
    ]);
    return { kind: "present" };
  } catch (error) {
    if (parseExitStatus(error) === 2) {
      return { kind: "absent" };
    }
    return {
      kind: "unknown",
      reason: error instanceof Error ? error.message : String(error),
    };
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
    if (parsed.length === 0) {
      return { kind: "absent" };
    }
    const open = parsed.find((pullRequest) => pullRequest.state === "OPEN");
    if (open !== undefined) {
      return { kind: "open", number: open.number, url: open.url };
    }
    const merged = parsed.find(
      (pullRequest) => pullRequest.mergedAt !== null && pullRequest.mergedAt !== undefined,
    );
    if (merged !== undefined) {
      return { kind: "merged", number: merged.number, url: merged.url };
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
