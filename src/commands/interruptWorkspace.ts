import type { ResolvedConfig } from "../lib/config.ts";
import { readRunState, recordRunState, type RunState } from "../lib/runState.ts";
import { errorMessage } from "../lib/util.ts";
import { workspaces, type WorkspaceInterruptResult } from "../lib/workspaces.ts";
import { type WorktreeEntry, worktrees } from "../lib/worktrees.ts";
import {
  executeLifecycleMutation,
  lifecycleCancellationSuffix,
  loadLifecycleConfig,
  probeWorkspaceForLifecycleReconciliation,
  type LifecycleCancellationContext,
} from "./lifecycleCommand.ts";
import {
  LIFECYCLE_PROBLEM_CODES,
  type LifecycleProblem,
  type LifecycleResources,
  type StopResult,
} from "./lifecycleResult.ts";

export interface InterruptWorkspaceOptions {
  task: string;
  reason?: string;
}

export interface InterruptWorkspaceRunOptions {
  signal?: AbortSignal;
}

interface InterruptSource {
  task: string;
  repository: string;
  agent: string;
  worktreeDir: string;
  branchName: string;
  workspaceName: string;
  resumeCount: number;
}

function parseArguments(argv: string[]): { options: InterruptWorkspaceOptions; json: boolean } {
  let reason: string | undefined;
  let json = false;
  const positionals: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    /* v8 ignore next @preserve -- loop bounds ensure argv[index] exists; guard satisfies noUncheckedIndexedAccess */
    if (argument === undefined) {
      continue;
    }
    if (argument === "--reason") {
      const value = argv[index + 1];
      if (value === undefined || value.length === 0 || value.startsWith("-")) {
        throw new Error("crew stop --reason: reason text is required");
      }
      reason = value;
      index += 1;
      continue;
    }
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument.startsWith("-")) {
      throw new Error(
        `Unknown option: ${argument}\nUsage: crew stop <task> [--reason <text>] [--json]`,
      );
    }
    positionals.push(argument);
  }
  const [task, ...extras] = positionals;
  if (task === undefined || task.length === 0 || extras.length > 0) {
    throw new Error("Usage: crew stop <task> [--reason <text>] [--json]");
  }
  return {
    options: { task: task.toLowerCase(), ...(reason === undefined ? {} : { reason }) },
    json,
  };
}

function sourceFromState(state: RunState): InterruptSource {
  return {
    task: state.task,
    repository: state.repository,
    agent: state.agent,
    worktreeDir: state.worktreeDir,
    branchName: state.branchName,
    workspaceName: state.workspaceName,
    resumeCount: state.resumeCount,
  };
}

function sourceFromWorktree(
  config: ResolvedConfig,
  task: string,
  entry: WorktreeEntry,
): InterruptSource {
  return {
    task,
    repository: entry.repository,
    agent: config.agents.default,
    worktreeDir: entry.dir,
    branchName: entry.branchName,
    workspaceName: task,
    resumeCount: 0,
  };
}

function resolveInterruptSource(arguments_: {
  config: ResolvedConfig;
  task: string;
  state: RunState | undefined;
  entry: WorktreeEntry | undefined;
}): InterruptSource | undefined {
  if (arguments_.state !== undefined) {
    return sourceFromState(arguments_.state);
  }
  if (arguments_.entry !== undefined) {
    return sourceFromWorktree(arguments_.config, arguments_.task, arguments_.entry);
  }
  return undefined;
}

function interruptDetail(result: WorkspaceInterruptResult): string | undefined {
  if (result.kind === "missing") {
    return "workspace missing";
  }
  return undefined;
}

