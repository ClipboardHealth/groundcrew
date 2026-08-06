import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  deleteEnvironmentVariable,
  setEnvironmentVariable,
  snapshotEnvironmentVariables,
} from "../testHelpers/env.ts";
import { type Config, type ResolvedConfig, resolveHookGeneratedPaths } from "./config.ts";

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

function validConfigSource(config: Config): string {
  return configSource({
    ...config,
    agents: {
      definitions: { claude: {} },
      ...config.agents,
    },
  });
}

describe("loadConfig hookGeneratedPaths", () => {
  const originalEnvironment = snapshotEnvironmentVariables();
  const ENV_KEYS = ["GROUNDCREW_CONFIG", "HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME"] as const;
  let temporary: string;

  beforeEach(() => {
    temporary = mkdtempSync(path.join(tmpdir(), "groundcrew-config-"));
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

  it("leaves defaults.hookGeneratedPaths unset when omitted", async () => {
    const configPath = writeConfigFile(
      temporary,
      validConfigSource({
        workspace: VALID_WORKSPACE(temporary),
        defaults: { hooks: { prepareWorktree: "npm ci" } },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();

    const actual = await loadConfig();

    expect(actual.defaults).toStrictEqual({ hooks: { prepareWorktree: "npm ci" } });
  });

  it("normalizes defaults.hookGeneratedPaths by trimming, stripping trailing slashes, and deduping", async () => {
    const configPath = writeConfigFile(
      temporary,
      validConfigSource({
        workspace: VALID_WORKSPACE(temporary),
        defaults: {
          hookGeneratedPaths: [".agents/skills/", ".agents/skills", "  .claude/settings.json  "],
        },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();

    const actual = await loadConfig();

    expect(actual.defaults.hookGeneratedPaths).toStrictEqual([
      ".agents/skills",
      ".claude/settings.json",
    ]);
  });

  it("carries hookGeneratedPaths onto the knownRepositories entry", async () => {
    const configPath = writeConfigFile(
      temporary,
      validConfigSource({
        workspace: {
          projectDir: temporary,
          knownRepositories: [{ name: "repo-a", hookGeneratedPaths: [".claude/settings.json"] }],
        },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();

    const config = await loadConfig();

    expect(config.workspace.repositories[0]).toStrictEqual({
      name: "repo-a",
      hookGeneratedPaths: [".claude/settings.json"],
    });
  });

  it("resolves the per-repo hookGeneratedPaths over the global defaults", async () => {
    const configPath = writeConfigFile(
      temporary,
      validConfigSource({
        workspace: {
          projectDir: temporary,
          knownRepositories: [{ name: "repo-a", hookGeneratedPaths: [".agents/skills"] }, "repo-b"],
        },
        defaults: { hookGeneratedPaths: [".claude/settings.json"] },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();
    const config = await loadConfig();

    const actual = resolveHookGeneratedPaths({ config, repository: "repo-a" });

    expect(actual).toStrictEqual([".agents/skills"]);
  });

  it("falls back to the global defaults when the repo entry omits hookGeneratedPaths", async () => {
    const configPath = writeConfigFile(
      temporary,
      validConfigSource({
        workspace: { projectDir: temporary, knownRepositories: ["repo-b"] },
        defaults: { hookGeneratedPaths: [".claude/settings.json"] },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();
    const config = await loadConfig();

    const actual = resolveHookGeneratedPaths({ config, repository: "repo-b" });

    expect(actual).toStrictEqual([".claude/settings.json"]);
  });

  it("resolves to an empty list when neither layer declares hookGeneratedPaths", async () => {
    const configPath = writeConfigFile(
      temporary,
      validConfigSource({ workspace: VALID_WORKSPACE(temporary) }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();
    const config = await loadConfig();

    const actual = resolveHookGeneratedPaths({ config, repository: "repo-a" });

    expect(actual).toStrictEqual([]);
  });

  const invalidHookGeneratedPaths: Array<[string, RegExp]> = [
    ["/etc/passwd", /hookGeneratedPaths\[0\] must be a relative path inside the worktree/],
    // `/` and `//` strip to the empty string, which git expands into a bare
    // `:(exclude,literal)` — a pathspec that hides the entire worktree from the
    // dirtiness probe and would let teardown force-remove real agent work.
    ["/", /hookGeneratedPaths\[0\] must be a relative path inside the worktree/],
    ["//", /hookGeneratedPaths\[0\] must be a relative path inside the worktree/],
    ["../outside", /hookGeneratedPaths\[0\] must not contain '\.' or '\.\.' segments/],
    [".", /hookGeneratedPaths\[0\] must not contain '\.' or '\.\.' segments/],
    [":(glob)**", /hookGeneratedPaths\[0\] must not start with ':'/],
    ["   ", /hookGeneratedPaths\[0\] must be a non-empty string/],
  ];
  it.each(invalidHookGeneratedPaths)(
    "rejects the hookGeneratedPaths entry %s",
    async (entry, expected) => {
      const configPath = writeConfigFile(
        temporary,
        validConfigSource({
          workspace: {
            projectDir: temporary,
            knownRepositories: [{ name: "repo-a", hookGeneratedPaths: [entry] }],
          },
        }),
      );
      setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
      const { loadConfig } = await loadFreshConfig();

      await expect(loadConfig()).rejects.toThrow(expected);
      await expect(loadConfig()).rejects.toThrow(/workspace\.knownRepositories\[0\]\./);
    },
  );

  it("rejects a non-string hookGeneratedPaths element", async () => {
    const configPath = writeConfigFile(
      temporary,
      [
        "export default {",
        `  workspace: { projectDir: "/dev", knownRepositories: [{ name: "repo-a", hookGeneratedPaths: [1] }] },`,
        `  agents: { definitions: { claude: {} } },`,
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(
      /workspace\.knownRepositories\[0\]\.hookGeneratedPaths\[0\] must be a non-empty string/,
    );
  });

  it("rejects a hookGeneratedPaths value that is not an array", async () => {
    const configPath = writeConfigFile(
      temporary,
      [
        "export default {",
        `  workspace: { projectDir: "/dev", knownRepositories: [{ name: "repo-a", hookGeneratedPaths: "x" }] },`,
        `  agents: { definitions: { claude: {} } },`,
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(
      /workspace\.knownRepositories\[0\]\.hookGeneratedPaths must be an array/,
    );
  });

  it("rejects a defaults.hookGeneratedPaths value that is not an array", async () => {
    const configPath = writeConfigFile(
      temporary,
      [
        "export default {",
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        `  defaults: { hookGeneratedPaths: "x" },`,
        `  agents: { definitions: { claude: {} } },`,
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(/defaults\.hookGeneratedPaths must be an array/);
  });
});
