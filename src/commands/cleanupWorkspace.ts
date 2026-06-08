import { loadConfig, type ResolvedConfig } from "../lib/config.ts";
import { readRunState, removeRunState } from "../lib/runState.ts";
import { recordCleanedUpRuns } from "../lib/runStateCleanup.ts";
import { log } from "../lib/util.ts";
import { workspaces } from "../lib/workspaces.ts";
import { worktrees } from "../lib/worktrees.ts";
import { logTeardown } from "./teardownReporter.ts";

export interface CleanupWorkspaceOptions {
  task: string;
  /** Default false. The automated cleanup path keeps in-flight uncommitted work. */
  force?: boolean;
}

function parseArguments(argv: string[]): CleanupWorkspaceOptions {
  let force = false;
  const positionals: string[] = [];
  for (const argument of argv) {
    if (argument === "--force") {
      force = true;
      continue;
    }
    if (argument.startsWith("-")) {
      throw new Error(
        `Unknown option: ${argument}\nUsage: crew cleanup [--force] <task>\nExample: crew cleanup team-220`,
      );
    }
    positionals.push(argument);
  }
  const [task, ...extras] = positionals;
  if (task === undefined || task.length === 0 || extras.length > 0) {
    throw new Error("Usage: crew cleanup [--force] <task>\nExample: crew cleanup team-220");
  }
  return { task: task.toLowerCase(), force };
}

export async function cleanupWorkspace(
  config: ResolvedConfig,
  options: CleanupWorkspaceOptions,
): Promise<void> {
  const { task, force = false } = options;
  const entries = worktrees.findByTask(config, task);

  if (entries.length === 0) {
    if (readRunState(config, task) === undefined) {
      log(`No worktree found for ${task}; nothing to clean up.`);
      return;
    }
    const workspaceProbe = await workspaces.probe(config);
    if (workspaceProbe.kind === "unavailable") {
      log(`No worktree found for ${task}; workspace probe unavailable, leaving run-state intact.`);
      return;
    }
    if (workspaceProbe.names.has(task)) {
      log(`No worktree found for ${task}; workspace still present; leaving run-state intact.`);
      return;
    }
    removeRunState(config, task);
    log(`No worktree found for ${task}; cleared stale run-state.`);
    return;
  }

  const result = await worktrees.teardown(config, entries, { force });
  recordCleanedUpRuns(config, result.removed);
  logTeardown(result);
  if (result.failures.length > 0) {
    throw result.failures[0]?.error;
  }
}

export async function cleanupWorkspaceCli(argv: string[]): Promise<void> {
  const config = await loadConfig();
  const options = parseArguments(argv);
  await cleanupWorkspace(config, options);
}
