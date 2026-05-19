/**
 * Pure eligibility classifier — takes the per-iteration board snapshot plus
 * derived state (worktrees, live workspaces, usage, slot count) and returns
 * a verdict per Todo ticket. No logging, no Linear calls, no shell-outs.
 *
 * The Dispatcher consumes the verdict list to drive logging and side
 * effects.
 */

import {
  AGENT_MAX_RETRIES_LABEL,
  AGENT_RETRIED_LABEL,
  type Blocker,
  type GroundcrewIssue,
  isTerminalStatus,
} from "../lib/boardSource.ts";
import { AGENT_ANY_MODEL, type ResolvedConfig } from "../lib/config.ts";
import type { UsageByModel } from "../lib/usage.ts";
import type { WorkspaceProbe } from "../lib/workspaces.ts";
import type { WorktreeEntry } from "../lib/worktrees.ts";

type SkipReason =
  | "blocked"
  | "blockers_paginated"
  | "agent_any_capacity"
  | "model_exhausted"
  | "workspace_list_unavailable"
  | "max_retries_exhausted";

export interface StartVerdict {
  kind: "start";
  issue: GroundcrewIssue;
  recovery: boolean;
  /**
   * Worktree on disk but no live workspace — caller must run setupWorkspace
   * (idempotent via `worktrees.ensure`) and treat any failure as a retry
   * exhaustion.
   */
  reopen: boolean;
  /** Set when the verdict resolved an `agent-any` label to a concrete model. */
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
   * Set when the skip event should carry the resolved model (i.e. the
   * verdict knew which model would have run). Omitted for blocker skips
   * and `agent_any_capacity` where the model was either unresolved or
   * irrelevant.
   */
  model?: string;
}

type Verdict = StartVerdict | SkipVerdict;

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
  usage: UsageByModel;
  /** Models flagged over `sessionLimitPercentage`. */
  exhausted: Set<string>;
  /** Maximum number of `start` verdicts to produce. */
  slots: number;
  dryRun: boolean;
}

interface BlockerClassification {
  unblocked: GroundcrewIssue[];
  skips: SkipVerdict[];
}

export type StrandAction =
  | {
      /**
       * First strand for this ticket: demote it back to Todo and mark
       * `agent-retried` so the next strand promotes to `retry_exhausted`.
       */
      kind: "demote";
      issue: GroundcrewIssue;
    }
  | {
      /**
       * Second strand: ticket already carries `agent-retried`. Stamp
       * `agent-error` + `agent-max-retries` and leave the slot occupied
       * so an operator can triage.
       */
      kind: "retry_exhausted";
      issue: GroundcrewIssue;
    };

interface StrandClassifyArguments {
  inProgress: readonly GroundcrewIssue[];
  worktreeEntries: readonly WorktreeEntry[];
  workspaceProbe: WorkspaceProbe;
}

/**
 * Detect In-Progress tickets whose worktree is still on disk but whose
 * cmux/tmux workspace has vanished. Each detection becomes a `demote` (first
 * strand) or `retry_exhausted` (second strand) action. Skipped when the
 * workspace probe is `unavailable` so a flaky adapter doesn't auto-demote
 * a healthy ticket.
 *
 * Pure — caller applies the returned side effects (Linear writes).
 */
export function classifyInProgressStrands(arguments_: StrandClassifyArguments): StrandAction[] {
  const { inProgress, worktreeEntries, workspaceProbe } = arguments_;
  if (workspaceProbe.kind === "unavailable") {
    return [];
  }
  const actions: StrandAction[] = [];
  for (const issue of inProgress) {
    const hasWorktree = worktreeEntries.some(
      (entry) => entry.repository === issue.repository && entry.ticket === issue.id,
    );
    if (!hasWorktree) {
      continue;
    }
    if (workspaceProbe.names.has(issue.id)) {
      continue;
    }
    if (issue.labels.includes(AGENT_MAX_RETRIES_LABEL)) {
      continue;
    }
    if (issue.labels.includes(AGENT_RETRIED_LABEL)) {
      actions.push({ kind: "retry_exhausted", issue });
      continue;
    }
    actions.push({ kind: "demote", issue });
  }
  return actions;
}

function blockerSummary(blocker: Blocker): string {
  return `${blocker.id}:${blocker.status ?? "missing"}`;
}

