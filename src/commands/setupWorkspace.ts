import { rmSync } from "node:fs";
import { fetchResolvedIssue } from "../lib/boardSource.ts";
import { loadConfig, type ResolvedConfig } from "../lib/config.ts";
import { ensureAgentSandbox, openAgentWorkspace, prepareAgentLaunch } from "../lib/agentLaunch.ts";
import { buildLaunchCommand } from "../lib/launchCommand.ts";
import { createLinearIssueStatusUpdater } from "../lib/linearIssueStatus.ts";
import { recordRunState } from "../lib/runState.ts";
import {
  stageBuildSecrets,
  stagePromptFromTemplate,
  stageWorkspaceLaunchCommand,
  type StagedPrompt,
} from "../lib/stagedLaunch.ts";
import { errorMessage, getLinearClient, log } from "../lib/util.ts";
import { type WorkspaceAccessHint, workspaces } from "../lib/workspaces.ts";
import { isWorktreeAlreadyExistsError, type WorktreeEntry, worktrees } from "../lib/worktrees.ts";

interface TicketDetails {
  title: string;
  description: string;
}

async function fetchTicket(ticket: string): Promise<TicketDetails> {
  const client = getLinearClient();
  const issue = await client.issue(ticket.toUpperCase());
  return {
    title: issue.title,
    description: issue.description ?? "",
  };
}

export interface SetupWorkspaceOptions {
  ticket: string;
  repository: string;
  model: string;
  /** When provided, skip the Linear lookup for prompt-template fields. */
  details?: TicketDetails;
}

export interface SetupWorkspaceRunOptions {
  signal?: AbortSignal;
}

function stagePrompt(input: {
  config: ResolvedConfig;
  ticket: string;
  ticketDetails: TicketDetails;
  worktreeName: string;
}): StagedPrompt {
  return stagePromptFromTemplate({
    config: input.config,
    prefix: "groundcrew",
    ticket: input.ticket,
    variables: {
      ticket: input.ticket,
      worktree: input.worktreeName,
      title: input.ticketDetails.title,
      description: input.ticketDetails.description,
    },
  });
}

export async function setupWorkspace(
  config: ResolvedConfig,
  options: SetupWorkspaceOptions,
  runOptions: SetupWorkspaceRunOptions = {},
): Promise<void> {
  const { ticket, repository, model } = options;
  const { signal } = runOptions;
  const definition = config.models.definitions[model];
  if (!definition) {
    throw new Error(`Unknown model: ${model}`);
  }
  const { runner, sandboxName } = await prepareAgentLaunch({
    config,
    model,
    definition,
    purpose: "runs",
    ...(signal === undefined ? {} : { signal }),
  });

  const spec = { repository, ticket };
  let created: WorktreeEntry;
  try {
    created =
      signal === undefined
        ? await worktrees.create(config, spec)
        : await worktrees.create(config, spec, signal);
  } catch (error) {
    if (isWorktreeAlreadyExistsError(error)) {
      await logAccessHintForExistingWorkspace({ config, ticket, signal });
    }
    throw error;
  }
  const { branchName, dir: launchDir } = created;
  const worktreeName = `${repository}-${ticket}`;

  // Anything that fails after the worktree is on disk must roll it back
  // (the worktree and the just-created branch). `workspaces.open` cleans
  // up its own workspace on a status-paint failure but does not auto-
  // close on unrecognized cmux output — closing by title there could hit
  // a same-named sibling, so we log a hint and accept a rare leak.
  // Without rollback the next tick hits "Worktree already exists" and
  // the ticket strands forever.
  let promptDir: string | undefined;
  try {
    let ticketDetails: TicketDetails;
    if (options.details === undefined) {
      log(`Fetching ${ticket} from Linear...`);
      ticketDetails = await fetchTicket(ticket);
    } else {
      ticketDetails = options.details;
    }

    const stagedPrompt = stagePrompt({ config, ticket, ticketDetails, worktreeName });
    promptDir = stagedPrompt.directory;

    const secretsFile = stageBuildSecrets(promptDir);
    await ensureAgentSandbox({
      config,
      definition,
      sandboxName,
      ...(signal === undefined ? {} : { signal }),
    });

    const launchCommand = buildLaunchCommand({
      definition,
      promptFile: stagedPrompt.file,
      worktreeDir: launchDir,
      secretsFile,
      runner,
      sandboxName,
    });
    const launchCmd = stageWorkspaceLaunchCommand(promptDir, launchCommand);

    log("Opening workspace...");
    await openAgentWorkspace({
      config,
      name: ticket,
      cwd: launchDir,
      command: launchCmd,
      model,
      color: definition.color,
      ...(signal === undefined ? {} : { signal }),
    });
    recordRunStateBestEffort({
      config,
      ticket,
      repository,
      model,
      worktreeDir: launchDir,
      branchName,
      workspaceName: ticket,
      state: "running",
    });

    log(`Workspace "${ticket}" launched (${model})`);
    log(`  Worktree: ${launchDir}`);
    log(`  Branch:   ${branchName}`);
    await logWorkspaceAccessHint({ config, ticket, signal });
  } catch (error) {
    await rollbackWorktree({ config, entry: created, promptDir });
    recordRunStateBestEffort({
      config,
      ticket,
      repository,
      model,
      worktreeDir: launchDir,
      branchName,
      workspaceName: ticket,
      state: "failed-to-launch",
      detail: errorMessage(error),
    });
    throw error;
  }
}

