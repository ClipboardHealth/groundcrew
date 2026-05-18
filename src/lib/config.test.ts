import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  deleteEnvironmentVariable,
  setEnvironmentVariable,
  snapshotEnvironmentVariables,
} from "../testHelpers/env.ts";
import type { Config, ResolvedConfig } from "./config.ts";

const PACKAGE_ROOT = resolve(import.meta.dirname, "..", "..");
const PACKAGE_CONFIG_PATH = join(PACKAGE_ROOT, "config.jsonc");

interface ConfigModule {
  loadConfig: () => Promise<Readonly<ResolvedConfig>>;
}

async function loadFreshConfig(): Promise<ConfigModule> {
  vi.resetModules();
  return await import("./config.ts");
}

const VALID_LINEAR = {
  projectSlug: "ai-strategy-5152195762f3",
} as const;

const VALID_WORKSPACE = (projectDir: string) => ({
  projectDir,
  knownRepositories: ["repo-a"],
});

function writeConfigFile(dir: string, body: string): string {
  const path = join(dir, `config-${Math.random().toString(36).slice(2)}.jsonc`);
  writeFileSync(path, body);
  return path;
}

function writeConfigJson(dir: string, config: Config): string {
  return writeConfigFile(dir, JSON.stringify(config, undefined, 2));
}

function readPackageConfig(): string | undefined {
  if (!existsSync(PACKAGE_CONFIG_PATH)) {
    return undefined;
  }
  return readFileSync(PACKAGE_CONFIG_PATH, "utf8");
}

