import { loadConfig, type ResolvedConfig } from "../lib/config.ts";
import { readRunState, recordRunState, type RunState } from "../lib/runState.ts";
import { errorMessage, log } from "../lib/util.ts";
import { workspaces, type WorkspaceInterruptResult } from "../lib/workspaces.ts";
import { type WorktreeEntry, worktrees } from "../lib/worktrees.ts";

export interface InterruptWorkspaceOptions {
  ticket: string;
  reason?: string;
}

interface InterruptSource {
  ticket: string;
  repository: string;
  model: string;
  worktreeDir: string;
  branchName: string;
  workspaceName: string;
  resumeCount: number;
}

function parseArguments(argv: string[]): InterruptWorkspaceOptions {
  let reason: string | undefined;
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
    if (argument.startsWith("-")) {
      throw new Error(`Unknown option: ${argument}\nUsage: crew stop <ticket> [--reason <text>]`);
    }
    positionals.push(argument);
  }
  const [ticket, ...extras] = positionals;
  if (ticket === undefined || ticket.length === 0 || extras.length > 0) {
    throw new Error("Usage: crew stop <ticket> [--reason <text>]");
  }
  return { ticket: ticket.toLowerCase(), ...(reason === undefined ? {} : { reason }) };
}

function sourceFromState(state: RunState): InterruptSource {
  return {
    ticket: state.ticket,
    repository: state.repository,
    model: state.model,
    worktreeDir: state.worktreeDir,
    branchName: state.branchName,
    workspaceName: state.workspaceName,
    resumeCount: state.resumeCount,
  };
}

function sourceFromWorktree(
  config: ResolvedConfig,
  ticket: string,
  entry: WorktreeEntry,
): InterruptSource {
  return {
    ticket,
    repository: entry.repository,
    model: config.models.default,
    worktreeDir: entry.dir,
    branchName: entry.branchName,
    workspaceName: ticket,
    resumeCount: 0,
  };
}

function resolveInterruptSource(arguments_: {
  config: ResolvedConfig;
  ticket: string;
  state: RunState | undefined;
  entry: WorktreeEntry | undefined;
}): InterruptSource {
  if (arguments_.state !== undefined) {
    return sourceFromState(arguments_.state);
  }
  if (arguments_.entry !== undefined) {
    return sourceFromWorktree(arguments_.config, arguments_.ticket, arguments_.entry);
  }
  throw new Error(`No run state or worktree found for ${arguments_.ticket}; nothing to interrupt.`);
}

function interruptDetail(result: WorkspaceInterruptResult): string | undefined {
  if (result.kind === "missing") {
    return "workspace missing";
  }
  return undefined;
}

function failOnUnavailable(result: WorkspaceInterruptResult): void {
  if (result.kind !== "unavailable") {
    return;
  }
  const detail =
    result.error === undefined ? "workspace adapter unavailable" : errorMessage(result.error);
  throw new Error(`Could not interrupt workspace: ${detail}`);
}

export async function interruptWorkspace(
  config: ResolvedConfig,
  options: InterruptWorkspaceOptions,
): Promise<void> {
  const ticket = options.ticket.toLowerCase();
  const state = readRunState(config, ticket);
  const [entry] = worktrees.findByTicket(config, ticket);
  const source = resolveInterruptSource({ config, ticket, state, entry });
  const result = await workspaces.interrupt(config, source.workspaceName);
  failOnUnavailable(result);
  const detail = interruptDetail(result);
  recordRunState({
    config,
    state: {
      ticket,
      repository: source.repository,
      model: source.model,
      worktreeDir: source.worktreeDir,
      branchName: source.branchName,
      workspaceName: source.workspaceName,
      state: "interrupted",
      resumeCount: source.resumeCount,
      ...(options.reason === undefined ? {} : { reason: options.reason }),
      ...(detail === undefined ? {} : { detail }),
    },
  });
  log(`Interrupted ${ticket}; worktree preserved at ${source.worktreeDir}`);
  log(`Next: crew status ${ticket}`);
}

export async function interruptWorkspaceCli(argv: string[]): Promise<void> {
  const config = await loadConfig();
  await interruptWorkspace(config, parseArguments(argv));
}
