import { loadConfig, type ResolvedConfig } from "../lib/config.ts";
import { composeAgentLaunch, openAgentWorkspace, prepareAgentLaunch } from "../lib/agentLaunch.ts";
import { inferAgentCommandName, workerEnvironmentForTask } from "../lib/launchCommand.ts";
import { type Board, createBoard } from "../lib/board.ts";
import { buildSources, sourcesFromConfig } from "../lib/buildSources.ts";
import { resolveRepositoryPreparationCommands } from "../lib/repositoryHooks.ts";
import { readRunState, recordRunState, type RunState } from "../lib/runState.ts";
import { seedLaunchWorkspaceTrust } from "../lib/seedLaunchWorkspaceTrust.ts";
import { sourceSupportsMarkDone } from "../lib/sourceCapabilities.ts";
import {
  removeStagedPrompt,
  stageBuildSecrets,
  stagePromptFromTemplate,
  stageWorkspaceLaunchCommand,
  type StagedPrompt,
} from "../lib/stagedLaunch.ts";
import { taskSourceWritePathsForCompletion } from "../lib/taskSourceFilesystem.ts";
import { naturalIdFromCanonical, type WorktreePreparation } from "../lib/taskSource.ts";
import { debug, errorMessage, log, withConsoleOutputSuppressed } from "../lib/util.ts";
import { type WorkspaceAccessHint, workspaces } from "../lib/workspaces.ts";
import {
  resolveLaunchDir,
  WorktreeAlreadyExistsError,
  type WorktreeEntry,
  worktrees,
} from "../lib/worktrees.ts";
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
  type StartResult,
} from "./lifecycleResult.ts";

export interface TaskDetails {
  title: string;
  description: string;
  /** Direct web URL for the task; cached into RunState when present. */
  url?: string;
}

export interface SetupWorkspaceOptions {
  task: string;
  /** Canonical source id for worker self-completion; falls back to `task`. */
  completionTaskId?: string;
  /** Whether the task source can apply `crew task done`; defaults to true for direct calls. */
  completionMarkDoneSupported?: boolean;
  repository: string;
  agent: string;
  /** Set to `skip` to bypass configured prepareWorktree hooks. */
  worktreePreparation?: WorktreePreparation;
  details: TaskDetails;
}

export interface SetupWorkspaceRunOptions {
  signal?: AbortSignal;
}

function stagePrompt(input: {
  config: ResolvedConfig;
  task: string;
  taskDetails: TaskDetails;
  worktreeName: string;
  workspaceContinuationInstruction: string;
}): StagedPrompt {
  return stagePromptFromTemplate({
    config: input.config,
    prefix: "groundcrew",
    task: input.task,
    variables: {
      task: input.task,
      worktree: input.worktreeName,
      title: input.taskDetails.title,
      description: input.taskDetails.description,
      workspaceContinuationInstruction: input.workspaceContinuationInstruction,
    },
  });
}

export async function setupWorkspace(
  config: ResolvedConfig,
  options: SetupWorkspaceOptions,
  runOptions: SetupWorkspaceRunOptions = {},
): Promise<StartResult> {
  return await withConsoleOutputSuppressed(
    async () => await setupWorkspaceOperation(config, options, runOptions),
  );
}

