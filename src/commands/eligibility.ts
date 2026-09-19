/**
 * Pure eligibility classifier — takes the per-iteration board snapshot plus
 * derived state (worktrees, live workspaces, usage, slot count) and returns
 * a verdict per Todo task. No logging, no Linear calls, no shell-outs of its
 * own: the one exception is the stacking decision in `classifyBlockers`,
 * which reads the blocker's run state and probes its branch's availability.
 * Both effects are routed through the injectable `EligibilityDeps` so
 * callers can fake them the way the rest of the codebase fakes git.
 * `probeParentBranch` also logs at WARN on a persistent `ls-remote` failure —
 * the one logging exception, kept because a silent auth failure would
 * otherwise hide forever behind the optimistic "unpushed, retry" verdict.
 *
 * The Dispatcher consumes the verdict list to drive logging and side
 * effects.
 */

import { runCommandAsync } from "../lib/commandRunner.ts";
import { AGENT_ANY, type ResolvedConfig } from "../lib/config.ts";
import { readRunState, type RunState } from "../lib/runState.ts";
import { naturalIdFromCanonical, type Blocker, type GroundcrewIssue } from "../lib/taskSource.ts";
import type { UsageByAgent } from "../lib/usage.ts";
import { errorMessage, log } from "../lib/util.ts";
import type { WorkspaceProbe } from "../lib/workspaces.ts";
import { localBranchExists, resolveRepoDir, type WorktreeEntry } from "../lib/worktrees.ts";

const PERCENT_FRACTION_DIVISOR = 100;
const DAYS_PER_WEEK = 7;
const MINUTES_PER_DAY = 24 * 60;
const MINUTES_PER_WEEK = DAYS_PER_WEEK * MINUTES_PER_DAY;

type SkipReason =
  | "blocked"
  | "blockers_paginated"
  | "agent_any_capacity"
  | "agent_exhausted"
  | "workspace_list_unavailable"
  | "workspace_missing"
  | "stack_multiple_blockers"
  | "stack_parent_unknown"
  | "stack_parent_unpushed"
  | "stack_cross_repo_blocker"
  | "stack_provisioned_repo"
  | "stack_opted_out";

export interface StartVerdict {
  kind: "start";
  issue: GroundcrewIssue;
  recovery: boolean;
  /** Set when the verdict resolved an `agent-any` label to a concrete agent. */
  resolvedFromAny: boolean;
  /** Parent branch this task's worktree and PR should be based on, when stacked. */
  baseBranch?: string;
  /** Natural (unprefixed) id of the blocker task this task is stacked on. */
  parentTask?: string;
}

export interface SkipVerdict {
  kind: "skip";
  issue: GroundcrewIssue;
  /** Human log line. */
  message: string;
  /** Stable kebab-case enum surfaced as `logEvent.reason`. */
  eventReason: SkipReason;
  /** Set for `blocked`, `blockers_paginated`, and every `stack_*` reason. */
  blockers?: string[];
  /**
   * Set when the skip event should carry the resolved agent (i.e. the
   * verdict knew which agent would have run). Omitted for blocker skips
   * and `agent_any_capacity` where the agent was either unresolved or
   * irrelevant.
   */
  agent?: string;
}

type Verdict = StartVerdict | SkipVerdict;

/** A stacking decision for a single blocked issue: where its branch and PR should be based. */
interface StackDecision {
  baseBranch: string;
  parentTask: string;
}

interface StackVerdict extends StackDecision {
  kind: "stack";
  issue: GroundcrewIssue;
}

/**
 * Result of probing a parent branch's availability for stacking (spec
 * section 8's error table):
 *
 * - `"pushed"`: `git ls-remote` finds the branch on the remote.
 * - `"unpushed"`: the branch may still show up — either `ls-remote` came
 *   back empty but a local branch of the same name exists (the parent's
 *   agent hasn't pushed yet), or the `ls-remote` probe itself failed
 *   (network/auth). Both retry next tick under the same optimistic reason.
 * - `"unknown"`: the branch is missing both locally and on the remote, so it
 *   will never appear (deleted, or the parent's run-state file is stale).
 */
