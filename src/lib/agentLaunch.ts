import { ensureClearance } from "@clipboard-health/clearance";

import { clearanceAllowHostsFilesFromEnvironment } from "./clearanceAllowlist.ts";
import {
  hasPreLaunchEnv,
  type LocalRunner,
  type AgentDefinition,
  type ResolvedConfig,
} from "./config.ts";
import { detectHostCapabilities } from "./host.ts";
import { buildLaunchCommand, type WorkerEnvironment } from "./launchCommand.ts";
import { assertLocalRunnerRequirements, resolveLocalRunner } from "./localRunner.ts";
import { sandboxNameFor } from "./sandboxName.ts";
import { buildAndStageSrtLaunch, resolveGitCommonDir } from "./srtLaunch.ts";
import { debug, sleep } from "./util.ts";
import { workspaces } from "./workspaces.ts";

/**
 * Stage any srt settings and build the workspace launch command — the assembly
 * shared verbatim by `setupWorkspace` (fresh runs) and `resumeWorkspace`
 * (resumes). `worktreeDir` is the checkout root (srt grants + `{{worktree}}`);
 * `workingDir` is the agent cwd (the worktree root, or its `workdir` subproject).
 * Returns `srtSettingsDir` so callers can tear it down on a pre-launch failure.
 */
export function composeAgentLaunch(input: {
  runner: LocalRunner;
  task: string;
  definition: AgentDefinition;
  promptFile: string;
  worktreeDir: string;
  workingDir: string;
  secretsFile?: string | undefined;
  prepareWorktreeCommand?: string | undefined;
  sandboxName?: string | undefined;
  workerEnvironment?: WorkerEnvironment | undefined;
}): { launchCommand: string; srtSettingsDir: string | undefined } {
  const staged =
    input.runner === "srt"
      ? buildAndStageSrtLaunch({
          task: input.task,
          worktreeDir: input.worktreeDir,
          definition: input.definition,
        })
      : undefined;
  const launchCommand = buildLaunchCommand({
    definition: input.definition,
    promptFile: input.promptFile,
    worktreeDir: input.worktreeDir,
    workingDir: input.workingDir,
    secretsFile: input.secretsFile,
    prepareWorktreeCommand: input.prepareWorktreeCommand,
    runner: input.runner,
    sandboxName: input.sandboxName,
    srtPrepareSettingsFile: staged?.prepareFile,
    srtAgentSettingsFile: staged?.agentFile,
    srtSettingsDir: staged?.directory,
    srtAgentConfigDirEnv: staged?.agentConfigDirEnv,
    workerEnvironment: input.workerEnvironment,
    safehouseAddDirs:
      input.runner === "safehouse" ? resolveSafehouseAddDirs(input.worktreeDir) : undefined,
  });
  return { launchCommand, srtSettingsDir: staged?.directory };
}

/**
 * Filesystem paths the safehouse sandbox must be granted (read/write) beyond
 * its automatic cwd grant, so git works for every worktree shape:
 *
 * - `worktreeDir` — the checkout root. A `workdir` subproject cwd's into a
 *   subdir, so without this the worktree-root `.git` gitfile is unreachable.
 * - the **git common dir** — resolved from the worktree itself (not assumed to
 *   be `<projectDir>/<repo>/.git`), so a scripted/sparse-checkout worktree
 *   whose store lives outside the worktree tree (e.g. graft's `~/carrot/.git`)
 *   gets git access. This is the path the bare cwd grant fundamentally cannot
 *   cover, and the reason this resolution exists.
 * Gated to the safehouse runner at the call site (srt fences its own equivalent
 * surface — worktree root + git common dir — through its settings file; sdx/none
 * don't use it). Deduped defensively in case git resolves either path to the
 * same directory in an unusual checkout shape.
 */
function resolveSafehouseAddDirs(worktreeDir: string): readonly string[] {
  return [...new Set([worktreeDir, resolveGitCommonDir(worktreeDir)])];
}

interface PreparedAgentLaunch {
  runner: LocalRunner;
  sandboxName: string | undefined;
  ensureReady: () => Promise<void>;
}

