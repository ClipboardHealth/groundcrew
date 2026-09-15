import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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

function validConfigSource(config: Config): string {
  const withAgents = { ...config, agents: { definitions: { claude: {} }, ...config.agents } };
  return `export default ${JSON.stringify(withAgents, undefined, 2)};\n`;
}

describe("loadConfig local.safehouse", () => {
  const originalEnvironment = snapshotEnvironmentVariables();
  const ENV_KEYS = ["GROUNDCREW_CONFIG", "HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME"] as const;
  let temporary: string;

  beforeEach(() => {
    temporary = mkdtempSync(path.join(tmpdir(), "groundcrew-config-safehouse-"));
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

  it("defaults local.safehouse.enable to an empty list when omitted", async () => {
    const configPath = writeConfigFile(
      temporary,
      validConfigSource({ workspace: VALID_WORKSPACE(temporary) }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();
    expect(actual.local.safehouse.enable).toStrictEqual([]);
  });

  it("preserves and de-duplicates local.safehouse.enable feature names", async () => {
    const configPath = writeConfigFile(
      temporary,
      validConfigSource({
        workspace: VALID_WORKSPACE(temporary),
        local: {
          safehouse: { enable: ["agent-browser", "browser-native-messaging", "agent-browser"] },
        },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();
    expect(actual.local.safehouse.enable).toStrictEqual([
      "agent-browser",
      "browser-native-messaging",
    ]);
  });

  it("defaults local.safehouse.enable to an empty list when safehouse is set without enable", async () => {
    const configPath = writeConfigFile(
      temporary,
      validConfigSource({
        workspace: VALID_WORKSPACE(temporary),
        local: { safehouse: {} },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();
    expect(actual.local.safehouse.enable).toStrictEqual([]);
  });

  it("rejects a non-object local.safehouse", async () => {
    const configPath = writeConfigFile(
      temporary,
      [
        "export default {",
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        `  agents: { definitions: { claude: {} } },`,
        `  local: { safehouse: 5 },`,
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(/local\.safehouse must be an object/);
  });

  it("rejects a non-array local.safehouse.enable", async () => {
    const configPath = writeConfigFile(
      temporary,
      [
        "export default {",
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        `  agents: { definitions: { claude: {} } },`,
        `  local: { safehouse: { enable: 'agent-browser' } },`,
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(/local\.safehouse\.enable must be an array/);
  });

  it("rejects an invalid local.safehouse.enable feature slug", async () => {
    const configPath = writeConfigFile(
      temporary,
      [
        "export default {",
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        `  agents: { definitions: { claude: {} } },`,
        `  local: { safehouse: { enable: ['Agent Browser'] } },`,
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(
      /local\.safehouse\.enable\[0\] must be a safehouse feature slug/,
    );
  });

  it("defaults local.safehouse.appendProfile to an empty list when omitted", async () => {
    const configPath = writeConfigFile(
      temporary,
      validConfigSource({ workspace: VALID_WORKSPACE(temporary) }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();
    expect(actual.local.safehouse.appendProfile).toStrictEqual([]);
  });

  it("expands ~ and de-duplicates local.safehouse.appendProfile paths", async () => {
    const configPath = writeConfigFile(
      temporary,
      validConfigSource({
        workspace: VALID_WORKSPACE(temporary),
        local: {
          safehouse: {
            appendProfile: [
              "~/.config/groundcrew/cmux.sb",
              "/etc/a.sb",
              "~/.config/groundcrew/cmux.sb",
            ],
          },
        },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();
    expect(actual.local.safehouse.appendProfile).toStrictEqual([
      path.join(homedir(), ".config/groundcrew/cmux.sb"),
      "/etc/a.sb",
    ]);
  });

  it("rejects a non-array local.safehouse.appendProfile", async () => {
    const configPath = writeConfigFile(
      temporary,
      [
        "export default {",
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        `  agents: { definitions: { claude: {} } },`,
        `  local: { safehouse: { appendProfile: '/etc/a.sb' } },`,
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(/local\.safehouse\.appendProfile must be an array/);
  });

  it("rejects a blank local.safehouse.appendProfile entry", async () => {
    const configPath = writeConfigFile(
      temporary,
      [
        "export default {",
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        `  agents: { definitions: { claude: {} } },`,
        `  local: { safehouse: { appendProfile: ['  '] } },`,
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(
      /local\.safehouse\.appendProfile\[0\] must be a non-empty path/,
    );
  });
});