type BranchAvailability = "pushed" | "unpushed" | "unknown";

/**
 * Side-effecting boundary for the stacking decision — the only I/O
 * `classifyBlockers` performs. Production uses the real run-state reader and
 * a `git ls-remote`/local-branch probe; tests substitute fakes instead of
 * mocking modules.
 */
export interface EligibilityDeps {
  readParentRunState: (config: ResolvedConfig, task: string) => RunState | undefined;
  probeParentBranch: (arguments_: {
    repoDir: string;
    remote: string;
    branch: string;
  }) => Promise<BranchAvailability>;
}

async function isBranchOnRemote(arguments_: {
  repoDir: string;
  remote: string;
  branch: string;
}): Promise<boolean | undefined> {
  try {
    const output = await runCommandAsync("git", [
      "-C",
      arguments_.repoDir,
      "ls-remote",
      "--heads",
      arguments_.remote,
      arguments_.branch,
    ]);
    return output.length > 0;
  } catch (error) {
    // Network/auth failures are common and expected (retried next tick), but
    // silent forever would hide a persistent auth failure. WARN once per
    // branch per tick — probeParentBranch is memoized per branch within a
    // single classifyBlockers call, so this can't spam.
    log(
      `Stack parent branch probe failed for ${arguments_.branch}; treating as unpushed and retrying next tick: ${errorMessage(error)}`,
    );
    return undefined;
  }
}

async function probeParentBranch(arguments_: {
  repoDir: string;
  remote: string;
  branch: string;
}): Promise<BranchAvailability> {
  const onRemote = await isBranchOnRemote(arguments_);
  if (onRemote === true) {
    return "pushed";
  }
  if (onRemote === undefined) {
    return "unpushed";
  }
  return (await localBranchExists(arguments_.repoDir, arguments_.branch)) ? "unpushed" : "unknown";
}

/**
 * Memoizes `probeParentBranch` by branch for the lifetime of a single
 * `classifyBlockers` call, so N siblings blocked by the same parent do one
 * `git ls-remote` probe instead of N. Wrapping happens fresh per call — the
 * cache must never survive past one dispatcher tick, or a since-pushed
 * branch could keep reading as unpushed.
 */
function memoizedProbeParentBranch(
  probeParentBranchDep: EligibilityDeps["probeParentBranch"],
): EligibilityDeps["probeParentBranch"] {
  const cache = new Map<string, ReturnType<EligibilityDeps["probeParentBranch"]>>();
  return async (arguments_) => {
    const cached = cache.get(arguments_.branch);
    if (cached !== undefined) {
      return await cached;
    }
    const probe = probeParentBranchDep(arguments_);
    cache.set(arguments_.branch, probe);
    return await probe;
  };
}

export const defaultEligibilityDeps: EligibilityDeps = {
  readParentRunState: readRunState,
  probeParentBranch,
};

export type AgentUsageExhaustion =
  | {
      kind: "unavailable";
      agent: string;
      reason: string;
    }
  | {
      kind: "session";
      agent: string;
      usedPercentage: number;
      limitPercentage: number;
      resetMinutes: number | null;
    }
  | {
      kind: "weekly";
      agent: string;
      usedPercentage: number;
      allowedPercentage: number;
      resetMinutes: number;
    };

export interface ClassifyArguments {
  config: ResolvedConfig;
  /**
   * Issues already filtered through `classifyBlockers` — the blocker
   * pre-pass runs on a separate path so dispatcher can short-circuit
   * (skipping the codexbar usage HTTP call and the cmux/tmux shell-out)
   * when every Todo is blocked.
   */
  unblocked: readonly GroundcrewIssue[];
  /** Stacking decisions from `classifyBlockers`, keyed by `issue.id`. Defaults to empty (no stacking). */
  stackDecisions?: ReadonlyMap<string, StackDecision>;
  worktreeEntries: readonly WorktreeEntry[];
  workspaceProbe: WorkspaceProbe;
  usage: UsageByAgent;
  /** Agents flagged over `sessionLimitPercentage`. */
  exhausted: Set<string>;
  /** Maximum number of `start` verdicts to produce. */
  slots: number;
  dryRun: boolean;
}

