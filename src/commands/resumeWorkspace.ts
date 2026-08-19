import { type Board, createBoard } from "../lib/board.ts";
import { buildSources, sourcesFromConfig } from "../lib/buildSources.ts";
import { type AgentDefinition, loadConfig, type ResolvedConfig } from "../lib/config.ts";
import { composeAgentLaunch, openAgentWorkspace, prepareAgentLaunch } from "../lib/agentLaunch.ts";
import {
  inferAgentCommandName,
  withResumeArgs,
  workerEnvironmentForTask,
} from "../lib/launchCommand.ts";
import { readRunState, recordRunState, type RunState } from "../lib/runState.ts";
import { seedLaunchWorkspaceTrust } from "../lib/seedLaunchWorkspaceTrust.ts";
import { taskSupportsCompletionCommand } from "../lib/sourceCapabilities.ts";
import {
  removeStagedPrompt,
  stageBuildSecrets,
  stagePromptText,
  stageWorkspaceLaunchCommand,
} from "../lib/stagedLaunch.ts";
import { taskSourceWritePathsForCompletion } from "../lib/taskSourceFilesystem.ts";
import { naturalIdFromCanonical } from "../lib/taskSource.ts";
import { errorMessage, log, withConsoleOutputSuppressed } from "../lib/util.ts";
import { workspaces } from "../lib/workspaces.ts";
import { resolveLaunchDir, type WorktreeEntry, worktrees } from "../lib/worktrees.ts";
import { cleanupAgentLaunchBestEffort } from "./agentLaunchCleanup.ts";
import {
  executeLifecycleMutation,
  lifecycleCancellationSuffix,
  type LifecycleCancellationContext,
} from "./lifecycleCommand.ts";
import {
  LIFECYCLE_PROBLEM_CODES,
  type LifecycleProblem,
  type LifecycleResources,
  type ResumeResult,
} from "./lifecycleResult.ts";

export interface ResumeWorkspaceOptions {
  task: string;
  /** Source-qualified id supplied at the CLI boundary, when present. */
  taskSourceId?: string;
  /**
   * Force a fresh conversation: cold-start the agent (the historic behavior),
   * ignoring the agent's `resumeArgs`. Defaults to false, which reopens the
   * agent's previous conversation when `resumeArgs` is configured.
   */
  fresh?: boolean;
}

export interface ResumeWorkspaceRunOptions {
  signal?: AbortSignal;
  board?: Board;
}

interface TaskDetails {
  title: string;
  description: string;
  url?: string;
}

interface ResumeContext {
  task: string;
  repository: string;
  agent: string;
  worktree: WorktreeEntry;
  title: string;
  description: string;
  url?: string;
  completionTaskId: string;
  completionMarkDoneSupported: boolean;
  reason?: string;
  resumeCount: number;
}

function parseArguments(argv: string[]): { options: ResumeWorkspaceOptions; json: boolean } {
  let fresh = false;
  let json = false;
  const positionals: string[] = [];
  for (const argument of argv) {
    if (argument === "--new") {
      fresh = true;
      continue;
    }
    if (argument === "--json") {
      json = true;
      continue;
    }
    positionals.push(argument);
  }
  const [task, ...extras] = positionals;
  if (task === undefined || task.length === 0 || extras.length > 0 || task.startsWith("-")) {
    throw new Error("Usage: crew resume [--new] <task>");
  }
  return {
    options: {
      task: naturalIdFromCanonical(task).toLowerCase(),
      taskSourceId: task,
      fresh,
    },
    json,
  };
}

async function resolveTaskDetails(
  config: ResolvedConfig,
  taskId: string,
  board?: Board,
): Promise<TaskDetails | undefined> {
  const rawSources = sourcesFromConfig(config);
  if (rawSources.length === 0) {
    return undefined;
  }
  try {
    const resolvedBoard =
      board ?? createBoard(await buildSources(rawSources, { globalConfig: config }));
    const issue = await resolvedBoard.resolveOne(taskId);
    if (issue === undefined) {
      return undefined;
    }
    return {
      title: issue.title,
      description: issue.description,
      ...(issue.url === undefined ? {} : { url: issue.url }),
    };
  } catch (error) {
    log(`Resume task detail lookup failed for ${taskId}: ${errorMessage(error)}`);
    return undefined;
  }
}