export async function prepareAgentLaunch(input: {
  config: ResolvedConfig;
  agent: string;
  definition: AgentDefinition;
  purpose: "runs" | "resumes";
  signal?: AbortSignal;
}): Promise<PreparedAgentLaunch> {
  const host = await detectHostCapabilities(input.signal);
  const runner = resolveLocalRunner(input.config.local.runner, host);
  assertLocalRunnerRequirements(host, runner);
  const ensureReady =
    runner === "safehouse"
      ? async (): Promise<void> => {
          await ensureSafehouseClearance(input.signal);
        }
      : alreadyReady;

  if (runner === "sdx" && input.definition.sandbox === undefined) {
    throw new Error(
      `Local groundcrew ${input.purpose} with the sdx runner require a sandbox config on agent '${input.agent}'.`,
    );
  }
  if (runner === "sdx" && input.definition.preLaunch !== undefined) {
    throw new Error(
      `Local groundcrew ${input.purpose} with the sdx runner do not support preLaunch on agent '${input.agent}'. ` +
        "Use local.runner 'safehouse' or 'none', or remove preLaunch from the agent.",
    );
  }
  if (runner === "sdx" && hasPreLaunchEnv(input.definition)) {
    throw new Error(
      `Local groundcrew ${input.purpose} with the sdx runner do not support preLaunchEnv on agent '${input.agent}'. ` +
        "Use local.runner 'safehouse' or 'none', or remove preLaunchEnv from the agent.",
    );
  }
  // Mirror of buildLaunchCommand's defense — fail at config-resolution time so
  // the operator sees the problem before the workspace is spawned, not deep in
  // the launch shell. The buildLaunchCommand check stays as defense in depth.
  if (
    runner === "safehouse" &&
    hasPreLaunchEnv(input.definition) &&
    /^safehouse(?:\s|$)/.test(input.definition.cmd)
  ) {
    throw new Error(
      `Local groundcrew ${input.purpose} on agent '${input.agent}' cannot inject preLaunchEnv when 'cmd' already starts with 'safehouse'. ` +
        "Your cmd owns the wrap, so add the names to its own '--env-pass=' flag, or drop the 'safehouse' prefix from 'cmd' to let groundcrew compose the flag for you.",
    );
  }
  if (runner === "safehouse" && /^safehouse(?:\s|$)/.test(input.definition.cmd)) {
    throw new Error(
      `Local groundcrew ${input.purpose} on agent '${input.agent}' cannot inject worker self-completion env when 'cmd' already starts with 'safehouse'. ` +
        "Your cmd owns the wrap, so add GROUNDCREW_TASK_ID,GROUNDCREW_COMPLETE to its own '--env-pass=' flag, or drop the 'safehouse' prefix from 'cmd' to let groundcrew compose the flag for you.",
    );
  }

  const sandboxName =
    runner === "sdx" && input.definition.sandbox !== undefined
      ? sandboxNameFor({ agent: input.definition.sandbox.agent })
      : undefined;
  return { runner, sandboxName, ensureReady };
}

async function alreadyReady(): Promise<void> {
  await Promise.resolve();
}

async function ensureSafehouseClearance(signal?: AbortSignal): Promise<void> {
  await ensureClearance({
    envOverrides: {
      CLEARANCE_ALLOW_HOSTS_FILES: clearanceAllowHostsFilesFromEnvironment(),
    },
    logger: debug,
    ...(signal === undefined
      ? {}
      : {
          sleep: async (ms) => {
            await sleep(ms, signal);
            signal.throwIfAborted();
          },
        }),
  });
  signal?.throwIfAborted();
}

export async function openAgentWorkspace(input: {
  config: ResolvedConfig;
  name: string;
  cwd: string;
  command: string;
  agent: string;
  color: string;
  signal?: AbortSignal;
}): Promise<void> {
  const spec = {
    name: input.name,
    cwd: input.cwd,
    command: input.command,
    status: { text: input.agent, color: input.color, icon: "sparkle" },
  };
  await (input.signal === undefined
    ? workspaces.open(input.config, spec)
    : workspaces.open(input.config, spec, input.signal));
}
