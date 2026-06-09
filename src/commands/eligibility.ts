/**
 * Pure eligibility classifier — takes the per-iteration board snapshot plus
 * derived state (worktrees, live workspaces, usage, slot count) and returns
 * a verdict per Todo task. No logging, no Linear calls, no shell-outs.
 *
 * The Dispatcher consumes the verdict list to drive logging and side
 * effects.
 */

import { AGENT_ANY, type ResolvedConfig } from "../lib/config.ts";
import { naturalIdFromCanonical, type Blocker, type GroundcrewIssue } from "../lib/taskSource.ts";
import type { UsageByAgent } from "../lib/usage.ts";
import type { WorkspaceProbe } from "../lib/workspaces.ts";
import type { WorktreeEntry } from "../lib/worktrees.ts";

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
  | "workspace_missing";

export interface StartVerdict {
  kind: "start";
  issue: GroundcrewIssue;
  recovery: boolean;
  /** Set when the verdict resolved an `agent-any` label to a concrete agent. */
  resolvedFromAny: boolean;
}

export interface SkipVerdict {
  kind: "skip";
  issue: GroundcrewIssue;
  /** Human log line. */
  message: string;
  /** Stable kebab-case enum surfaced as `logEvent.reason`. */
  eventReason: SkipReason;
  /** Set for `blocked` and `blockers_paginated`. */
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

export type AgentUsageExhaustion =
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
  worktreeEntries: readonly WorktreeEntry[];
  workspaceProbe: WorkspaceProbe;
  usage: UsageByAgent;
  /** Agents flagged over `sessionLimitPercentage`. */
  exhausted: Set<string>;
  /** Maximum number of `start` verdicts to produce. */
  slots: number;
  dryRun: boolean;
}

interface BlockerClassification {
  unblocked: GroundcrewIssue[];
  skips: SkipVerdict[];
}

function blockerSummary(blocker: Blocker): string {
  return `${blocker.id}:${blocker.status}`;
}

function blockerVerdictFor(issue: GroundcrewIssue): SkipVerdict | undefined {
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
      message: `Skipping ${issue.id}: worktree exists but no live workspace. Run \`crew cleanup ${naturalId}\` to allow re-provisioning.`,
      eventReason: "workspace_missing",
    };
  }
  return { kind: "go", recovery: true };
}

/**
 * Cheap pre-pass — partitions Todo into unblocked issues and blocker
 * skip verdicts. Runs before the dispatcher fetches usage or probes the
 * workspace adapter, so a board where every Todo is blocked short-circuits
 * without paying for either.
 */
export function classifyBlockers(todo: readonly GroundcrewIssue[]): BlockerClassification {
  const unblocked: GroundcrewIssue[] = [];
  const skips: SkipVerdict[] = [];
  for (const issue of todo) {
    const verdict = blockerVerdictFor(issue);
    if (verdict === undefined) {
      unblocked.push(issue);
    } else {
      skips.push(verdict);
    }
  }
  return { unblocked, skips };
}

/**
 * Eligibility verdicts for already-unblocked Todo issues — handles
 * agent-any resolution, session exhaustion, worktree/workspace recovery,
 * and slot capping. Pure: caller pre-fetches usage + workspaces and passes
 * the snapshots in.
 */
export function classifyEligibility(arguments_: ClassifyArguments): Verdict[] {
  const { config, unblocked, worktreeEntries, workspaceProbe, usage, exhausted, slots, dryRun } =
    arguments_;

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

    verdicts.push({
      kind: "start",
      issue: resolved,
      recovery: recovery.recovery,
      resolvedFromAny,
    });
    started += 1;
  }

  return verdicts;
}
