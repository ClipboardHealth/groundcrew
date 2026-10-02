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

function validConfigSource(config: Config): string {
  return `export default ${JSON.stringify(
    {
      ...config,
      agents: { definitions: { claude: {} }, ...config.agents },
    },
    undefined,
    2,
  )};\n`;
}

describe("loadConfig cmux.prStages", () => {
  const originalEnvironment = snapshotEnvironmentVariables();
  const ENV_KEYS = ["GROUNDCREW_CONFIG", "HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME"] as const;
  let temporary: string;

  beforeEach(() => {
    temporary = mkdtempSync(path.join(tmpdir(), "groundcrew-config-cmux-"));
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

  it("defaults to disabled with the stock gating label names when cmux is omitted", async () => {
    const configPath = writeConfigFile(
      temporary,
      validConfigSource({ workspace: VALID_WORKSPACE(temporary) }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);

    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();

    expect(actual.cmux).toStrictEqual({
      prStages: { enabled: false, labels: { selfReviewed: "self-reviewed", tested: "tested" } },
    });
  });

  it("defaults prStages when cmux is given but empty", async () => {
    const configPath = writeConfigFile(
      temporary,
      validConfigSource({ workspace: VALID_WORKSPACE(temporary), cmux: {} }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);

    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();

    expect(actual.cmux.prStages.enabled).toBe(false);
  });

  it("defaults the gating label names when prStages is given without labels", async () => {
    const configPath = writeConfigFile(
      temporary,
      validConfigSource({
        workspace: VALID_WORKSPACE(temporary),
        cmux: { prStages: { enabled: true } },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);

    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();

    expect(actual.cmux.prStages.labels).toStrictEqual({
      selfReviewed: "self-reviewed",
      tested: "tested",
    });
  });

  it("defaults each gating label name independently when labels is given without it", async () => {
    const configPath = writeConfigFile(
      temporary,
      validConfigSource({
        workspace: VALID_WORKSPACE(temporary),
        cmux: { prStages: { labels: {} } },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);

    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();

    expect(actual.cmux.prStages.labels).toStrictEqual({
      selfReviewed: "self-reviewed",
      tested: "tested",
    });
  });

  it("accepts enabled:true and custom gating label names", async () => {
    const configPath = writeConfigFile(
      temporary,
      validConfigSource({
        workspace: VALID_WORKSPACE(temporary),
        cmux: {
          prStages: {
            enabled: true,
            labels: { selfReviewed: "reviewed-by-author", tested: "qa-passed" },
          },
        },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);

    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();

    expect(actual.cmux).toStrictEqual({
      prStages: {
        enabled: true,
        labels: { selfReviewed: "reviewed-by-author", tested: "qa-passed" },
      },
    });
  });

  it("rejects a non-object cmux value", async () => {
    const configPath = writeConfigFile(
      temporary,
      [
        "export default {",
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        "  agents: { definitions: { claude: {} } },",
        "  cmux: 5,",
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);

    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow("cmux must be an object");
  });

  it("rejects a non-object cmux.prStages value", async () => {
    const configPath = writeConfigFile(
      temporary,
      [
        "export default {",
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        "  agents: { definitions: { claude: {} } },",
        "  cmux: { prStages: 5 },",
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);

    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow("cmux.prStages must be an object");
  });

  it("rejects a non-boolean cmux.prStages.enabled", async () => {
    const configPath = writeConfigFile(
      temporary,
      [
        "export default {",
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        "  agents: { definitions: { claude: {} } },",
        '  cmux: { prStages: { enabled: "yes" } },',
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);

    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow("cmux.prStages.enabled must be a boolean");
  });

  it("rejects a non-object cmux.prStages.labels value", async () => {
    const configPath = writeConfigFile(
      temporary,
      [
        "export default {",
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        "  agents: { definitions: { claude: {} } },",
        "  cmux: { prStages: { labels: 5 } },",
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);

    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow("cmux.prStages.labels must be an object");
  });

  it("rejects identical selfReviewed and tested gating label names", async () => {
    const configPath = writeConfigFile(
      temporary,
      validConfigSource({
        workspace: VALID_WORKSPACE(temporary),
        cmux: { prStages: { labels: { selfReviewed: "ready", tested: "ready" } } },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);

    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(
      /cmux\.prStages\.labels\.selfReviewed and cmux\.prStages\.labels\.tested must be distinct/,
    );
  });
});
