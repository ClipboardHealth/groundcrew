import { copyFileSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import path from "node:path";

/**
 * How an agent that cannot run with a read-only config home is pointed at a
 * relocated, per-launch writable home instead. The safehouse launch stages a
 * temp dir, seeds it with the minimal files the agent needs to authenticate +
 * keep its config, exports `configDirEnv` to that dir, and grants it write.
 * Credential files that Codex refreshes are copied back by the host after the
 * agent exits, without granting the sandbox the whole real home.
 *
 * Empirically validated on macOS: codex hard-fails to launch
 * with a read-only `~/.codex` ("failed to initialize in-process app-server
 * client") and authenticates from a file (`auth.json`), so relocating
 * `CODEX_HOME` + seeding `auth.json`/`config.toml` both unblocks it and closes
 * persistence.
 */
export interface AgentConfigRelocation {
  /** Env var that points the agent at a relocated config home. */
  configDirEnv: string;
  /** Home-relative dir the seed files come from (the agent's real home). */
  sourceHomeRelativeDir: string;
  /** Files (relative to `sourceHomeRelativeDir`) seeded into the relocated home. */
  seedFiles: readonly string[];
  /** Seed files whose writes must persist back to the source store. */
  persistedFiles: readonly string[];
}

const AGENT_CONFIG_RELOCATIONS: Record<string, AgentConfigRelocation> = {
  codex: {
    configDirEnv: "CODEX_HOME",
    sourceHomeRelativeDir: ".codex",
    // auth.json carries the ChatGPT OAuth tokens (codex reads creds from a file,
    // not the keychain); config.toml preserves the user's codex configuration.
    seedFiles: ["auth.json", "config.toml"],
    persistedFiles: ["auth.json"],
  },
};

/**
 * Return the config-relocation spec for an agent, or `undefined` when the
 * agent has no registered relocation (claude, unknown agents) — the caller
 * then runs that agent against its real home.
 */
export function agentConfigRelocation(agent: string): AgentConfigRelocation | undefined {
  return AGENT_CONFIG_RELOCATIONS[agent.toLowerCase()];
}

export interface StagedAgentConfigHome {
  /** The relocated, writable config/state home staged for this launch. */
  configDir: string;
  /** Env var (e.g. `CODEX_HOME`) that points the agent at `configDir`. */
  configDirEnv: { name: string; value: string };
  /** Files the host copies back after the sandboxed agent exits. */
  writeBackFiles: readonly StagedAgentConfigWriteBack[];
}

interface StagedAgentConfigWriteBack {
  baselinePath: string;
  sourcePath: string;
  stagedPath: string;
}

/**
 * Stage + seed a relocated, writable config home for an agent that cannot run
 * with a read-only config home (codex's `CODEX_HOME`) under the safehouse
 * runner. `parentDir` must already exist (the caller stages it inside a
 * dedicated per-launch temp dir); the config home itself is created here.
 */
export function stageRelocatedAgentConfigHome(input: {
  agent: string;
  relocation: AgentConfigRelocation;
  parentDir: string;
  sourceConfigDir: string;
}): StagedAgentConfigHome {
  const configDir = path.join(input.parentDir, `${input.agent}-home`);
  mkdirSync(configDir, { recursive: true });
  const writeBackFiles = seedRelocatedConfigDir({
    baselineDir: path.join(input.parentDir, "write-back-baseline"),
    sourceDir: input.sourceConfigDir,
    seedFiles: input.relocation.seedFiles,
    persistedFiles: input.relocation.persistedFiles,
    relocatedConfigDir: configDir,
  });
  return {
    configDir,
    configDirEnv: { name: input.relocation.configDirEnv, value: configDir },
    writeBackFiles,
  };
}

/**
 * Seed the agent's minimal credential/config files into the relocated home.
 * Best-effort per file: a missing source (e.g. the user isn't logged into the
 * agent, or has no config) is skipped rather than aborting the launch — the
 * agent then reports its own "not logged in" state, which is the correct signal.
 */
function seedRelocatedConfigDir(input: {
  baselineDir: string;
  sourceDir: string;
  seedFiles: readonly string[];
  persistedFiles: readonly string[];
  relocatedConfigDir: string;
}): StagedAgentConfigWriteBack[] {
  const writeBackFiles: StagedAgentConfigWriteBack[] = [];
  for (const file of input.seedFiles) {
    const source = path.join(input.sourceDir, file);
    if (!existsSync(source)) {
      continue;
    }
    const destination = path.join(input.relocatedConfigDir, file);
    copyFileSync(source, destination);
    if (input.persistedFiles.includes(file)) {
      const baselinePath = path.join(input.baselineDir, file);
      mkdirSync(path.dirname(baselinePath), { recursive: true });
      copyFileSync(source, baselinePath);
      writeBackFiles.push({
        baselinePath,
        sourcePath: realpathSync(source),
        stagedPath: destination,
      });
    }
  }
  return writeBackFiles;
}
