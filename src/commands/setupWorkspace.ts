import { rmSync } from "node:fs";
import { loadConfig, type ResolvedConfig } from "../lib/config.ts";
import { openAgentWorkspace, prepareAgentLaunch } from "../lib/agentLaunch.ts";
import { type Board, createBoard } from "../lib/board.ts";
import { buildSources, sourcesFromConfig } from "../lib/buildSources.ts";
import { buildLaunchCommand } from "../lib/launchCommand.ts";
import { recordRunState } from "../lib/runState.ts";
import {
  stageBuildSecrets,
  stagePromptFromTemplate,
  stageWorkspaceLaunchCommand,
  type StagedPrompt,
} from "../lib/stagedLaunch.ts";
import { naturalIdFromCanonical } from "../lib/ticketSource.ts";
import { errorMessage, log } from "../lib/util.ts";
import { type WorkspaceAccessHint, workspaces } from "../lib/workspaces.ts";
import { isWorktreeAlreadyExistsError, type WorktreeEntry, worktrees } from "../lib/worktrees.ts";

export interface TicketDetails {
  title: string;
  description: string;
}

export interface SetupWorkspaceOptions {
  ticket: string;
  repository: string;
  model: string;
  details: TicketDetails;
}

export interface SetupWorkspaceRunOptions {
  signal?: AbortSignal;
}

function stagePrompt(input: {
  config: ResolvedConfig;
  ticket: string;
  ticketDetails: TicketDetails;
  worktreeName: string;
  workspaceContinuationInstruction: string;
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
      workspaceContinuationInstruction: input.workspaceContinuationInstruction,
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
    const ticketDetails = options.details;
    const accessHint = await workspaces.accessHint(config, ticket, signal);

    const stagedPrompt = stagePrompt({
      config,
      ticket,
      ticketDetails,
      worktreeName,
      workspaceContinuationInstruction: renderWorkspaceContinuationInstruction(accessHint),
    });
    promptDir = stagedPrompt.directory;

    const secretsFile = stageBuildSecrets(promptDir);
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
    if (accessHint !== undefined) {
      logAccessHint(accessHint);
    }
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

function logAccessHint(accessHint: WorkspaceAccessHint): void {
  log(`  Attach:   ${accessHint.command}`);
}

function renderWorkspaceContinuationInstruction(
  accessHint: WorkspaceAccessHint | undefined,
): string {
  if (accessHint === undefined) {
    return "";
  }
  return `7. Include this workspace continuation note in the PR body: Workspace attach: \`${accessHint.command}\`.`;
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
  let sources;
  try {
    sources = await buildSources(sourcesFromConfig(config), { globalConfig: config });
  } catch (error) {
    /* v8 ignore next @preserve -- catch re-throw always receives an Error; String(error) is an unreachable fallback */
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not initialize ticket sources for 'crew setup ${ticket}': ${message}`, {
      cause: error,
    });
  }
  const board: Board = createBoard(sources);

  const resolved = await board.resolveOne(ticket);
  if (resolved === undefined) {
    throw new Error(`Ticket ${ticket} not found across configured sources.`);
  }
  if (resolved.repository === undefined || resolved.model === undefined) {
    throw new Error(
      `Ticket ${ticket} resolved but isn't groundcrew-eligible (missing agent-* label or repository/model).`,
    );
  }

  log(`Resolved ${ticket}: repository=${resolved.repository}, model=${resolved.model}`);

  if (options.dryRun === true) {
    log(`[dry-run] Would launch ${ticket} in ${resolved.repository} (${resolved.model})`);
    return;
  }

  const naturalId = naturalIdFromCanonical(resolved.id);

  await setupWorkspace(config, {
    ticket: naturalId,
    repository: resolved.repository,
    model: resolved.model,
    details: { title: resolved.title, description: resolved.description },
  });
  await board.markInProgress(resolved);
}
