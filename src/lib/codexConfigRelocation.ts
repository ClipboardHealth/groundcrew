import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

/**
 * How an agent that cannot run with a read-only config home is pointed at a
 * relocated, per-launch writable home instead. The safehouse launch stages a
 * temp dir, seeds it with the minimal files the agent needs to authenticate +
 * keep its config, exports `configDirEnv` to that dir, and grants it write —
 * so the real home (which holds the persistence surfaces) is never written.
 *
 * Empirically (STAFF-1305 live validation, macOS): codex hard-fails to launch
 * with a read-only `~/.codex` ("failed to initialize in-process app-server
 * client") and authenticates from a file (`auth.json`), so relocating
 * `CODEX_HOME` + seeding `auth.json`/`config.toml` both unblocks it and closes
 * persistence.
 */
export interface AgentConfigRelocation {
  /** Env var that points the agent at a relocated config home. */
  configDirEnv: string;
  /** Home-relative dir the seed files are copied from (the agent's real home). */
  sourceHomeRelativeDir: string;
  /** Files (relative to `sourceHomeRelativeDir`) seeded into the relocated home. */
  seedFiles: readonly string[];
}

const AGENT_CONFIG_RELOCATIONS: Record<string, AgentConfigRelocation> = {
  codex: {
    configDirEnv: "CODEX_HOME",
    sourceHomeRelativeDir: ".codex",
    // auth.json carries the ChatGPT OAuth tokens (codex reads creds from a file,
    // not the keychain); config.toml preserves the user's codex configuration.
    seedFiles: ["auth.json", "config.toml"],
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
}

/**
 * Stage + seed a relocated, writable config home for an agent that cannot run
 * with a read-only config home (codex's `CODEX_HOME`) under the safehouse
 * runner. `parentDir` must already exist (the caller stages it inside a
 * dedicated per-launch temp dir); the config home itself is created here.
 *
 * Returns `undefined` when the agent has no registered relocation (claude,
 * unknown agents) — the caller then runs that agent against its real home.
 */
export function stageRelocatedAgentConfigHome(input: {
  agent: string;
  parentDir: string;
  homeDir: string;
}): StagedAgentConfigHome | undefined {
  const relocation = agentConfigRelocation(input.agent);
  if (relocation === undefined) {
    return undefined;
  }
  const configDir = path.join(input.parentDir, `${input.agent}-home`);
  mkdirSync(configDir, { recursive: true });
  seedRelocatedConfigDir({
    sourceDir: path.join(input.homeDir, relocation.sourceHomeRelativeDir),
    seedFiles: relocation.seedFiles,
    relocatedConfigDir: configDir,
  });
  return { configDir, configDirEnv: { name: relocation.configDirEnv, value: configDir } };
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
