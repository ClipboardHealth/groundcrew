import { fetchResolvedIssue } from "../lib/adapters/linear/fetch.ts";
import { getLinearClient } from "../lib/adapters/linear/client.ts";
import { isLinearEnabled, sourcesFromConfig } from "../lib/buildSources.ts";
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
import { naturalIdFromCanonical, toCanonicalId } from "../lib/taskSource.ts";
import { errorMessage, log } from "../lib/util.ts";
import { failIfWorkspaceAlreadyLive } from "../lib/workspaceLiveness.ts";
import { resolveLaunchDir, type WorktreeEntry, worktrees } from "../lib/worktrees.ts";

export interface ResumeWorkspaceOptions {
  task: string;
  /**
   * Force a fresh conversation: cold-start the agent (the historic behavior),
   * ignoring the agent's `resumeArgs`. Defaults to false, which reopens the
   * agent's previous conversation when `resumeArgs` is configured.
   */
  fresh?: boolean;
}

interface TaskDetails {
  title: string;
  description: string;
}

interface ResumeContext {
  task: string;
  repository: string;
  agent: string;
  worktree: WorktreeEntry;
  title: string;
  description: string;
  completionTaskId: string;
  completionMarkDoneSupported: boolean;
  reason?: string;
  resumeCount: number;
}

function parseArguments(argv: string[]): ResumeWorkspaceOptions {
  let fresh = false;
  const positionals: string[] = [];
  for (const argument of argv) {
    if (argument === "--new") {
      fresh = true;
      continue;
    }
    positionals.push(argument);
  }
  const [task, ...extras] = positionals;
  if (task === undefined || task.length === 0 || extras.length > 0 || task.startsWith("-")) {
    throw new Error("Usage: crew resume [--new] <task>");
  }
  return { task: naturalIdFromCanonical(task).toLowerCase(), fresh };
}

async function fetchTaskDetails(task: string): Promise<TaskDetails | undefined> {
  try {
    const issue = await getLinearClient().issue(task.toUpperCase());
    return {
      title: issue.title,
      description: issue.description ?? "",
    };
  } catch (error) {
    log(`Resume Linear detail lookup failed for ${task}: ${errorMessage(error)}`);
    return undefined;
  }
}

async function contextFromLinear(
  config: ResolvedConfig,
  task: string,
  worktree: WorktreeEntry,
): Promise<ResumeContext> {
  const resolved = await fetchResolvedIssue({ client: getLinearClient(), config, task });
  const completionTaskId = toCanonicalId("linear", task);
  return {
    task,
    repository: resolved.repository,
    agent: resolved.agent,
    worktree,
    title: resolved.title,
    description: resolved.description,
    completionTaskId,
    completionMarkDoneSupported: taskSupportsCompletionCommand({
      rawSources: sourcesFromConfig(config),
      taskId: completionTaskId,
    }),
    resumeCount: 0,
  };
}

async function contextFromState(
  config: ResolvedConfig,
  task: string,
  state: RunState,
  worktree: WorktreeEntry,
): Promise<ResumeContext> {
  // Skip the Linear lookup when Linear is disabled — otherwise the
  // missing-API-key error logs noisily even though resume only needs it to
  // enrich the prompt title/description (which falls back to the task id).
  const details = isLinearEnabled(config) ? await fetchTaskDetails(task) : undefined;
  const completionTaskId = state.completionTaskId ?? task;
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
    completionTaskId,
    completionMarkDoneSupported: taskSupportsCompletionCommand({
      rawSources: sourcesFromConfig(config),
      taskId: completionTaskId,
    }),
    ...(state.reason === undefined ? {} : { reason: state.reason }),
    resumeCount: state.resumeCount,
  };
}

async function buildResumeContext(config: ResolvedConfig, task: string): Promise<ResumeContext> {
  const state = readRunState(config, task);
  const entries = worktrees.findByTask(config, task);
  const worktree =
    state === undefined
      ? entries[0]
      : (entries.find((entry) => entry.repository === state.repository) ?? entries[0]);
  if (worktree === undefined) {
    throw new Error(`No worktree found for ${task}; cannot resume.`);
  }
  if (state !== undefined) {
    return await contextFromState(config, task, state, worktree);
  }
  // The cold-resume path resolves repository + agent from Linear alone, so it
  // can't proceed when Linear is disabled. Fail with a clear reason instead of
  // the cryptic missing-API-key error getLinearClient() would otherwise raise.
  if (!isLinearEnabled(config)) {
    throw new Error(`Cannot resume ${task}: no run state recorded and Linear is disabled.`);
  }
  return await contextFromLinear(config, task, worktree);
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
): Promise<void> {
  const task = options.task.toLowerCase();
  await failIfWorkspaceAlreadyLive(config, task, "resuming");
  const context = await buildResumeContext(config, task);
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
  // Resume stages srt settings exactly like setup (a relocating agent such as
  // codex needs its config home re-seeded to authenticate on the resumed launch).
  // Composition runs inside the try so a pre-launch failure still cleans up the
  // staged prompt (and any srt settings) dir.
  let srtSettingsDir: string | undefined;
  try {
    let launchCommand: string;
    const taskSourceWritePaths =
      runner === "safehouse" || runner === "srt"
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
    ({ launchCommand, srtSettingsDir } = composeAgentLaunch({
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
    }));
    const launchCmd = stageWorkspaceLaunchCommand(stagedPrompt.directory, launchCommand);
    await openAgentWorkspace({
      config,
      name: task,
      displayName: context.title,
      cwd: launchDir,
      command: launchCmd,
      agent: context.agent,
      color: definition.color,
    });
  } catch (error) {
    removeStagedPrompt(stagedPrompt.directory);
    // The launch command tears down the settings dir after srt exits; on the
    // pre-launch failure path it never ran, so clean it up here.
    if (srtSettingsDir !== undefined) {
      removeStagedPrompt(srtSettingsDir);
    }
    throw error;
  }
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
      ...(context.reason === undefined ? {} : { reason: context.reason }),
    },
  });
  log(`Resumed ${task} in ${context.worktree.dir} (${context.agent})`);
}

export async function resumeWorkspaceCli(argv: string[]): Promise<void> {
  const config = await loadConfig();
  await resumeWorkspace(config, parseArguments(argv));
}
