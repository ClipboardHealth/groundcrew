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
  type BoardState,
  type GroundcrewIssue,
  isGroundcrewIssue,
  isIssueInProgress,
  isIssueTodo,
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
  classifyUsageExhaustion,
  type ModelUsageExhaustion,
  type SkipVerdict,
  type StartVerdict,
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
    /**
     * Appended to the dispatcher's idle-branch log lines so the watch loop
     * can fold its `next poll in Xs` heartbeat into the same line instead of
     * printing a second line per tick.
     */
    idleSuffix?: string;
  }): Promise<void>;
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

export function createDispatcher(deps: DispatcherDeps): Dispatcher {
  const { config, client } = deps;
  const issueStatusUpdater = createLinearIssueStatusUpdater({ client });

  function buildExhaustedSet(usage: UsageByModel): Set<string> {
    const exhausted = new Set<string>();
    for (const exhaustion of classifyUsageExhaustion(config, usage)) {
      exhausted.add(exhaustion.model);
      log(formatUsageExhaustion(exhaustion));
    }
    return exhausted;
  }

  async function startEligibleIssue(
    start: StartVerdict,
    dryRun: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    const { issue, recovery } = start;
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
        const setupOptions = {
          repository: issue.repository,
          ticket: issue.id,
          model: issue.model,
        };
        await (signal === undefined
          ? setupWorkspace(config, setupOptions)
          : setupWorkspace(config, setupOptions, { signal }));
      }
      await issueStatusUpdater.markInProgress(issue);
      logEvent("dispatch", {
        outcome: recovery ? "resumed" : "started",
        ticket: issue.id,
        model: issue.model,
        repository: issue.repository,
      });
    } catch (error) {
      log(`Failed to start ${issue.id}: ${errorMessage(error)}`);
      logEvent("dispatch", {
        outcome: "failed",
        ticket: issue.id,
        model: issue.model,
        repository: issue.repository,
        error: errorMessage(error),
      });
    }
  }

  async function runOnce(arguments_: {
    state: BoardState;
    worktreeEntries: readonly WorktreeEntry[];
    usage: (signal?: AbortSignal) => Promise<UsageByModel>;
    dryRun: boolean;
    signal?: AbortSignal;
    idleSuffix?: string;
  }): Promise<void> {
    const { state, worktreeEntries, usage, dryRun, signal, idleSuffix = "" } = arguments_;
    issueStatusUpdater.resetMissingInProgressCache();

    // Surface parent tickets that fetchBoard silently dropped. Without this
    // an operator sees "No Todo tickets to pick up" with no signal that an
    // expected Todo+labelled ticket was skipped because it has sub-issues.
    for (const skip of state.parentSkips) {
      log(
        `Skipping ${skip.id}: parent ticket with ${skip.childCount} sub-issue(s) — groundcrew works sub-issues, not parents`,
      );
      logEvent("dispatch", {
        outcome: "skipped",
        reason: "parent_with_children",
        ticket: skip.id,
        children: skip.childCount,
      });
    }

    const activeCount = state.issues.filter((issue) => isIssueInProgress(issue)).length;
    const slots = config.orchestrator.maximumInProgress - activeCount;
    // Narrow Todo to tickets that opted in via an `agent-*` label.
    // Unlabeled tickets are not groundcrew's concern even when in Todo.
    const todo: readonly GroundcrewIssue[] = state.issues.filter(
      (issue): issue is GroundcrewIssue => isIssueTodo(issue) && isGroundcrewIssue(issue),
    );

    if (slots <= 0) {
      log(
        `At capacity (${activeCount}/${config.orchestrator.maximumInProgress}), no new work to start${idleSuffix}`,
      );
      return;
    }

    if (todo.length === 0) {
      log(`No Todo tickets to pick up${idleSuffix}`);
      return;
    }

    // Run the blocker pre-pass first so an all-blocked board short-circuits
    // before the codexbar HTTP call and the cmux/tmux shell-out fire.
    const { unblocked, skips: blockerSkips } = classifyBlockers(todo);
    for (const skip of blockerSkips) {
      logSkip(skip);
    }
    if (unblocked.length === 0) {
      log(`No eligible Todo tickets after blocker filtering${idleSuffix}`);
      return;
    }

    // usage() is an HTTP call; workspaces.probe shells tmux/cmux. Kick off
    // usage first so the workspace probe can overlap with the in-flight request.
    const usagePromise = usage(signal);
    // Snapshot live workspace names once per iteration so eligibility can
    // distinguish "worktree exists AND its agent is still running" (resume)
    // from "worktree exists but the workspace is gone" (ambiguous — don't
    // auto-recover). Done before slot-counting so a skipped stale ticket
    // doesn't consume an eligible slot and starve later Todo tickets.
    let workspaceProbe: WorkspaceProbe;
    try {
      workspaceProbe = dryRun
        ? { kind: "ok", names: new Set<string>() }
        : await workspaces.probe(config, signal);
    } catch (error) {
      usagePromise.catch(() => "ignored");
      throw error;
    }
    const fetchedUsage = await usagePromise;
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
      log(`No eligible Todo tickets after eligibility filtering${idleSuffix}`);
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
