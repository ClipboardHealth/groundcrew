import { loadConfig, type ResolvedConfig } from "../lib/config.ts";
import { readRunState, recordRunState, type RunState } from "../lib/runState.ts";
import { errorMessage, log } from "../lib/util.ts";
import { workspaces, type WorkspaceInterruptResult } from "../lib/workspaces.ts";
import { type WorktreeEntry, worktrees } from "../lib/worktrees.ts";

export interface InterruptWorkspaceOptions {
  task: string;
  reason?: string;
}

interface InterruptSource {
  task: string;
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
      throw new Error(`Unknown option: ${argument}\nUsage: crew stop <task> [--reason <text>]`);
    }
    positionals.push(argument);
  }
  const [task, ...extras] = positionals;
  if (task === undefined || task.length === 0 || extras.length > 0) {
    throw new Error("Usage: crew stop <task> [--reason <text>]");
  }
  return { task: task.toLowerCase(), ...(reason === undefined ? {} : { reason }) };
}

function sourceFromState(state: RunState): InterruptSource {
  return {
    task: state.task,
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
  task: string,
  entry: WorktreeEntry,
): InterruptSource {
  return {
    task,
    repository: entry.repository,
    model: config.models.default,
    worktreeDir: entry.dir,
    branchName: entry.branchName,
    workspaceName: task,
    resumeCount: 0,
  };
}

function resolveInterruptSource(arguments_: {
  config: ResolvedConfig;
  task: string;
  state: RunState | undefined;
  entry: WorktreeEntry | undefined;
}): InterruptSource {
  if (arguments_.state !== undefined) {
    return sourceFromState(arguments_.state);
  }
  if (arguments_.entry !== undefined) {
    return sourceFromWorktree(arguments_.config, arguments_.task, arguments_.entry);
  }
  throw new Error(`No run state or worktree found for ${arguments_.task}; nothing to interrupt.`);
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
  const task = options.task.toLowerCase();
  const state = readRunState(config, task);
  const [entry] = worktrees.findByTask(config, task);
  const source = resolveInterruptSource({ config, task, state, entry });
  const result = await workspaces.interrupt(config, source.workspaceName);
  failOnUnavailable(result);
  const detail = interruptDetail(result);
  recordRunState({
    config,
    state: {
      task,
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
  log(`Interrupted ${task}; worktree preserved at ${source.worktreeDir}`);
  log(`Next: crew status ${task}`);
}

export async function interruptWorkspaceCli(argv: string[]): Promise<void> {
  const config = await loadConfig();
  await interruptWorkspace(config, parseArguments(argv));
}