export interface BlockerClassification {
  unblocked: GroundcrewIssue[];
  /** Stacking decisions for issues in `unblocked` that stack on a parent, keyed by `issue.id`. */
  stackDecisions: ReadonlyMap<string, StackDecision>;
  skips: SkipVerdict[];
}

function blockerSummary(blocker: Blocker): string {
  return `${blocker.id}:${blocker.status}`;
}

function stackSkip(
  issue: GroundcrewIssue,
  blockers: readonly Blocker[],
  eventReason: SkipReason,
  message: string,
): SkipVerdict {
  return {
    kind: "skip",
    issue,
    message,
    eventReason,
    blockers: blockers.map(blockerSummary),
  };
}

type RunStatesByTask = ReadonlyMap<string, RunState | undefined>;

function normalizedTaskId(task: string): string {
  return task.toLowerCase();
}

function readBlockerRunStates(
  blockers: readonly Blocker[],
  config: ResolvedConfig,
  deps: EligibilityDeps,
): RunStatesByTask {
  return new Map(
    blockers.map((blocker) => {
      const task = naturalIdFromCanonical(blocker.id);
      return [normalizedTaskId(task), deps.readParentRunState(config, task)];
    }),
  );
}

/**
 * Every task reachable from `start` by following `parentTask` links, read
 * lazily so intermediate ancestors that are not themselves blockers (already
 * merged, or never blocking this issue) still connect the chain. The visited
 * set is the cycle guard.
 */
function stackAncestorsOf(
  start: string,
  runStates: RunStatesByTask,
  config: ResolvedConfig,
  deps: EligibilityDeps,
): Set<string> {
  const ancestors = new Set<string>();
  let current = runStates.get(start);
  while (current?.parentTask !== undefined) {
    const parent = normalizedTaskId(current.parentTask);
    if (ancestors.has(parent) || parent === start) {
      break;
    }
    ancestors.add(parent);
    current = runStates.has(parent)
      ? runStates.get(parent)
      : deps.readParentRunState(config, current.parentTask);
  }
  return ancestors;
}

/**
 * With several unresolved blockers, the child can still stack when they form
 * a chain: exactly one blocker (the tip) has every other blocker among its
 * stack ancestors, so its branch already carries all of their work. Siblings
 * off the default branch have no single base and yield `undefined`.
 */
function chainTipOf(
  blockers: readonly Blocker[],
  runStates: RunStatesByTask,
  config: ResolvedConfig,
  deps: EligibilityDeps,
): Blocker | undefined {
  const candidates = blockers.map((blocker) => ({
    blocker,
    task: normalizedTaskId(naturalIdFromCanonical(blocker.id)),
  }));
  const tips = candidates.filter(({ task }) => {
    const ancestors = stackAncestorsOf(task, runStates, config, deps);
    return candidates.every((other) => other.task === task || ancestors.has(other.task));
  });
  const [tip, ...rest] = tips;
  return rest.length === 0 ? tip?.blocker : undefined;
}

/**
 * The stacking check from the stacked-PRs design (spec section 1). Cheap,
 * dependency-free checks (provisioner, opt-out label) run before the
 * run-state reads, which run before the `git ls-remote` probe, so a task that
 * fails early never pays for the network call. Multiple unresolved blockers
 * stack only when they form a chain (see `chainTipOf`).
 */
