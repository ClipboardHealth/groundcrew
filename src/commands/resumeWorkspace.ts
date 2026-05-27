import { fetchResolvedIssue } from "../lib/boardSource.ts";
import { loadConfig, type ResolvedConfig } from "../lib/config.ts";
import { openAgentWorkspace, prepareAgentLaunch } from "../lib/agentLaunch.ts";
import { buildLaunchCommand } from "../lib/launchCommand.ts";
import { readRunState, recordRunState, type RunState } from "../lib/runState.ts";
import {
  removeStagedPrompt,
  stageBuildSecrets,
  stagePromptText,
  stageWorkspaceLaunchCommand,
} from "../lib/stagedLaunch.ts";
import { errorMessage, getLinearClient, log } from "../lib/util.ts";
import { workspaces } from "../lib/workspaces.ts";
import { type WorktreeEntry, worktrees } from "../lib/worktrees.ts";

export interface ResumeWorkspaceOptions {
  ticket: string;
}

interface TicketDetails {
  title: string;
  description: string;
}

interface ResumeContext {
  ticket: string;
  repository: string;
  model: string;
  worktree: WorktreeEntry;
  title: string;
  description: string;
  reason?: string;
  resumeCount: number;
}

function parseArguments(argv: string[]): ResumeWorkspaceOptions {
  const [ticket, ...extras] = argv;
  if (ticket === undefined || ticket.length === 0 || extras.length > 0 || ticket.startsWith("-")) {
    throw new Error("Usage: crew resume <ticket>");
  }
  return { ticket: ticket.toLowerCase() };
}

async function fetchTicketDetails(ticket: string): Promise<TicketDetails | undefined> {
  try {
    const issue = await getLinearClient().issue(ticket.toUpperCase());
    return {
      title: issue.title,
      description: issue.description ?? "",
    };
  } catch (error) {
    log(`Resume Linear detail lookup failed for ${ticket}: ${errorMessage(error)}`);
    return undefined;
  }
}

async function contextFromLinear(
  config: ResolvedConfig,
  ticket: string,
  worktree: WorktreeEntry,
): Promise<ResumeContext> {
  const resolved = await fetchResolvedIssue({ client: getLinearClient(), config, ticket });
  return {
    ticket,
    repository: resolved.repository,
    model: resolved.model,
    worktree,
    title: resolved.title,
    description: resolved.description,
    resumeCount: 0,
  };
}

async function contextFromState(
  ticket: string,
  state: RunState,
  worktree: WorktreeEntry,
): Promise<ResumeContext> {
  const details = await fetchTicketDetails(ticket);
  return {
    ticket,
    repository: state.repository,
    model: state.model,
    worktree,
    title: details?.title ?? ticket.toUpperCase(),
    description: details?.description ?? "",
    ...(state.reason === undefined ? {} : { reason: state.reason }),
    resumeCount: state.resumeCount,
  };
}

async function buildResumeContext(config: ResolvedConfig, ticket: string): Promise<ResumeContext> {
  const state = readRunState(config, ticket);
  const entries = worktrees.findByTicket(config, ticket);
  const worktree =
    state === undefined
      ? entries[0]
      : (entries.find((entry) => entry.repository === state.repository) ?? entries[0]);
  if (worktree === undefined) {
    throw new Error(`No worktree found for ${ticket}; cannot resume.`);
  }
  if (state !== undefined) {
    return await contextFromState(ticket, state, worktree);
  }
  return await contextFromLinear(config, ticket, worktree);
}

function renderResumePrompt(context: ResumeContext): string {
  return [
    `You are resuming Groundcrew ticket ${context.ticket} (${context.title}) in an existing worktree.`,
    "",
    "Ticket description:",
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

async function failIfWorkspaceAlreadyLive(config: ResolvedConfig, ticket: string): Promise<void> {
  const probe = await workspaces.probe(config);
  if (probe.kind === "unavailable") {
    const detail = probe.error === undefined ? "" : `: ${errorMessage(probe.error)}`;
    throw new Error(
      `Could not verify whether workspace for ${ticket} is already live${detail}. Retry or inspect the workspace backend manually before resuming.`,
    );
  }
  if (probe.names.has(ticket)) {
    throw new Error(`Workspace for ${ticket} is already live; attach to it instead of resuming.`);
  }
}

export async function resumeWorkspace(
  config: ResolvedConfig,
  options: ResumeWorkspaceOptions,
): Promise<void> {
  const ticket = options.ticket.toLowerCase();
  await failIfWorkspaceAlreadyLive(config, ticket);
  const context = await buildResumeContext(config, ticket);
  const definition = config.models.definitions[context.model];
  if (definition === undefined) {
    throw new Error(`Unknown model: ${context.model}`);
  }

  const { runner, sandboxName } = await prepareAgentLaunch({
    config,
    model: context.model,
    definition,
    purpose: "resumes",
  });

  const stagedPrompt = stagePromptText({
    prefix: "groundcrew-resume",
    ticket,
    text: renderResumePrompt(context),
  });
  const secretsFile = stageBuildSecrets(stagedPrompt.directory);
  const launchCommand = buildLaunchCommand({
    definition,
    promptFile: stagedPrompt.file,
    worktreeDir: context.worktree.dir,
    secretsFile,
    runner,
    sandboxName,
  });
  const launchCmd = stageWorkspaceLaunchCommand(stagedPrompt.directory, launchCommand);

  try {
    await openAgentWorkspace({
      config,
      name: ticket,
      cwd: context.worktree.dir,
      command: launchCmd,
      model: context.model,
      color: definition.color,
    });
  } catch (error) {
    removeStagedPrompt(stagedPrompt.directory);
    throw error;
  }
  recordRunState({
    config,
    state: {
      ticket,
      repository: context.repository,
      model: context.model,
      worktreeDir: context.worktree.dir,
      branchName: context.worktree.branchName,
      workspaceName: ticket,
      state: "resumed",
      resumeCount: context.resumeCount + 1,
      ...(context.reason === undefined ? {} : { reason: context.reason }),
    },
  });
  log(`Resumed ${ticket} in ${context.worktree.dir} (${context.model})`);
}

export async function resumeWorkspaceCli(argv: string[]): Promise<void> {
  const config = await loadConfig();
  await resumeWorkspace(config, parseArguments(argv));
}
