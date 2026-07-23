import { loadConfig, type ResolvedConfig } from "../lib/config.ts";
import { composeAgentLaunch, openAgentWorkspace, prepareAgentLaunch } from "../lib/agentLaunch.ts";
import { inferAgentCommandName, workerEnvironmentForTask } from "../lib/launchCommand.ts";
import { type Board, createBoard } from "../lib/board.ts";
import { buildSources, sourcesFromConfig } from "../lib/buildSources.ts";
import { resolvePrepareWorktreeCommand } from "../lib/repositoryHooks.ts";
import { recordRunState } from "../lib/runState.ts";
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
import { naturalIdFromCanonical } from "../lib/taskSource.ts";
import { debug, errorMessage, log, okMark } from "../lib/util.ts";
import { type WorkspaceAccessHint, workspaces } from "../lib/workspaces.ts";
import {
  resolveLaunchDir,
  WorktreeAlreadyExistsError,
  type WorktreeEntry,
  worktrees,
} from "../lib/worktrees.ts";

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
): Promise<void> {
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
  try {
    await assertLaunchReady(readinessPromise);

    const taskDetails = options.details;
    const accessHint = await workspaces.accessHint(config, task, signal);

    const stagedPrompt = stagePrompt({
      config,
      task,
      taskDetails,
      worktreeName,
      workspaceContinuationInstruction: renderWorkspaceContinuationInstruction(accessHint),
    });
    promptDir = stagedPrompt.directory;

    const repositoryEntry = config.workspace.repositories.find(
      (entry) => entry.name === repository,
    );
    const perRepoHooks = repositoryEntry?.hooks;
    const prepareWorktreeUnsandboxedCommand = repositoryEntry?.unsandboxedHooks?.prepareWorktree;
    const prepareWorktreeCommand = resolvePrepareWorktreeCommand({
      worktreeDir: launchDir,
      // Spread-conditional rather than a direct assignment: under
      // exactOptionalPropertyTypes an optional field can't take an explicit
      // `undefined`, and the lookup yields undefined for repos with no hooks.
      ...(perRepoHooks === undefined ? {} : { perRepoHooks }),
      defaultHooks: config.defaults.hooks,
    });
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
    recordRunStateBestEffort({
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

    log(`${okMark()} "${task}" launched (${agent})  worktree ${worktreeName}`);
    debug(`  Worktree: ${launchDir}`);
    debug(`  Branch:   ${branchName}`);
    if (accessHint !== undefined) {
      logAccessHint(accessHint);
    }
  } catch (error) {
    cleanupAgentLaunch?.();
    await rollbackWorktree({ config, entry: created, promptDir });
    recordFailedToLaunch({ config, options, paths: { worktreeDir, branchName }, error });
    throw error;
  }
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
}): void {
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
  } catch (error) {
    log(`Run state update failed for ${arguments_.task}: ${errorMessage(error)}`);
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
  options: { dryRun?: boolean } = {},
): Promise<void> {
  const config = await loadConfig();
  const rawSources = sourcesFromConfig(config);
  let sources;
  try {
    sources = await buildSources(rawSources, { globalConfig: config });
  } catch (error) {
    /* v8 ignore next @preserve -- catch re-throw always receives an Error; String(error) is an unreachable fallback */
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not initialize task sources for 'crew setup ${task}': ${message}`, {
      cause: error,
    });
  }
  const board: Board = createBoard(sources);

  const resolved = await board.resolveOne(task);
  if (resolved === undefined) {
    throw new Error(`Task ${task} not found across configured sources.`);
  }
  if (resolved.repository === undefined || resolved.agent === undefined) {
    throw new Error(
      `Task ${task} resolved but isn't groundcrew-eligible (missing agent-* label or repository/agent).`,
    );
  }

  log(`Resolved ${task}: repository=${resolved.repository}, agent=${resolved.agent}`);

  if (options.dryRun === true) {
    log(`[dry-run] Would launch ${task} in ${resolved.repository} (${resolved.agent})`);
    return;
  }

  const naturalId = naturalIdFromCanonical(resolved.id);

  await setupWorkspace(config, {
    task: naturalId,
    completionTaskId: resolved.id,
    completionMarkDoneSupported: sourceSupportsMarkDone({
      rawSources,
      sourceName: resolved.source,
    }),
    repository: resolved.repository,
    agent: resolved.agent,
    details: {
      title: resolved.title,
      description: resolved.description,
      ...(resolved.url === undefined ? {} : { url: resolved.url }),
    },
  });
  await board.markInProgress(resolved);
}
