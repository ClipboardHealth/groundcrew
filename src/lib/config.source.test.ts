import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  deleteEnvironmentVariable,
  setEnvironmentVariable,
  snapshotEnvironmentVariables,
} from "../testHelpers/env.ts";
import type { Config, LoadedConfig } from "./config.ts";

interface ConfigModule {
  loadConfigWithSource: () => Promise<Readonly<LoadedConfig>>;
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

function validConfigSource(config: Config): string {
  return configSource({
    ...config,
    agents: {
      definitions: { claude: {} },
      ...config.agents,
    },
  });
}

describe("loadConfigWithSource", () => {
  const originalEnvironment = snapshotEnvironmentVariables();
  const ENV_KEYS = ["GROUNDCREW_CONFIG", "HOME", "XDG_CONFIG_HOME"] as const;
  let temporary: string;

  beforeEach(() => {
    temporary = mkdtempSync(path.join(tmpdir(), "groundcrew-resolve-"));
    for (const key of ENV_KEYS) {
      deleteEnvironmentVariable(key);
    }
    setEnvironmentVariable("XDG_CONFIG_HOME", path.join(temporary, "xdg-config"));
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

  it("reports an env-override source", async () => {
    const configPath = writeConfigFile(
      temporary,
      validConfigSource({ workspace: VALID_WORKSPACE(temporary) }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);

    const { loadConfigWithSource } = await loadFreshConfig();
    const actual = await loadConfigWithSource();

    expect(actual.source).toStrictEqual({ kind: "env", filepath: path.resolve(configPath) });
    expect(actual.config.workspace.projectDir).toBe(temporary);
  });

  it("reports a project-search source", async () => {
    const projectConfigPath = path.join(temporary, "crew.config.ts");
    writeFileSync(projectConfigPath, validConfigSource({ workspace: VALID_WORKSPACE(temporary) }));

    const { loadConfigWithSource } = await loadFreshConfig();
    const actual = await loadConfigWithSource();

    expect(actual.source).toStrictEqual({ kind: "project", filepath: projectConfigPath });
    expect(actual.config.workspace.projectDir).toBe(temporary);
  });

  it("reports an XDG fallback source", async () => {
    const xdgDir = path.join(temporary, "xdg-config", "groundcrew");
    mkdirSync(xdgDir, { recursive: true });
    const xdgConfigPath_ = path.join(xdgDir, "crew.config.ts");
    writeFileSync(xdgConfigPath_, validConfigSource({ workspace: VALID_WORKSPACE(temporary) }));

    const { loadConfigWithSource } = await loadFreshConfig();
    const actual = await loadConfigWithSource();

    expect(actual.source).toStrictEqual({ kind: "xdg", filepath: xdgConfigPath_ });
    expect(actual.config.workspace.projectDir).toBe(temporary);
  });
});