async function contextFromBoard(
  config: ResolvedConfig,
  task: string,
  taskId: string,
  worktree: WorktreeEntry,
  board?: Board,
): Promise<ResumeContext> {
  const rawSources = sourcesFromConfig(config);
  if (rawSources.length === 0) {
    throw new Error(
      `Cannot resume ${task}: no run state recorded and no task source is configured.`,
    );
  }
  const resolvedBoard =
    board ?? createBoard(await buildSources(rawSources, { globalConfig: config }));
  const resolved = await resolvedBoard.resolveOne(taskId);
  if (resolved === undefined) {
    throw new Error(`Task ${taskId} not found across configured sources.`);
  }
  if (resolved.repository === undefined || resolved.agent === undefined) {
    throw new Error(
      `Task ${taskId} resolved but isn't groundcrew-eligible (missing agent-* label or repository/agent).`,
    );
  }
  return {
    task,
    repository: resolved.repository,
    agent: resolved.agent,
    worktree,
    title: resolved.title,
    description: resolved.description,
    ...(resolved.url === undefined ? {} : { url: resolved.url }),
    completionTaskId: resolved.id,
    completionMarkDoneSupported: taskSupportsCompletionCommand({
      rawSources,
      taskId: resolved.id,
    }),
    resumeCount: 0,
  };
}

async function contextFromState(
  config: ResolvedConfig,
  task: string,
  state: RunState,
  worktree: WorktreeEntry,
  board?: Board,
): Promise<ResumeContext> {
  const completionTaskId = state.completionTaskId ?? task;
  const details = await resolveTaskDetails(config, completionTaskId, board);
  const url = state.url ?? details?.url;
  return {
    task,
    repository: state.repository,
    agent: state.agent,
    // Prefer the branch recorded in run state: `crew open` worktrees check out
    // an existing PR branch that diverges from the `<prefix>-<task>` name the
    // worktree-dir scan derives, and run state is the source of truth for it.
    worktree: { ...worktree, branchName: state.branchName },
    title: details?.title ?? state.title ?? task.toUpperCase(),
    description: details?.description ?? "",
    ...(url === undefined ? {} : { url }),
    completionTaskId,
    completionMarkDoneSupported: taskSupportsCompletionCommand({
      rawSources: sourcesFromConfig(config),
      taskId: completionTaskId,
    }),
    ...(state.reason === undefined ? {} : { reason: state.reason }),
    resumeCount: state.resumeCount,
  };
}

async function buildResumeContext(
  config: ResolvedConfig,
  options: ResumeWorkspaceOptions,
  board?: Board,
): Promise<ResumeContext | undefined> {
  const { task } = options;
  const state = readRunState(config, task);
  const entries = worktrees.findByTask(config, task);
  const worktree =
    state === undefined
      ? entries[0]
      : (entries.find((entry) => entry.repository === state.repository) ?? entries[0]);
  if (worktree === undefined) {
    return undefined;
  }
  if (state !== undefined) {
    return await contextFromState(config, task, state, worktree, board);
  }
  return await contextFromBoard(config, task, options.taskSourceId ?? task, worktree, board);
}

function renderResumePrompt(context: ResumeContext): string {
  return [
    `You are resuming Groundcrew task ${context.task} (${context.title}) in an existing worktree.`,
    "",
    "Task description:",
    "",
    context.description,
    "",
    "## Continuation context",
    "",
    `- Worktree: ${context.worktree.dir}`,
    `- Branch: ${context.worktree.branchName}`,
    context.reason === undefined
      ? "- Previous interrupt reason: none recorded"
      : `- Previous interrupt reason: ${context.reason}`,
    "",
    "Before editing, inspect the current git status and diff. Continue from the work already present in this worktree; do not restart from scratch unless the diff proves that is necessary.",
    "",
    "Run the repository's documented verification before stopping, then leave the branch ready or open a PR when possible.",
  ].join("\n");
}

/**
 * Decide the definition to launch on resume: when the agent has `resumeArgs`
 * and `--new` was not passed, append them so the agent reopens its previous
 * conversation; otherwise cold-start (the historic behavior).
 */
function resolveResumeLaunch(input: {
  task: string;
  definition: AgentDefinition;
  fresh: boolean;
}): AgentDefinition {
  const { task, definition, fresh } = input;
  if (fresh || definition.resumeArgs === undefined) {
    if (fresh && definition.resumeArgs !== undefined) {
      log(`Starting a fresh conversation for ${task}`);
    }
    return definition;
  }
  log(`Reopening the previous conversation for ${task}`);
  return withResumeArgs(definition, definition.resumeArgs);
}