/**
 * Probe the workspace backend and, if a workspace for `ticket` is still
 * live, log the access hint. Used on the pre-launch error path (e.g. the
 * worktree already exists from a prior run) so the user can find the
 * still-running session instead of being told only that the worktree is
 * in the way. Silent when the probe is unavailable or the workspace is
 * gone — we don't want to point at a window that doesn't exist.
 */
async function logAccessHintForExistingWorkspace(arguments_: {
  config: ResolvedConfig;
  ticket: string;
  signal: AbortSignal | undefined;
}): Promise<void> {
  const { config, ticket, signal } = arguments_;
  const accessHint = await workspaces.accessHint(config, ticket, signal);
  if (accessHint === undefined) {
    return;
  }
  const probe = await workspaces.probe(config, signal);
  if (probe.kind !== "ok" || !probe.names.has(ticket)) {
    return;
  }
  logAccessHint(accessHint);
}

async function logWorkspaceAccessHint(arguments_: {
  config: ResolvedConfig;
  ticket: string;
  signal: AbortSignal | undefined;
}): Promise<void> {
  const accessHint = await workspaces.accessHint(
    arguments_.config,
    arguments_.ticket,
    arguments_.signal,
  );
  if (accessHint === undefined) {
    return;
  }
  logAccessHint(accessHint);
}

function logAccessHint(accessHint: WorkspaceAccessHint): void {
  log(`  Attach:   ${accessHint.command}`);
}

function recordRunStateBestEffort(arguments_: {
  config: ResolvedConfig;
  ticket: string;
  repository: string;
  model: string;
  worktreeDir: string;
  branchName: string;
  workspaceName: string;
  state: "running" | "failed-to-launch";
  detail?: string;
}): void {
  try {
    recordRunState({
      config: arguments_.config,
      state: {
        ticket: arguments_.ticket,
        repository: arguments_.repository,
        model: arguments_.model,
        worktreeDir: arguments_.worktreeDir,
        branchName: arguments_.branchName,
        workspaceName: arguments_.workspaceName,
        state: arguments_.state,
        ...(arguments_.detail === undefined ? {} : { detail: arguments_.detail }),
      },
    });
  } catch (error) {
    log(`Run state update failed for ${arguments_.ticket}: ${errorMessage(error)}`);
  }
}

async function rollbackWorktree(arguments_: {
  config: ResolvedConfig;
  entry: WorktreeEntry;
  promptDir: string | undefined;
}): Promise<void> {
  log(
    `Setup failed; rolling back worktree ${arguments_.entry.repository}-${arguments_.entry.ticket}...`,
  );
  let result: Awaited<ReturnType<typeof worktrees.teardown>> | undefined;
  try {
    result = await worktrees.teardown(arguments_.config, [arguments_.entry], { force: true });
  } catch (error) {
    log(`Worktree teardown failed during rollback: ${errorMessage(error)}`);
  } finally {
    if (arguments_.promptDir !== undefined) {
      try {
        rmSync(arguments_.promptDir, { recursive: true, force: true });
      } catch {
        // The launch command would have removed this; silent on retry races.
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
      `Workspace adapter unavailable during rollback${detail}; close ${arguments_.entry.ticket} by hand if it's still open.`,
    );
  }
  for (const failure of result.failures) {
    log(`Worktree teardown ${failure.step} failed: ${errorMessage(failure.error)}`);
  }
}

export async function setupWorkspaceCli(
  ticket: string,
  options: { dryRun?: boolean } = {},
): Promise<void> {
  const config = await loadConfig();
  const client = getLinearClient();
  const resolved = await fetchResolvedIssue({ client, config, ticket });
  log(`Resolved ${ticket}: repository=${resolved.repository}, model=${resolved.model}`);
  if (options.dryRun === true) {
    log(`[dry-run] Would launch ${ticket} in ${resolved.repository} (${resolved.model})`);
    return;
  }
  await setupWorkspace(config, {
    ticket: ticket.toLowerCase(),
    repository: resolved.repository,
    model: resolved.model,
    details: { title: resolved.title, description: resolved.description },
  });
  await createLinearIssueStatusUpdater({ client }).markInProgress({
    id: ticket.toLowerCase(),
    uuid: resolved.uuid,
    teamId: resolved.teamId,
  });
}
