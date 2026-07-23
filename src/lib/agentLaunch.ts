import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ensureClearance,
  resolveSafehouseCmuxIntegration,
  safehouseCmuxIntegrationWarningLines,
} from "@clipboard-health/clearance";

import { clearanceAllowHostsFilesFromEnvironment } from "./clearanceAllowlist.ts";
import { installCmuxAgentHooks } from "./cmuxAgentHookInstall.ts";
import { cmuxAgentHookSettingsJson } from "./cmuxAgentHooks.ts";
import { shellSingleQuote } from "./shell.ts";
import {
  hasPreLaunchEnv,
  type LocalRunner,
  type AgentDefinition,
  type NetworkEgressSetting,
  type ResolvedConfig,
} from "./config.ts";
import { detectHostCapabilities } from "./host.ts";
import {
  buildLaunchCommand,
  inferAgentCommandName,
  type SafehouseAgentIntegration,
  type WorkerEnvironment,
} from "./launchCommand.ts";
import {
  agentConfigRelocation,
  stageRelocatedAgentConfigHome,
  type StagedAgentConfigHome,
} from "./codexConfigRelocation.ts";
import { resolveGitCommonDir } from "./gitCommonDir.ts";
import { assertLocalRunnerRequirements, resolveLocalRunner } from "./localRunner.ts";
import { sandboxNameFor } from "./sandboxName.ts";
import { debug, readEnvironmentVariable, sleep, writeError } from "./util.ts";
import { resolveWorkspaceKind, workspaces } from "./workspaces.ts";
import type { WorkspaceKind } from "./workspaceAdapter.ts";

export interface ComposedAgentLaunch {
  command: string;
  cleanup: () => void;
}