async function setupWorkspaceOperation(
  config: ResolvedConfig,
  options: SetupWorkspaceOptions,
  runOptions: SetupWorkspaceRunOptions,
): Promise<StartResult> {
  const { task, repository, agent } = options;
  const { signal } = runOptions;
  const definition = config.agents.definitions[agent];
  if (!definition) {
    throw new Error(`Unknown agent: ${agent}`);
  }
  const { runner, networkEgress, sandboxName, workspaceKind, ensureReady } =
    await prepareAgentLaunch({
      config,
      agent,
      definition,
      purpose: "runs",
      ...(signal === undefined ? {} : { signal }),
    });

  await preflightProvisioningGate({ config, options, signal });

  const spec = { repository, task };
  const createdPromise =
    signal === undefined ? worktrees.create(config, spec) : worktrees.create(config, spec, signal);
  const readinessPromise = startLaunchReadiness(ensureReady);
  let created: WorktreeEntry;
  try {
    created = await createdPromise;
  } catch (error) {
    // Roll the pre-flight `provisioning` row forward; the outer catch only
    // fires post-create and the dispatcher just logs and moves on.
    recordFailedToLaunch({
      config,
      options,
      paths: worktrees.predictedEntry(config, repository, task),
      error,
    });
    throw error;
  }
  const { branchName, dir: worktreeDir } = created;
  const launchDir = resolveLaunchDir(config, repository, worktreeDir);
  const worktreeName = `${repository}-${task}`;

  // Anything that fails after the worktree is on disk must roll it back
  // (the worktree and the just-created branch). `workspaces.open` cleans
  // up its own workspace on a status-paint failure but does not auto-
  // close on unrecognized cmux output — closing by title there could hit
  // a same-named sibling, so we log a hint and accept a rare leak.
  // Without rollback the next tick hits "Worktree already exists" and
  // the task strands forever.
  let promptDir: string | undefined;
  let cleanupAgentLaunch: (() => void) | undefined;
  let accessHint: WorkspaceAccessHint | undefined;
  try {
    await assertLaunchReady(readinessPromise);

    const taskDetails = options.details;
    accessHint = await workspaces.accessHint(config, task, signal);

    const stagedPrompt = stagePrompt({
      config,
      task,
      taskDetails,
      worktreeName,
      workspaceContinuationInstruction: renderWorkspaceContinuationInstruction(accessHint),
    });
    promptDir = stagedPrompt.directory;

    const shouldPrepareWorktree = options.worktreePreparation !== "skip";
    const { prepareWorktreeCommand, prepareWorktreeUnsandboxedCommand } =
      resolveTaskPreparationCommands({
        config,
        repository,
        launchDir,
        shouldPrepareWorktree,
      });
    if (!shouldPrepareWorktree) {
      log(`Skipping prepareWorktree for ${task} (task policy)`);
    }
    const secretsFile =
      prepareWorktreeCommand === undefined && prepareWorktreeUnsandboxedCommand === undefined
        ? undefined
        : stageBuildSecrets(promptDir);
    const completionTaskId = options.completionTaskId ?? task;
    const completionMarkDoneSupported = options.completionMarkDoneSupported ?? true;
    const taskSourceWritePaths =
      runner === "safehouse"
        ? taskSourceWritePathsForCompletion({
            config,
            taskId: completionTaskId,
            workingDir: launchDir,
          })
        : undefined;
    seedLaunchWorkspaceTrust({
      agentCommandName: inferAgentCommandName(definition.cmd),
      launchDir,
    });
    const launch = composeAgentLaunch({
      runner,
      networkEgress,
      task,
      definition,
      promptFile: stagedPrompt.file,
      worktreeDir,
      workingDir: launchDir,
      secretsFile,
      prepareWorktreeCommand,
      prepareWorktreeUnsandboxedCommand,
      sandboxName,
      workspaceKind,
      readOnlyDirs: config.local.readOnlyDirs,
      workerEnvironment: workerEnvironmentForTask({
        taskId: completionTaskId,
        markDoneSupported: completionMarkDoneSupported,
      }),
      taskSourceWritePaths,
      safehouseEnableFeatures: config.local.safehouse.enable,
    });
    cleanupAgentLaunch = launch.cleanup;
    const launchCmd = stageWorkspaceLaunchCommand(promptDir, launch.command);

    debug("Opening workspace...");
    await openAgentWorkspace({
      config,
      name: task,
      displayName: taskDetails.title,
      url: taskDetails.url,
      cwd: launchDir,
      command: launchCmd,
      agent,
      color: definition.color,
      ...(signal === undefined ? {} : { signal }),
    });
    const stateProblem = recordRunStateBestEffort({
      config,
      task,
      repository,
      agent,
      worktreeDir,
      branchName,
      workspaceName: task,
      state: "running",
      title: taskDetails.title,
      completionTaskId,
      ...(taskDetails.url === undefined ? {} : { url: taskDetails.url }),
    });

    return {
      action: "start",
      task: lifecycleTaskIdentity({
        task,
        canonicalId: completionTaskId,
        url: taskDetails.url,
      }),
      outcome: stateProblem === undefined ? "started" : "partial",
      state: "running",
      resources: {
        repository,
        branch: branchName,
        worktreeDir,
        workspace: {
          name: task,
          ...(accessHint === undefined ? {} : { accessCommand: accessHint.command }),
        },
        agent,
      },
      problems: stateProblem === undefined ? [] : [stateProblem],
    };
  } catch (error) {
    cleanupAgentLaunchBestEffort({ cleanup: cleanupAgentLaunch, context: "setup rollback" });
    await rollbackWorktree({ config, entry: created, promptDir });
    recordFailedToLaunch({ config, options, paths: { worktreeDir, branchName }, error });
    throw error;
  }
}

