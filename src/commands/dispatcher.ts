/**
 * Per-iteration decider that picks Todo tickets to start and acts on the
 * picks. One per `orchestrate()` invocation; reuses its team-state cache
 * across iterations within an invocation.
 *
 * Pure verdict logic lives in `eligibility.ts`; this module is responsible
 * for telemetry, Linear writes, and side-effecting setupWorkspace calls.
 */

import type { LinearClient } from "@linear/sdk";

import {
  AGENT_ERROR_LABEL,
  AGENT_MAX_RETRIES_LABEL,
  AGENT_RETRIED_LABEL,
  type BoardState,
  type GroundcrewIssue,
  isGroundcrewIssue,
} from "../lib/boardSource.ts";
import type { ResolvedConfig } from "../lib/config.ts";
import { createLinearIssueStatusUpdater } from "../lib/linearIssueStatus.ts";
import type { UsageByModel } from "../lib/usage.ts";
import { errorMessage, log, logEvent } from "../lib/util.ts";
import { type WorkspaceProbe, workspaces } from "../lib/workspaces.ts";
import type { WorktreeEntry } from "../lib/worktrees.ts";
import {
  classifyBlockers,
  classifyEligibility,
  classifyInProgressStrands,
  classifyUsageExhaustion,
  type ModelUsageExhaustion,
  type SkipVerdict,
  type StartVerdict,
  type StrandAction,
} from "./eligibility.ts";
import { setupWorkspace } from "./setupWorkspace.ts";

interface DispatcherDeps {
  config: ResolvedConfig;
  client: LinearClient;
}

export interface Dispatcher {
  runOnce(arguments_: {
    state: BoardState;
    worktreeEntries: readonly WorktreeEntry[];
    /** Lazy so dispatcher can early-return on idle ticks without paying the codexbar shell-out. */
    usage: (signal?: AbortSignal) => Promise<UsageByModel>;
    dryRun: boolean;
    signal?: AbortSignal;
  }): Promise<void>;
}