async function stackDecisionFor(
  issue: GroundcrewIssue,
  unresolved: readonly Blocker[],
  config: ResolvedConfig,
  deps: EligibilityDeps,
): Promise<StackVerdict | SkipVerdict> {
  const repositoryEntry = config.workspace.repositories.find(
    (entry) => entry.name === issue.repository,
  );
  if (repositoryEntry?.provision !== undefined) {
    return stackSkip(
      issue,
      unresolved,
      "stack_provisioned_repo",
      `Skipping ${issue.id}: stacking is refused for scripted-provisioner repositories`,
    );
  }
  if (issue.stacking === "opted-out") {
    return stackSkip(
      issue,
      unresolved,
      "stack_opted_out",
      `Skipping ${issue.id}: opted out of stacking via the groundcrew-no-stack label`,
    );
  }

  const runStates = readBlockerRunStates(unresolved, config, deps);
  const foreign = unresolved.filter((blocker) => {
    const repository = runStates.get(
      normalizedTaskId(naturalIdFromCanonical(blocker.id)),
    )?.repository;
    return repository !== undefined && repository !== issue.repository;
  });
  if (foreign.length > 0) {
    return stackSkip(
      issue,
      unresolved,
      "stack_cross_repo_blocker",
      `Skipping ${issue.id}: blocked by ${foreign.map(blockerSummary).join(", ")} in another repository; a branch cannot stack across repositories`,
    );
  }

  const [singleBlocker] = unresolved;
  const blocker =
    unresolved.length === 1 ? singleBlocker : chainTipOf(unresolved, runStates, config, deps);
  if (blocker === undefined) {
    return stackSkip(
      issue,
      unresolved,
      "stack_multiple_blockers",
      `Skipping ${issue.id}: blocked by ${unresolved.map(blockerSummary).join(", ")}, which do not form a single stack`,
    );
  }
  return await stackOntoBlocker(issue, blocker, runStates, config, deps);
}

async function stackOntoBlocker(
  issue: GroundcrewIssue,
  blocker: Blocker,
  runStates: RunStatesByTask,
  config: ResolvedConfig,
  deps: EligibilityDeps,
): Promise<StackVerdict | SkipVerdict> {
  const parentTask = naturalIdFromCanonical(blocker.id);
  const parentRunState = runStates.get(normalizedTaskId(parentTask));
  if (parentRunState === undefined) {
    return stackSkip(
      issue,
      [blocker],
      "stack_parent_unknown",
      `Skipping ${issue.id}: blocker ${parentTask} has no run state in repository ${issue.repository}`,
    );
  }

  const availability = await deps.probeParentBranch({
    repoDir: resolveRepoDir(config, issue.repository),
    remote: config.git.remote,
    branch: parentRunState.branchName,
  });
  if (availability === "unknown") {
    return stackSkip(
      issue,
      [blocker],
      "stack_parent_unknown",
      `Skipping ${issue.id}: blocker ${parentTask}'s branch ${parentRunState.branchName} is missing locally and on the remote`,
    );
  }
  if (availability === "unpushed") {
    return stackSkip(
      issue,
      [blocker],
      "stack_parent_unpushed",
      `Skipping ${issue.id}: blocker ${parentTask}'s branch isn't pushed yet`,
    );
  }

  return { kind: "stack", issue, baseBranch: parentRunState.branchName, parentTask };
}

async function blockerVerdictFor(
  issue: GroundcrewIssue,
  config: ResolvedConfig,
  deps: EligibilityDeps,
): Promise<SkipVerdict | StackVerdict | undefined> {
  if (issue.hasMoreBlockers) {
    const blockers = issue.blockers.map(blockerSummary);
    return {
      kind: "skip",
      issue,
      message: `Skipping ${issue.id}: blockers exceeded the v1 relation page size; verify blockers manually before dispatch`,
      eventReason: "blockers_paginated",
      blockers,
    };
  }

  const unresolved = issue.blockers.filter((blocker) => blocker.status !== "done");
  if (unresolved.length === 0) {
    return undefined;
  }

  if (config.git.stacking === true) {
    return await stackDecisionFor(issue, unresolved, config, deps);
  }

  const blockers = unresolved.map(blockerSummary);
  return {
    kind: "skip",
    issue,
    message: `Skipping ${issue.id}: blocked by ${blockers.join(", ")}`,
    eventReason: "blocked",
    blockers,
  };
}

/**
 * Pick the configured agent with the most available session capacity.
 * Agents flagged exhausted (over `sessionLimitPercentage`) are excluded.
 * Score is `usage[agent].session` with `null`/missing treated as 0
 * (maximum headroom), so when no usage data is available every agent
 * ties at 0 and the default agent wins the tiebreak — `agent-any` then
 * falls back to the default predictably.
 */