export async function resumeWorkspace(
  config: ResolvedConfig,
  options: ResumeWorkspaceOptions,
  runOptions: ResumeWorkspaceRunOptions = {},
): Promise<ResumeResult> {
  return await withConsoleOutputSuppressed(
    async () => await resumeWorkspaceOperation(config, options, runOptions),
  );
}

// oxlint-disable-next-line eslint/complexity -- lifecycle outcomes are kept together as one decision table
async function resumeWorkspaceOperation(
  config: ResolvedConfig,
  options: ResumeWorkspaceOptions,
  runOptions: ResumeWorkspaceRunOptions,
): Promise<ResumeResult> {
  const task = options.task.toLowerCase();
  const state = readRunState(config, task);
  const entries = worktrees.findByTask(config, task);
  const probe =
    runOptions.signal === undefined
      ? await workspaces.probe(config)
      : await workspaces.probe(config, runOptions.signal);
  if (probe.kind === "unavailable") {
    const detail = probe.error === undefined ? "" : `: ${errorMessage(probe.error)}`;
    return resumeClassifiedResult({
      task,
      state,
      resources: resumeResourcesFromLocal({ state, entries }),
      outcome: "conflict",
      lifecycleState: state?.state ?? "unknown",
      problems: [
        {
          code: LIFECYCLE_PROBLEM_CODES.workspaceStatusUnavailable,
          message: `Could not verify whether the task workspace is already live${detail}.`,
        },
      ],
    });
  }
  if (probe.names.has(task)) {
    const hasMatchingContext = state !== undefined || entries.length > 0;
    return resumeClassifiedResult({
      task,
      state,
      resources: {
        ...resumeResourcesFromLocal({ state, entries }),
        workspace: { name: task },
      },
      outcome: hasMatchingContext ? "already-running" : "conflict",
      lifecycleState: state?.state === "resumed" ? "resumed" : "running",
      problems: hasMatchingContext
        ? []
        : [
            {
              code: LIFECYCLE_PROBLEM_CODES.workspaceConflict,
              message: "A live workspace exists without matching local task context.",
            },
          ],
    });
  }
  const context = await buildResumeContext(config, options, runOptions.board);
  if (context === undefined) {
    return resumeClassifiedResult({
      task,
      state,
      resources: resumeResourcesFromLocal({ state, entries }),
      outcome: "not-found",
      lifecycleState: "absent",
      problems: [],
    });
  }
  const definition = config.agents.definitions[context.agent];
  if (definition === undefined) {
    throw new Error(`Unknown agent: ${context.agent}`);
  }

  const launchDefinition = resolveResumeLaunch({
    task,
    definition,
    fresh: options.fresh === true,
  });

  const { runner, networkEgress, sandboxName, workspaceKind, ensureReady } =
    await prepareAgentLaunch({
      config,
      agent: context.agent,
      definition: launchDefinition,
      purpose: "resumes",
      ...(runOptions.signal === undefined ? {} : { signal: runOptions.signal }),
    });
  await ensureReady();

  const worktreeDir = context.worktree.dir;
  const launchDir = resolveLaunchDir(config, context.repository, worktreeDir);
  const stagedPrompt = stagePromptText({
    prefix: "groundcrew-resume",
    task,
    text: renderResumePrompt(context),
  });
  const secretsFile = stageBuildSecrets(stagedPrompt.directory);
  let cleanupAgentLaunch: (() => void) | undefined;
  try {
    const taskSourceWritePaths =
      runner === "safehouse"
        ? taskSourceWritePathsForCompletion({
            config,
            taskId: context.completionTaskId,
            workingDir: launchDir,
          })
        : undefined;
    seedLaunchWorkspaceTrust({
      agentCommandName: inferAgentCommandName(launchDefinition.cmd),
      launchDir,
    });
    const launch = composeAgentLaunch({
      runner,
      networkEgress,
      task,
      definition: launchDefinition,
      promptFile: stagedPrompt.file,
      worktreeDir,
      workingDir: launchDir,
      secretsFile,
      sandboxName,
      workspaceKind,
      readOnlyDirs: config.local.readOnlyDirs,
      workerEnvironment: workerEnvironmentForTask({
        taskId: context.completionTaskId,
        markDoneSupported: context.completionMarkDoneSupported,
      }),
      taskSourceWritePaths,
      safehouseEnableFeatures: config.local.safehouse.enable,
    });
    cleanupAgentLaunch = launch.cleanup;
    const launchCmd = stageWorkspaceLaunchCommand(stagedPrompt.directory, launch.command);
    await openAgentWorkspace({
      config,
      name: task,
      displayName: context.title,
      ...(context.url === undefined ? {} : { url: context.url }),
      cwd: launchDir,
      command: launchCmd,
      agent: context.agent,
      color: definition.color,
      ...(runOptions.signal === undefined ? {} : { signal: runOptions.signal }),
    });
  } catch (error) {
    cleanupAgentLaunchBestEffort({
      cleanup: cleanupAgentLaunch,
      context: `resume rollback for ${task}`,
    });
    try {
      removeStagedPrompt(stagedPrompt.directory);
    } catch (cleanupError) {
      log(
        `Staged prompt cleanup failed during resume rollback for ${task}: ${errorMessage(cleanupError)}`,
      );
    }
    throw error;
  }

  let stateProblem: LifecycleProblem | undefined;
  try {
    recordRunState({
      config,
      state: {
        task,
        repository: context.repository,
        agent: context.agent,
        worktreeDir: context.worktree.dir,
        branchName: context.worktree.branchName,
        workspaceName: task,
        state: "resumed",
        resumeCount: context.resumeCount + 1,
        completionTaskId: context.completionTaskId,
        ...(context.url === undefined ? {} : { url: context.url }),
        ...(context.reason === undefined ? {} : { reason: context.reason }),
      },
    });
  } catch (error) {
    stateProblem = {
      code: LIFECYCLE_PROBLEM_CODES.stateWriteFailed,
      message: `Workspace resumed but run state could not be updated: ${errorMessage(error)}`,
    };
  }
  const cancelled = runOptions.signal?.aborted === true;
  return {
    action: "resume",
    task: {
      id: task,
      canonicalId: context.completionTaskId,
      ...(context.url === undefined ? {} : { url: context.url }),
    },
    outcome: stateProblem === undefined && !cancelled ? "resumed" : "partial",
    state: "resumed",
    resources: resourcesFromResumeContext(context),
    problems: [
      ...(cancelled
        ? [
            {
              code: LIFECYCLE_PROBLEM_CODES.cancelled,
              message: "Resume was cancelled after the workspace opened.",
            },
          ]
        : []),
      ...(stateProblem === undefined ? [] : [stateProblem]),
    ],
  };
}

