import { loadConfig, type ResolvedConfig } from "../lib/config.ts";
import { readRunState, updateRunState } from "../lib/runState.ts";
import { naturalIdFromCanonical } from "../lib/taskSource.ts";
import { errorMessage, log } from "../lib/util.ts";
import { workspaces } from "../lib/workspaces.ts";
import { interruptWorkspace } from "./interruptWorkspace.ts";
import { resumeWorkspace } from "./resumeWorkspace.ts";

export interface SetAgentWorkspaceOptions {
  task: string;
  agent: string;
}

const USAGE = "crew set-agent <task> <agent>";

/**
 * Reports whether a live workspace exists for the task. Treats an
 * unavailable probe as a hard error rather than "not live" so we never
 * skip the stop/resume restart on a backend hiccup.
 */
async function isWorkspaceLive(config: ResolvedConfig, task: string): Promise<boolean> {
  const probe = await workspaces.probe(config);
  if (probe.kind === "unavailable") {
    const detail = probe.error === undefined ? "" : `: ${errorMessage(probe.error)}`;
    throw new Error(
      `Could not verify whether workspace for ${task} is live${detail}. Retry or inspect the workspace backend before changing its agent.`,
    );
  }
  return probe.names.has(task);
}

/**
 * Switches an existing task worktree to a different agent (and therefore a
 * different model/provider). The agent name is persisted into run state so the
 * next `crew resume` launches the new definition; when the workspace is already
 * live we stop and resume it in one shot so the switch takes effect immediately.
 */
export async function setAgentWorkspace(
  config: ResolvedConfig,
  options: SetAgentWorkspaceOptions,
): Promise<void> {
  const task = options.task.toLowerCase();
  const { agent } = options;
  if (config.agents.definitions[agent] === undefined) {
    throw new Error(`Unknown agent: ${agent}`);
  }
  const state = readRunState(config, task);
  if (state === undefined) {
    throw new Error(`No run state for ${task}; start it before changing its agent.`);
  }
  if (state.agent === agent) {
    log(`Agent for ${task} is already ${agent}; nothing to change.`);
    return;
  }

  const live = await isWorkspaceLive(config, task);
  // Persist before stopping: interrupt re-records run state from its current
  // agent, so the new value must already be on disk for the restart to use it.
  updateRunState({ config, task, patch: { state: state.state, agent } });

  if (live) {
    await interruptWorkspace(config, { task });
    await resumeWorkspace(config, { task });
    log(`Switched ${task} to ${agent} and resumed.`);
    return;
  }
  log(`Agent for ${task} set to ${agent}; takes effect on next 'crew resume'.`);
}

function parseArguments(argv: string[]): SetAgentWorkspaceOptions {
  const positionals: string[] = [];
  for (const argument of argv) {
    if (argument.startsWith("-")) {
      throw new Error(`Unknown option: ${argument}\nUsage: ${USAGE}`);
    }
    positionals.push(argument);
  }
  const [task, agent, ...extras] = positionals;
  if (
    task === undefined ||
    task.length === 0 ||
    agent === undefined ||
    agent.length === 0 ||
    extras.length > 0
  ) {
    throw new Error(`Usage: ${USAGE}`);
  }
  return { task: naturalIdFromCanonical(task).toLowerCase(), agent };
}

export async function setAgentWorkspaceCli(argv: string[]): Promise<void> {
  const config = await loadConfig();
  await setAgentWorkspace(config, parseArguments(argv));
}