function blockerVerdictFor(
  issue: GroundcrewIssue,
  config: ResolvedConfig,
): SkipVerdict | undefined {
  if (issue.labels.includes(AGENT_MAX_RETRIES_LABEL)) {
    return {
      kind: "skip",
      issue,
      message: `Skipping ${issue.id}: ${AGENT_MAX_RETRIES_LABEL} label set — remove the label to re-enable dispatch`,
      eventReason: "max_retries_exhausted",
    };
  }
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

  const unresolved = issue.blockers.filter(
    (blocker) => blocker.status === undefined || !isTerminalStatus(blocker.status, config),
  );
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
 * Pick the configured model with the most available session capacity.
 * Models flagged exhausted (over `sessionLimitPercentage`) are excluded.
 * Score is `usage[model].session` with `null`/missing treated as 0
 * (maximum headroom), so when no usage data is available every model
 * ties at 0 and the default model wins the tiebreak — `agent-any` then
 * falls back to the default predictably.
 */
export function pickBestModel(
  config: ResolvedConfig,
  usage: UsageByModel,
  exhausted: Set<string>,
): string | undefined {
  const candidates = Object.keys(config.models.definitions).filter((name) => !exhausted.has(name));
  if (candidates.length === 0) {
    return undefined;
  }
  const scored = candidates.map((name) => ({ name, score: usage[name]?.session ?? 0 }));
  return scored.reduce((best, candidate) => {
    if (candidate.score < best.score) {
      return candidate;
    }
    if (candidate.score === best.score && candidate.name === config.models.default) {
      return candidate;
    }
    return best;
  }).name;
}

interface RecoveryArguments {
  issue: GroundcrewIssue;
  worktreeEntries: readonly WorktreeEntry[];
  workspaceProbe: WorkspaceProbe;
  dryRun: boolean;
}

// "Worktree exists but workspace gone" → reopen path so the orchestrator
// can rebuild the cmux/tmux window from the surviving worktree. The
// strand classifier on the In-Progress slice handles the demote that
// gets us here; an `unavailable` probe still skips so a transient adapter
// hiccup never promotes a healthy ticket to a reopen.
function classifyRecovery(
  arguments_: RecoveryArguments,
): { kind: "go"; recovery: boolean; reopen: boolean } | SkipVerdict {
  const { issue, worktreeEntries, workspaceProbe, dryRun } = arguments_;
  if (dryRun) {
    return { kind: "go", recovery: false, reopen: false };
  }

  const exists = worktreeEntries.some(
    (entry) => entry.repository === issue.repository && entry.ticket === issue.id,
  );
  if (!exists) {
    return { kind: "go", recovery: false, reopen: false };
  }
  if (workspaceProbe.kind === "unavailable") {
    return {
      kind: "skip",
      issue,
      message: `Skipping ${issue.id}: worktree exists but workspace list unavailable; will retry next tick`,
      eventReason: "workspace_list_unavailable",
    };
  }
  if (!workspaceProbe.names.has(issue.id)) {
    return { kind: "go", recovery: false, reopen: true };
  }
  return { kind: "go", recovery: true, reopen: false };
}

/**
 * Cheap pre-pass — partitions Todo into unblocked issues and blocker
 * skip verdicts. Runs before the dispatcher fetches usage or probes the
 * workspace adapter, so a board where every Todo is blocked short-circuits
 * without paying for either.
 */
export function classifyBlockers(
  config: ResolvedConfig,
  todo: readonly GroundcrewIssue[],
): BlockerClassification {
  const unblocked: GroundcrewIssue[] = [];
  const skips: SkipVerdict[] = [];
  for (const issue of todo) {
    const verdict = blockerVerdictFor(issue, config);
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
    if (original.model === AGENT_ANY_MODEL) {
      const picked = pickBestModel(config, usage, exhausted);
      if (picked === undefined) {
        verdicts.push({
          kind: "skip",
          issue: original,
          message: `Skipping ${original.id}: agent-any but no model has available capacity`,
          eventReason: "agent_any_capacity",
        });
        continue;
      }
      resolved = { ...original, model: picked };
      resolvedFromAny = true;
    }

    if (exhausted.has(resolved.model)) {
      verdicts.push({
        kind: "skip",
        issue: resolved,
        message: `Skipping ${resolved.id} (${resolved.model} session exhausted)`,
        eventReason: "model_exhausted",
        model: resolved.model,
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
      verdicts.push({ ...recovery, model: resolved.model });
      continue;
    }

    verdicts.push({
      kind: "start",
      issue: resolved,
      recovery: recovery.recovery,
      reopen: recovery.reopen,
      resolvedFromAny,
    });
    started += 1;
  }

  return verdicts;
}