function resolveTaskPreparationCommands(arguments_: {
  config: ResolvedConfig;
  repository: string;
  launchDir: string;
  shouldPrepareWorktree: boolean;
}): {
  prepareWorktreeCommand: string | undefined;
  prepareWorktreeUnsandboxedCommand: string | undefined;
} {
  if (!arguments_.shouldPrepareWorktree) {
    return {
      prepareWorktreeCommand: undefined,
      prepareWorktreeUnsandboxedCommand: undefined,
    };
  }
  return resolveRepositoryPreparationCommands({
    config: arguments_.config,
    repository: arguments_.repository,
    worktreeDir: arguments_.launchDir,
  });
}

/**
 * Bail out before any state-write when the worktree already exists, then
 * record a "provisioning" row so `crew status` can surface the in-flight
 * worktree create instead of falling back to "idle". The dispatcher
 * serializes setupWorkspace calls per host, so the race against a parallel
 * worktrees.create() can't realistically fire here — `worktrees.create()`
 * still defends against it internally.
 */
async function preflightProvisioningGate(arguments_: {
  config: ResolvedConfig;
  options: SetupWorkspaceOptions;
  signal: AbortSignal | undefined;
}): Promise<void> {
  const { config, options, signal } = arguments_;
  const { task, repository, agent } = options;
  const existing = worktrees
    .findByTask(config, task)
    .find((entry) => entry.repository === repository);
  if (existing !== undefined) {
    await logAccessHintForExistingWorkspace({ config, task, signal });
    throw new WorktreeAlreadyExistsError(existing.dir);
  }
  const predicted = worktrees.predictedEntry(config, repository, task);
  recordRunStateBestEffort({
    config,
    task,
    repository,
    agent,
    worktreeDir: predicted.worktreeDir,
    branchName: predicted.branchName,
    workspaceName: task,
    state: "provisioning",
    title: options.details.title,
    completionTaskId: options.completionTaskId ?? task,
    ...(options.details.url === undefined ? {} : { url: options.details.url }),
  });
}

function recordFailedToLaunch(arguments_: {
  config: ResolvedConfig;
  options: SetupWorkspaceOptions;
  paths: { worktreeDir: string; branchName: string };
  error: unknown;
}): void {
  const { config, options, paths, error } = arguments_;
  const { task, repository, agent } = options;
  recordRunStateBestEffort({
    config,
    task,
    repository,
    agent,
    worktreeDir: paths.worktreeDir,
    branchName: paths.branchName,
    workspaceName: task,
    state: "failed-to-launch",
    detail: errorMessage(error),
    title: options.details.title,
    completionTaskId: options.completionTaskId ?? task,
    ...(options.details.url === undefined ? {} : { url: options.details.url }),
  });
}

type LaunchReadinessResult = { kind: "ready" } | { kind: "failed"; error: unknown };

async function startLaunchReadiness(
  ensureReady: () => Promise<void>,
): Promise<LaunchReadinessResult> {
  try {
    await ensureReady();
    return { kind: "ready" };
  } catch (error) {
    return { kind: "failed", error };
  }
}

async function assertLaunchReady(readinessPromise: Promise<LaunchReadinessResult>): Promise<void> {
  const readiness = await readinessPromise;
  if (readiness.kind === "failed") {
    throw readiness.error;
  }
}

/**
 * Probe the workspace backend and, if a workspace for `task` is still
 * live, log the access hint. Used on the pre-launch error path (e.g. the
 * worktree already exists from a prior run) so the user can find the
 * still-running session instead of being told only that the worktree is
 * in the way. Silent when the probe is unavailable or the workspace is
 * gone — we don't want to point at a window that doesn't exist.
 */