export async function interruptWorkspace(
  config: ResolvedConfig,
  options: InterruptWorkspaceOptions,
  runOptions: InterruptWorkspaceRunOptions = {},
): Promise<StopResult> {
  const task = options.task.toLowerCase();
  const state = readRunState(config, task);
  const [entry] = worktrees.findByTask(config, task);
  const source = resolveInterruptSource({ config, task, state, entry });
  if (source === undefined) {
    return await interruptOrphanWorkspace(config, task, runOptions.signal);
  }
  const result =
    runOptions.signal === undefined
      ? await workspaces.interrupt(config, source.workspaceName)
      : await workspaces.interrupt(config, source.workspaceName, runOptions.signal);
  switch (result.kind) {
    case "unavailable": {
      const detail =
        result.error === undefined ? "workspace adapter unavailable" : errorMessage(result.error);
      return stopResult({
        task,
        state,
        source,
        outcome: "conflict",
        lifecycleState: state?.state ?? "unknown",
        problems: [
          {
            code: LIFECYCLE_PROBLEM_CODES.workspaceStatusUnavailable,
            message: `Could not interrupt workspace: ${detail}`,
          },
        ],
      });
    }
    case "interrupted":
    case "missing": {
      const detail = interruptDetail(result);
      const problem = recordInterruptedState({ config, task, source, options, detail });
      const outcome =
        problem === undefined
          ? result.kind === "interrupted"
            ? "stopped"
            : state?.state === "interrupted"
              ? "already-stopped"
              : "workspace-missing"
          : "partial";
      return stopResult({
        task,
        state,
        source,
        outcome,
        lifecycleState: "interrupted",
        problems: problem === undefined ? [] : [problem],
      });
    }
    /* v8 ignore next 2 @preserve -- WorkspaceInterruptResult is exhaustively discriminated above */
    default:
      throw new Error("Unexpected workspace interrupt result");
  }
}

// Orphan path: a tmux session/window for `task` exists but neither a run-state
// record nor a worktree does, so there's no lifecycle to record `interrupted`
// against — just close the workspace. Reported in `crew status` under
// "Orphaned sessions" and pointed at `crew stop`.
async function interruptOrphanWorkspace(
  config: ResolvedConfig,
  task: string,
  signal: AbortSignal | undefined,
): Promise<StopResult> {
  const result =
    signal === undefined
      ? await workspaces.interrupt(config, task)
      : await workspaces.interrupt(config, task, signal);
  switch (result.kind) {
    case "unavailable": {
      const detail =
        result.error === undefined ? "workspace adapter unavailable" : errorMessage(result.error);
      return {
        action: "stop",
        task: { id: task },
        outcome: "conflict",
        state: "unknown",
        resources: {},
        problems: [
          {
            code: LIFECYCLE_PROBLEM_CODES.workspaceStatusUnavailable,
            message: `Could not interrupt workspace: ${detail}`,
          },
        ],
      };
    }
    case "missing":
      return {
        action: "stop",
        task: { id: task },
        outcome: "not-found",
        state: "absent",
        resources: {},
        problems: [],
      };
    case "interrupted":
      return {
        action: "stop",
        task: { id: task },
        outcome: "stopped",
        state: "absent",
        resources: { workspace: { name: task } },
        problems: [],
      };
    /* v8 ignore next 2 @preserve -- WorkspaceInterruptResult is exhaustively discriminated above */
    default:
      throw new Error("Unexpected workspace interrupt result");
  }
}

export async function interruptWorkspaceCli(argv: string[]): Promise<StopResult> {
  const parsed = parseArguments(argv);
  const config = await loadLifecycleConfig(parsed.json);
  return await executeLifecycleMutation({
    config,
    task: parsed.options.task,
    json: parsed.json,
    conflictResult: () => stopLockConflictResult({ config, task: parsed.options.task }),
    operation: async ({ signal }) => await interruptWorkspace(config, parsed.options, { signal }),
    cancelledResult: async (context) =>
      await cancelledStopResult({ config, options: parsed.options, context }),
  });
}

