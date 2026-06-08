import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { collectAllowedDomains } from "./clearanceHosts.ts";
import { type ModelDefinition, type ResolvedConfig, repositoryBaseDir } from "./config.ts";
import { inferAgentCommandName } from "./launchCommand.ts";
import { agentConfigRelocation, buildSrtSettings } from "./srtPolicy.ts";
import { readEnvironmentVariable } from "./util.ts";

export interface StagedSrtLaunch {
  /** Dedicated temp dir holding the settings files (and any relocated config home). */
  directory: string;
  /** Profile-neutral policy for the prepareWorktree wrap (no agent credentials). */
  prepareFile: string;
  /** Full agent policy for the agent wrap. */
  agentFile: string;
  /**
   * Env var pointing the agent at its relocated, writable config home (codex's
   * `CODEX_HOME`). Threaded into the agent wrap by `buildLaunchCommand`.
   * Undefined for read-only agents (claude), which run with a read-only home.
   */
  agentConfigDirEnv?: { name: string; value: string };
}

/**
 * Generate the srt policies for a launch and stage them, plus — for agents that
 * cannot run with a read-only config home (codex) — a relocated, writable
 * config dir seeded with the minimal files the agent needs to authenticate and
 * keep its config. Shared by `setupWorkspace` (fresh runs) and `resumeWorkspace`
 * (resumes) so both behave identically under the srt runner.
 *
 * Two policies, distinct surfaces:
 * - the `prepare` policy is profile-neutral (empty agent → no `~/.claude` /
 *   `~/.codex` grants, no relocated home) so the repo-controlled prepareWorktree
 *   hook can't touch the agent's credentials;
 * - the `agent` policy carries the agent's read-only config profile and, when
 *   the agent relocates, the writable relocated home.
 *
 * The relocated home lives **inside** the settings dir but is the only thing
 * under it granted to the sandbox — the settings JSON siblings are never
 * read-granted, so the agent can't read or rewrite its own policy. The launch
 * command tears the whole dir down after srt exits.
 */
export function buildAndStageSrtLaunch(input: {
  config: ResolvedConfig;
  repository: string;
  task: string;
  worktreeDir: string;
  definition: ModelDefinition;
  /** Defaults to `os.homedir()`. Injected in tests to seed from a fixture home. */
  homeDir?: string;
}): StagedSrtLaunch {
  const agent = inferAgentCommandName(input.definition.cmd);
  const homeDir = input.homeDir ?? os.homedir();
  const repoDir = path.resolve(repositoryBaseDir(input.config, input.repository), input.repository);
  const base = {
    worktreeDir: input.worktreeDir,
    gitCommonDir: path.join(repoDir, ".git"),
    allowedDomains: collectAllowedDomains({
      hosts: readEnvironmentVariable("CLEARANCE_ALLOW_HOSTS"),
      files: readEnvironmentVariable("CLEARANCE_ALLOW_HOSTS_FILES"),
    }),
  };

  const directory = mkdtempSync(path.join(os.tmpdir(), `groundcrew-srt-${input.task}-`));

  const relocation = agentConfigRelocation(agent);
  let relocatedConfigDir: string | undefined;
  let agentConfigDirEnv: { name: string; value: string } | undefined;
  if (relocation !== undefined) {
    relocatedConfigDir = path.join(directory, `${agent}-home`);
    mkdirSync(relocatedConfigDir, { recursive: true });
    seedRelocatedConfigDir({
      sourceDir: path.join(homeDir, relocation.sourceHomeRelativeDir),
      seedFiles: relocation.seedFiles,
      relocatedConfigDir,
    });
    agentConfigDirEnv = { name: relocation.configDirEnv, value: relocatedConfigDir };
  }

  const prepare = buildSrtSettings({ ...base, agent: "" });
  const agentSettings = buildSrtSettings({
    ...base,
    agent,
    ...(relocatedConfigDir === undefined ? {} : { relocatedConfigDir }),
  });
  const prepareFile = path.join(directory, "prepare-settings.json");
  const agentFile = path.join(directory, "agent-settings.json");
  writeFileSync(prepareFile, `${JSON.stringify(prepare, undefined, 2)}\n`);
  writeFileSync(agentFile, `${JSON.stringify(agentSettings, undefined, 2)}\n`);

  return {
    directory,
    prepareFile,
    agentFile,
    ...(agentConfigDirEnv === undefined ? {} : { agentConfigDirEnv }),
  };
}

/**
 * Copy the agent's minimal credential/config files into the relocated home.
 * Best-effort per file: a missing source (e.g. the user isn't logged into the
 * agent, or has no config) is skipped rather than aborting the launch — the
 * agent then reports its own "not logged in" state, which is the correct signal.
 */
function seedRelocatedConfigDir(input: {
  sourceDir: string;
  seedFiles: readonly string[];
  relocatedConfigDir: string;
}): void {
  for (const file of input.seedFiles) {
    const source = path.join(input.sourceDir, file);
    if (!existsSync(source)) {
      continue;
    }
    copyFileSync(source, path.join(input.relocatedConfigDir, file));
  }
}
