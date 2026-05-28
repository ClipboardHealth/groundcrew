import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  const path = join(dir, `config-${Math.random().toString(36).slice(2)}.ts`);
  writeFileSync(path, body);
  return path;
}

function configSource(config: Config): string {
  return `export default ${JSON.stringify(config, undefined, 2)};\n`;
}

describe("loadConfig", () => {
  const originalEnvironment = snapshotEnvironmentVariables();
  const ENV_KEYS = ["GROUNDCREW_CONFIG", "HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME"] as const;
  let temporary: string;

  beforeEach(() => {
    temporary = mkdtempSync(join(tmpdir(), "groundcrew-config-"));
    for (const key of ENV_KEYS) {
      deleteEnvironmentVariable(key);
    }
    setEnvironmentVariable("XDG_CONFIG_HOME", join(temporary, "xdg-config"));
    setEnvironmentVariable("XDG_STATE_HOME", join(temporary, "xdg-state"));
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

  it("loads a minimal config and applies defaults", async () => {
    const path = writeConfigFile(
      temporary,
      configSource({ workspace: VALID_WORKSPACE(temporary) }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();

    expect(actual.git).toStrictEqual({ remote: "origin", defaultBranch: "main" });
    expect(actual.orchestrator).toStrictEqual({
      maximumInProgress: 4,
      pollIntervalMilliseconds: 120_000,
      sessionLimitPercentage: 85,
    });
    expect(actual.models.default).toBe("claude");
    expect(Object.keys(actual.models.definitions).toSorted()).toStrictEqual(["claude", "codex"]);
    expect(actual.models.definitions["claude"]?.cmd).toBe("claude --permission-mode auto");
    expect(actual.models.definitions["codex"]?.cmd).toBe(
      "codex --dangerously-bypass-approvals-and-sandbox",
    );
    expect(actual.prompts.initial).toContain("{{ticket}}");
    expect(actual.sources).toStrictEqual([]);
  });

  it("ships a model-agnostic unattended default prompt", async () => {
    const path = writeConfigFile(
      temporary,
      configSource({ workspace: VALID_WORKSPACE(temporary) }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();

    expect(actual.prompts.initial).toContain("There is no human watching this session");
    expect(actual.prompts.initial).toMatch(/documented verification/i);
    expect(actual.prompts.initial).toMatch(/open a pull request/i);
    expect(actual.prompts.initial).toContain("{{workspaceContinuationInstruction}}");
    expect(actual.prompts.initial).not.toContain("tmux attach -t groundcrew:{{ticket}}");
  });

  it("rejects a `linear` config block with a migration message", async () => {
    const path = writeConfigFile(
      temporary,
      [
        "export default {",
        `  linear: { projects: [{ projectSlug: "ai-strategy-5152195762f3" }] },`,
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(/The `linear` config block is no longer supported/);
  });

  it("caches the resolved config across calls", async () => {
    const path = writeConfigFile(
      temporary,
      configSource({ workspace: VALID_WORKSPACE(temporary) }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();
    const first = await loadConfig();
    const second = await loadConfig();

    expect(second).toBe(first);
  });

  it("merges per-key overrides into the default model definitions", async () => {
    const path = writeConfigFile(
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
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

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
    const path = writeConfigFile(
      temporary,
      configSource({
        workspace: VALID_WORKSPACE(temporary),
        models: { definitions: { claude: { cmd: "my-claude", usage: undefined } } },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();

    const { claude } = actual.models.definitions;
    expect(claude?.cmd).toBe("my-claude");
    expect(claude?.usage).toStrictEqual({ codexbar: { provider: "claude" } });
  });

  it("strips usage from a default model when override sets `usage: { disabled: true }`", async () => {
    const path = writeConfigFile(
      temporary,
      configSource({
        workspace: VALID_WORKSPACE(temporary),
        models: { definitions: { claude: { usage: { disabled: true } } } },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();

    expect(actual.models.definitions["claude"]?.usage).toBeUndefined();
    expect(actual.models.definitions["claude"]?.cmd).toBe("claude --permission-mode auto");
    expect(actual.models.definitions["codex"]?.usage).toStrictEqual({
      codexbar: { provider: "codex" },
    });
  });

  it("treats `usage: { disabled: true }` on a brand-new model as no gating", async () => {
    const path = writeConfigFile(
      temporary,
      configSource({
        workspace: VALID_WORKSPACE(temporary),
        models: {
          definitions: {
            cursor: { cmd: "cursor", color: "#abc", usage: { disabled: true } },
          },
        },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();

    expect(actual.models.definitions["cursor"]).toStrictEqual({ cmd: "cursor", color: "#abc" });
  });

  it("rejects legacy models.isolation config", async () => {
    const path = writeConfigFile(
      temporary,
      [
        "export default {",
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        `  models: { isolation: "safehouse" },`,
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(/models\.isolation is no longer supported/);
  });

  it("rejects the legacy remote config block", async () => {
    const path = writeConfigFile(
      temporary,
      [
        "export default {",
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        `  remote: { hostname: "foo" },`,
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(/remote is no longer supported/);
  });

  it("rejects non-object model definitions", async () => {
    const path = writeConfigFile(
      temporary,
      [
        "export default {",
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        `  models: { definitions: 5 },`,
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(/models\.definitions must be an object/);
  });

  it("rejects non-object per-model definitions", async () => {
    const path = writeConfigFile(
      temporary,
      [
        "export default {",
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        `  models: { definitions: { claude: 5 } },`,
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(/models\.definitions\.claude must be an object/);
  });

  it("rejects legacy per-model isolation config", async () => {
    const path = writeConfigFile(
      temporary,
      [
        "export default {",
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        `  models: { definitions: { claude: { isolation: "safehouse" } } },`,
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(
      /models\.definitions\.claude\.isolation is no longer supported/,
    );
  });

  it("accepts a per-model sandbox agent binding and surfaces it on the resolved definition", async () => {
    const path = writeConfigFile(
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
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();

    expect(actual.models.definitions["claude"]?.sandbox).toStrictEqual({
      agent: "claude",
    });
  });

  it("rejects a per-model sandbox config with a whitespace-only agent", async () => {
    const path = writeConfigFile(
      temporary,
      [
        "export default {",
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        `  models: { definitions: { claude: { sandbox: { agent: "   " } } } },`,
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(
      /models\.definitions\.claude\.sandbox\.agent must be a non-empty string/,
    );
  });

  it("rejects removed per-model sandbox.template with migration guidance", async () => {
    const path = writeConfigFile(
      temporary,
      [
        "export default {",
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        `  models: { definitions: { claude: { sandbox: { agent: "claude", template: "node-22" } } } },`,
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(
      /models\.definitions\.claude\.sandbox\.template is no longer supported/,
    );
    await expect(loadConfig()).rejects.toThrow(/sbx create --name groundcrew-<agent>/);
  });

  it("rejects removed per-model sandbox.kits with migration guidance", async () => {
    const path = writeConfigFile(
      temporary,
      [
        "export default {",
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        `  models: { definitions: { claude: { sandbox: { agent: "claude", kits: ["npm-cache"] } } } },`,
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(
      /models\.definitions\.claude\.sandbox\.kits is no longer supported/,
    );
    await expect(loadConfig()).rejects.toThrow(/Provision and manage the sandbox yourself/);
  });

  it("threads sandbox.setupCommand through to the resolved sandbox definition", async () => {
    const path = writeConfigFile(
      temporary,
      [
        "export default {",
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        `  models: { definitions: { claude: { sandbox: { agent: "claude", setupCommand: "./bootstrap.sh" } } } },`,
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);
    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();
    expect(actual.models.definitions["claude"]?.sandbox?.setupCommand).toBe("./bootstrap.sh");
  });

  it("accepts a brand-new model override that supplies an explicit usage block", async () => {
    const path = writeConfigFile(
      temporary,
      configSource({
        workspace: VALID_WORKSPACE(temporary),
        models: {
          definitions: {
            cursor: { cmd: "cursor", color: "#abc", usage: { codexbar: { provider: "cursor" } } },
          },
        },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);
    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();
    expect(actual.models.definitions["cursor"]?.usage).toStrictEqual({
      codexbar: { provider: "cursor" },
    });
  });

  it("rejects a per-model sandbox config that omits agent", async () => {
    const path = writeConfigFile(
      temporary,
      [
        "export default {",
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        `  models: { definitions: { claude: { sandbox: {} } } },`,
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(
      /models\.definitions\.claude\.sandbox\.agent must be a non-empty string/,
    );
  });

  it("merges preLaunch through overlay without dropping default cmd/color", async () => {
    const path = writeConfigFile(
      temporary,
      [
        "export const config = {",
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        '  models: { definitions: { claude: { preLaunch: "export FOO=bar" } } },',
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    const config = await loadConfig();
    expect(config.models.definitions["claude"]?.preLaunch).toBe("export FOO=bar");
    expect(config.models.definitions["claude"]?.cmd).toContain("claude");
    expect(config.models.definitions["claude"]?.color).toBe("#C15F3C");
  });

  it("rejects an empty preLaunch string", async () => {
    const path = writeConfigFile(
      temporary,
      [
        "export const config = {",
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        '  models: { definitions: { claude: { preLaunch: "" } } },',
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(
      /models\.definitions\.claude\.preLaunch must be a non-empty string/,
    );
  });

  it("rejects a whitespace-only preLaunch string", async () => {
    const path = writeConfigFile(
      temporary,
      [
        "export const config = {",
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        String.raw`  models: { definitions: { claude: { preLaunch: "   \n\t " } } },`,
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(
      /models\.definitions\.claude\.preLaunch must contain non-whitespace characters/,
    );
  });

  it("allows preLaunch on a brand-new model when cmd and color are supplied", async () => {
    const path = writeConfigFile(
      temporary,
      [
        "export const config = {",
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        "  models: {",
        '    definitions: { cursor: { cmd: "cursor-agent", color: "#929292", preLaunch: "export FOO=bar" } },',
        "  },",
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    const config = await loadConfig();
    expect(config.models.definitions["cursor"]?.preLaunch).toBe("export FOO=bar");
  });

  it("merges preLaunchEnv through an override and preserves cmd/color defaults", async () => {
    const path = writeConfigFile(
      temporary,
      configSource({
        workspace: VALID_WORKSPACE(temporary),
        models: {
          definitions: { claude: { preLaunchEnv: ["SESSION_TOKEN", "TEAM_ID"] } },
        },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);
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
    const path = writeConfigFile(
      temporary,
      [
        "export const config = {",
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        '  models: { definitions: { claude: { preLaunchEnv: "SESSION_TOKEN" } } },',
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(
      /models\.definitions\.claude\.preLaunchEnv must be an array/,
    );
  });

  it("rejects a preLaunchEnv entry that isn't a valid POSIX env var name", async () => {
    const path = writeConfigFile(
      temporary,
      configSource({
        workspace: VALID_WORKSPACE(temporary),
        models: { definitions: { claude: { preLaunchEnv: ["SESSION_TOKEN", "1bad"] } } },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(
      /models\.definitions\.claude\.preLaunchEnv\[1\] must be a POSIX env var name/,
    );
  });

  it("rejects a preLaunchEnv entry that overlaps BUILD_SECRET_NAMES", async () => {
    // BUILD_SECRET_NAMES are `unset` on the host between the setup wrap and
    // the agent wrap, so forwarding them via --env-pass would silently never
    // reach the agent. Fail at config-load time.
    const path = writeConfigFile(
      temporary,
      configSource({
        workspace: VALID_WORKSPACE(temporary),
        models: { definitions: { claude: { preLaunchEnv: ["SESSION_TOKEN", "NPM_TOKEN"] } } },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(
      /models\.definitions\.claude\.preLaunchEnv\[1\] cannot be a BUILD_SECRET_NAMES entry/,
    );
  });

  it("rejects combining disabled: true with preLaunchEnv", async () => {
    const path = writeConfigFile(
      temporary,
      [
        "export const config = {",
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        '  models: { definitions: { claude: { disabled: true, preLaunchEnv: ["SESSION_TOKEN"] } } },',
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(/cannot combine `disabled: true` with other fields/);
  });

  it("trims surrounding whitespace from a per-model sandbox agent", async () => {
    const path = writeConfigFile(
      temporary,
      configSource({
        workspace: VALID_WORKSPACE(temporary),
        models: { definitions: { claude: { sandbox: { agent: "  claude  " } } } },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);
    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();
    expect(actual.models.definitions["claude"]?.sandbox?.agent).toBe("claude");
  });

  it("rejects a non-object local block", async () => {
    const path = writeConfigFile(
      temporary,
      [
        "export default {",
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        `  local: 5,`,
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(/local must be an object/);
  });

  it("rejects a non-object per-model sandbox block", async () => {
    const path = writeConfigFile(
      temporary,
      [
        "export default {",
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        `  models: { definitions: { claude: { sandbox: 5 } } },`,
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(
      /models\.definitions\.claude\.sandbox must be an object/,
    );
  });

  it("rejects a non-object top-level sandbox block", async () => {
    const path = writeConfigFile(
      temporary,
      [
        "export default {",
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        `  sandbox: 'nope',`,
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(/sandbox must be an object/);
  });

  it("allows an empty top-level sandbox block during migration", async () => {
    const path = writeConfigFile(
      temporary,
      [
        "export default {",
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        `  sandbox: {},`,
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);
    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();
    expect(actual.workspace.projectDir).toBe(temporary);
  });

  it("rejects removed sandbox.gitDefaults with migration guidance", async () => {
    const path = writeConfigFile(
      temporary,
      [
        "export default {",
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        `  sandbox: { gitDefaults: false },`,
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(/sandbox\.gitDefaults is no longer supported/);
    await expect(loadConfig()).rejects.toThrow(/no longer seeds git defaults/);
  });

  it("rejects removed sandbox.authRecipes with migration guidance", async () => {
    const path = writeConfigFile(
      temporary,
      [
        "export default {",
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        `  sandbox: { authRecipes: { gh: { displayName: 'GitHub CLI' } } },`,
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(/sandbox\.authRecipes is no longer supported/);
    await expect(loadConfig()).rejects.toThrow(/no longer drives in-sandbox auth flows/);
  });

  it("rejects an invalid local.runner value", async () => {
    const path = writeConfigFile(
      temporary,
      [
        "export default {",
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        `  local: { runner: 'nope' },`,
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(/local\.runner must be one of/);
  });

  it("defaults local.runner to 'auto' when omitted", async () => {
    const path = writeConfigFile(
      temporary,
      configSource({ workspace: VALID_WORKSPACE(temporary) }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);
    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();
    expect(actual.local.runner).toBe("auto");
  });

  it("preserves an explicit local.runner value", async () => {
    const path = writeConfigFile(
      temporary,
      configSource({
        workspace: VALID_WORKSPACE(temporary),
        local: { runner: "safehouse" },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);
    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();
    expect(actual.local.runner).toBe("safehouse");
  });

  it("rejects `disabled: false` on a model definition", async () => {
    const path = writeConfigFile(
      temporary,
      [
        "export default {",
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        `  models: { definitions: { claude: { disabled: false } } },`,
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(
      /models\.definitions\.claude\.disabled must be exactly `true`/,
    );
  });

  it("rejects `disabled: true` combined with other fields (cmd / color / usage)", async () => {
    const path = writeConfigFile(
      temporary,
      [
        "export default {",
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        `  models: { definitions: { claude: { disabled: true, cmd: "x" } } },`,
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(
      /models\.definitions\.claude: cannot combine `disabled: true` with other fields/,
    );
  });

  it("drops a shipped default when `disabled: true` is set", async () => {
    const path = writeConfigFile(
      temporary,
      configSource({
        workspace: VALID_WORKSPACE(temporary),
        models: { definitions: { codex: { disabled: true } } },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);
    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();
    expect(Object.keys(actual.models.definitions).toSorted()).toStrictEqual(["claude"]);
  });

  it("rejects `disabled: true` on a key that isn't a shipped default", async () => {
    const path = writeConfigFile(
      temporary,
      configSource({
        workspace: VALID_WORKSPACE(temporary),
        models: { definitions: { cursor: { disabled: true } } },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(
      /models\.definitions\.cursor: `disabled: true` is only valid for shipped defaults/,
    );
  });

  it("rejects disabling the model used as `models.default`", async () => {
    const path = writeConfigFile(
      temporary,
      configSource({
        workspace: VALID_WORKSPACE(temporary),
        models: { default: "claude", definitions: { claude: { disabled: true } } },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(/models\.default \("claude"\) is disabled/);
  });

  it("defaults workspaceKind to auto when omitted", async () => {
    const path = writeConfigFile(
      temporary,
      configSource({ workspace: VALID_WORKSPACE(temporary) }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);
    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();
    expect(actual.workspaceKind).toBe("auto");
  });

  it("accepts a valid workspaceKind override", async () => {
    const path = writeConfigFile(
      temporary,
      configSource({
        workspace: VALID_WORKSPACE(temporary),
        workspaceKind: "tmux",
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);
    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();
    expect(actual.workspaceKind).toBe("tmux");
  });

  it("rejects an unknown workspaceKind value", async () => {
    const path = writeConfigFile(
      temporary,
      [
        "export default {",
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        `  workspaceKind: "screen",`,
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(/workspaceKind must be one of/);
  });

  it("respects user-supplied prompts.initial", async () => {
    const path = writeConfigFile(
      temporary,
      configSource({
        workspace: VALID_WORKSPACE(temporary),
        prompts: { initial: "do {{ticket}} in {{worktree}}" },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);
    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();
    expect(actual.prompts.initial).toBe("do {{ticket}} in {{worktree}}");
  });

  it("allows known placeholders in prompts.initial", async () => {
    const path = writeConfigFile(
      temporary,
      configSource({
        workspace: VALID_WORKSPACE(temporary),
        prompts: {
          initial:
            "{{ticket}} {{worktree}} {{title}} {{description}} {{workspaceContinuationInstruction}}",
        },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);
    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();
    expect(actual.prompts.initial).toBe(
      "{{ticket}} {{worktree}} {{title}} {{description}} {{workspaceContinuationInstruction}}",
    );
  });

  it("fails when prompts.initial contains an unknown placeholder", async () => {
    const path = writeConfigFile(
      temporary,
      configSource({
        workspace: VALID_WORKSPACE(temporary),
        prompts: { initial: "do {{unknown}}" },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(/prompts\.initial contains unknown placeholder/);
  });

  it("expands a leading ~ in workspace.projectDir", async () => {
    setEnvironmentVariable("HOME", "/fake-home");
    const path = writeConfigFile(
      temporary,
      configSource({
        workspace: { projectDir: "~/work", knownRepositories: ["repo-a"] },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);
    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();
    expect(actual.workspace.projectDir).toBe("/fake-home/work");
  });

  it("expands a bare ~ in workspace.projectDir", async () => {
    setEnvironmentVariable("HOME", "/fake-home");
    const path = writeConfigFile(
      temporary,
      configSource({ workspace: { projectDir: "~", knownRepositories: ["repo-a"] } }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);
    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();
    expect(actual.workspace.projectDir).toBe("/fake-home");
  });

  it("leaves non-tilde projectDir paths alone", async () => {
    const path = writeConfigFile(
      temporary,
      configSource({ workspace: { projectDir: "/work/here", knownRepositories: ["repo-a"] } }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);
    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();
    expect(actual.workspace.projectDir).toBe("/work/here");
  });

  it("defaults logging.file to the XDG state path", async () => {
    const path = writeConfigFile(
      temporary,
      configSource({ workspace: VALID_WORKSPACE(temporary) }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);
    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();
    expect(actual.logging.file).toBe(join(temporary, "xdg-state", "groundcrew", "groundcrew.log"));
  });

  it("uses HOME when XDG_STATE_HOME is unset", async () => {
    deleteEnvironmentVariable("XDG_STATE_HOME");
    setEnvironmentVariable("HOME", "/fake-home");
    const path = writeConfigFile(
      temporary,
      configSource({ workspace: VALID_WORKSPACE(temporary) }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);
    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();
    expect(actual.logging.file).toBe("/fake-home/.local/state/groundcrew/groundcrew.log");
  });

  it("respects a user-supplied logging.file", async () => {
    const path = writeConfigFile(
      temporary,
      configSource({
        workspace: VALID_WORKSPACE(temporary),
        logging: { file: "/var/log/groundcrew.log" },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);
    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();
    expect(actual.logging.file).toBe("/var/log/groundcrew.log");
  });

  it("expands a leading ~ in logging.file", async () => {
    setEnvironmentVariable("HOME", "/fake-home");
    const path = writeConfigFile(
      temporary,
      configSource({
        workspace: VALID_WORKSPACE(temporary),
        logging: { file: "~/groundcrew.log" },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);
    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();
    expect(actual.logging.file).toBe("/fake-home/groundcrew.log");
  });

  it("rejects an empty logging.file", async () => {
    const path = writeConfigFile(
      temporary,
      configSource({
        workspace: VALID_WORKSPACE(temporary),
        logging: { file: "  " },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(/logging\.file must be a non-empty string/);
  });

  it("falls back to the XDG crew.config.ts when GROUNDCREW_CONFIG is unset", async () => {
    const xdgDir = join(temporary, "xdg-config", "groundcrew");
    mkdirSync(xdgDir, { recursive: true });
    writeFileSync(
      join(xdgDir, "crew.config.ts"),
      configSource({ workspace: VALID_WORKSPACE(temporary) }),
    );
    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();
    expect(actual.workspace.projectDir).toBe(temporary);
  });

  it("keeps reading legacy XDG ~/.config/groundcrew/config.ts during the back-compat window", async () => {
    const xdgDir = join(temporary, "xdg-config", "groundcrew");
    mkdirSync(xdgDir, { recursive: true });
    writeFileSync(
      join(xdgDir, "config.ts"),
      configSource({ workspace: VALID_WORKSPACE(temporary) }),
    );
    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();
    expect(actual.workspace.projectDir).toBe(temporary);
  });

  it("fails when the config file does not exist", async () => {
    setEnvironmentVariable("GROUNDCREW_CONFIG", join(temporary, "missing.ts"));
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(/GROUNDCREW_CONFIG=/);
  });

  it("fails when the config file has no default or `config` export", async () => {
    const path = writeConfigFile(temporary, "export const notConfig = {};\n");
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(/must export a config object/);
  });

  it("fails when workspace is not an object", async () => {
    const path = writeConfigFile(temporary, `export default { workspace: 5 };\n`);
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(/workspace must be an object/);
  });

  it("fails when knownRepositories is empty", async () => {
    const path = writeConfigFile(
      temporary,
      configSource({ workspace: { projectDir: temporary, knownRepositories: [] } }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(
      /workspace\.knownRepositories must be a non-empty array/,
    );
  });

  it("fails when sessionLimitPercentage is out of range", async () => {
    const path = writeConfigFile(
      temporary,
      configSource({
        workspace: VALID_WORKSPACE(temporary),
        orchestrator: { sessionLimitPercentage: 0 },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(
      /orchestrator\.sessionLimitPercentage must be a finite number in \(0, 100]/,
    );
  });

  it("fails when sessionLimitPercentage is greater than 100", async () => {
    const path = writeConfigFile(
      temporary,
      configSource({
        workspace: VALID_WORKSPACE(temporary),
        orchestrator: { sessionLimitPercentage: 150 },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(
      /orchestrator\.sessionLimitPercentage must be a finite number in \(0, 100]/,
    );
  });

  it("fails when sessionLimitPercentage is NaN", async () => {
    const path = writeConfigFile(
      temporary,
      [
        "export default {",
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        `  orchestrator: { sessionLimitPercentage: Number.NaN },`,
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(
      /orchestrator\.sessionLimitPercentage must be a finite number in \(0, 100]/,
    );
  });

  it("fails when maximumInProgress is not a positive integer", async () => {
    const path = writeConfigFile(
      temporary,
      configSource({
        workspace: VALID_WORKSPACE(temporary),
        orchestrator: { maximumInProgress: 0 },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(
      /orchestrator\.maximumInProgress must be an integer ≥ 1/,
    );
  });

  it("fails when an override drops cmd to empty", async () => {
    const path = writeConfigFile(
      temporary,
      configSource({
        workspace: VALID_WORKSPACE(temporary),
        models: { definitions: { claude: { cmd: "" } } },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(/models\.definitions\.claude\.cmd/);
  });

  it("fails when a brand-new model omits color", async () => {
    const path = writeConfigFile(
      temporary,
      configSource({
        workspace: VALID_WORKSPACE(temporary),
        models: { definitions: { cursor: { cmd: "cursor" } } },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(/models\.definitions\.cursor\.color/);
  });

  it('fails when models.definitions contains the reserved "any" name', async () => {
    const path = writeConfigFile(
      temporary,
      configSource({
        workspace: VALID_WORKSPACE(temporary),
        models: { definitions: { any: { cmd: "any", color: "#000" } } },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(/models\.definitions cannot contain "any"/);
  });

  it("fails when models.default is unknown", async () => {
    const path = writeConfigFile(
      temporary,
      configSource({
        workspace: VALID_WORKSPACE(temporary),
        models: { default: "unknown" },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(
      /models\.default \("unknown"\) is not a key in models\.definitions/,
    );
  });

  it("discovers crew.config.ts via cosmiconfig project-walk from a nested cwd", async () => {
    const root = join(temporary, "root");
    const nested = join(root, "nested", "deep");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(root, "crew.config.ts"), configSource({ workspace: VALID_WORKSPACE(root) }));
    vi.spyOn(process, "cwd").mockReturnValue(nested);
    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();
    expect(actual.workspace.projectDir).toBe(root);
  });

  it("loads a JSON config via cosmiconfig", async () => {
    const root = join(temporary, "root");
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, "crew.config.json"),
      JSON.stringify({ workspace: VALID_WORKSPACE(root) }),
    );
    vi.spyOn(process, "cwd").mockReturnValue(root);
    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();
    expect(actual.workspace.projectDir).toBe(root);
  });

  it("accepts the legacy `export const config = {...}` shape for back-compat", async () => {
    const root = join(temporary, "root");
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, "crew.config.ts"),
      `export const config = ${JSON.stringify({ workspace: VALID_WORKSPACE(root) })};\n`,
    );
    vi.spyOn(process, "cwd").mockReturnValue(root);
    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();
    expect(actual.workspace.projectDir).toBe(root);
  });

  it("env-var override wins over both project-walk and XDG fallback", async () => {
    const projectRoot = join(temporary, "project");
    const decoyXdg = join(temporary, "xdg-config", "groundcrew");
    const targetDir = join(temporary, "target");
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(decoyXdg, { recursive: true });
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(
      join(projectRoot, "crew.config.ts"),
      configSource({ workspace: { projectDir: projectRoot, knownRepositories: ["xdg-decoy"] } }),
    );
    writeFileSync(
      join(decoyXdg, "crew.config.ts"),
      configSource({
        workspace: { projectDir: decoyXdg, knownRepositories: ["project-decoy"] },
      }),
    );
    const targetPath = join(targetDir, "crew.config.ts");
    writeFileSync(
      targetPath,
      configSource({ workspace: { projectDir: targetDir, knownRepositories: ["repo-a"] } }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", targetPath);
    vi.spyOn(process, "cwd").mockReturnValue(projectRoot);
    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();
    expect(actual.workspace.projectDir).toBe(targetDir);
  });

  it("fails when the default export is not an object (e.g. a primitive)", async () => {
    const path = writeConfigFile(temporary, "export default 42;\n");
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(/must export a config object/);
  });

  it("defaults sources to an empty array when the field is omitted", async () => {
    const path = writeConfigFile(
      temporary,
      configSource({ workspace: VALID_WORKSPACE(temporary) }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);
    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();
    expect(actual.sources).toStrictEqual([]);
  });

  it("preserves a valid sources array through resolution", async () => {
    const path = writeConfigFile(
      temporary,
      [
        "export default {",
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        `  sources: [{ kind: "shell", name: "jira" }],`,
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);
    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();
    expect(actual.sources).toStrictEqual([{ kind: "shell", name: "jira" }]);
  });

  it("rejects sources when it isn't an array", async () => {
    const path = writeConfigFile(
      temporary,
      [
        "export default {",
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        `  sources: 5,`,
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(/sources must be an array/);
  });

  it("rejects a source entry that isn't an object", async () => {
    const path = writeConfigFile(
      temporary,
      [
        "export default {",
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        `  sources: [42],`,
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(/sources\[0] must be an object/);
  });

  it("rejects a source entry missing a string kind field", async () => {
    const path = writeConfigFile(
      temporary,
      [
        "export default {",
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        `  sources: [{ name: "no-kind" }],`,
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(/sources\[0]\.kind/);
  });

  it("rejects duplicate source names", async () => {
    const path = writeConfigFile(
      temporary,
      [
        "export default {",
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        `  sources: [{ kind: "shell", name: "jira" }, { kind: "shell", name: "jira" }],`,
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(/duplicating sources\[0]/);
  });

  it("rejects a source entry where name is set but not a string", async () => {
    const path = writeConfigFile(
      temporary,
      [
        "export default {",
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        `  sources: [{ kind: "shell", name: 5 }],`,
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(/sources\[0]\.name/);
  });

  it("fails with a discovery error when no config exists anywhere", async () => {
    const { loadConfig } = await loadFreshConfig();
    await expect(loadConfig()).rejects.toThrow(/no crew config found/);
  });
});