async function logAccessHintForExistingWorkspace(arguments_: {
  config: ResolvedConfig;
  task: string;
  signal: AbortSignal | undefined;
}): Promise<void> {
  const { config, task, signal } = arguments_;
  const accessHint = await workspaces.accessHint(config, task, signal);
  if (accessHint === undefined) {
    return;
  }
  const probe = await workspaces.probe(config, signal);
  if (probe.kind !== "ok" || !probe.names.has(task)) {
    return;
  }
  logAccessHint(accessHint);
}

function logAccessHint(accessHint: WorkspaceAccessHint): void {
  debug(`  Attach:   ${accessHint.command}`);
}

function renderWorkspaceContinuationInstruction(
  accessHint: WorkspaceAccessHint | undefined,
): string {
  if (accessHint === undefined) {
    return "";
  }
  return `Include this workspace continuation note in the output: Workspace attach: \`${accessHint.command}\`.`;
}

function recordRunStateBestEffort(arguments_: {
  config: ResolvedConfig;
  task: string;
  repository: string;
  agent: string;
  worktreeDir: string;
  branchName: string;
  workspaceName: string;
  state: "provisioning" | "running" | "failed-to-launch";
  title: string;
  detail?: string;
  url?: string;
  completionTaskId: string;
}): LifecycleProblem | undefined {
  try {
    recordRunState({
      config: arguments_.config,
      state: {
        task: arguments_.task,
        repository: arguments_.repository,
        agent: arguments_.agent,
        worktreeDir: arguments_.worktreeDir,
        branchName: arguments_.branchName,
        workspaceName: arguments_.workspaceName,
        state: arguments_.state,
        title: arguments_.title,
        completionTaskId: arguments_.completionTaskId,
        ...(arguments_.detail === undefined ? {} : { detail: arguments_.detail }),
        ...(arguments_.url === undefined ? {} : { url: arguments_.url }),
      },
    });
    return undefined;
  } catch (error) {
    log(`Run state update failed for ${arguments_.task}: ${errorMessage(error)}`);
    return {
      code: LIFECYCLE_PROBLEM_CODES.stateWriteFailed,
      message: `Run state update failed: ${errorMessage(error)}`,
    };
  }
}

async function rollbackWorktree(arguments_: {
  config: ResolvedConfig;
  entry: WorktreeEntry;
  promptDir: string | undefined;
}): Promise<void> {
  log(
    `Setup failed; rolling back worktree ${arguments_.entry.repository}-${arguments_.entry.task}...`,
  );
  let result: Awaited<ReturnType<typeof worktrees.teardown>> | undefined;
  try {
    result = await worktrees.teardown(arguments_.config, [arguments_.entry], { force: true });
  } catch (error) {
    log(`Worktree teardown failed during rollback: ${errorMessage(error)}`);
  } finally {
    // The prompt dir is normally removed by the launch command; clean it here
    // for the pre-launch failure path. Silent on retry races.
    if (arguments_.promptDir !== undefined) {
      try {
        removeStagedPrompt(arguments_.promptDir);
      } catch {
        // already gone
      }
    }
  }
  if (result === undefined) {
    return;
  }
  if (result.workspaceProbe.kind === "unavailable") {
    // The Workspace adapter was unavailable, so teardown couldn't enumerate
    // (or close) the just-opened workspace. The Worktree was still removed
    // — the user is likely left with an orphaned workspace pointing at a
    // gone directory; surface this so they can close it manually.
    const detail =
      result.workspaceProbe.error === undefined
        ? ""
        : `: ${errorMessage(result.workspaceProbe.error)}`;
    log(
      `Workspace adapter unavailable during rollback${detail}; close ${arguments_.entry.task} by hand if it's still open.`,
    );
  }
  for (const failure of result.failures) {
    log(`Worktree teardown ${failure.step} failed: ${errorMessage(failure.error)}`);
  }
}