function restorePackageConfig(original: string | undefined): void {
  if (original === undefined) {
    rmSync(PACKAGE_CONFIG_PATH, { force: true });
    return;
  }
  writeFileSync(PACKAGE_CONFIG_PATH, original);
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
    const path = writeConfigJson(temporary, {
      linear: { ...VALID_LINEAR },
      workspace: VALID_WORKSPACE(temporary),
    });
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();

    expect(actual.linear.projectSlug).toBe(VALID_LINEAR.projectSlug);
    expect(actual.linear.slugId).toBe("5152195762f3");
    expect(actual.linear.statuses).toStrictEqual({
      todo: "Todo",
      inProgress: "In Progress",
      done: "Done",
      terminal: ["Done"],
    });
    expect(actual.git).toStrictEqual({ remote: "origin", defaultBranch: "main" });
    expect(actual.orchestrator).toStrictEqual({
      maximumInProgress: 4,
      pollIntervalMilliseconds: 120_000,
      sessionLimitPercentage: 85,
    });
    expect(actual.models.default).toBe("claude");
    expect(Object.keys(actual.models.definitions).toSorted()).toStrictEqual(["claude", "codex"]);
    expect(actual.models.definitions["claude"]?.cmd).toBe(
      "claude --permission-mode bypassPermissions",
    );
    expect(actual.models.definitions["codex"]?.cmd).toBe(
      "codex --dangerously-bypass-approvals-and-sandbox",
    );
    expect(actual.prompts.initial).toContain("{{ticket}}");
    expect(actual.remote).toStrictEqual({
      provider: "sprite",
      runnerName: "crew-claude-1",
      owner: "ClipboardHealth",
      repoRoot: "/home/sprite/dev",
      worktreeRoot: "/home/sprite/groundcrew/worktrees",
      secretNames: ["NPM_TOKEN", "BUF_TOKEN"],
    });
  });

  it("parses JSONC with comments and trailing commas", async () => {
    const path = writeConfigFile(
      temporary,
      `{
        // Linear project slug (12-char hex suffix is what's matched)
        "linear": { "projectSlug": "ai-strategy-5152195762f3" },
        "workspace": {
          "projectDir": ${JSON.stringify(temporary)},
          "knownRepositories": [
            "repo-a", /* trailing comma intentional */
          ],
        },
      }`,
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();

    expect(actual.linear.slugId).toBe("5152195762f3");
    expect(actual.workspace.knownRepositories).toStrictEqual(["repo-a"]);
  });

  it("rejects malformed JSONC with a helpful error", async () => {
    const path = writeConfigFile(temporary, "{ invalid: not-json,");
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(/is not valid JSONC/);
  });

  it("rejects a legacy config.ts at the XDG location with a migration hint", async () => {
    const xdgConfigHome = join(temporary, "xdg-config");
    setEnvironmentVariable("XDG_CONFIG_HOME", xdgConfigHome);
    const legacyPath = join(xdgConfigHome, "groundcrew", "config.ts");
    mkdirSync(dirname(legacyPath), { recursive: true });
    writeFileSync(legacyPath, "export const config = {};");
    deleteEnvironmentVariable("GROUNDCREW_CONFIG");

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(
      /legacy TypeScript config.*migrateConfigToJsonc\.mts/s,
    );
  });

  it("accepts remote runner config overrides", async () => {
    const path = writeConfigJson(temporary, {
      linear: { ...VALID_LINEAR },
      workspace: VALID_WORKSPACE(temporary),
      remote: {
        provider: "sprite",
        runnerName: "crew-codex-1",
        owner: "ClipboardHealth",
        repoRoot: "/srv/repos",
        worktreeRoot: "/srv/worktrees",
        secretNames: ["NPM_TOKEN", "CUSTOM_BUILD_TOKEN"],
      },
    });
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();

    expect(actual.remote).toStrictEqual({
      provider: "sprite",
      runnerName: "crew-codex-1",
      owner: "ClipboardHealth",
      repoRoot: "/srv/repos",
      worktreeRoot: "/srv/worktrees",
      secretNames: ["NPM_TOKEN", "CUSTOM_BUILD_TOKEN"],
    });
  });

  it("rejects empty remote runner names", async () => {
    const path = writeConfigJson(temporary, {
      linear: { ...VALID_LINEAR },
      workspace: VALID_WORKSPACE(temporary),
      remote: { runnerName: "" },
    });
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(/remote\.runnerName/);
  });

  it("rejects unsupported remote provider names", async () => {
    const path = writeConfigFile(
      temporary,
      JSON.stringify({
        linear: VALID_LINEAR,
        workspace: VALID_WORKSPACE(temporary),
        remote: { provider: "other" },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(/remote\.provider/);
  });

  it("rejects invalid remote secret names", async () => {
    const path = writeConfigJson(temporary, {
      linear: { ...VALID_LINEAR },
      workspace: VALID_WORKSPACE(temporary),
      remote: { secretNames: ["bad-name"] },
    });
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(/remote\.secretNames\[0\]/);
  });

  it("rejects the legacy remote.sprite config shape", async () => {
    const path = writeConfigFile(
      temporary,
      JSON.stringify({
        linear: VALID_LINEAR,
        workspace: VALID_WORKSPACE(temporary),
        remote: { sprite: { runnerName: "crew-claude-1" } },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(/remote\.sprite is no longer supported/);
  });

  it("accepts custom terminal statuses and dedupes them with done", async () => {
    const path = writeConfigJson(temporary, {
      linear: {
        ...VALID_LINEAR,
        statuses: {
          done: "Shipped",
          terminal: ["Done", "Shipped", " Won't Do ", "Done"],
        },
      },
      workspace: VALID_WORKSPACE(temporary),
    });
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();

    expect(actual.linear.statuses.terminal).toStrictEqual(["Done", "Shipped", "Won't Do"]);
  });

  it("trims custom status names before using them", async () => {
    const path = writeConfigJson(temporary, {
      linear: {
        ...VALID_LINEAR,
        statuses: {
          todo: " Todo ",
          inProgress: " Started ",
          done: " Released ",
        },
      },
      workspace: VALID_WORKSPACE(temporary),
    });
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();

    expect(actual.linear.statuses).toStrictEqual({
      todo: "Todo",
      inProgress: "Started",
      done: "Released",
      terminal: ["Released"],
    });
  });

  it("fails when a terminal status is malformed", async () => {
    const path = writeConfigJson(temporary, {
      linear: {
        ...VALID_LINEAR,
        statuses: { terminal: ["Done", "  "] },
      },
      workspace: VALID_WORKSPACE(temporary),
    });
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(/linear\.statuses\.terminal\[1\]/);
  });

  it("fails when terminal statuses is not an array", async () => {
    const path = writeConfigFile(
      temporary,
      JSON.stringify({
        linear: { ...VALID_LINEAR, statuses: { terminal: "Done" } },
        workspace: VALID_WORKSPACE(temporary),
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(/linear\.statuses\.terminal must be an array/);
  });

  it("caches the resolved config across calls", async () => {
    const path = writeConfigJson(temporary, {
      linear: { ...VALID_LINEAR },
      workspace: VALID_WORKSPACE(temporary),
    });
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();
    const first = await loadConfig();
    const second = await loadConfig();

    expect(second).toBe(first);
  });

  it("merges per-key overrides into the default model definitions", async () => {
    const path = writeConfigJson(temporary, {
      linear: { ...VALID_LINEAR },
      workspace: VALID_WORKSPACE(temporary),
      models: {
        definitions: {
          claude: { cmd: "my-claude" },
          cursor: { cmd: "cursor-agent", color: "#929292" },
        },
      },
    });
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

  it("rejects legacy models.isolation config", async () => {
    const path = writeConfigFile(
      temporary,
      JSON.stringify({
        linear: VALID_LINEAR,
        workspace: VALID_WORKSPACE(temporary),
        models: { isolation: "docker" },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(/models\.isolation is no longer supported/);
  });

  it("rejects non-object model definitions", async () => {
    const path = writeConfigFile(
      temporary,
      JSON.stringify({
        linear: VALID_LINEAR,
        workspace: VALID_WORKSPACE(temporary),
        models: { definitions: [] },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(/models\.definitions/);
  });

  it("rejects non-object per-model definitions", async () => {
    const path = writeConfigFile(
      temporary,
      JSON.stringify({
        linear: VALID_LINEAR,
        workspace: VALID_WORKSPACE(temporary),
        models: { definitions: { claude: null } },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(/models\.definitions\.claude/);
  });

  it("rejects legacy per-model isolation config", async () => {
    const path = writeConfigFile(
      temporary,
      JSON.stringify({
        linear: VALID_LINEAR,
        workspace: VALID_WORKSPACE(temporary),
        models: { definitions: { claude: { isolation: "safehouse" } } },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(
      /models\.definitions\.claude\.isolation is no longer supported/,
    );
  });

  it("rejects legacy per-model sandbox config", async () => {
    const path = writeConfigFile(
      temporary,
      JSON.stringify({
        linear: VALID_LINEAR,
        workspace: VALID_WORKSPACE(temporary),
        models: { definitions: { claude: { sandbox: { agent: "claude" } } } },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(
      /models\.definitions\.claude\.sandbox is no longer supported/,
    );
  });

  it("rejects `disabled: false` on a model definition", async () => {
    const path = writeConfigFile(
      temporary,
      JSON.stringify({
        linear: VALID_LINEAR,
        workspace: VALID_WORKSPACE(temporary),
        models: { definitions: { codex: { disabled: false } } },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(
      /models\.definitions\.codex\.disabled must be exactly `true` when set/,
    );
  });

  it('rejects a non-boolean `disabled` value (e.g. the string "true")', async () => {
    const path = writeConfigFile(
      temporary,
      JSON.stringify({
        linear: VALID_LINEAR,
        workspace: VALID_WORKSPACE(temporary),
        models: { definitions: { codex: { disabled: "true" } } },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(
      /models\.definitions\.codex\.disabled must be exactly `true` when set/,
    );
  });

  it("rejects `disabled: true` combined with other fields (cmd / color / usage)", async () => {
    const path = writeConfigFile(
      temporary,
      JSON.stringify({
        linear: VALID_LINEAR,
        workspace: VALID_WORKSPACE(temporary),
        models: { definitions: { codex: { disabled: true, cmd: "override" } } },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(
      /models\.definitions\.codex: cannot combine `disabled: true` with other fields \(cmd\)/,
    );
  });

  it("drops a shipped default when `disabled: true` is set", async () => {
    const path = writeConfigFile(
      temporary,
      JSON.stringify({
        linear: VALID_LINEAR,
        workspace: VALID_WORKSPACE(temporary),
        models: { definitions: { codex: { disabled: true } } },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();

    expect(Object.keys(actual.models.definitions).toSorted()).toStrictEqual(["claude"]);
    expect(actual.models.definitions["codex"]).toBeUndefined();
    expect(actual.models.default).toBe("claude");
  });

  it("rejects `disabled: true` on a key that isn't a shipped default", async () => {
    const path = writeConfigFile(
      temporary,
      JSON.stringify({
        linear: VALID_LINEAR,
        workspace: VALID_WORKSPACE(temporary),
        // cspell:disable-next-line
        models: { definitions: { codexx: { disabled: true } } },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(
      // cspell:disable-next-line
      /models\.definitions\.codexx: `disabled: true` is only valid for shipped defaults \(claude, codex\)\. Remove the entry instead\./,
    );
  });

  it("rejects disabling the model used as `models.default`", async () => {
    const path = writeConfigFile(
      temporary,
      JSON.stringify({
        linear: VALID_LINEAR,
        workspace: VALID_WORKSPACE(temporary),
        models: { default: "codex", definitions: { codex: { disabled: true } } },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(
      /models\.default \("codex"\) is disabled\. Either re-enable it or set models\.default to an enabled model\./,
    );
  });

  it("defaults workspaceKind to auto when omitted", async () => {
    const path = writeConfigJson(temporary, {
      linear: { ...VALID_LINEAR },
      workspace: VALID_WORKSPACE(temporary),
    });
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();
    const resolved = await loadConfig();

    expect(resolved.workspaceKind).toBe("auto");
  });

  it("accepts a valid workspaceKind override", async () => {
    const path = writeConfigJson(temporary, {
      linear: { ...VALID_LINEAR },
      workspace: VALID_WORKSPACE(temporary),
      workspaceKind: "tmux",
    });
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();
    const resolved = await loadConfig();

    expect(resolved.workspaceKind).toBe("tmux");
  });

  it("rejects an unknown workspaceKind value", async () => {
    const path = writeConfigFile(
      temporary,
      JSON.stringify({
        linear: VALID_LINEAR,
        workspace: VALID_WORKSPACE(temporary),
        workspaceKind: "screen",
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(/workspaceKind/);
  });

  it("respects user-supplied prompts.initial", async () => {
    const path = writeConfigJson(temporary, {
      linear: { ...VALID_LINEAR },
      workspace: VALID_WORKSPACE(temporary),
      prompts: { initial: "custom prompt" },
    });
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();

    expect(actual.prompts.initial).toBe("custom prompt");
  });

  it("allows known placeholders in prompts.initial", async () => {
    const path = writeConfigJson(temporary, {
      linear: { ...VALID_LINEAR },
      workspace: VALID_WORKSPACE(temporary),
      prompts: {
        initial: "{{ticket}} {{worktree}} {{title}} {{description}}",
      },
    });
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();

    expect(actual.prompts.initial).toBe("{{ticket}} {{worktree}} {{title}} {{description}}");
  });

  it("fails when prompts.initial contains an unknown placeholder", async () => {
    const path = writeConfigJson(temporary, {
      linear: { ...VALID_LINEAR },
      workspace: VALID_WORKSPACE(temporary),
      prompts: { initial: "Start {{ticket}} for {{assignee}}" },
    });
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(/unknown placeholder "{{assignee}}"/);
  });

  it("expands a leading ~ in workspace.projectDir", async () => {
    setEnvironmentVariable("HOME", temporary);
    const path = writeConfigJson(temporary, {
      linear: { ...VALID_LINEAR },
      workspace: { ...VALID_WORKSPACE(temporary), projectDir: "~/projects" },
    });
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();

    expect(actual.workspace.projectDir).toBe(join(temporary, "projects"));
  });

  it("expands a bare ~ in workspace.projectDir", async () => {
    setEnvironmentVariable("HOME", temporary);
    const path = writeConfigJson(temporary, {
      linear: { ...VALID_LINEAR },
      workspace: { ...VALID_WORKSPACE(temporary), projectDir: "~" },
    });
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();

    expect(actual.workspace.projectDir).toBe(temporary);
  });

  it("leaves non-tilde projectDir paths alone", async () => {
    const path = writeConfigJson(temporary, {
      linear: { ...VALID_LINEAR },
      workspace: VALID_WORKSPACE(temporary),
    });
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();

    expect(actual.workspace.projectDir).toBe(temporary);
  });

  it("defaults logging.file to the XDG state path", async () => {
    setEnvironmentVariable("XDG_STATE_HOME", join(temporary, "state"));
    const path = writeConfigJson(temporary, {
      linear: { ...VALID_LINEAR },
      workspace: VALID_WORKSPACE(temporary),
    });
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();

    expect(actual.logging.file).toBe(join(temporary, "state", "groundcrew", "groundcrew.log"));
  });

  it("uses HOME when XDG_STATE_HOME is unset", async () => {
    deleteEnvironmentVariable("XDG_STATE_HOME");
    setEnvironmentVariable("HOME", temporary);
    const path = writeConfigJson(temporary, {
      linear: { ...VALID_LINEAR },
      workspace: VALID_WORKSPACE(temporary),
    });
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();

    expect(actual.logging.file).toBe(
      join(temporary, ".local", "state", "groundcrew", "groundcrew.log"),
    );
  });

  it("respects a user-supplied logging.file", async () => {
    const overridePath = join(temporary, "custom", "crew.log");
    const path = writeConfigJson(temporary, {
      linear: { ...VALID_LINEAR },
      workspace: VALID_WORKSPACE(temporary),
      logging: { file: overridePath },
    });
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();

    expect(actual.logging.file).toBe(overridePath);
  });

  it("expands a leading ~ in logging.file", async () => {
    setEnvironmentVariable("HOME", temporary);
    const path = writeConfigJson(temporary, {
      linear: { ...VALID_LINEAR },
      workspace: VALID_WORKSPACE(temporary),
      logging: { file: "~/logs/crew.log" },
    });
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();

    expect(actual.logging.file).toBe(join(temporary, "logs", "crew.log"));
  });

  it("rejects an empty logging.file", async () => {
    const path = writeConfigJson(temporary, {
      linear: { ...VALID_LINEAR },
      workspace: VALID_WORKSPACE(temporary),
      logging: { file: "   " },
    });
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(/logging\.file/);
  });

  it("falls back to the XDG config path when GROUNDCREW_CONFIG is unset", async () => {
    const xdgConfigHome = join(temporary, "xdg-config");
    setEnvironmentVariable("XDG_CONFIG_HOME", xdgConfigHome);
    const xdgConfigPath = join(xdgConfigHome, "groundcrew", "config.jsonc");
    mkdirSync(dirname(xdgConfigPath), { recursive: true });
    writeFileSync(
      xdgConfigPath,
      JSON.stringify({
        linear: VALID_LINEAR,
        workspace: VALID_WORKSPACE(temporary),
      }),
    );
    deleteEnvironmentVariable("GROUNDCREW_CONFIG");

    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();

    expect(actual.linear.slugId).toBe("5152195762f3");
  });

  it("fails when the config file does not exist", async () => {
    setEnvironmentVariable("GROUNDCREW_CONFIG", join(temporary, "nope.jsonc"));

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(/not found/);
  });

  it("fails when the JSONC root is not an object", async () => {
    const path = writeConfigFile(temporary, "[]");
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(/JSON object at the top level/);
  });

  it("fails when linear is not an object", async () => {
    const path = writeConfigFile(temporary, JSON.stringify({ linear: 5, workspace: {} }));
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(/linear must be an object/);
  });

  it("fails when projectSlug is empty", async () => {
    const path = writeConfigJson(temporary, {
      linear: { projectSlug: "" },
      workspace: VALID_WORKSPACE(temporary),
    });
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(/linear\.projectSlug must be a non-empty string/);
  });

  it("fails when projectSlug is missing the 12-char hex tail", async () => {
    const path = writeConfigJson(temporary, {
      linear: { projectSlug: "no-hex-here" },
      workspace: VALID_WORKSPACE(temporary),
    });
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(/12-character hex slugId/);
  });

  it("fails when workspace is not an object", async () => {
    const path = writeConfigFile(
      temporary,
      JSON.stringify({ linear: { projectSlug: "x-aaaaaaaaaaaa" } }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(/workspace/);
  });

  it("fails when knownRepositories is empty", async () => {
    const path = writeConfigJson(temporary, {
      linear: { ...VALID_LINEAR },
      workspace: { ...VALID_WORKSPACE(temporary), knownRepositories: [] },
    });
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(/knownRepositories/);
  });

  it("fails when sessionLimitPercentage is out of range", async () => {
    const path = writeConfigJson(temporary, {
      linear: { ...VALID_LINEAR },
      workspace: VALID_WORKSPACE(temporary),
      orchestrator: { sessionLimitPercentage: 0 },
    });
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(/sessionLimitPercentage/);
  });

  it("fails when sessionLimitPercentage is greater than 100", async () => {
    const path = writeConfigJson(temporary, {
      linear: { ...VALID_LINEAR },
      workspace: VALID_WORKSPACE(temporary),
      orchestrator: { sessionLimitPercentage: 101 },
    });
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(/sessionLimitPercentage/);
  });

  it("fails when maximumInProgress is not a positive integer", async () => {
    const path = writeConfigJson(temporary, {
      linear: { ...VALID_LINEAR },
      workspace: VALID_WORKSPACE(temporary),
      orchestrator: { maximumInProgress: 0 },
    });
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(/maximumInProgress/);
  });

  it("fails when an override drops cmd to empty", async () => {
    const path = writeConfigJson(temporary, {
      linear: { ...VALID_LINEAR },
      workspace: VALID_WORKSPACE(temporary),
      models: { definitions: { claude: { cmd: "" } } },
    });
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(/models\.definitions\.claude\.cmd/);
  });

  it("applies a user-supplied usage override (with and without source)", async () => {
    const path = writeConfigJson(temporary, {
      linear: { ...VALID_LINEAR },
      workspace: VALID_WORKSPACE(temporary),
      models: {
        definitions: {
          claude: { usage: { codexbar: { provider: "claude", source: "web" } } },
          cursor: {
            cmd: "cursor-agent",
            color: "#fff",
            usage: { codexbar: { provider: "cursor" } },
          },
        },
      },
    });
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();

    expect(actual.models.definitions["claude"]?.usage).toStrictEqual({
      codexbar: { provider: "claude", source: "web" },
    });
    expect(actual.models.definitions["cursor"]?.usage).toStrictEqual({
      codexbar: { provider: "cursor" },
    });
  });

  it("fails when a brand-new model omits cmd", async () => {
    const path = writeConfigJson(temporary, {
      linear: { ...VALID_LINEAR },
      workspace: VALID_WORKSPACE(temporary),
      models: {
        definitions: {
          cursor: { color: "#000", usage: { codexbar: { provider: "cursor" } } },
        },
      },
    });
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(/models\.definitions\.cursor\.cmd/);
  });

  it("fails when a brand-new model omits color", async () => {
    const path = writeConfigJson(temporary, {
      linear: { ...VALID_LINEAR },
      workspace: VALID_WORKSPACE(temporary),
      models: { definitions: { cursor: { cmd: "cursor-agent" } } },
    });
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(/models\.definitions\.cursor\.color/);
  });

  it('fails when models.definitions contains the reserved "any" name', async () => {
    const path = writeConfigJson(temporary, {
      linear: { ...VALID_LINEAR },
      workspace: VALID_WORKSPACE(temporary),
      models: { definitions: { any: { cmd: "any-cmd", color: "#fff" } } },
    });
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(/reserved for the agent-any label/);
  });

  it("fails when models.default is unknown", async () => {
    const path = writeConfigJson(temporary, {
      linear: { ...VALID_LINEAR },
      workspace: VALID_WORKSPACE(temporary),
      models: { default: "ghost" },
    });
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(/models\.default \("ghost"\) is not a key/);
  });

  it("fails when a custom usage block is malformed", async () => {
    const path = writeConfigJson(temporary, {
      linear: { ...VALID_LINEAR },
      workspace: VALID_WORKSPACE(temporary),
      models: {
        definitions: {
          cursor: {
            cmd: "cursor",
            color: "#000",
            usage: { codexbar: { provider: "" } },
          },
        },
      },
    });
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(/codexbar\.provider/);
  });

  it("falls back to the package config when GROUNDCREW_CONFIG is not set", async () => {
    // The package's config.jsonc is gitignored (per-developer), so CI doesn't
    // have one. Stage a temp config.jsonc at the package root for the test,
    // then restore whatever was there (or remove the file) afterwards.
    const original = readPackageConfig();
    writeFileSync(
      PACKAGE_CONFIG_PATH,
      JSON.stringify({
        linear: { projectSlug: "ai-strategy-5152195762f3" },
        workspace: { projectDir: temporary, knownRepositories: ["repo-a"] },
      }),
    );
    deleteEnvironmentVariable("GROUNDCREW_CONFIG");

    try {
      const { loadConfig } = await loadFreshConfig();
      const actual = await loadConfig();

      expect(actual.linear.slugId).toBe("5152195762f3");
    } finally {
      restorePackageConfig(original);
    }
  });

  it("fails when usage is not an object", async () => {
    const path = writeConfigFile(
      temporary,
      JSON.stringify({
        linear: VALID_LINEAR,
        workspace: VALID_WORKSPACE(temporary),
        models: { definitions: { cursor: { cmd: "cursor", color: "#fff", usage: 5 } } },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(/models\.definitions\.cursor\.usage/);
  });

  it("fails when codexbar is not an object", async () => {
    const path = writeConfigFile(
      temporary,
      JSON.stringify({
        linear: VALID_LINEAR,
        workspace: VALID_WORKSPACE(temporary),
        models: {
          definitions: {
            cursor: { cmd: "cursor", color: "#fff", usage: { codexbar: 5 } },
          },
        },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(/codexbar must be an object/);
  });
});
