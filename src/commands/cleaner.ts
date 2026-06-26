/**
 * Per-iteration scanner that closes workspaces and removes worktrees for
 * tasks that have reached a terminal status. One per `orchestrate()`
 * invocation; stateless across iterations. Mirrors `Dispatcher`.
 */

import type { ResolvedConfig } from "../lib/config.ts";
import { naturalIdFromCanonical, type BoardState } from "../lib/taskSource.ts";
import { log, logEvent } from "../lib/util.ts";
import type { WorktreeEntry } from "../lib/worktrees.ts";
import { reapWorktrees } from "./teardownReporter.ts";

interface CleanerDeps {
  config: ResolvedConfig;
}

export interface Cleaner {
  runOnce: (arguments_: {
    state: BoardState;
    worktreeEntries: readonly WorktreeEntry[];
    dryRun: boolean;
    signal?: AbortSignal;
  }) => Promise<void>;
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

    const terminalTasks = new Set(
      state.issues
        .filter((issue) => issue.status === "done")
        .map((issue) => naturalIdFromCanonical(issue.id)),
    );
    if (terminalTasks.size === 0) {
      return;
    }

    const stale = worktreeEntries.filter((entry) => terminalTasks.has(entry.task));

    if (stale.length === 0) {
      return;
    }

    if (dryRun) {
      log(`[dry-run] ${stale.length} worktree(s) due for cleanup:`);
      for (const entry of stale) {
        log(`  - ${entry.repository}-${entry.task} (${entry.kind})`);
        logEvent("cleanup", {
          outcome: "skipped",
          reason: "dry_run",
          task: entry.task,
          repository: entry.repository,
          kind: entry.kind,
        });
      }
      return;
    }

    log(`Cleaning up ${stale.length} terminal worktree(s)`);
    await reapWorktrees(config, stale, signal);
  }

  return { runOnce };
}