export async function resumeWorkspaceCli(argv: string[]): Promise<ResumeResult> {
  const parsed = parseArguments(argv);
  const config = await loadConfig();
  return await executeLifecycleMutation({
    config,
    task: parsed.options.task,
    json: parsed.json,
    conflictResult: () => resumeLockConflictResult({ config, task: parsed.options.task }),
    operation: async ({ signal }) => await resumeWorkspace(config, parsed.options, { signal }),
    cancelledResult: async (context) =>
      await cancelledResumeResult({ config, task: parsed.options.task, context }),
  });
}

function resumeClassifiedResult(arguments_: {
  task: string;
  state: RunState | undefined;
  resources: LifecycleResources;
  outcome: ResumeResult["outcome"];
  lifecycleState: ResumeResult["state"];
  problems: LifecycleProblem[];
}): ResumeResult {
  return {
    action: "resume",
    task: resumeTaskIdentity(arguments_.task, arguments_.state),
    outcome: arguments_.outcome,
    state: arguments_.lifecycleState,
    resources: arguments_.resources,
    problems: arguments_.problems,
  };
}

function resumeTaskIdentity(task: string, state: RunState | undefined): ResumeResult["task"] {
  return {
    id: task,
    ...(state?.completionTaskId === undefined ? {} : { canonicalId: state.completionTaskId }),
    ...(state?.url === undefined ? {} : { url: state.url }),
  };
}

function resumeResourcesFromLocal(arguments_: {
  state: RunState | undefined;
  entries: readonly WorktreeEntry[];
}): LifecycleResources {
  const entry =
    arguments_.state === undefined
      ? arguments_.entries[0]
      : (arguments_.entries.find(
          (candidate) => candidate.repository === arguments_.state?.repository,
        ) ?? arguments_.entries[0]);
  const repository = arguments_.state?.repository ?? entry?.repository;
  const branch = arguments_.state?.branchName ?? entry?.branchName;
  const worktreeDir = arguments_.state?.worktreeDir ?? entry?.dir;
  return {
    ...(repository === undefined ? {} : { repository }),
    ...(branch === undefined ? {} : { branch }),
    ...(worktreeDir === undefined ? {} : { worktreeDir }),
    ...(arguments_.state?.agent === undefined ? {} : { agent: arguments_.state.agent }),
  };
}

