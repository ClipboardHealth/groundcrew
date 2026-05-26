/**
 * Per-iteration scanner that closes workspaces and removes worktrees for
 * tickets that have reached a terminal status. One per `orchestrate()`
 * invocation; stateless across iterations. Mirrors `Dispatcher`.
 */

import { type BoardState, isTerminalStatusForIssue } from "../lib/boardSource.ts";
import type { ResolvedConfig } from "../lib/config.ts";
import { recordCleanedUpRuns } from "../lib/runStateCleanup.ts";
import { log, logEvent } from "../lib/util.ts";
import { type WorktreeEntry, worktrees } from "../lib/worktrees.ts";
import { logTeardown, recordTeardownEvents } from "./teardownReporter.ts";

interface CleanerDeps {
  config: ResolvedConfig;
}

export interface Cleaner {
  runOnce(arguments_: {
    state: BoardState;
    worktreeEntries: readonly WorktreeEntry[];
    dryRun: boolean;
    signal?: AbortSignal;
  }): Promise<void>;
}

export function createCleaner(deps: CleanerDeps): Cleaner {
  const { config } = deps;

  async function runOnce(arguments_: {
    state: BoardState;
    worktreeEntries: readonly WorktreeEntry[];
    dryRun: boolean;
    signal?: AbortSignal;
  }): Promise<void> {
    const { state, worktreeEntries, dryRun, signal } = arguments_;

    const terminalTickets = new Set(
      state.issues.filter((issue) => isTerminalStatusForIssue(issue)).map((issue) => issue.id),
    );
    if (terminalTickets.size === 0) {
      return;
    }

    const stale = worktreeEntries.filter((entry) => terminalTickets.has(entry.ticket));

    if (stale.length === 0) {
      return;
    }

    if (dryRun) {
      log(`[dry-run] ${stale.length} worktree(s) due for cleanup:`);
      for (const entry of stale) {
        log(`  - ${entry.repository}-${entry.ticket} (${entry.kind})`);
        logEvent("cleanup", {
          outcome: "skipped",
          reason: "dry_run",
          ticket: entry.ticket,
          repository: entry.repository,
          kind: entry.kind,
        });
      }
      return;
    }

    log(`Cleaning up ${stale.length} terminal worktree(s)`);
    const result =
      signal === undefined
        ? await worktrees.teardown(config, stale)
        : await worktrees.teardown(config, stale, { signal });
    recordCleanedUpRuns(config, result.removed);
    logTeardown(result);
    recordTeardownEvents(result);
  }

  return { runOnce };
}
