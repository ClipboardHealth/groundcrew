import { rmSync } from "node:fs";
import { loadConfig, type ResolvedConfig } from "../lib/config.ts";
import { composeAgentLaunch, openAgentWorkspace, prepareAgentLaunch } from "../lib/agentLaunch.ts";
import { type Board, createBoard } from "../lib/board.ts";
import { buildSources, sourcesFromConfig } from "../lib/buildSources.ts";
import { workerEnvironmentForTask } from "../lib/launchCommand.ts";
import { resolvePrepareWorktreeCommand } from "../lib/repositoryHooks.ts";
import { recordRunState } from "../lib/runState.ts";
import {
  stageBuildSecrets,
  stagePromptFromTemplate,
  stageWorkspaceLaunchCommand,
  type StagedPrompt,
} from "../lib/stagedLaunch.ts";
import { naturalIdFromCanonical } from "../lib/taskSource.ts";
import { debug, errorMessage, log, okMark } from "../lib/util.ts";
import { type WorkspaceAccessHint, workspaces } from "../lib/workspaces.ts";
import {
  isWorktreeAlreadyExistsError,
  resolveLaunchDir,
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
  const { runner, sandboxName, ensureReady } = await prepareAgentLaunch({
    config,
    agent,
    definition,
    purpose: "runs",
    ...(signal === undefined ? {} : { signal }),
  });

  const spec = { repository, task };
  let created: WorktreeEntry;
  const createdPromise =
    signal === undefined ? worktrees.create(config, spec) : worktrees.create(config, spec, signal);
  const readinessPromise = startLaunchReadiness(ensureReady);
  try {
    created = await createdPromise;
  } catch (error) {
    if (isWorktreeAlreadyExistsError(error)) {
      await logAccessHintForExistingWorkspace({ config, task, signal });
    }
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
  let srtSettingsDir: string | undefined;
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

    const prepareWorktreeCommand = resolvePrepareWorktreeCommand({
      worktreeDir: launchDir,
      defaultHooks: config.defaults.hooks,
    });
    const secretsFile =
      prepareWorktreeCommand === undefined ? undefined : stageBuildSecrets(promptDir);
    const completionTaskId = options.completionTaskId ?? task;
    const { launchCommand, srtSettingsDir: stagedSrtSettingsDir } = composeAgentLaunch({
      runner,
      task,
      definition,
      promptFile: stagedPrompt.file,
      worktreeDir,
      workingDir: launchDir,
      secretsFile,
      prepareWorktreeCommand,
      sandboxName,
      workerEnvironment: workerEnvironmentForTask(completionTaskId),
    });
    srtSettingsDir = stagedSrtSettingsDir;
    const launchCmd = stageWorkspaceLaunchCommand(promptDir, launchCommand);

    debug("Opening workspace...");
    await openAgentWorkspace({
      config,
      name: task,
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
    await rollbackWorktree({ config, entry: created, promptDir, srtSettingsDir });
    recordRunStateBestEffort({
      config,
      task,
      repository,
      agent,
      worktreeDir,
      branchName,
      workspaceName: task,
      state: "failed-to-launch",
      detail: errorMessage(error),
      title: options.details.title,
      completionTaskId: options.completionTaskId ?? task,
      ...(options.details.url === undefined ? {} : { url: options.details.url }),
    });
    throw error;
  }
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
  state: "running" | "failed-to-launch";
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
  srtSettingsDir?: string | undefined;
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
    // Both temp dirs are normally removed by the launch command; clean them
    // here for the pre-launch failure path. Silent on retry races.
    for (const dir of [arguments_.promptDir, arguments_.srtSettingsDir]) {
      if (dir !== undefined) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // already gone
        }
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
  let sources;
  try {
    sources = await buildSources(sourcesFromConfig(config), { globalConfig: config });
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