function resourcesFromResumeContext(context: ResumeContext): LifecycleResources {
  return {
    repository: context.repository,
    branch: context.worktree.branchName,
    worktreeDir: context.worktree.dir,
    workspace: { name: context.task },
    agent: context.agent,
  };
}

function resumeLockConflictResult(arguments_: {
  config: ResolvedConfig;
  task: string;
}): ResumeResult {
  const state = readRunState(arguments_.config, arguments_.task);
  return resumeClassifiedResult({
    task: arguments_.task,
    state,
    resources: resumeResourcesFromLocal({
      state,
      entries: worktrees.findByTask(arguments_.config, arguments_.task),
    }),
    outcome: "conflict",
    lifecycleState: state?.state ?? "unknown",
    problems: [
      {
        code: LIFECYCLE_PROBLEM_CODES.lifecycleLockHeld,
        message: "Another lifecycle mutation owns this task.",
      },
    ],
  });
}

function reconciledResumeRunState(arguments_: {
  config: ResolvedConfig;
  task: string;
  state: RunState | undefined;
  repository: string;
  worktreeDir: string;
  branchName: string;
}): Parameters<typeof recordRunState>[0]["state"] {
  return {
    task: arguments_.task,
    repository: arguments_.repository,
    agent: arguments_.state?.agent ?? arguments_.config.agents.default,
    worktreeDir: arguments_.worktreeDir,
    branchName: arguments_.branchName,
    workspaceName: arguments_.state?.workspaceName ?? arguments_.task,
    state: "resumed",
    resumeCount: (arguments_.state?.resumeCount ?? 0) + 1,
    ...(arguments_.state?.completionTaskId === undefined
      ? {}
      : { completionTaskId: arguments_.state.completionTaskId }),
    ...(arguments_.state?.url === undefined ? {} : { url: arguments_.state.url }),
    ...(arguments_.state?.reason === undefined ? {} : { reason: arguments_.state.reason }),
  };
}

function reconcileCancelledResumeState(arguments_: {
  config: ResolvedConfig;
  task: string;
  state: RunState | undefined;
  entries: readonly WorktreeEntry[];
  isLive: boolean;
}): LifecycleProblem | undefined {
  if (!arguments_.isLive) {
    return undefined;
  }
  const [entry] = arguments_.entries;
  const repository = arguments_.state?.repository ?? entry?.repository;
  const worktreeDir = arguments_.state?.worktreeDir ?? entry?.dir;
  const branchName = arguments_.state?.branchName ?? entry?.branchName;
  if (repository === undefined || worktreeDir === undefined || branchName === undefined) {
    return undefined;
  }
  try {
    recordRunState({
      config: arguments_.config,
      state: reconciledResumeRunState({
        config: arguments_.config,
        task: arguments_.task,
        state: arguments_.state,
        repository,
        worktreeDir,
        branchName,
      }),
    });
    return undefined;
  } catch (error) {
    return {
      code: LIFECYCLE_PROBLEM_CODES.stateWriteFailed,
      message: `Live resumed workspace could not be reconciled to run state: ${errorMessage(error)}`,
    };
  }
}

async function cancelledResumeResult(arguments_: {
  config: ResolvedConfig;
  task: string;
  context: LifecycleCancellationContext;
}): Promise<ResumeResult> {
  const state = readRunState(arguments_.config, arguments_.task);
  const entries = worktrees.findByTask(arguments_.config, arguments_.task);
  const probe = await workspaces.probe(arguments_.config);
  const isLive = probe.kind === "ok" && probe.names.has(arguments_.task);
  const stateProblem = reconcileCancelledResumeState({
    config: arguments_.config,
    task: arguments_.task,
    state,
    entries,
    isLive,
  });
  return resumeClassifiedResult({
    task: arguments_.task,
    state,
    resources: {
      ...resumeResourcesFromLocal({ state, entries }),
      ...(isLive ? { workspace: { name: arguments_.task } } : {}),
    },
    outcome: "partial",
    lifecycleState: isLive ? "resumed" : (state?.state ?? "unknown"),
    problems: [
      {
        code: LIFECYCLE_PROBLEM_CODES.cancelled,
        message: `Resume cancelled${lifecycleCancellationSuffix(arguments_.context)}.`,
      },
      ...(stateProblem === undefined ? [] : [stateProblem]),
    ],
  });
}
