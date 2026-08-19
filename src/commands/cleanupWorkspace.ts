import type { ResolvedConfig } from "../lib/config.ts";
import { readRunState, removeRunState } from "../lib/runState.ts";
import { recordCleanedUpRuns, type RunStateCleanupFailure } from "../lib/runStateCleanup.ts";
import { errorMessage, log } from "../lib/util.ts";
import { type WorkspaceProbe, workspaces } from "../lib/workspaces.ts";
import {
  type TeardownFailure,
  type TeardownResult,
  type WorktreeDirtiness,
  type WorktreeEntry,
  worktrees,
} from "../lib/worktrees.ts";
import { logTeardown } from "./teardownReporter.ts";
import {
  executeLifecycleMutation,
  lifecycleCancellationSuffix,
  loadLifecycleConfig,
  type LifecycleCancellationContext,
} from "./lifecycleCommand.ts";
import {
  LIFECYCLE_PROBLEM_CODES,
  type CleanupResources,
  type CleanupResult,
  type LifecycleProblem,
} from "./lifecycleResult.ts";

const USAGE = [
  "Usage: crew cleanup [--force] <task> [--json]",
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

export interface CleanupWorkspaceRunOptions {
  signal?: AbortSignal;
}

type CleanupArguments =
  | { mode: "task"; task: string; force: boolean; json: boolean }
  | { mode: "all"; force: boolean; json: false };

function parseArguments(argv: string[]): CleanupArguments {
  let force = false;
  let all = false;
  let json = false;
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
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument.startsWith("-")) {
      throw new Error(`Unknown option: ${argument}\n${USAGE}`);
    }
    positionals.push(argument);
  }
  if (all) {
    if (json) {
      throw new Error(`crew cleanup --json requires a task argument.\n${USAGE}`);
    }
    if (positionals.length > 0) {
      throw new Error(`crew cleanup --all takes no task argument.\n${USAGE}`);
    }
    return { mode: "all", force, json: false };
  }
  const [task, ...extras] = positionals;
  if (task === undefined || task.length === 0 || extras.length > 0) {
    throw new Error(USAGE);
  }
  return { mode: "task", task: task.toLowerCase(), force, json };
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
  runOptions: CleanupWorkspaceRunOptions = {},
): Promise<CleanupResult> {
  const { task, force = false } = options;
  const entries = worktrees.findByTask(config, task);
  const state = readRunState(config, task);
  const workspaceProbe =
    runOptions.signal === undefined
      ? await workspaces.probe(config)
      : await workspaces.probe(config, runOptions.signal);

  switch (entries[0]) {
    case undefined: {
      if (workspaceProbe.kind === "unavailable") {
        return cleanupClassifiedResult({
          task,
          state,
          outcome: "conflict",
          lifecycleState: state?.state ?? "unknown",
          resources: emptyCleanupResources(),
          problems: [
            {
              code: LIFECYCLE_PROBLEM_CODES.workspaceStatusUnavailable,
              message: "Workspace status is unavailable; no cleanup was attempted.",
            },
          ],
        });
      }
      if (workspaceProbe.names.has(task)) {
        return cleanupClassifiedResult({
          task,
          state,
          outcome: "refused",
          lifecycleState: "running",
          resources: {
            worktrees: [],
            workspaces: [{ name: task, closed: false }],
          },
          problems: [
            {
              code: LIFECYCLE_PROBLEM_CODES.workspaceBusy,
              message: "The task workspace is still running; no cleanup was attempted.",
            },
          ],
        });
      }
      if (state === undefined) {
        return cleanupClassifiedResult({
          task,
          state,
          outcome: "nothing-to-clean",
          lifecycleState: "absent",
          resources: emptyCleanupResources(),
          problems: [],
        });
      }
      try {
        removeRunState(config, task);
        return cleanupClassifiedResult({
          task,
          state,
          outcome: "state-cleared",
          lifecycleState: "absent",
          resources: emptyCleanupResources(),
          problems: [],
        });
      } catch (error) {
        return cleanupClassifiedResult({
          task,
          state,
          outcome: "partial",
          lifecycleState: state.state,
          resources: emptyCleanupResources(),
          problems: [
            {
              code: LIFECYCLE_PROBLEM_CODES.stateWriteFailed,
              message: `Stale run state could not be cleared: ${errorMessage(error)}`,
            },
          ],
        });
      }
    }
    default:
      break;
  }

  if (!force) {
    const refusal = await cleanupRefusal({
      task,
      state,
      entries,
      workspaceProbe,
      signal: runOptions.signal,
    });
    if (refusal !== undefined) {
      return refusal;
    }
  }

  const result = await worktrees.teardown(config, entries, {
    force,
    ...(runOptions.signal === undefined ? {} : { signal: runOptions.signal }),
  });
  const stateFailures = recordCleanedUpRuns(config, result.removed);
  return cleanupResultFromTeardown({ task, state, entries, result, stateFailures });
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

export async function cleanupWorkspaceCli(argv: string[]): Promise<CleanupResult | undefined> {
  const parsed = parseArguments(argv);
  const config = await loadLifecycleConfig(parsed.mode === "task" && parsed.json);
  if (parsed.mode === "all") {
    await cleanupAllWorkspaces(config, { force: parsed.force });
    return undefined;
  }
  return await executeLifecycleMutation({
    config,
    task: parsed.task,
    json: parsed.json,
    conflictResult: () => cleanupLockConflictResult({ config, task: parsed.task }),
    operation: async ({ signal }) =>
      await cleanupWorkspace(config, { task: parsed.task, force: parsed.force }, { signal }),
    cancelledResult: async (context) =>
      await cancelledCleanupResult({ config, task: parsed.task, context }),
  });
}

async function cleanupRefusal(arguments_: {
  task: string;
  state: ReturnType<typeof readRunState>;
  entries: readonly WorktreeEntry[];
  workspaceProbe: WorkspaceProbe;
  signal: AbortSignal | undefined;
}): Promise<CleanupResult | undefined> {
  const { task, state, entries, workspaceProbe, signal } = arguments_;
  if (isWorkspaceInUse(workspaceProbe, task)) {
    return cleanupClassifiedResult({
      task,
      state,
      outcome: "refused",
      lifecycleState: "running",
      resources: cleanupResources(entries, [], []),
      problems: [
        {
          code: LIFECYCLE_PROBLEM_CODES.workspaceBusy,
          message: "The task workspace is still running; no cleanup was attempted.",
        },
      ],
    });
  }
  if (workspaceProbe.kind === "unavailable") {
    return cleanupClassifiedResult({
      task,
      state,
      outcome: "conflict",
      lifecycleState: state?.state ?? "unknown",
      resources: cleanupResources(entries, [], []),
      problems: [
        {
          code: LIFECYCLE_PROBLEM_CODES.workspaceStatusUnavailable,
          message: "Workspace status is unavailable; no cleanup was attempted.",
        },
      ],
    });
  }
  for (const entry of entries) {
    // oxlint-disable-next-line no-await-in-loop -- preflight is sequential to avoid concurrent git probes
    const dirtiness = await worktrees.probeWorkingTree({
      worktreeDir: entry.dir,
      ...(signal === undefined ? {} : { signal }),
    });
    const refusal = dirtinessRefusal({ task, state, entries, entry, dirtiness });
    if (refusal !== undefined) {
      return refusal;
    }
  }
  return undefined;
}

function dirtinessRefusal(arguments_: {
  task: string;
  state: ReturnType<typeof readRunState>;
  entries: readonly WorktreeEntry[];
  entry: WorktreeEntry;
  dirtiness: WorktreeDirtiness;
}): CleanupResult | undefined {
  if (arguments_.dirtiness.kind === "clean") {
    return undefined;
  }
  const problem: LifecycleProblem =
    arguments_.dirtiness.kind === "dirty"
      ? {
          code: LIFECYCLE_PROBLEM_CODES.worktreeDirty,
          message: `Worktree ${arguments_.entry.dir} has ${arguments_.dirtiness.modified} modified and ${arguments_.dirtiness.untracked} untracked files; no cleanup was attempted.`,
        }
      : {
          code: LIFECYCLE_PROBLEM_CODES.worktreeStatusUnknown,
          message: `Worktree cleanliness could not be verified for ${arguments_.entry.dir}; no cleanup was attempted.`,
        };
  return cleanupClassifiedResult({
    task: arguments_.task,
    state: arguments_.state,
    outcome: "refused",
    lifecycleState: arguments_.state?.state ?? "unknown",
    resources: cleanupResources(arguments_.entries, [], []),
    problems: [problem],
  });
}

function cleanupResultFromTeardown(arguments_: {
  task: string;
  state: ReturnType<typeof readRunState>;
  entries: readonly WorktreeEntry[];
  result: TeardownResult;
  stateFailures: readonly RunStateCleanupFailure[];
}): CleanupResult {
  const { task, state, entries, result, stateFailures } = arguments_;
  const problems = result.failures.map(problemFromTeardownFailure);
  for (const failure of stateFailures) {
    problems.push({
      code: LIFECYCLE_PROBLEM_CODES.stateWriteFailed,
      message: `Removed resources for ${failure.task}, but run state could not be cleared: ${errorMessage(failure.error)}`,
    });
  }
  if (result.workspaceProbe.kind === "unavailable") {
    problems.push({
      code: LIFECYCLE_PROBLEM_CODES.workspaceStatusUnavailable,
      message:
        result.workspaceProbe.error === undefined
          ? "Workspace status was unavailable during cleanup."
          : `Workspace status was unavailable during cleanup: ${errorMessage(result.workspaceProbe.error)}`,
    });
  }
  if (result.cancelled === true) {
    problems.push({
      code: LIFECYCLE_PROBLEM_CODES.cancelled,
      message: "Cleanup was cancelled before every resource was reconciled.",
    });
  }
  return cleanupClassifiedResult({
    task,
    state,
    outcome: problems.length === 0 ? "cleaned" : "partial",
    lifecycleState:
      result.removed.length === entries.length && problems.length === 0
        ? "absent"
        : (state?.state ?? "unknown"),
    resources: cleanupResources(entries, result.removed, result.closed),
    problems,
  });
}

function problemFromTeardownFailure(failure: TeardownFailure): LifecycleProblem {
  if (failure.step === "workspace_close") {
    return {
      code: LIFECYCLE_PROBLEM_CODES.workspaceCloseFailed,
      message: `Workspace close failed: ${errorMessage(failure.error)}`,
    };
  }
  const detail = errorMessage(failure.error);
  return {
    code: LIFECYCLE_PROBLEM_CODES.worktreeRemoveFailed,
    message: detail.includes("--force")
      ? "Worktree could not be removed safely; inspect it for uncommitted changes."
      : `Worktree removal failed: ${detail}`,
  };
}

function cleanupResources(
  entries: readonly WorktreeEntry[],
  removed: readonly WorktreeEntry[],
  closed: readonly string[],
): CleanupResources {
  const removedDirs = new Set(removed.map((entry) => entry.dir));
  const workspaceNames = new Set(entries.map((entry) => entry.task));
  for (const name of closed) {
    workspaceNames.add(name);
  }
  return {
    worktrees: entries.map((entry) => ({
      repository: entry.repository,
      branch: entry.branchName,
      worktreeDir: entry.dir,
      removed: removedDirs.has(entry.dir),
    })),
    workspaces: [...workspaceNames].map((name) => ({ name, closed: closed.includes(name) })),
  };
}

function emptyCleanupResources(): CleanupResources {
  return { worktrees: [], workspaces: [] };
}

function cleanupClassifiedResult(arguments_: {
  task: string;
  state: ReturnType<typeof readRunState>;
  outcome: CleanupResult["outcome"];
  lifecycleState: CleanupResult["state"];
  resources: CleanupResources;
  problems: LifecycleProblem[];
}): CleanupResult {
  return {
    action: "cleanup",
    task: {
      id: arguments_.task,
      ...(arguments_.state?.completionTaskId === undefined
        ? {}
        : { canonicalId: arguments_.state.completionTaskId }),
      ...(arguments_.state?.url === undefined ? {} : { url: arguments_.state.url }),
    },
    outcome: arguments_.outcome,
    state: arguments_.lifecycleState,
    resources: arguments_.resources,
    problems: arguments_.problems,
  };
}

function cleanupLockConflictResult(arguments_: {
  config: ResolvedConfig;
  task: string;
}): CleanupResult {
  const state = readRunState(arguments_.config, arguments_.task);
  const entries = worktrees.findByTask(arguments_.config, arguments_.task);
  return cleanupClassifiedResult({
    task: arguments_.task,
    state,
    outcome: "conflict",
    lifecycleState: state?.state ?? "unknown",
    resources: cleanupResources(entries, [], []),
    problems: [
      {
        code: LIFECYCLE_PROBLEM_CODES.lifecycleLockHeld,
        message: "Another lifecycle mutation owns this task.",
      },
    ],
  });
}

async function cancelledCleanupResult(arguments_: {
  config: ResolvedConfig;
  task: string;
  context: LifecycleCancellationContext;
}): Promise<CleanupResult> {
  const state = readRunState(arguments_.config, arguments_.task);
  const entries = worktrees.findByTask(arguments_.config, arguments_.task);
  return cleanupClassifiedResult({
    task: arguments_.task,
    state,
    outcome: "partial",
    lifecycleState: state?.state ?? (entries.length === 0 ? "absent" : "unknown"),
    resources: cleanupResources(entries, [], []),
    problems: [
      {
        code: LIFECYCLE_PROBLEM_CODES.cancelled,
        message: `Cleanup cancelled${lifecycleCancellationSuffix(arguments_.context)}.`,
      },
    ],
  });
}