export function pickBestAgent(
  config: ResolvedConfig,
  usage: UsageByAgent,
  exhausted: Set<string>,
): string | undefined {
  const candidates = Object.keys(config.agents.definitions).filter((name) => !exhausted.has(name));
  if (candidates.length === 0) {
    return undefined;
  }
  const scored = candidates.map((name) => ({ name, score: usage[name]?.session ?? 0 }));
  return scored.reduce((best, candidate) => {
    if (candidate.score < best.score) {
      return candidate;
    }
    if (candidate.score === best.score && candidate.name === config.agents.default) {
      return candidate;
    }
    return best;
  }).name;
}

function weeklyPacedBudgetPercentage(weekEndDuration: number): number {
  const elapsedMinutes = Math.min(
    MINUTES_PER_WEEK,
    Math.max(0, MINUTES_PER_WEEK - weekEndDuration),
  );
  const elapsedDayCount = Math.ceil(elapsedMinutes / MINUTES_PER_DAY);
  const budgetDayCount = Math.min(DAYS_PER_WEEK, Math.max(1, elapsedDayCount));

  return (budgetDayCount / DAYS_PER_WEEK) * PERCENT_FRACTION_DIVISOR;
}

export function classifyUsageExhaustion(
  config: ResolvedConfig,
  usage: UsageByAgent,
): AgentUsageExhaustion[] {
  const exhausted: AgentUsageExhaustion[] = [];
  const sessionLimit = config.orchestrator.sessionLimitPercentage;
  for (const [agent, snapshot] of Object.entries(usage)) {
    if (snapshot.unavailableReason !== undefined) {
      exhausted.push({
        kind: "unavailable",
        agent,
        reason: snapshot.unavailableReason,
      });
      continue;
    }
    if (snapshot.session !== null && snapshot.session * PERCENT_FRACTION_DIVISOR > sessionLimit) {
      exhausted.push({
        kind: "session",
        agent,
        usedPercentage: snapshot.session * PERCENT_FRACTION_DIVISOR,
        limitPercentage: sessionLimit,
        resetMinutes: snapshot.sessionEndDuration,
      });
    }
    // Weekly gate paces total weekly usage against day buckets from the
    // weekly reset. Day 1's budget is available immediately after rollover,
    // then each later day opens another 1/7 of the weekly budget.
    if (
      snapshot.weekly !== null &&
      Number.isFinite(snapshot.weekly) &&
      snapshot.weekEndDuration !== null
    ) {
      const usedPercentage = snapshot.weekly * PERCENT_FRACTION_DIVISOR;
      const allowedPercentage = weeklyPacedBudgetPercentage(snapshot.weekEndDuration);
      if (usedPercentage > allowedPercentage) {
        exhausted.push({
          kind: "weekly",
          agent,
          usedPercentage,
          allowedPercentage,
          resetMinutes: snapshot.weekEndDuration,
        });
      }
    }
  }
  return exhausted;
}

interface RecoveryArguments {
  issue: GroundcrewIssue;
  worktreeEntries: readonly WorktreeEntry[];
  workspaceProbe: WorkspaceProbe;
  dryRun: boolean;
}

// Stale worktrees with no matching live workspace are filtered out here so
// they don't permanently block later tasks in the Todo queue.
function classifyRecovery(
  arguments_: RecoveryArguments,
): { kind: "go"; recovery: boolean } | SkipVerdict {
  const { issue, worktreeEntries, workspaceProbe, dryRun } = arguments_;
  if (dryRun) {
    return { kind: "go", recovery: false };
  }

  const naturalId = naturalIdFromCanonical(issue.id);
  const exists = worktreeEntries.some(
    (entry) => entry.repository === issue.repository && entry.task === naturalId,
  );
  if (!exists) {
    return { kind: "go", recovery: false };
  }
  if (workspaceProbe.kind === "unavailable") {
    return {
      kind: "skip",
      issue,
      message: `Skipping ${issue.id}: worktree exists but workspace list unavailable; will retry next tick`,
      eventReason: "workspace_list_unavailable",
    };
  }
  if (!workspaceProbe.names.has(naturalId)) {
    return {
      kind: "skip",
      issue,
      message: `Skipping ${issue.id}: worktree exists but no live workspace. Run 'crew cleanup ${naturalId}' to allow re-provisioning.`,
      eventReason: "workspace_missing",
    };
  }
  return { kind: "go", recovery: true };
}