function recordInterruptedState(arguments_: {
  config: ResolvedConfig;
  task: string;
  source: InterruptSource;
  options: InterruptWorkspaceOptions;
  detail: string | undefined;
}): LifecycleProblem | undefined {
  const { config, task, source, options, detail } = arguments_;
  try {
    recordRunState({
      config,
      state: {
        task,
        repository: source.repository,
        agent: source.agent,
        worktreeDir: source.worktreeDir,
        branchName: source.branchName,
        workspaceName: source.workspaceName,
        state: "interrupted",
        resumeCount: source.resumeCount,
        ...(options.reason === undefined ? {} : { reason: options.reason }),
        ...(detail === undefined ? {} : { detail }),
      },
    });
    return undefined;
  } catch (error) {
    return {
      code: LIFECYCLE_PROBLEM_CODES.stateWriteFailed,
      message: `Workspace was stopped but run state could not be updated: ${errorMessage(error)}`,
    };
  }
}

function stopResult(arguments_: {
  task: string;
  state: RunState | undefined;
  source: InterruptSource;
  outcome: StopResult["outcome"];
  lifecycleState: StopResult["state"];
  problems: LifecycleProblem[];
}): StopResult {
  return {
    action: "stop",
    task: taskIdentity(arguments_.task, arguments_.state),
    outcome: arguments_.outcome,
    state: arguments_.lifecycleState,
    resources: resourcesFromSource(arguments_.source),
    problems: arguments_.problems,
  };
}

function taskIdentity(task: string, state: RunState | undefined): StopResult["task"] {
  return {
    id: task,
    ...(state?.completionTaskId === undefined ? {} : { canonicalId: state.completionTaskId }),
    ...(state?.url === undefined ? {} : { url: state.url }),
  };
}

function resourcesFromSource(source: InterruptSource | undefined): LifecycleResources {
  if (source === undefined) {
    return {};
  }
  return {
    repository: source.repository,
    branch: source.branchName,
    worktreeDir: source.worktreeDir,
    workspace: { name: source.workspaceName },
    agent: source.agent,
  };
}

function stopLockConflictResult(arguments_: { config: ResolvedConfig; task: string }): StopResult {
  const state = readRunState(arguments_.config, arguments_.task);
  const [entry] = worktrees.findByTask(arguments_.config, arguments_.task);
  const source = resolveInterruptSource({
    config: arguments_.config,
    task: arguments_.task,
    state,
    entry,
  });
  return {
    action: "stop",
    task: taskIdentity(arguments_.task, state),
    outcome: "conflict",
    state: state?.state ?? "unknown",
    resources: resourcesFromSource(source),
    problems: [
      {
        code: LIFECYCLE_PROBLEM_CODES.lifecycleLockHeld,
        message: "Another lifecycle mutation owns this task.",
      },
    ],
  };
}

async function cancelledStopResult(arguments_: {
  config: ResolvedConfig;
  options: InterruptWorkspaceOptions;
  context: LifecycleCancellationContext;
}): Promise<StopResult> {
  const { config, options, context } = arguments_;
  const state = readRunState(config, options.task);
  const [entry] = worktrees.findByTask(config, options.task);
  const source = resolveInterruptSource({
    config,
    task: options.task,
    state,
    entry,
  });
  const probe = await probeWorkspaceForLifecycleReconciliation(config);
  const workspaceAbsent = probe.kind === "ok" && !probe.names.has(options.task);
  let stateProblem: LifecycleProblem | undefined;
  if (workspaceAbsent && source !== undefined) {
    stateProblem = recordInterruptedState({
      config,
      task: options.task,
      source,
      options,
      detail: "workspace missing after cancellation",
    });
  }
  return {
    action: "stop",
    task: taskIdentity(options.task, state),
    outcome: "partial",
    state: workspaceAbsent ? "interrupted" : (state?.state ?? "unknown"),
    resources: resourcesFromSource(source),
    problems: [
      {
        code: LIFECYCLE_PROBLEM_CODES.cancelled,
        message: `Stop cancelled${lifecycleCancellationSuffix(context)}.`,
      },
      ...(stateProblem === undefined ? [] : [stateProblem]),
    ],
  };
}
