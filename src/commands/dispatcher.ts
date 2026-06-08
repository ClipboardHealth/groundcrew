/**
 * Per-iteration decider that picks Todo tasks to start and acts on the
 * picks. Stateless across iterations. The Board adapter owns its own writeback
 * caches (e.g., Linear's team-state cache lives in `src/lib/adapters/linear/writeback.ts`).
 *
 * Pure verdict logic lives in `eligibility.ts`; this module is responsible
 * for telemetry, writeback via Board, and side-effecting setupWorkspace calls.
 */

import type { Board } from "../lib/board.ts";
import type { ResolvedConfig } from "../lib/config.ts";
import { dispatchableRepository } from "../lib/repositoryValidation.ts";
import {
  type BoardState,
  type GroundcrewIssue,
  isGroundcrewIssue,
  type Issue,
  naturalIdFromCanonical,
} from "../lib/taskSource.ts";
import type { UsageByModel } from "../lib/usage.ts";
import { errorMessage, failMark, log, logEvent } from "../lib/util.ts";
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
  board: Board;
}

export interface Dispatcher {
  runOnce: (arguments_: {
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
  }) => Promise<void>;
}

function logSkip(verdict: SkipVerdict): void {
  log(verdict.message);
  logEvent("dispatch", {
    outcome: "skipped",
    reason: verdict.eventReason,
    task: naturalIdFromCanonical(verdict.issue.id),
    blockers: verdict.blockers,
    model: verdict.model,
  });
}