/**
 * Cheap pre-pass — partitions Todo into unblocked issues (including those
 * stacking on a single unresolved blocker, per `stackDecisions`) and blocker
 * skip verdicts. Runs before the dispatcher fetches usage or probes the
 * workspace adapter, so a board where every Todo is blocked short-circuits
 * without paying for either. `config.git.stacking` off reproduces today's
 * behavior exactly and performs no run-state reads or git calls.
 */
export async function classifyBlockers(
  todo: readonly GroundcrewIssue[],
  config: ResolvedConfig,
  deps: EligibilityDeps = defaultEligibilityDeps,
): Promise<BlockerClassification> {
  const unblocked: GroundcrewIssue[] = [];
  const skips: SkipVerdict[] = [];
  const stackDecisions = new Map<string, StackDecision>();
  // Scoped to this call only: memoizing probeParentBranch across ticks would
  // let a since-pushed branch keep reading as unpushed indefinitely.
  const memoizedDeps: EligibilityDeps = {
    ...deps,
    probeParentBranch: memoizedProbeParentBranch(deps.probeParentBranch),
  };
  for (const issue of todo) {
    // oxlint-disable-next-line no-await-in-loop -- one blocker check at a time mirrors the dispatcher's own "one workspace at a time" git serialization
    const verdict = await blockerVerdictFor(issue, config, memoizedDeps);
    if (verdict === undefined) {
      unblocked.push(issue);
    } else if (verdict.kind === "stack") {
      unblocked.push(issue);
      stackDecisions.set(issue.id, {
        baseBranch: verdict.baseBranch,
        parentTask: verdict.parentTask,
      });
    } else {
      skips.push(verdict);
    }
  }
  return { unblocked, stackDecisions, skips };
}

/**
 * Eligibility verdicts for already-unblocked Todo issues — handles
 * agent-any resolution, session exhaustion, worktree/workspace recovery,
 * and slot capping. Pure: caller pre-fetches usage + workspaces and passes
 * the snapshots in.
 */
export function classifyEligibility(arguments_: ClassifyArguments): Verdict[] {
  const {
    config,
    unblocked,
    stackDecisions = new Map<string, StackDecision>(),
    worktreeEntries,
    workspaceProbe,
    usage,
    exhausted,
    slots,
    dryRun,
  } = arguments_;

  const verdicts: Verdict[] = [];
  let started = 0;

  for (const original of unblocked) {
    if (started >= slots) {
      // Slot cap reached — stop classifying further issues. Today's
      // dispatcher behaves the same: it stops scanning Todo issues once the
      // slot count is filled, so unreached issues never produce a verdict.
      break;
    }

    let resolved = original;
    let resolvedFromAny = false;
    if (original.agent === AGENT_ANY) {
      const picked = pickBestAgent(config, usage, exhausted);
      if (picked === undefined) {
        verdicts.push({
          kind: "skip",
          issue: original,
          message: `Skipping ${original.id}: agent-any but no agent has available capacity`,
          eventReason: "agent_any_capacity",
        });
        continue;
      }
      resolved = { ...original, agent: picked };
      resolvedFromAny = true;
    }

    if (exhausted.has(resolved.agent)) {
      verdicts.push({
        kind: "skip",
        issue: resolved,
        message: `Skipping ${resolved.id} (${resolved.agent} session exhausted)`,
        eventReason: "agent_exhausted",
        agent: resolved.agent,
      });
      continue;
    }

    const recovery = classifyRecovery({
      issue: resolved,
      worktreeEntries,
      workspaceProbe,
      dryRun,
    });
    if (recovery.kind === "skip") {
      verdicts.push({ ...recovery, agent: resolved.agent });
      continue;
    }

    const stackDecision = stackDecisions.get(resolved.id);
    verdicts.push({
      kind: "start",
      issue: resolved,
      recovery: recovery.recovery,
      resolvedFromAny,
      ...(stackDecision === undefined
        ? {}
        : { baseBranch: stackDecision.baseBranch, parentTask: stackDecision.parentTask }),
    });
    started += 1;
  }

  return verdicts;
}
