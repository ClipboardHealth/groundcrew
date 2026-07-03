import { loadConfig, type ResolvedConfig } from "../lib/config.ts";
import { readRunState, removeRunState } from "../lib/runState.ts";
import { recordCleanedUpRuns } from "../lib/runStateCleanup.ts";
import { log } from "../lib/util.ts";
import { type WorkspaceProbe, workspaces } from "../lib/workspaces.ts";
import { type WorktreeEntry, worktrees } from "../lib/worktrees.ts";
import { logTeardown } from "./teardownReporter.ts";

const USAGE = [
  "Usage: crew cleanup [--force] <task>",
  "       crew cleanup [--force] --all",
  "Example: crew cleanup team-220",
].join("\n");

export interface CleanupWorkspaceOptions {
  task: string;
  /** Default false. The automated cleanup path keeps in-flight uncommitted work. */
  force?: boolean;
}

export interface CleanupAllOptions {
  /** Default false. Force-remove even worktrees with uncommitted work. */
  force?: boolean;
}

type CleanupArguments =
  | { mode: "task"; task: string; force: boolean }
  | { mode: "all"; force: boolean };

function parseArguments(argv: string[]): CleanupArguments {
  let force = false;
  let all = false;
  const positionals: string[] = [];
  for (const argument of argv) {
    if (argument === "--force") {
      force = true;
      continue;
    }
    if (argument === "--all") {
      all = true;
      continue;
    }
    if (argument.startsWith("-")) {
      throw new Error(`Unknown option: ${argument}\n${USAGE}`);
    }
    positionals.push(argument);
  }
  if (all) {
    if (positionals.length > 0) {
      throw new Error(`crew cleanup --all takes no task argument.\n${USAGE}`);
    }
    return { mode: "all", force };
  }
  const [task, ...extras] = positionals;
  if (task === undefined || task.length === 0 || extras.length > 0) {
    throw new Error(USAGE);
  }
  return { mode: "task", task: task.toLowerCase(), force };
}

/**
 * A worktree is "in use" when its task has a live workspace session — present
 * in the probe and not exited. An exited session is a dead agent, so its
 * worktree is idle and safe to reap. An `unavailable` probe is "we don't know",
 * handled by the caller (never inferred as idle).
 */
function isWorkspaceInUse(probe: WorkspaceProbe, task: string): boolean {
  if (probe.kind !== "ok" || !probe.names.has(task)) {
    return false;
  }
  return probe.exitedNames?.has(task) !== true;
}

async function teardownEntries(
  config: ResolvedConfig,
  entries: readonly WorktreeEntry[],
  force: boolean,
): Promise<void> {
  const result = await worktrees.teardown(config, entries, { force });
  recordCleanedUpRuns(config, result.removed);
  logTeardown(result);
  if (result.failures.length > 0) {
    throw result.failures[0]?.error;
  }
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

  await teardownEntries(config, entries, force);
}

/**
 * Tear down every local worktree whose task is not currently in use — that is,
 * has no live workspace session. Worktrees backed by a running session are left
 * untouched. Uncommitted work is still protected by teardown's dirtiness guard
 * unless `--force` is passed.
 */
export async function cleanupAllWorkspaces(
  config: ResolvedConfig,
  options: CleanupAllOptions,
): Promise<void> {
  const { force = false } = options;
  const entries = worktrees.list(config);
  if (entries.length === 0) {
    log("No worktrees found; nothing to clean up.");
    return;
  }

  const workspaceProbe = await workspaces.probe(config);
  if (workspaceProbe.kind === "unavailable") {
    log("Workspace probe unavailable; cannot tell which worktrees are in use, leaving all intact.");
    return;
  }

  const idle: WorktreeEntry[] = [];
  for (const entry of entries) {
    if (isWorkspaceInUse(workspaceProbe, entry.task)) {
      log(`Skipping ${entry.task} (${entry.repository}); workspace in use.`);
      continue;
    }
    idle.push(entry);
  }

  if (idle.length === 0) {
    log("No idle worktrees to clean up.");
    return;
  }

  await teardownEntries(config, idle, force);
}

export async function cleanupWorkspaceCli(argv: string[]): Promise<void> {
  const config = await loadConfig();
  const parsed = parseArguments(argv);
  if (parsed.mode === "all") {
    await cleanupAllWorkspaces(config, { force: parsed.force });
    return;
  }
  await cleanupWorkspace(config, { task: parsed.task, force: parsed.force });
}