export async function setupWorkspaceCli(
  task: string,
  options: { dryRun?: boolean; json?: boolean } = {},
): Promise<StartResult> {
  const config = await loadConfig();
  const localTask = naturalIdFromCanonical(task).toLowerCase();
  return await executeLifecycleMutation({
    config,
    task: localTask,
    json: options.json === true,
    conflictResult: () => startLockConflictResult({ config, task: localTask }),
    operation: async (context) =>
      await startLifecycle({ config, taskArgument: task, options, context }),
    cancelledResult: async (context) =>
      await cancelledStartResult({ config, task: localTask, context }),
  });
}

async function startLifecycle(arguments_: {
  config: ResolvedConfig;
  taskArgument: string;
  options: { dryRun?: boolean };
  context: LifecycleCancellationContext;
}): Promise<StartResult> {
  const { config, taskArgument, options, context } = arguments_;
  const rawSources = sourcesFromConfig(config);
  let sources;
  try {
    sources = await buildSources(rawSources, { globalConfig: config });
  } catch (error) {
    /* v8 ignore next @preserve -- catch re-throw always receives an Error; String(error) is an unreachable fallback */
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not initialize task sources for 'crew start ${taskArgument}': ${message}`,
      {
        cause: error,
      },
    );
  }
  const board: Board = createBoard(sources);

  const resolved = await board.resolveOne(taskArgument);
  if (resolved === undefined) {
    throw new Error(`Task ${taskArgument} not found across configured sources.`);
  }
  if (resolved.repository === undefined || resolved.agent === undefined) {
    throw new Error(
      `Task ${taskArgument} resolved but isn't groundcrew-eligible (missing agent-* label or repository/agent).`,
    );
  }

  const naturalId = naturalIdFromCanonical(resolved.id).toLowerCase();
  log(`Resolved ${taskArgument}: repository=${resolved.repository}, agent=${resolved.agent}`);

  if (options.dryRun === true) {
    const predicted = worktrees.predictedEntry(config, resolved.repository, naturalId);
    return {
      action: "start",
      task: lifecycleTaskIdentity({
        task: naturalId,
        canonicalId: resolved.id,
        url: resolved.url,
      }),
      outcome: "dry-run",
      state: observedState(readRunState(config, naturalId)),
      resources: {
        repository: resolved.repository,
        branch: predicted.branchName,
        worktreeDir: predicted.worktreeDir,
        agent: resolved.agent,
        ...(resolved.worktreePreparation === "skip" ? { worktreePreparation: "skip" } : {}),
      },
      problems: [],
    };
  }

  const existing = await existingStartResult({
    config,
    task: naturalId,
    canonicalId: resolved.id,
    url: resolved.url,
    repository: resolved.repository,
    signal: context.signal,
  });
  if (existing !== undefined) {
    return existing;
  }

  const result = await setupWorkspace(
    config,
    {
      task: naturalId,
      completionTaskId: resolved.id,
      completionMarkDoneSupported: sourceSupportsMarkDone({
        rawSources,
        sourceName: resolved.source,
      }),
      repository: resolved.repository,
      agent: resolved.agent,
      ...(resolved.worktreePreparation === undefined
        ? {}
        : { worktreePreparation: resolved.worktreePreparation }),
      details: {
        title: resolved.title,
        description: resolved.description,
        ...(resolved.url === undefined ? {} : { url: resolved.url }),
      },
    },
    { signal: context.signal },
  );
  try {
    await board.markInProgress(resolved);
    return result;
  } catch (error) {
    return {
      ...result,
      outcome: "partial",
      problems: [
        ...result.problems,
        {
          code: LIFECYCLE_PROBLEM_CODES.taskStatusUpdateFailed,
          message: `Task status update failed: ${errorMessage(error)}`,
        },
      ],
    };
  }
}