export function createDispatcher(deps: DispatcherDeps): Dispatcher {
  const { config, board } = deps;

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
    const taskId = naturalIdFromCanonical(issue.id);
    if (start.resolvedFromAny) {
      log(`Resolved agent-any for ${taskId} → ${issue.model}`);
    }

    if (dryRun) {
      log(
        /* v8 ignore next @preserve -- classifyTodo forces recovery=false in dry-run, so the resume branch can't fire here */
        `[dry-run] Would ${recovery ? "resume" : "start"} ${taskId} in ${issue.repository} (${issue.model})`,
      );
      logEvent("dispatch", {
        outcome: "skipped",
        reason: "dry_run",
        task: taskId,
        model: issue.model,
        repository: issue.repository,
      });
      return;
    }

    try {
      if (recovery) {
        log(`Worktree and workspace already exist for ${taskId}; resuming with markInProgress`);
      } else {
        const setupOptions = {
          repository: issue.repository,
          task: taskId,
          model: issue.model,
          details: {
            title: issue.title,
            description: issue.description,
            ...(issue.url === undefined ? {} : { url: issue.url }),
          },
        };
        await (signal === undefined
          ? setupWorkspace(config, setupOptions)
          : setupWorkspace(config, setupOptions, { signal }));
      }
      await board.markInProgress(issue);
      logEvent("dispatch", {
        outcome: recovery ? "resumed" : "started",
        task: taskId,
        model: issue.model,
        repository: issue.repository,
      });
    } catch (error) {
      log(`${failMark()} Failed to start ${taskId}: ${errorMessage(error)}`);
      logEvent("dispatch", {
        outcome: "failed",
        task: taskId,
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

    // Surface parent tasks that fetch silently dropped. Without this
    // an operator sees "No Todo tasks to pick up" with no signal that an
    // expected Todo+labelled task was skipped because it has sub-issues.
    for (const skip of state.parentSkips) {
      const task = naturalIdFromCanonical(skip.id);
      log(
        `Skipping ${task}: parent task with ${skip.childCount} sub-issue(s) — groundcrew works sub-issues, not parents`,
      );
      logEvent("dispatch", {
        outcome: "skipped",
        reason: "parent_with_children",
        task,
        children: skip.childCount,
      });
    }

    const active = state.issues
      .filter((issue) => issue.status === "in-progress")
      .toSorted((a, b) => a.id.localeCompare(b.id));
    const activeCount = active.length;
    const slots = config.orchestrator.maximumInProgress - activeCount;
    // Narrow Todo to tasks that opted in via an `agent-*` label.
    // Unlabeled tasks are not groundcrew's concern even when in Todo.
    // Sort by priority so higher-priority tasks fill slots first.
    const todo: readonly GroundcrewIssue[] = state.issues
      .filter(
        (issue): issue is GroundcrewIssue => issue.status === "todo" && isGroundcrewIssue(issue),
      )
      .toSorted((a, b) => prioritySortKey(a.priority) - prioritySortKey(b.priority));

    if (slots <= 0) {
      log(
        `At capacity (${activeCount}/${config.orchestrator.maximumInProgress})${formatActiveSlotList(active)}, no new work to start${idleSuffix}`,
      );
      return;
    }

    if (todo.length === 0) {
      log(`No Todo tasks to pick up${idleSuffix}`);
      return;
    }

    // Run the blocker pre-pass first so an all-blocked board short-circuits
    // before the codexbar HTTP call and the cmux/tmux shell-out fire.
    const { unblocked, skips: blockerSkips } = classifyBlockers(todo);
    for (const skip of blockerSkips) {
      logSkip(skip);
    }
    if (unblocked.length === 0) {
      log(`No eligible Todo tasks after blocker filtering${idleSuffix}`);
      return;
    }

    // Validate repositories BEFORE the expensive probes so a tick whose only
    // candidates have unknown repos short-circuits without paying for the
    // usage() HTTP call or the workspaces.probe shell-out. Doing this filter
    // here also keeps an unknown-repo task at the head of the queue from
    // consuming a slot in classifyEligibility and starving later valid
    // tasks. Each unknown repo still emits a WARN via dispatchableRepository.
    const dispatchableUnblocked = unblocked.filter((issue) => {
      const repository = dispatchableRepository(issue, config.workspace.knownRepositories, log);
      return repository !== undefined;
    });

    if (dispatchableUnblocked.length === 0) {
      log(`No eligible Todo tasks after repository validation${idleSuffix}`);
      return;
    }

    // usage() is an HTTP call; workspaces.probe shells tmux/cmux. Kick off
    // usage first so any necessary workspace probe can overlap with the
    // in-flight request.
    const usagePromise = usage(signal);
    // Snapshot live workspace names once per iteration so eligibility can
    // distinguish "worktree exists AND its agent is still running" (resume)
    // from "worktree exists but the workspace is gone" (ambiguous — don't
    // auto-recover). Skip the shell-out entirely for fresh-start-only ticks:
    // if none of the candidates has a matching worktree, classifyRecovery()
    // will never read the probe.
    let workspaceProbe: WorkspaceProbe;
    try {
      workspaceProbe =
        dryRun || !hasRecoverableCandidate(dispatchableUnblocked, worktreeEntries)
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
      unblocked: dispatchableUnblocked,
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
      log(`No eligible Todo tasks after eligibility filtering${idleSuffix}`);
      return;
    }

    const dispatchable = starts;

    log(
      `Slots ${activeCount}/${config.orchestrator.maximumInProgress} used${formatActiveSlotList(active)}, starting ${dispatchable.length} task(s): ${dispatchable.map(({ issue }) => `${naturalIdFromCanonical(issue.id)}(${issue.model})`).join(", ")}`,
    );
    logEvent("dispatch", {
      outcome: "starting",
      tasks: dispatchable.map(({ issue }) => `${naturalIdFromCanonical(issue.id)}:${issue.model}`),
    });

    for (const start of dispatchable) {
      // oxlint-disable-next-line no-await-in-loop -- one workspace at a time avoids racing on git
      await startEligibleIssue(start, dryRun, signal);
    }
  }

  return { runOnce };
}

function hasRecoverableCandidate(
  issues: readonly GroundcrewIssue[],
  worktreeEntries: readonly WorktreeEntry[],
): boolean {
  return issues.some((issue) => {
    const naturalId = naturalIdFromCanonical(issue.id);
    return worktreeEntries.some(
      (entry) => entry.repository === issue.repository && entry.task === naturalId,
    );
  });
}

function formatUsageExhaustion(exhaustion: ModelUsageExhaustion): string {
  if (exhaustion.kind === "session") {
    const mins = exhaustion.resetMinutes ?? "?";
    return `${exhaustion.model} session at ${exhaustion.usedPercentage.toFixed(0)}% (> ${exhaustion.limitPercentage}%), resets in ${mins}m — skipping its tasks`;
  }
  return `${exhaustion.model} weekly at ${exhaustion.usedPercentage.toFixed(1)}% (> ${exhaustion.allowedPercentage.toFixed(1)}% paced budget), resets in ${exhaustion.resetMinutes}m — skipping its tasks`;
}

/** Undefined priority sorts last. */
function prioritySortKey(priority: number | undefined): number {
  return priority ?? Number.POSITIVE_INFINITY;
}

export function formatActiveSlotList(active: readonly Issue[]): string {
  if (active.length === 0) {
    return "";
  }
  const entries = active
    .map((issue) => `${naturalIdFromCanonical(issue.id)}(${issue.model ?? "?"})`)
    .join(", ");
  return ` [${entries}]`;
}