/** Build the workspace launch command shared by fresh runs and resumes. */
export function composeAgentLaunch(input: {
  runner: LocalRunner;
  networkEgress: NetworkEgressSetting;
  task: string;
  definition: AgentDefinition;
  promptFile: string;
  worktreeDir: string;
  workingDir: string;
  secretsFile?: string | undefined;
  prepareWorktreeCommand?: string | undefined;
  prepareWorktreeUnsandboxedCommand?: string | undefined;
  sandboxName?: string | undefined;
  workspaceKind: WorkspaceKind;
  workerEnvironment?: WorkerEnvironment | undefined;
  omitPromptArgument?: boolean | undefined;
  taskSourceWritePaths?: readonly string[] | undefined;
  safehouseEnableFeatures?: readonly string[] | undefined;
  readOnlyDirs?: readonly string[] | undefined;
  /**
   * Test-only seam: overrides `os.homedir()` when staging a relocated agent
   * config home (codex's `CODEX_HOME` under safehouse). Production callers
   * must omit this so specs can seed a fixture home instead of touching the
   * real `~/.codex`.
   */
  homeDir?: string;
}): ComposedAgentLaunch {
  const homeDir = input.homeDir ?? os.homedir();
  const safehouseAgentIntegration =
    input.runner === "safehouse"
      ? safehouseAgentIntegrationFor({
          workspaceKind: input.workspaceKind,
          definition: input.definition,
          task: input.task,
          homeDir,
        })
      : undefined;
  function cleanup(): void {
    for (const teardownPath of safehouseAgentIntegration?.teardownPaths ?? []) {
      rmSync(teardownPath, { recursive: true, force: true });
    }
  }
  try {
    return {
      command: buildLaunchCommand({
        definition: input.definition,
        promptFile: input.promptFile,
        worktreeDir: input.worktreeDir,
        workingDir: input.workingDir,
        secretsFile: input.secretsFile,
        prepareWorktreeCommand: input.prepareWorktreeCommand,
        prepareWorktreeUnsandboxedCommand: input.prepareWorktreeUnsandboxedCommand,
        runner: input.runner,
        networkEgress: input.networkEgress,
        sandboxName: input.sandboxName,
        workerEnvironment: input.workerEnvironment,
        omitPromptArgument: input.omitPromptArgument,
        safehouseAddDirs:
          input.runner === "safehouse" ? resolveSafehouseAddDirs(input.worktreeDir) : undefined,
        safehouseAgentAddDirs:
          input.runner === "safehouse" ? (input.taskSourceWritePaths ?? []) : undefined,
        safehouseEnableFeatures:
          input.runner === "safehouse" ? input.safehouseEnableFeatures : undefined,
        // Safehouse rejects nonexistent --add-dirs-ro paths, so drop absent ones.
        safehouseAgentAddDirsReadOnly:
          input.runner === "safehouse" ? (input.readOnlyDirs ?? []).filter(existsSync) : undefined,
        safehouseAgentIntegration,
      }),
      cleanup,
    };
  } catch (error) {
    cleanup();
    throw error;
  }
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
 * Gated to the safehouse runner at the call site. Deduped defensively in case
 * git resolves either path to the same directory in an unusual checkout shape.
 */
function resolveSafehouseAddDirs(worktreeDir: string): readonly string[] {
  return [...new Set([worktreeDir, resolveGitCommonDir(worktreeDir)])];
}

function safehouseAgentIntegrationFor(input: {
  workspaceKind: WorkspaceKind;
  definition: AgentDefinition;
  task: string;
  homeDir: string;
}): SafehouseAgentIntegration | undefined {
  if (input.workspaceKind !== "cmux") {
    return undefined;
  }
  const agentCommandName = inferAgentCommandName(input.definition.cmd);
  const isClaudeAgent = agentCommandName === "claude";
  const cmuxIntegration = resolveSafehouseCmuxIntegration();
  if (isClaudeAgent) {
    warnOnCmuxIntegrationDrift({ unreviewedEnvNames: cmuxIntegration.unreviewedEnvNames });
  }

  const relocatedCmuxHooksHome = stageSafehouseCmuxHooksHome({
    agent: agentCommandName,
    task: input.task,
    homeDir: input.homeDir,
  });

  return {
    addDirsReadOnly: cmuxIntegration.addDirsReadOnly,
    envPass: cmuxIntegration.envPass,
    commandPreludes: [
      ...(isClaudeAgent ? [cmuxIntegration.claudeCommandPrelude] : []),
      ...(relocatedCmuxHooksHome === undefined
        ? []
        : [
            `export ${relocatedCmuxHooksHome.configDirEnv.name}=${shellSingleQuote(relocatedCmuxHooksHome.configDirEnv.value)}`,
          ]),
    ],
    ...(isClaudeAgent
      ? {
          agentArgs: [
            "--settings",
            shellSingleQuote(cmuxAgentHookSettingsJson({ agent: agentCommandName })),
          ],
        }
      : {}),
    ...(relocatedCmuxHooksHome === undefined
      ? {}
      : {
          addDirs: [relocatedCmuxHooksHome.configDir],
          writeBackFiles: relocatedCmuxHooksHome.writeBackFiles,
          teardownPaths: [relocatedCmuxHooksHome.parentDir],
        }),
  };
}

/**
 * Relocate + seed a writable config home for a cmux-hosted agent whose hook
 * activation is file-driven (codex reads `$CODEX_HOME/config.toml` +
 * `hooks.json`, unlike Claude's `--settings` flag) and best-effort install
 * cmux's lifecycle hooks into it. Undefined for agents with no registered
 * relocation (claude), which keep reporting status via `--settings` instead.
 */
function stageSafehouseCmuxHooksHome(input: {
  agent: string;
  task: string;
  homeDir: string;
}): (StagedAgentConfigHome & { parentDir: string }) | undefined {
  const relocation = agentConfigRelocation(input.agent);
  if (relocation === undefined) {
    return undefined;
  }
  const parentDir = mkdtempSync(path.join(os.tmpdir(), `groundcrew-safehouse-${input.task}-`));
  try {
    const staged = stageRelocatedAgentConfigHome({
      agent: input.agent,
      relocation,
      parentDir,
      sourceConfigDir:
        readEnvironmentVariable(relocation.configDirEnv) ??
        path.join(input.homeDir, relocation.sourceHomeRelativeDir),
    });
    installCmuxAgentHooks({ agent: input.agent, configDir: staged.configDir });
    return { ...staged, parentDir };
  } catch (error) {
    rmSync(parentDir, { recursive: true, force: true });
    throw error;
  }
}

function warnOnCmuxIntegrationDrift(input: { unreviewedEnvNames: readonly string[] }): void {
  for (const warningLine of safehouseCmuxIntegrationWarningLines({
    commandName: "groundcrew",
    unreviewedEnvNames: input.unreviewedEnvNames,
  })) {
    writeError(warningLine);
  }
}

interface PreparedAgentLaunch {
  runner: LocalRunner;
  /** Resolved `config.local.networkEgress`, threaded into `composeAgentLaunch`. */
  networkEgress: NetworkEgressSetting;
  sandboxName: string | undefined;
  workspaceKind: WorkspaceKind;
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
  const { networkEgress } = input.config.local;
  const workspaceKind = resolveWorkspaceKind({ config: input.config, host }).resolved;
  assertLocalRunnerRequirements(host, runner);
  const cmdOwnsSafehouseWrap = /^safehouse(?:\s|$)/.test(input.definition.cmd);
  // A user-owned safehouse wrap owns its own egress posture and may rely on
  // Clearance, so keep the readiness check aligned with the existing behavior.
  const ensureReady =
    runner === "safehouse" && (networkEgress === "allowlisted" || cmdOwnsSafehouseWrap)
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
  if (runner === "safehouse" && hasPreLaunchEnv(input.definition) && cmdOwnsSafehouseWrap) {
    throw new Error(
      `Local groundcrew ${input.purpose} on agent '${input.agent}' cannot inject preLaunchEnv when 'cmd' already starts with 'safehouse'. ` +
        "Your cmd owns the wrap, so add the names to its own '--env-pass=' flag, or drop the 'safehouse' prefix from 'cmd' to let groundcrew compose the flag for you.",
    );
  }
  if (runner === "safehouse" && cmdOwnsSafehouseWrap) {
    throw new Error(
      `Local groundcrew ${input.purpose} on agent '${input.agent}' cannot inject worker self-completion env when 'cmd' already starts with 'safehouse'. ` +
        "Your cmd owns the wrap, so add GROUNDCREW_TASK_ID,GROUNDCREW_COMPLETE to its own '--env-pass=' flag, or drop the 'safehouse' prefix from 'cmd' to let groundcrew compose the flag for you.",
    );
  }

  const sandboxName =
    runner === "sdx" && input.definition.sandbox !== undefined
      ? sandboxNameFor({ agent: input.definition.sandbox.agent })
      : undefined;
  return { runner, networkEgress, sandboxName, workspaceKind, ensureReady };
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
  displayName?: string;
  url?: string | undefined;
  cwd: string;
  command: string;
  agent: string;
  color: string;
  signal?: AbortSignal;
}): Promise<void> {
  const panelTitle =
    input.config.workspace.useTaskTitleForPanelName === true ? input.displayName : undefined;
  const spec = {
    name: input.name,
    ...(panelTitle === undefined ? {} : { displayName: panelTitle }),
    ...(input.url === undefined ? {} : { url: input.url }),
    cwd: input.cwd,
    command: input.command,
    status: { text: input.agent, color: input.color, icon: "sparkle" },
  };
  await (input.signal === undefined
    ? workspaces.open(input.config, spec)
    : workspaces.open(input.config, spec, input.signal));
}
