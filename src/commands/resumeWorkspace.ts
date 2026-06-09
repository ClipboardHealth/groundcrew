import { fetchResolvedIssue } from "../lib/adapters/linear/fetch.ts";
import { getLinearClient } from "../lib/adapters/linear/client.ts";
import { isLinearEnabled } from "../lib/buildSources.ts";
import { loadConfig, type ResolvedConfig } from "../lib/config.ts";
import { openAgentWorkspace, prepareAgentLaunch } from "../lib/agentLaunch.ts";
import { buildLaunchCommand } from "../lib/launchCommand.ts";
import { readRunState, recordRunState, type RunState } from "../lib/runState.ts";
import { buildAndStageSrtLaunch } from "../lib/srtLaunch.ts";
import {
  removeStagedPrompt,
  stageBuildSecrets,
  stagePromptText,
  stageWorkspaceLaunchCommand,
} from "../lib/stagedLaunch.ts";
import { errorMessage, log } from "../lib/util.ts";
import { workspaces } from "../lib/workspaces.ts";
import { type WorktreeEntry, worktrees } from "../lib/worktrees.ts";

export interface ResumeWorkspaceOptions {
  task: string;
}

interface TaskDetails {
  title: string;
  description: string;
}

interface ResumeContext {
  task: string;
  repository: string;
  model: string;
  worktree: WorktreeEntry;
  title: string;
  description: string;
  reason?: string;
  resumeCount: number;
}

function parseArguments(argv: string[]): ResumeWorkspaceOptions {
  const [task, ...extras] = argv;
  if (task === undefined || task.length === 0 || extras.length > 0 || task.startsWith("-")) {
    throw new Error("Usage: crew resume <task>");
  }
  return { task: task.toLowerCase() };
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
  return {
    task,
    repository: resolved.repository,
    model: resolved.model,
    worktree,
    title: resolved.title,
    description: resolved.description,
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
  return {
    task,
    repository: state.repository,
    model: state.model,
    worktree,
    title: details?.title ?? task.toUpperCase(),
    description: details?.description ?? "",
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
  // The cold-resume path resolves repository + model from Linear alone, so it
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

async function failIfWorkspaceAlreadyLive(config: ResolvedConfig, task: string): Promise<void> {
  const probe = await workspaces.probe(config);
  if (probe.kind === "unavailable") {
    const detail = probe.error === undefined ? "" : `: ${errorMessage(probe.error)}`;
    throw new Error(
      `Could not verify whether workspace for ${task} is already live${detail}. Retry or inspect the workspace backend manually before resuming.`,
    );
  }
  if (probe.names.has(task)) {
    throw new Error(`Workspace for ${task} is already live; attach to it instead of resuming.`);
  }
}

export async function resumeWorkspace(
  config: ResolvedConfig,
  options: ResumeWorkspaceOptions,
): Promise<void> {
  const task = options.task.toLowerCase();
  await failIfWorkspaceAlreadyLive(config, task);
  const context = await buildResumeContext(config, task);
  const definition = config.models.definitions[context.model];
  if (definition === undefined) {
    throw new Error(`Unknown model: ${context.model}`);
  }

  const { runner, sandboxName, ensureReady } = await prepareAgentLaunch({
    config,
    model: context.model,
    definition,
    purpose: "resumes",
  });
  await ensureReady();

  const stagedPrompt = stagePromptText({
    prefix: "groundcrew-resume",
    task,
    text: renderResumePrompt(context),
  });
  const secretsFile = stageBuildSecrets(stagedPrompt.directory);
  // Resume must stage srt settings exactly like setup, or `buildLaunchCommand`
  // throws under the srt runner — and a relocating agent (codex) needs its
  // config home re-seeded so it authenticates on the resumed launch.
  let srtPrepareSettingsFile: string | undefined;
  let srtAgentSettingsFile: string | undefined;
  let srtSettingsDir: string | undefined;
  let srtAgentConfigDirEnv: { name: string; value: string } | undefined;
  if (runner === "srt") {
    const staged = buildAndStageSrtLaunch({
      config,
      repository: context.repository,
      task,
      worktreeDir: context.worktree.dir,
      definition,
    });
    srtPrepareSettingsFile = staged.prepareFile;
    srtAgentSettingsFile = staged.agentFile;
    srtSettingsDir = staged.directory;
    srtAgentConfigDirEnv = staged.agentConfigDirEnv;
  }
  const launchCommand = buildLaunchCommand({
    definition,
    promptFile: stagedPrompt.file,
    worktreeDir: context.worktree.dir,
    secretsFile,
    runner,
    sandboxName,
    srtPrepareSettingsFile,
    srtAgentSettingsFile,
    srtSettingsDir,
    srtAgentConfigDirEnv,
  });
  const launchCmd = stageWorkspaceLaunchCommand(stagedPrompt.directory, launchCommand);

  try {
    await openAgentWorkspace({
      config,
      name: task,
      cwd: context.worktree.dir,
      command: launchCmd,
      model: context.model,
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
      model: context.model,
      worktreeDir: context.worktree.dir,
      branchName: context.worktree.branchName,
      workspaceName: task,
      state: "resumed",
      resumeCount: context.resumeCount + 1,
      ...(context.reason === undefined ? {} : { reason: context.reason }),
    },
  });
  log(`Resumed ${task} in ${context.worktree.dir} (${context.model})`);
}

export async function resumeWorkspaceCli(argv: string[]): Promise<void> {
  const config = await loadConfig();
  await resumeWorkspace(config, parseArguments(argv));
}
