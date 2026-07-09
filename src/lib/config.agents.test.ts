import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  deleteEnvironmentVariable,
  setEnvironmentVariable,
  snapshotEnvironmentVariables,
} from "../testHelpers/env.ts";
import type { Config, ResolvedConfig } from "./config.ts";

interface ConfigModule {
  loadConfig: () => Promise<Readonly<ResolvedConfig>>;
}

async function loadFreshConfig(): Promise<ConfigModule> {
  vi.resetModules();
  return await import("./config.ts");
}

const VALID_WORKSPACE = (projectDir: string) => ({
  projectDir,
  knownRepositories: ["repo-a"],
});

function writeConfigFile(dir: string, body: string): string {
  const configPath = path.join(dir, `config-${Math.random().toString(36).slice(2)}.ts`);
  writeFileSync(configPath, body);
  return configPath;
}

function configSource(config: Config): string {
  return `export default ${JSON.stringify(config, undefined, 2)};\n`;
}

describe("loadConfig built-in agent presets", () => {
  const originalEnvironment = snapshotEnvironmentVariables();
  const ENV_KEYS = ["GROUNDCREW_CONFIG", "HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME"] as const;
  let temporary: string;

  beforeEach(() => {
    temporary = mkdtempSync(path.join(tmpdir(), "groundcrew-config-agents-"));
    for (const key of ENV_KEYS) {
      deleteEnvironmentVariable(key);
    }
    setEnvironmentVariable("XDG_CONFIG_HOME", path.join(temporary, "xdg-config"));
    setEnvironmentVariable("XDG_STATE_HOME", path.join(temporary, "xdg-state"));
    vi.spyOn(process, "cwd").mockReturnValue(temporary);
  });

  afterEach(() => {
    rmSync(temporary, { recursive: true, force: true });
    for (const key of ENV_KEYS) {
      const original = originalEnvironment[key];
      if (original === undefined) {
        deleteEnvironmentVariable(key);
      } else {
        setEnvironmentVariable(key, original);
      }
    }
    vi.restoreAllMocks();
  });

  it("enables cursor from an empty override using the built-in preset", async () => {
    const configPath = writeConfigFile(
      temporary,
      configSource({
        workspace: VALID_WORKSPACE(temporary),
        agents: { default: "cursor", definitions: { cursor: {} } },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);

    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();

    const { cursor } = actual.agents.definitions;
    // The cursor preset runs Cursor's composer-2.5 model via cursor-agent.
    expect(cursor?.cmd).toBe("cursor-agent --model composer-2.5 --sandbox disabled --force");
    expect(cursor?.color).toBe("#8B5CF6");
    expect(cursor?.resumeArgs).toBe("--continue");
    // The cursor preset ships without codexbar usage gating.
    expect(cursor?.usage).toBeUndefined();
  });

  it("enables cursor-grok from an empty override using the built-in preset", async () => {
    const configPath = writeConfigFile(
      temporary,
      configSource({
        workspace: VALID_WORKSPACE(temporary),
        agents: { default: "cursor-grok", definitions: { "cursor-grok": {} } },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);

    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();

    // cursor-grok runs Grok 4.5 through the same cursor-agent CLI as cursor.
    const grok = actual.agents.definitions["cursor-grok"];
    expect(grok?.cmd).toBe("cursor-agent --model grok-4.5-xhigh --sandbox disabled --force");
    expect(grok?.color).toBe("#16A34A");
    expect(grok?.resumeArgs).toBe("--continue");
    expect(grok?.usage).toBeUndefined();
  });
});
