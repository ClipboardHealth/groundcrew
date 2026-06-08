import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  deleteEnvironmentVariable,
  setEnvironmentVariable,
  snapshotEnvironmentVariables,
} from "../testHelpers/env.ts";
import {
  repositoryBaseDir,
  worktreeBaseDir,
  type Config,
  type LoadedConfig,
  type ResolvedConfig,
} from "./config.ts";

interface ConfigModule {
  loadConfig: () => Promise<Readonly<ResolvedConfig>>;
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
    models: {
      definitions: { claude: {} },
      ...config.models,
    },
  });
}

describe("loadConfig", () => {
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

  it("rejects configs that do not explicitly enable models", async () => {
    const configPath = writeConfigFile(
      temporary,
      configSource({ workspace: VALID_WORKSPACE(temporary) }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(/models are no longer enabled by default/);
    await expect(loadConfig()).rejects.toThrow(/claude: \{\}/);
    await expect(loadConfig()).rejects.toThrow(/disabled: true` is no longer supported/);
  });

  it("loads an explicit built-in model and applies defaults", async () => {
    const configPath = writeConfigFile(
      temporary,
      validConfigSource({ workspace: VALID_WORKSPACE(temporary) }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);

    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();

    expect(actual.git).toStrictEqual({ remote: "origin", defaultBranch: "main" });
    expect(actual.orchestrator).toStrictEqual({
      maximumInProgress: 4,
      pollIntervalMilliseconds: 120_000,
      sessionLimitPercentage: 85,
    });
    expect(actual.models.default).toBe("claude");
    expect(Object.keys(actual.models.definitions).toSorted()).toStrictEqual(["claude"]);
    expect(actual.models.definitions["claude"]?.cmd).toBe("claude --permission-mode auto");
    expect(actual.prompts.initial).toContain("{{task}}");
    expect(actual.sources).toStrictEqual([]);
  });

  it("ships a model-agnostic unattended default prompt", async () => {
    const configPath = writeConfigFile(
      temporary,
      validConfigSource({ workspace: VALID_WORKSPACE(temporary) }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);

    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();

    expect(actual.prompts.initial).toContain("There is no human watching this session");
    expect(actual.prompts.initial).toContain("Task description:\n\n{{description}}");
    expect(actual.prompts.initial).toMatch(/documented verification/i);
    expect(actual.prompts.initial).toMatch(/open a PR/i);
    expect(actual.prompts.initial).toContain("{{workspaceContinuationInstruction}}");
    expect(actual.prompts.initial).not.toContain("tmux attach -t groundcrew:{{task}}");
  });

  it("resolves a valid git.branchPrefix", async () => {
    const configPath = writeConfigFile(
      temporary,
      validConfigSource({
        workspace: VALID_WORKSPACE(temporary),
        git: { branchPrefix: "groundcrew" },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);

    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();

    expect(actual.git.branchPrefix).toBe("groundcrew");
  });

  it("rejects a git.branchPrefix containing a slash", async () => {
    const configPath = writeConfigFile(
      temporary,
      validConfigSource({
        workspace: VALID_WORKSPACE(temporary),
        git: { branchPrefix: "feature/x" },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(/git\.branchPrefix must be a slash-free slug/);
  });

  it("accepts a git.branchPrefix with interior dots and dashes", async () => {
    const configPath = writeConfigFile(
      temporary,
      validConfigSource({
        workspace: VALID_WORKSPACE(temporary),
        git: { branchPrefix: "my-team.v2" },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);

    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();

    expect(actual.git.branchPrefix).toBe("my-team.v2");
  });

  it("rejects a git.branchPrefix starting with a dash", async () => {
    const configPath = writeConfigFile(
      temporary,
      validConfigSource({
        workspace: VALID_WORKSPACE(temporary),
        git: { branchPrefix: "-lead" },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(/git\.branchPrefix must be a slash-free slug/);
  });

  it("rejects a git.branchPrefix starting with a dot", async () => {
    const configPath = writeConfigFile(
      temporary,
      validConfigSource({
        workspace: VALID_WORKSPACE(temporary),
        git: { branchPrefix: ".lead" },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(/git\.branchPrefix must be a slash-free slug/);
  });

  it("rejects a git.branchPrefix containing '..'", async () => {
    const configPath = writeConfigFile(
      temporary,
      validConfigSource({
        workspace: VALID_WORKSPACE(temporary),
        git: { branchPrefix: "a..b" },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(/git\.branchPrefix must be a slash-free slug/);
  });

  it("rejects an empty git.branchPrefix", async () => {
    const configPath = writeConfigFile(
      temporary,
      validConfigSource({
        workspace: VALID_WORKSPACE(temporary),
        git: { branchPrefix: "   " },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(/git\.branchPrefix must be a non-empty string/);
  });

  it("rejects a `linear` config block with a migration message", async () => {
    const configPath = writeConfigFile(
      temporary,
      [
        "export default {",
        `  linear: { projects: [{ projectSlug: "ai-strategy-5152195762f3" }] },`,
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);

    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(/The `linear` config block is no longer supported/);
  });

  it("caches the resolved config across calls", async () => {
    const configPath = writeConfigFile(
      temporary,
      validConfigSource({ workspace: VALID_WORKSPACE(temporary) }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);

    const { loadConfig } = await loadFreshConfig();
    const first = await loadConfig();
    const second = await loadConfig();

    expect(second).toBe(first);
  });

  it("merges per-key overrides into enabled built-in model definitions", async () => {
    const configPath = writeConfigFile(
      temporary,
      configSource({
        workspace: VALID_WORKSPACE(temporary),
        models: {
          definitions: {
            claude: { cmd: "my-claude" },
            cursor: { cmd: "cursor-agent", color: "#929292" },
          },
        },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);

    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();

    expect(actual.models.definitions["claude"]?.cmd).toBe("my-claude");
    expect(actual.models.definitions["claude"]?.color).toBe("#C15F3C");
    expect(actual.models.definitions["claude"]?.usage).toStrictEqual({
      codexbar: { provider: "claude" },
    });
    expect(actual.models.definitions["cursor"]).toStrictEqual({
      cmd: "cursor-agent",
      color: "#929292",
    });
  });

  it("falls back to the inherited usage block when override sets `usage: undefined`", async () => {
    const configPath = writeConfigFile(
      temporary,
      configSource({
        workspace: VALID_WORKSPACE(temporary),
        models: { definitions: { claude: { cmd: "my-claude", usage: undefined } } },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);

    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();

    const { claude } = actual.models.definitions;
    expect(claude?.cmd).toBe("my-claude");
    expect(claude?.usage).toStrictEqual({ codexbar: { provider: "claude" } });
  });

  it("strips usage from a built-in model when override sets `usage: { disabled: true }`", async () => {
    const configPath = writeConfigFile(
      temporary,
      configSource({
        workspace: VALID_WORKSPACE(temporary),
        models: { definitions: { claude: { usage: { disabled: true } } } },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);

    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();

    expect(actual.models.definitions["claude"]?.usage).toBeUndefined();
    expect(actual.models.definitions["claude"]?.cmd).toBe("claude --permission-mode auto");
    expect(actual.models.definitions["codex"]).toBeUndefined();
  });

  it("treats `usage: { disabled: true }` on a brand-new model as no gating", async () => {
    const configPath = writeConfigFile(
      temporary,
      configSource({
        workspace: VALID_WORKSPACE(temporary),
        models: {
          default: "cursor",
          definitions: {
            cursor: { cmd: "cursor", color: "#abc", usage: { disabled: true } },
          },
        },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);

    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();

    expect(actual.models.definitions["cursor"]).toStrictEqual({ cmd: "cursor", color: "#abc" });
  });

  it("rejects legacy models.isolation config", async () => {
    const configPath = writeConfigFile(
      temporary,
      [
        "export default {",
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        `  models: { isolation: "safehouse" },`,
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(/models\.isolation is no longer supported/);
  });

  it("rejects the legacy remote config block", async () => {
    const configPath = writeConfigFile(
      temporary,
      [
        "export default {",
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        `  remote: { hostname: "foo" },`,
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(/remote is no longer supported/);
  });

  it("rejects non-object model definitions", async () => {
    const configPath = writeConfigFile(
      temporary,
      [
        "export default {",
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        `  models: { definitions: 5 },`,
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(/models\.definitions must be an object/);
  });

  it("rejects empty model definitions", async () => {
    const configPath = writeConfigFile(
      temporary,
      configSource({
        workspace: VALID_WORKSPACE(temporary),
        models: { definitions: {} },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(
      /models\.definitions must contain at least one model/,
    );
  });

  it("rejects non-object per-model definitions", async () => {
    const configPath = writeConfigFile(
      temporary,
      [
        "export default {",
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        `  models: { definitions: { claude: 5 } },`,
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(/models\.definitions\.claude must be an object/);
  });

  it("rejects legacy per-model isolation config", async () => {
    const configPath = writeConfigFile(
      temporary,
      [
        "export default {",
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        `  models: { definitions: { claude: { isolation: "safehouse" } } },`,
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(
      /models\.definitions\.claude\.isolation is no longer supported/,
    );
  });

  it("accepts a per-model sandbox agent binding and surfaces it on the resolved definition", async () => {
    const configPath = writeConfigFile(
      temporary,
      configSource({
        workspace: VALID_WORKSPACE(temporary),
        models: {
          definitions: {
            claude: { sandbox: { agent: "claude" } },
          },
        },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);

    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();

    expect(actual.models.definitions["claude"]?.sandbox).toStrictEqual({
      agent: "claude",
    });
  });

  it("rejects a per-model sandbox config with a whitespace-only agent", async () => {
    const configPath = writeConfigFile(
      temporary,
      [
        "export default {",
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        `  models: { definitions: { claude: { sandbox: { agent: "   " } } } },`,
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(
      /models\.definitions\.claude\.sandbox\.agent must be a non-empty string/,
    );
  });

  it("rejects removed per-model sandbox.template with migration guidance", async () => {
    const configPath = writeConfigFile(
      temporary,
      [
        "export default {",
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        `  models: { definitions: { claude: { sandbox: { agent: "claude", template: "node-22" } } } },`,
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(
      /models\.definitions\.claude\.sandbox\.template is no longer supported/,
    );
    await expect(loadConfig()).rejects.toThrow(/sbx create --name groundcrew-<agent>/);
  });

  it("rejects removed per-model sandbox.kits with migration guidance", async () => {
    const configPath = writeConfigFile(
      temporary,
      [
        "export default {",
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        `  models: { definitions: { claude: { sandbox: { agent: "claude", kits: ["npm-cache"] } } } },`,
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(
      /models\.definitions\.claude\.sandbox\.kits is no longer supported/,
    );
    await expect(loadConfig()).rejects.toThrow(/Provision and manage the sandbox yourself/);
  });

  it("rejects per-model sandbox.setupCommand with prepareWorktree migration guidance", async () => {
    const configPath = writeConfigFile(
      temporary,
      [
        "export default {",
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        `  models: { definitions: { claude: { sandbox: { agent: "claude", setupCommand: "./bootstrap.sh" } } } },`,
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(
      /models\.definitions\.claude\.sandbox\.setupCommand is no longer supported/,
    );
    await expect(loadConfig()).rejects.toThrow(/defaults\.hooks\.prepareWorktree/);
  });

  it("resolves defaults.hooks.prepareWorktree", async () => {
    const configPath = writeConfigFile(
      temporary,
      configSource({
        workspace: VALID_WORKSPACE(temporary),
        defaults: {
          hooks: {
            prepareWorktree: "npm ci",
          },
        },
        models: {
          definitions: {
            claude: {},
          },
        },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();

    const actual = await loadConfig();

    expect(actual.defaults.hooks.prepareWorktree).toBe("npm ci");
  });

  it("allows defaults without hooks", async () => {
    const configPath = writeConfigFile(
      temporary,
      configSource({
        workspace: VALID_WORKSPACE(temporary),
        defaults: {},
        models: {
          definitions: {
            claude: {},
          },
        },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();

    const actual = await loadConfig();

    expect(actual.defaults.hooks).toStrictEqual({});
  });

  it("rejects non-object defaults", async () => {
    const configPath = writeConfigFile(
      temporary,
      [
        "export default {",
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        `  defaults: [],`,
        `  models: { definitions: { claude: {} } },`,
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(/defaults must be an object/);
  });

  it("rejects non-object defaults.hooks", async () => {
    const configPath = writeConfigFile(
      temporary,
      [
        "export default {",
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        `  defaults: { hooks: [] },`,
        `  models: { definitions: { claude: {} } },`,
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(/defaults\.hooks must be an object/);
  });

  it("rejects empty defaults.hooks.prepareWorktree", async () => {
    const configPath = writeConfigFile(
      temporary,
      [
        "export default {",
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        `  defaults: { hooks: { prepareWorktree: " " } },`,
        `  models: { definitions: { claude: {} } },`,
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(
      /defaults\.hooks\.prepareWorktree must be a non-empty string/,
    );
  });

  it("accepts a brand-new model override that supplies an explicit usage block", async () => {
    const configPath = writeConfigFile(
      temporary,
      configSource({
        workspace: VALID_WORKSPACE(temporary),
        models: {
          default: "cursor",
          definitions: {
            cursor: { cmd: "cursor", color: "#abc", usage: { codexbar: { provider: "cursor" } } },
          },
        },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();
    expect(actual.models.definitions["cursor"]?.usage).toStrictEqual({
      codexbar: { provider: "cursor" },
    });
  });

  it("rejects a per-model sandbox config that omits agent", async () => {
    const configPath = writeConfigFile(
      temporary,
      [
        "export default {",
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        `  models: { definitions: { claude: { sandbox: {} } } },`,
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(
      /models\.definitions\.claude\.sandbox\.agent must be a non-empty string/,
    );
  });

  it("merges preLaunch through overlay without dropping default cmd/color", async () => {
    const configPath = writeConfigFile(
      temporary,
      [
        "export const config = {",
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        '  models: { definitions: { claude: { preLaunch: "export FOO=bar" } } },',
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);

    const { loadConfig } = await loadFreshConfig();

    const config = await loadConfig();
    expect(config.models.definitions["claude"]?.preLaunch).toBe("export FOO=bar");
    expect(config.models.definitions["claude"]?.cmd).toContain("claude");
    expect(config.models.definitions["claude"]?.color).toBe("#C15F3C");
  });

  it("rejects an empty preLaunch string", async () => {
    const configPath = writeConfigFile(
      temporary,
      [
        "export const config = {",
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        '  models: { definitions: { claude: { preLaunch: "" } } },',
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(
      /models\.definitions\.claude\.preLaunch must be a non-empty string/,
    );
  });

  it("rejects a whitespace-only preLaunch string", async () => {
    const configPath = writeConfigFile(
      temporary,
      [
        "export const config = {",
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        String.raw`  models: { definitions: { claude: { preLaunch: "   \n\t " } } },`,
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(
      /models\.definitions\.claude\.preLaunch must contain non-whitespace characters/,
    );
  });

  it("allows preLaunch on a brand-new model when cmd and color are supplied", async () => {
    const configPath = writeConfigFile(
      temporary,
      [
        "export const config = {",
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        "  models: {",
        '    default: "cursor",',
        '    definitions: { cursor: { cmd: "cursor-agent", color: "#929292", preLaunch: "export FOO=bar" } },',
        "  },",
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);

    const { loadConfig } = await loadFreshConfig();

    const config = await loadConfig();
    expect(config.models.definitions["cursor"]?.preLaunch).toBe("export FOO=bar");
  });

  it("merges preLaunchEnv through an override and preserves cmd/color defaults", async () => {
    const configPath = writeConfigFile(
      temporary,
      configSource({
        workspace: VALID_WORKSPACE(temporary),
        models: {
          definitions: { claude: { preLaunchEnv: ["SESSION_TOKEN", "TEAM_ID"] } },
        },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();

    expect(actual.models.definitions["claude"]?.preLaunchEnv).toStrictEqual([
      "SESSION_TOKEN",
      "TEAM_ID",
    ]);
    expect(actual.models.definitions["claude"]?.cmd).toBeTypeOf("string");
    expect(actual.models.definitions["claude"]?.color).toBeTypeOf("string");
  });

  it("rejects a non-array preLaunchEnv", async () => {
    const configPath = writeConfigFile(
      temporary,
      [
        "export const config = {",
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        '  models: { definitions: { claude: { preLaunchEnv: "SESSION_TOKEN" } } },',
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(
      /models\.definitions\.claude\.preLaunchEnv must be an array/,
    );
  });

  it("rejects a preLaunchEnv entry that isn't a valid POSIX env var name", async () => {
    const configPath = writeConfigFile(
      temporary,
      configSource({
        workspace: VALID_WORKSPACE(temporary),
        models: { definitions: { claude: { preLaunchEnv: ["SESSION_TOKEN", "1bad"] } } },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(
      /models\.definitions\.claude\.preLaunchEnv\[1\] must be a POSIX env var name/,
    );
  });

  it("rejects a preLaunchEnv entry that overlaps BUILD_SECRET_NAMES", async () => {
    // BUILD_SECRET_NAMES are `unset` on the host between the prepareWorktree wrap and
    // the agent wrap, so forwarding them via --env-pass would silently never
    // reach the agent. Fail at config-load time.
    const configPath = writeConfigFile(
      temporary,
      configSource({
        workspace: VALID_WORKSPACE(temporary),
        models: { definitions: { claude: { preLaunchEnv: ["SESSION_TOKEN", "NPM_TOKEN"] } } },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(
      /models\.definitions\.claude\.preLaunchEnv\[1\] cannot be a BUILD_SECRET_NAMES entry/,
    );
  });

  it("rejects legacy disabled model entries even when combined with other fields", async () => {
    const configPath = writeConfigFile(
      temporary,
      [
        "export const config = {",
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        '  models: { definitions: { claude: { disabled: true, preLaunchEnv: ["SESSION_TOKEN"] } } },',
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(/disabled: true` is no longer supported/);
  });

  it("trims surrounding whitespace from a per-model sandbox agent", async () => {
    const configPath = writeConfigFile(
      temporary,
      configSource({
        workspace: VALID_WORKSPACE(temporary),
        models: { definitions: { claude: { sandbox: { agent: "  claude  " } } } },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();
    expect(actual.models.definitions["claude"]?.sandbox?.agent).toBe("claude");
  });

  it("rejects a non-object local block", async () => {
    const configPath = writeConfigFile(
      temporary,
      [
        "export default {",
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        `  local: 5,`,
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(/local must be an object/);
  });

  it("rejects a non-object per-model sandbox block", async () => {
    const configPath = writeConfigFile(
      temporary,
      [
        "export default {",
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        `  models: { definitions: { claude: { sandbox: 5 } } },`,
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(
      /models\.definitions\.claude\.sandbox must be an object/,
    );
  });

  it("rejects a non-object top-level sandbox block", async () => {
    const configPath = writeConfigFile(
      temporary,
      [
        "export default {",
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        `  sandbox: 'nope',`,
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(/sandbox must be an object/);
  });

  it("allows an empty top-level sandbox block during migration", async () => {
    const configPath = writeConfigFile(
      temporary,
      [
        "export default {",
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        `  models: { definitions: { claude: {} } },`,
        `  sandbox: {},`,
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();
    expect(actual.workspace.projectDir).toBe(temporary);
  });

  it("rejects removed sandbox.gitDefaults with migration guidance", async () => {
    const configPath = writeConfigFile(
      temporary,
      [
        "export default {",
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        `  sandbox: { gitDefaults: false },`,
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(/sandbox\.gitDefaults is no longer supported/);
    await expect(loadConfig()).rejects.toThrow(/no longer seeds git defaults/);
  });

  it("rejects removed sandbox.authRecipes with migration guidance", async () => {
    const configPath = writeConfigFile(
      temporary,
      [
        "export default {",
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        `  sandbox: { authRecipes: { gh: { displayName: 'GitHub CLI' } } },`,
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(/sandbox\.authRecipes is no longer supported/);
    await expect(loadConfig()).rejects.toThrow(/no longer drives in-sandbox auth flows/);
  });

  it("rejects an invalid local.runner value", async () => {
    const configPath = writeConfigFile(
      temporary,
      [
        "export default {",
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        `  models: { definitions: { claude: {} } },`,
        `  local: { runner: 'nope' },`,
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(/local\.runner must be one of/);
  });

  it("defaults local.runner to 'auto' when omitted", async () => {
    const configPath = writeConfigFile(
      temporary,
      validConfigSource({ workspace: VALID_WORKSPACE(temporary) }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();
    expect(actual.local.runner).toBe("auto");
  });

  it("preserves an explicit local.runner value", async () => {
    const configPath = writeConfigFile(
      temporary,
      validConfigSource({
        workspace: VALID_WORKSPACE(temporary),
        local: { runner: "safehouse" },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();
    expect(actual.local.runner).toBe("safehouse");
  });

  it("rejects legacy disabled model entries with migration guidance", async () => {
    const configPath = writeConfigFile(
      temporary,
      [
        "export default {",
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        `  models: { definitions: { codex: { disabled: true } } },`,
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(/disabled: true` is no longer supported/);
    await expect(loadConfig()).rejects.toThrow(/claude: \{\}/);
  });

  it("enables both shipped models when both are listed", async () => {
    const configPath = writeConfigFile(
      temporary,
      configSource({
        workspace: VALID_WORKSPACE(temporary),
        models: { definitions: { claude: {}, codex: {} } },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();

    expect(Object.keys(actual.models.definitions).toSorted()).toStrictEqual(["claude", "codex"]);
    expect(actual.models.definitions["codex"]?.cmd).toBe(
      "codex --dangerously-bypass-approvals-and-sandbox",
    );
  });

  it("rejects a default model that is not enabled", async () => {
    const configPath = writeConfigFile(
      temporary,
      configSource({
        workspace: VALID_WORKSPACE(temporary),
        models: { default: "codex", definitions: { claude: {} } },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(/models\.default \("codex"\) is not enabled/);
  });

  it("defaults workspaceKind to auto when omitted", async () => {
    const configPath = writeConfigFile(
      temporary,
      validConfigSource({ workspace: VALID_WORKSPACE(temporary) }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();
    expect(actual.workspaceKind).toBe("auto");
  });

  it("accepts a valid workspaceKind override", async () => {
    const configPath = writeConfigFile(
      temporary,
      validConfigSource({
        workspace: VALID_WORKSPACE(temporary),
        workspaceKind: "tmux",
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();
    expect(actual.workspaceKind).toBe("tmux");
  });

  it("rejects an unknown workspaceKind value", async () => {
    const configPath = writeConfigFile(
      temporary,
      [
        "export default {",
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        `  models: { definitions: { claude: {} } },`,
        `  workspaceKind: "screen",`,
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(/workspaceKind must be one of/);
  });

  it("respects user-supplied prompts.initial", async () => {
    const configPath = writeConfigFile(
      temporary,
      validConfigSource({
        workspace: VALID_WORKSPACE(temporary),
        prompts: { initial: "do {{task}} in {{worktree}}" },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();
    expect(actual.prompts.initial).toBe("do {{task}} in {{worktree}}");
  });

  it("allows known placeholders in prompts.initial", async () => {
    const configPath = writeConfigFile(
      temporary,
      validConfigSource({
        workspace: VALID_WORKSPACE(temporary),
        prompts: {
          initial:
            "{{task}} {{worktree}} {{title}} {{description}} {{workspaceContinuationInstruction}}",
        },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();
    expect(actual.prompts.initial).toBe(
      "{{task}} {{worktree}} {{title}} {{description}} {{workspaceContinuationInstruction}}",
    );
  });

  it("fails when prompts.initial contains an unknown placeholder", async () => {
    const configPath = writeConfigFile(
      temporary,
      validConfigSource({
        workspace: VALID_WORKSPACE(temporary),
        prompts: { initial: "do {{unknown}}" },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(/prompts\.initial contains unknown placeholder/);
  });

  it("expands a leading ~ in workspace.projectDir", async () => {
    setEnvironmentVariable("HOME", "/fake-home");
    const configPath = writeConfigFile(
      temporary,
      validConfigSource({
        workspace: { projectDir: "~/work", knownRepositories: ["repo-a"] },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();
    expect(actual.workspace.projectDir).toBe("/fake-home/work");
  });

  it("expands a bare ~ in workspace.projectDir", async () => {
    setEnvironmentVariable("HOME", "/fake-home");
    const configPath = writeConfigFile(
      temporary,
      validConfigSource({ workspace: { projectDir: "~", knownRepositories: ["repo-a"] } }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();
    expect(actual.workspace.projectDir).toBe("/fake-home");
  });

  it("leaves non-tilde projectDir paths alone", async () => {
    const configPath = writeConfigFile(
      temporary,
      validConfigSource({
        workspace: { projectDir: "/work/here", knownRepositories: ["repo-a"] },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();
    expect(actual.workspace.projectDir).toBe("/work/here");
  });

  it("lifts per-repo projectDirOverride out of knownRepositories", async () => {
    setEnvironmentVariable("HOME", "/fake-home");
    const configPath = writeConfigFile(
      temporary,
      validConfigSource({
        workspace: {
          projectDir: "~/dev",
          worktreeDir: "~/worktrees",
          knownRepositories: [
            "owner/flat",
            { name: "owner/elsewhere", projectDirOverride: "~/work" },
          ],
        },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();
    const config = await loadConfig();
    expect(config.workspace.knownRepositories).toStrictEqual(["owner/flat", "owner/elsewhere"]);
    expect(config.workspace.worktreeDir).toBe("/fake-home/worktrees");
    expect(config.workspace.repositoryDirs).toStrictEqual({
      "owner/elsewhere": "/fake-home/work",
    });
  });

  it("rejects duplicate knownRepositories names instead of overwriting overrides", async () => {
    const configPath = writeConfigFile(
      temporary,
      [
        "export default {",
        `  workspace: { projectDir: "/dev", knownRepositories: ["owner/dup", { name: "owner/dup", projectDirOverride: "/work" }] },`,
        `  models: { definitions: { claude: {} } },`,
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(
      'workspace.knownRepositories[1] duplicates "owner/dup" from workspace.knownRepositories[0]',
    );
  });

  it("treats an object entry without a projectDirOverride like a bare string", async () => {
    const configPath = writeConfigFile(
      temporary,
      validConfigSource({
        workspace: {
          projectDir: "/dev",
          knownRepositories: [{ name: "owner/plain" }],
        },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();
    const config = await loadConfig();
    expect(config.workspace.knownRepositories).toStrictEqual(["owner/plain"]);
    expect(config.workspace.repositoryDirs).toBeUndefined();
  });

  it("omits worktreeDir and repositoryDirs when no overrides are given", async () => {
    const configPath = writeConfigFile(
      temporary,
      validConfigSource({
        workspace: { projectDir: "/dev", knownRepositories: ["owner/flat"] },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();
    const config = await loadConfig();
    expect(config.workspace.worktreeDir).toBeUndefined();
    expect(config.workspace.repositoryDirs).toBeUndefined();
  });

  it("rejects a knownRepositories object entry with a non-string projectDirOverride", async () => {
    const configPath = writeConfigFile(
      temporary,
      [
        "export default {",
        `  workspace: { projectDir: "/dev", knownRepositories: [{ name: "owner/x", projectDirOverride: 5 }] },`,
        `  models: { definitions: { claude: {} } },`,
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow("workspace.knownRepositories[0].projectDirOverride");
  });

  it("rejects a knownRepositories entry that is neither a string nor an object", async () => {
    const configPath = writeConfigFile(
      temporary,
      [
        "export default {",
        `  workspace: { projectDir: "/dev", knownRepositories: [42] },`,
        `  models: { definitions: { claude: {} } },`,
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow("workspace.knownRepositories[0] must be an object");
  });

  it("rejects a knownRepositories object entry with a non-string name", async () => {
    const configPath = writeConfigFile(
      temporary,
      [
        "export default {",
        `  workspace: { projectDir: "/dev", knownRepositories: [{ name: 5 }] },`,
        `  models: { definitions: { claude: {} } },`,
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow("workspace.knownRepositories[0].name");
  });

  it("rejects a non-string projectDir with a clean config error", async () => {
    const configPath = writeConfigFile(
      temporary,
      [
        "export default {",
        `  workspace: { projectDir: 5, knownRepositories: ["owner/flat"] },`,
        `  models: { definitions: { claude: {} } },`,
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow("workspace.projectDir must be a non-empty string");
  });

  it("rejects a worktreeDir that is not a string", async () => {
    const configPath = writeConfigFile(
      temporary,
      [
        "export default {",
        `  workspace: { projectDir: "/dev", worktreeDir: 5, knownRepositories: ["owner/flat"] },`,
        `  models: { definitions: { claude: {} } },`,
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow("workspace.worktreeDir");
  });

  it("defaults logging.file to the XDG state path", async () => {
    const configPath = writeConfigFile(
      temporary,
      validConfigSource({ workspace: VALID_WORKSPACE(temporary) }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();
    expect(actual.logging.file).toBe(
      path.join(temporary, "xdg-state", "groundcrew", "groundcrew.log"),
    );
  });

  it("uses HOME when XDG_STATE_HOME is unset", async () => {
    deleteEnvironmentVariable("XDG_STATE_HOME");
    setEnvironmentVariable("HOME", "/fake-home");
    const configPath = writeConfigFile(
      temporary,
      validConfigSource({ workspace: VALID_WORKSPACE(temporary) }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();
    expect(actual.logging.file).toBe("/fake-home/.local/state/groundcrew/groundcrew.log");
  });

  it("respects a user-supplied logging.file", async () => {
    const configPath = writeConfigFile(
      temporary,
      validConfigSource({
        workspace: VALID_WORKSPACE(temporary),
        logging: { file: "/var/log/groundcrew.log" },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();
    expect(actual.logging.file).toBe("/var/log/groundcrew.log");
  });

  it("expands a leading ~ in logging.file", async () => {
    setEnvironmentVariable("HOME", "/fake-home");
    const configPath = writeConfigFile(
      temporary,
      validConfigSource({
        workspace: VALID_WORKSPACE(temporary),
        logging: { file: "~/groundcrew.log" },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();
    expect(actual.logging.file).toBe("/fake-home/groundcrew.log");
  });

  it("rejects an empty logging.file", async () => {
    const configPath = writeConfigFile(
      temporary,
      validConfigSource({
        workspace: VALID_WORKSPACE(temporary),
        logging: { file: "  " },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(/logging\.file must be a non-empty string/);
  });

  it("falls back to the XDG crew.config.ts when GROUNDCREW_CONFIG is unset", async () => {
    const xdgDir = path.join(temporary, "xdg-config", "groundcrew");
    mkdirSync(xdgDir, { recursive: true });
    writeFileSync(
      path.join(xdgDir, "crew.config.ts"),
      validConfigSource({ workspace: VALID_WORKSPACE(temporary) }),
    );
    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();
    expect(actual.workspace.projectDir).toBe(temporary);
  });

  it("keeps reading legacy XDG ~/.config/groundcrew/config.ts during the back-compat window", async () => {
    const xdgDir = path.join(temporary, "xdg-config", "groundcrew");
    mkdirSync(xdgDir, { recursive: true });
    writeFileSync(
      path.join(xdgDir, "config.ts"),
      validConfigSource({ workspace: VALID_WORKSPACE(temporary) }),
    );
    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();
    expect(actual.workspace.projectDir).toBe(temporary);
  });

  it("fails when the config file does not exist", async () => {
    setEnvironmentVariable("GROUNDCREW_CONFIG", path.join(temporary, "missing.ts"));
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(/GROUNDCREW_CONFIG=/);
  });

  it("fails when the config file has no default or `config` export", async () => {
    const configPath = writeConfigFile(temporary, "export const notConfig = {};\n");
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(/must export a config object/);
  });

  it("fails when workspace is not an object", async () => {
    const configPath = writeConfigFile(temporary, `export default { workspace: 5 };\n`);
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(/workspace must be an object/);
  });

  it("fails when knownRepositories is not an array", async () => {
    const configPath = writeConfigFile(
      temporary,
      [
        "export default {",
        `  workspace: { projectDir: ${JSON.stringify(temporary)}, knownRepositories: "owner/repo" },`,
        `  models: { definitions: { claude: {} } },`,
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(
      /workspace\.knownRepositories must be a non-empty array/,
    );
  });

  it("fails when knownRepositories is empty", async () => {
    const configPath = writeConfigFile(
      temporary,
      validConfigSource({ workspace: { projectDir: temporary, knownRepositories: [] } }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(
      /workspace\.knownRepositories must be a non-empty array/,
    );
  });

  it("fails when sessionLimitPercentage is out of range", async () => {
    const configPath = writeConfigFile(
      temporary,
      validConfigSource({
        workspace: VALID_WORKSPACE(temporary),
        orchestrator: { sessionLimitPercentage: 0 },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(
      /orchestrator\.sessionLimitPercentage must be a finite number in \(0, 100]/,
    );
  });

  it("fails when sessionLimitPercentage is greater than 100", async () => {
    const configPath = writeConfigFile(
      temporary,
      validConfigSource({
        workspace: VALID_WORKSPACE(temporary),
        orchestrator: { sessionLimitPercentage: 150 },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(
      /orchestrator\.sessionLimitPercentage must be a finite number in \(0, 100]/,
    );
  });

  it("fails when sessionLimitPercentage is NaN", async () => {
    const configPath = writeConfigFile(
      temporary,
      [
        "export default {",
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        `  models: { definitions: { claude: {} } },`,
        `  orchestrator: { sessionLimitPercentage: Number.NaN },`,
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(
      /orchestrator\.sessionLimitPercentage must be a finite number in \(0, 100]/,
    );
  });

  it("fails when maximumInProgress is not a positive integer", async () => {
    const configPath = writeConfigFile(
      temporary,
      validConfigSource({
        workspace: VALID_WORKSPACE(temporary),
        orchestrator: { maximumInProgress: 0 },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(
      /orchestrator\.maximumInProgress must be an integer ≥ 1/,
    );
  });

  it("fails when an override drops cmd to empty", async () => {
    const configPath = writeConfigFile(
      temporary,
      configSource({
        workspace: VALID_WORKSPACE(temporary),
        models: { definitions: { claude: { cmd: "" } } },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(/models\.definitions\.claude\.cmd/);
  });

  it("fails when a brand-new model omits color", async () => {
    const configPath = writeConfigFile(
      temporary,
      configSource({
        workspace: VALID_WORKSPACE(temporary),
        models: { definitions: { cursor: { cmd: "cursor" } } },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(/models\.definitions\.cursor\.color/);
  });

  it('fails when models.definitions contains the reserved "any" name', async () => {
    const configPath = writeConfigFile(
      temporary,
      configSource({
        workspace: VALID_WORKSPACE(temporary),
        models: { definitions: { any: { cmd: "any", color: "#000" } } },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(/models\.definitions cannot contain "any"/);
  });

  it("fails when models.default is unknown", async () => {
    const configPath = writeConfigFile(
      temporary,
      configSource({
        workspace: VALID_WORKSPACE(temporary),
        models: { default: "unknown", definitions: { claude: {} } },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(
      /models\.default \("unknown"\) is not a key in models\.definitions/,
    );
  });

  it("discovers crew.config.ts via cosmiconfig project-walk from a nested cwd", async () => {
    const root = path.join(temporary, "root");
    const nested = path.join(root, "nested", "deep");
    mkdirSync(nested, { recursive: true });
    writeFileSync(
      path.join(root, "crew.config.ts"),
      validConfigSource({ workspace: VALID_WORKSPACE(root) }),
    );
    vi.spyOn(process, "cwd").mockReturnValue(nested);
    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();
    expect(actual.workspace.projectDir).toBe(root);
  });

  it("loads a JSON config via cosmiconfig", async () => {
    const root = path.join(temporary, "root");
    mkdirSync(root, { recursive: true });
    writeFileSync(
      path.join(root, "crew.config.json"),
      JSON.stringify({
        workspace: VALID_WORKSPACE(root),
        models: { definitions: { claude: {} } },
      }),
    );
    vi.spyOn(process, "cwd").mockReturnValue(root);
    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();
    expect(actual.workspace.projectDir).toBe(root);
  });

  it("accepts the legacy `export const config = {...}` shape for back-compat", async () => {
    const root = path.join(temporary, "root");
    mkdirSync(root, { recursive: true });
    writeFileSync(
      path.join(root, "crew.config.ts"),
      `export const config = ${JSON.stringify({
        workspace: VALID_WORKSPACE(root),
        models: { definitions: { claude: {} } },
      })};\n`,
    );
    vi.spyOn(process, "cwd").mockReturnValue(root);
    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();
    expect(actual.workspace.projectDir).toBe(root);
  });

  it("env-var override wins over both project-walk and XDG fallback", async () => {
    const projectRoot = path.join(temporary, "project");
    const decoyXdg = path.join(temporary, "xdg-config", "groundcrew");
    const targetDir = path.join(temporary, "target");
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(decoyXdg, { recursive: true });
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(
      path.join(projectRoot, "crew.config.ts"),
      validConfigSource({
        workspace: { projectDir: projectRoot, knownRepositories: ["xdg-decoy"] },
      }),
    );
    writeFileSync(
      path.join(decoyXdg, "crew.config.ts"),
      validConfigSource({
        workspace: { projectDir: decoyXdg, knownRepositories: ["project-decoy"] },
      }),
    );
    const targetPath = path.join(targetDir, "crew.config.ts");
    writeFileSync(
      targetPath,
      validConfigSource({
        workspace: { projectDir: targetDir, knownRepositories: ["repo-a"] },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", targetPath);
    vi.spyOn(process, "cwd").mockReturnValue(projectRoot);
    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();
    expect(actual.workspace.projectDir).toBe(targetDir);
  });

  it("fails when the default export is not an object (e.g. a primitive)", async () => {
    const configPath = writeConfigFile(temporary, "export default 42;\n");
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(/must export a config object/);
  });

  it("defaults sources to an empty array when the field is omitted", async () => {
    const configPath = writeConfigFile(
      temporary,
      validConfigSource({ workspace: VALID_WORKSPACE(temporary) }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();
    expect(actual.sources).toStrictEqual([]);
  });

  it("preserves a valid sources array through resolution", async () => {
    const configPath = writeConfigFile(
      temporary,
      [
        "export default {",
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        `  models: { definitions: { claude: {} } },`,
        `  sources: [{ kind: "shell", name: "jira" }],`,
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();
    expect(actual.sources).toStrictEqual([{ kind: "shell", name: "jira" }]);
  });

  it("preserves the Linear disabled sentinel through resolution", async () => {
    const configPath = writeConfigFile(
      temporary,
      validConfigSource({
        workspace: VALID_WORKSPACE(temporary),
        sources: [{ kind: "linear", enabled: false }],
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();
    expect(actual.sources).toStrictEqual([{ kind: "linear", enabled: false }]);
  });

  it("rejects sources when it isn't an array", async () => {
    const configPath = writeConfigFile(
      temporary,
      [
        "export default {",
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        `  sources: 5,`,
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(/sources must be an array/);
  });

  it("rejects a source entry that isn't an object", async () => {
    const configPath = writeConfigFile(
      temporary,
      [
        "export default {",
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        `  sources: [42],`,
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(/sources\[0] must be an object/);
  });

  it("rejects a source entry missing a string kind field", async () => {
    const configPath = writeConfigFile(
      temporary,
      [
        "export default {",
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        `  sources: [{ name: "no-kind" }],`,
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(/sources\[0]\.kind/);
  });

  it("rejects duplicate source names", async () => {
    const configPath = writeConfigFile(
      temporary,
      [
        "export default {",
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        `  sources: [{ kind: "shell", name: "jira" }, { kind: "shell", name: "jira" }],`,
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(/duplicating sources\[0]/);
  });

  it("rejects a source entry where name is set but not a string", async () => {
    const configPath = writeConfigFile(
      temporary,
      [
        "export default {",
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        `  sources: [{ kind: "shell", name: 5 }],`,
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(/sources\[0]\.name/);
  });

  it("fails with a discovery error when no config exists anywhere", async () => {
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(/no crew config found/);
  });
});

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

function resolvedConfigWithWorkspace(workspace: ResolvedConfig["workspace"]): ResolvedConfig {
  return {
    sources: [],
    git: { remote: "origin", defaultBranch: "main" },
    workspace,
    defaults: { hooks: {} },
    orchestrator: {
      maximumInProgress: 4,
      pollIntervalMilliseconds: 1000,
      sessionLimitPercentage: 85,
    },
    models: {
      default: "claude",
      definitions: { claude: { cmd: "claude", color: "#fff" } },
    },
    prompts: { initial: "x" },
    workspaceKind: "auto",
    local: { runner: "auto" },
    logging: { file: "/tmp/x.log" },
  };
}

describe("workspace path accessors", () => {
  const resolved = resolvedConfigWithWorkspace;

  it("worktreeBaseDir falls back to projectDir when worktreeDir is unset", () => {
    const config = resolved({ projectDir: "/p", knownRepositories: ["a"] });
    expect(worktreeBaseDir(config)).toBe("/p");
  });

  it("worktreeBaseDir prefers worktreeDir when set", () => {
    const config = resolved({
      projectDir: "/p",
      worktreeDir: "/w",
      knownRepositories: ["a"],
    });
    expect(worktreeBaseDir(config)).toBe("/w");
  });

  it("repositoryBaseDir falls back to projectDir without an override", () => {
    const config = resolved({ projectDir: "/p", knownRepositories: ["a"] });
    expect(repositoryBaseDir(config, "a")).toBe("/p");
  });

  it("repositoryBaseDir uses the per-repo override when present", () => {
    const config = resolved({
      projectDir: "/p",
      knownRepositories: ["a", "b"],
      repositoryDirs: { b: "/other" },
    });
    expect(repositoryBaseDir(config, "b")).toBe("/other");
    expect(repositoryBaseDir(config, "a")).toBe("/p");
  });
});