async function existingStartResult(arguments_: {
  config: ResolvedConfig;
  task: string;
  canonicalId: string;
  url: string | undefined;
  repository: string;
  signal: AbortSignal;
}): Promise<StartResult | undefined> {
  const { config, task, canonicalId, url, repository, signal } = arguments_;
  const state = readRunState(config, task);
  const entries = worktrees.findByTask(config, task);
  const probe = await workspaces.probe(config, signal);
  const resources = startResourcesFromContext({ state, entries });
  const identity = lifecycleTaskIdentity({ task, canonicalId, url: url ?? state?.url });
  if (probe.kind === "unavailable") {
    return {
      action: "start",
      task: identity,
      outcome: "conflict",
      state: observedState(state),
      resources,
      problems: [
        {
          code: LIFECYCLE_PROBLEM_CODES.workspaceStatusUnavailable,
          message: "Could not verify whether the task workspace is already live.",
        },
      ],
    };
  }
  if (probe.names.has(task)) {
    const matchingContext =
      state?.repository === repository || entries.some((entry) => entry.repository === repository);
    return matchingContext
      ? {
          action: "start",
          task: identity,
          outcome: "already-running",
          state: observedState(state, "running"),
          resources: { ...resources, workspace: { name: task } },
          problems: [],
        }
      : {
          action: "start",
          task: identity,
          outcome: "conflict",
          state: observedState(state, "running"),
          resources: { ...resources, workspace: { name: task } },
          problems: [
            {
              code: LIFECYCLE_PROBLEM_CODES.workspaceConflict,
              message: "A live workspace exists without matching local task context.",
            },
          ],
        };
  }
  if (state !== undefined || entries.length > 0) {
    return {
      action: "start",
      task: identity,
      outcome: "conflict",
      state: observedState(state),
      resources,
      problems: [
        {
          code: LIFECYCLE_PROBLEM_CODES.worktreeConflict,
          message: "Existing local state or a stale worktree must be reconciled before starting.",
        },
      ],
    };
  }
  return undefined;
}

function startLockConflictResult(arguments_: {
  config: ResolvedConfig;
  task: string;
}): StartResult {
  const state = readRunState(arguments_.config, arguments_.task);
  return {
    action: "start",
    task: lifecycleTaskIdentity({
      task: arguments_.task,
      canonicalId: state?.completionTaskId,
      url: state?.url,
    }),
    outcome: "conflict",
    state: observedState(state),
    resources: startResourcesFromContext({
      state,
      entries: worktrees.findByTask(arguments_.config, arguments_.task),
    }),
    problems: [
      {
        code: LIFECYCLE_PROBLEM_CODES.lifecycleLockHeld,
        message: "Another lifecycle mutation owns this task.",
      },
    ],
  };
}

async function cancelledStartResult(arguments_: {
  config: ResolvedConfig;
  task: string;
  context: LifecycleCancellationContext;
}): Promise<StartResult> {
  const state = readRunState(arguments_.config, arguments_.task);
  const entries = worktrees.findByTask(arguments_.config, arguments_.task);
  const probe = await workspaces.probe(arguments_.config);
  return {
    action: "start",
    task: lifecycleTaskIdentity({
      task: arguments_.task,
      canonicalId: state?.completionTaskId,
      url: state?.url,
    }),
    outcome: "partial",
    state: observedState(
      state,
      probe.kind === "ok" && probe.names.has(arguments_.task) ? "running" : undefined,
    ),
    resources: {
      ...startResourcesFromContext({ state, entries }),
      ...(probe.kind === "ok" && probe.names.has(arguments_.task)
        ? { workspace: { name: arguments_.task } }
        : {}),
    },
    problems: [
      {
        code: LIFECYCLE_PROBLEM_CODES.cancelled,
        message: `Start cancelled${lifecycleCancellationSuffix(arguments_.context)}.`,
      },
    ],
  };
}

function lifecycleTaskIdentity(arguments_: {
  task: string;
  canonicalId?: string | undefined;
  url?: string | undefined;
}): StartResult["task"] {
  return {
    id: arguments_.task,
    ...(arguments_.canonicalId === undefined ? {} : { canonicalId: arguments_.canonicalId }),
    ...(arguments_.url === undefined ? {} : { url: arguments_.url }),
  };
}

function startResourcesFromContext(arguments_: {
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
    ...(arguments_.state?.workspaceName === undefined
      ? {}
      : { workspace: { name: arguments_.state.workspaceName } }),
    ...(arguments_.state?.agent === undefined ? {} : { agent: arguments_.state.agent }),
  };
}

function observedState(
  state: RunState | undefined,
  fallback?: StartResult["state"],
): StartResult["state"] {
  return state?.state ?? fallback ?? "absent";
}