export function createDispatcher(deps: DispatcherDeps): Dispatcher {
  const { config, client } = deps;
  const issueStatusUpdater = createLinearIssueStatusUpdater({ config, client });

  function buildExhaustedSet(usage: UsageByModel): Set<string> {
    const exhausted = new Set<string>();
    for (const exhaustion of classifyUsageExhaustion(config, usage)) {
      exhausted.add(exhaustion.model);
      log(formatUsageExhaustion(exhaustion));
    }
    return exhausted;
  }

  function logSkip(verdict: SkipVerdict): void {
    log(verdict.message);
    logEvent("dispatch", {
      outcome: "skipped",
      reason: verdict.eventReason,
      ticket: verdict.issue.id,
      blockers: verdict.blockers,
      model: verdict.model,
    });
  }

  async function startEligibleIssue(
    start: StartVerdict,
    dryRun: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    const { issue, recovery, reopen } = start;
    if (start.resolvedFromAny) {
      log(`Resolved agent-any for ${issue.id} → ${issue.model}`);
    }

    if (dryRun) {
      log(
        /* v8 ignore next @preserve -- classifyTodo forces recovery=false in dry-run, so the resume branch can't fire here */
        `[dry-run] Would ${recovery ? "resume" : "start"} ${issue.id} in ${issue.repository} (${issue.model})`,
      );
      logEvent("dispatch", {
        outcome: "skipped",
        reason: "dry_run",
        ticket: issue.id,
        model: issue.model,
        repository: issue.repository,
      });
      return;
    }

    try {
      if (recovery) {
        log(`Worktree and workspace already exist for ${issue.id}; resuming with markInProgress`);
      } else {
        if (reopen) {
          log(
            `Reopening workspace for stranded ${issue.id}; setupWorkspace will reuse the existing worktree`,
          );
        }
        const setupOptions = {
          repository: issue.repository,
          ticket: issue.id,
          model: issue.model,
          reuseWorktree: reopen,
        };
        await (signal === undefined
          ? setupWorkspace(config, setupOptions)
          : setupWorkspace(config, setupOptions, { signal }));
      }
      await issueStatusUpdater.markInProgress(issue);
      logEvent("dispatch", {
        outcome: dispatchOutcome(recovery, reopen),
        ticket: issue.id,
        model: issue.model,
        repository: issue.repository,
      });
    } catch (error) {
      const message = errorMessage(error);
      log(`Failed to start ${issue.id}: ${message}`);
      logEvent("dispatch", {
        outcome: "failed",
        ticket: issue.id,
        model: issue.model,
        repository: issue.repository,
        error: message,
      });
      // A failure on the reopen path uses the ticket's one retry — escalate
      // to retry-exhausted so the orchestrator stops re-attempting it.
      if (reopen) {
        await markRetryExhausted(issue, "reopen_failed");
      }
    }
  }

  async function applyStrandActions(actions: readonly StrandAction[]): Promise<void> {
    for (const action of actions) {
      // oxlint-disable-next-line no-await-in-loop -- Linear mutations are serial per ticket to avoid label-cache races
      await (action.kind === "demote"
        ? demoteStranded(action.issue)
        : markRetryExhausted(action.issue, "stranded_after_retry"));
    }
  }

  async function demoteStranded(issue: GroundcrewIssue): Promise<void> {
    try {
      // markTodo first: if the state transition fails, leave the ticket
      // un-labelled so the next tick re-detects it as a fresh strand and
      // tries again. Reversing the order would mark `agent-retried` on a
      // ticket that never actually got its retry, locking it into
      // retry_exhausted on the next iteration.
      await issueStatusUpdater.markTodo(issue);
      await issueStatusUpdater.addLabels(issue, [AGENT_RETRIED_LABEL]);
      log(`Demoted stranded ${issue.id} to Todo (one retry remaining)`);
      logEvent("orchestrator", {
        outcome: "demote_stranded",
        ticket: issue.id,
        model: issue.model,
        repository: issue.repository,
      });
    } catch (error) {
      logDemoteFailure(issue, error);
    }
  }

  async function markRetryExhausted(
    issue: GroundcrewIssue,
    reason: "stranded_after_retry" | "reopen_failed",
  ): Promise<void> {
    try {
      await issueStatusUpdater.addLabels(issue, [AGENT_ERROR_LABEL, AGENT_MAX_RETRIES_LABEL]);
      log(`Marked ${issue.id} as retry-exhausted (${reason})`);
      logEvent("orchestrator", {
        outcome: "demote_skipped_max_retries",
        ticket: issue.id,
        model: issue.model,
        repository: issue.repository,
        reason,
      });
    } catch (error) {
      logDemoteFailure(issue, error);
    }
  }

  function logDemoteFailure(issue: GroundcrewIssue, error: unknown): void {
    const message = errorMessage(error);
    log(`Failed to update Linear for ${issue.id}: ${message}`);
    logEvent("orchestrator", {
      outcome: "demote_failed",
      ticket: issue.id,
      model: issue.model,
      repository: issue.repository,
      error: message,
    });
  }

  async function runOnce(arguments_: {
    state: BoardState;
    worktreeEntries: readonly WorktreeEntry[];
    usage: (signal?: AbortSignal) => Promise<UsageByModel>;
    dryRun: boolean;
    signal?: AbortSignal;
  }): Promise<void> {
    const { state, worktreeEntries, usage, dryRun, signal } = arguments_;
    issueStatusUpdater.resetMissingStateCache();

    const inProgress: readonly GroundcrewIssue[] = state.issues.filter(
      (issue): issue is GroundcrewIssue =>
        issue.status === config.linear.statuses.inProgress && isGroundcrewIssue(issue),
    );
    // Narrow Todo to tickets that opted in via an `agent-*` label.
    // Unlabeled tickets are not groundcrew's concern even when in Todo.
    const todo: readonly GroundcrewIssue[] = state.issues.filter(
      (issue): issue is GroundcrewIssue =>
        issue.status === config.linear.statuses.todo && isGroundcrewIssue(issue),
    );

    // Strand recovery looks for In-Progress tickets whose worktree is on
    // disk but whose workspace has vanished. Skip the workspace probe (and
    // its shell-out) when there are no In-Progress candidates with a
    // matching worktree — there's nothing for it to find.
    const inProgressHasWorktree = inProgress.some((issue) =>
      worktreeEntries.some(
        (entry) => entry.repository === issue.repository && entry.ticket === issue.id,
      ),
    );

    const { unblocked, skips: blockerSkips } = classifyBlockers(config, todo);
    for (const skip of blockerSkips) {
      logSkip(skip);
    }

    const needsWorkspaceProbe = !dryRun && (inProgressHasWorktree || unblocked.length > 0);
    const workspaceProbe: WorkspaceProbe = needsWorkspaceProbe
      ? await workspaces.probe(config, signal)
      : { kind: "ok", names: new Set<string>() };

    const strandActions = dryRun
      ? []
      : classifyInProgressStrands({
          inProgress,
          worktreeEntries,
          workspaceProbe,
        });
    await applyStrandActions(strandActions);
    const demotedTickets = new Set(
      strandActions.filter((action) => action.kind === "demote").map((action) => action.issue.id),
    );

    // Demoted tickets still appear In-Progress in the stale `state` snapshot,
    // but conceptually their slots are free this tick — subtract them so
    // eligibility can dispatch into the headroom on the same iteration.
    const activeCount = state.issues.filter(
      (issue) =>
        issue.status === config.linear.statuses.inProgress && !demotedTickets.has(issue.id),
    ).length;
    const slots = config.orchestrator.maximumInProgress - activeCount;

    if (slots <= 0) {
      log(
        `At capacity (${activeCount}/${config.orchestrator.maximumInProgress}), no new work to start`,
      );
      return;
    }

    if (todo.length === 0) {
      log(`No ${config.linear.statuses.todo} tickets to pick up`);
      return;
    }

    if (unblocked.length === 0) {
      log(`No eligible ${config.linear.statuses.todo} tickets after blocker filtering`);
      return;
    }

    // usage() is an HTTP call. Resolve it only after we know there is
    // unblocked Todo work that might consume the result.
    const fetchedUsage = await usage(signal);
    const exhausted = buildExhaustedSet(fetchedUsage);

    const verdicts = classifyEligibility({
      config,
      unblocked,
      worktreeEntries,
      workspaceProbe,
      usage: fetchedUsage,
      exhausted,
      slots,
      dryRun,
    });

    const starts = verdicts.filter((v): v is StartVerdict => v.kind === "start");
    const skips = verdicts.filter((v): v is SkipVerdict => v.kind === "skip");

    for (const skip of skips) {
      logSkip(skip);
    }

    if (starts.length === 0) {
      log(`No eligible ${config.linear.statuses.todo} tickets after eligibility filtering`);
      return;
    }

    log(
      `${slots} slot(s) available, starting ${starts.length} ticket(s): ${starts.map(({ issue }) => `${issue.id}(${issue.model})`).join(", ")}`,
    );
    logEvent("dispatch", {
      outcome: "starting",
      tickets: starts.map(({ issue }) => `${issue.id}:${issue.model}`),
    });

    for (const start of starts) {
      // oxlint-disable-next-line no-await-in-loop -- one workspace at a time avoids racing on git
      await startEligibleIssue(start, dryRun, signal);
    }
  }

  return { runOnce };
}

function formatUsageExhaustion(exhaustion: ModelUsageExhaustion): string {
  if (exhaustion.kind === "session") {
    const mins = exhaustion.resetMinutes ?? "?";
    return `${exhaustion.model} session at ${exhaustion.usedPercentage.toFixed(0)}% (> ${exhaustion.limitPercentage}%), resets in ${mins}m — skipping its tickets`;
  }
  return `${exhaustion.model} weekly at ${exhaustion.usedPercentage.toFixed(1)}% (> ${exhaustion.allowedPercentage.toFixed(1)}% paced budget), resets in ${exhaustion.resetMinutes}m — skipping its tickets`;
}

function dispatchOutcome(recovery: boolean, reopen: boolean): "resumed" | "reopened" | "started" {
  if (recovery) {
    return "resumed";
  }
  if (reopen) {
    return "reopened";
  }
  return "started";
}
