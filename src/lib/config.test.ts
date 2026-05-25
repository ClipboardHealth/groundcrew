import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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

const VALID_PROJECT_SLUG = "ai-strategy-5152195762f3";

const VALID_LINEAR: Config["linear"] = { projects: [{ projectSlug: VALID_PROJECT_SLUG }] };

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
    // Point XDG away from the host's real ~/.config/groundcrew so the
    // fallback resolver doesn't accidentally pick up a developer's
    // actual config.ts during test runs.
    setEnvironmentVariable("XDG_CONFIG_HOME", join(temporary, "xdg-config"));
    setEnvironmentVariable("XDG_STATE_HOME", join(temporary, "xdg-state"));
    // Project-walk starts from cwd and traverses to the filesystem root,
    // so an unmocked cwd could discover a real `crew.config.ts` somewhere
    // up the tree. Pin cwd to the empty temp dir to scope discovery.
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
      configSource({
        linear: { ...VALID_LINEAR },
        workspace: VALID_WORKSPACE(temporary),
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();

    expect(actual.linear.projects).toHaveLength(1);
    expect(actual.linear.projects[0]?.projectSlug).toBe(VALID_PROJECT_SLUG);
    expect(actual.linear.projects[0]?.slugId).toBe("5152195762f3");
    expect(actual.linear.projects[0]?.statuses).toStrictEqual({
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
  });

  it("ships a model-agnostic unattended default prompt", async () => {
    const path = writeConfigFile(
      temporary,
      configSource({
        linear: { ...VALID_LINEAR },
        workspace: VALID_WORKSPACE(temporary),
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();

    expect(actual.prompts.initial).toContain("There is no human watching this session");
    expect(actual.prompts.initial).toMatch(/documented verification/i);
    expect(actual.prompts.initial).toMatch(/open a pull request/i);
    expect(actual.prompts.initial).toContain("tmux attach -t groundcrew:{{ticket}}");
    expect(actual.prompts.initial).not.toContain("draft");
    expect(actual.prompts.initial).not.toMatch(/terminal status/i);
    expect(actual.prompts.initial).not.toContain("Do not wait for review feedback");
    expect(actual.prompts.initial).not.toContain("superpowers");
    expect(actual.prompts.initial).not.toContain("babysit-pr");
    expect(actual.prompts.initial).not.toContain("CodeRabbit");
    expect(actual.prompts.initial).not.toContain("Generated with Claude Code");
    expect(actual.prompts.initial).not.toContain("Co-Authored-By: Claude");
  });

  it("accepts custom terminal statuses and dedupes them with done", async () => {
    const path = writeConfigFile(
      temporary,
      configSource({
        linear: {
          projects: [
            {
              projectSlug: VALID_PROJECT_SLUG,
              statuses: {
                done: "Shipped",
                terminal: ["Done", "Shipped", " Won't Do ", "Done"],
              },
            },
          ],
        },
        workspace: VALID_WORKSPACE(temporary),
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();

    expect(actual.linear.projects[0]?.statuses.terminal).toStrictEqual([
      "Done",
      "Shipped",
      "Won't Do",
    ]);
  });

  it("trims custom status names before using them", async () => {
    const path = writeConfigFile(
      temporary,
      configSource({
        linear: {
          projects: [
            {
              projectSlug: VALID_PROJECT_SLUG,
              statuses: {
                todo: " Todo ",
                inProgress: " Started ",
                done: " Released ",
              },
            },
          ],
        },
        workspace: VALID_WORKSPACE(temporary),
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();

    expect(actual.linear.projects[0]?.statuses).toStrictEqual({
      todo: "Todo",
      inProgress: "Started",
      done: "Released",
      terminal: ["Released"],
    });
  });

  it("fails when a terminal status is malformed", async () => {
    const path = writeConfigFile(
      temporary,
      configSource({
        linear: {
          projects: [
            {
              projectSlug: VALID_PROJECT_SLUG,
              statuses: {
                terminal: ["Done", "  "],
              },
            },
          ],
        },
        workspace: VALID_WORKSPACE(temporary),
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(/linear\.projects\[0\]\.statuses\.terminal\[1\]/);
  });

  it("fails when terminal statuses is not an array", async () => {
    const path = writeConfigFile(
      temporary,
      [
        "export default {",
        `  linear: { projects: [{ projectSlug: "${VALID_PROJECT_SLUG}", statuses: { terminal: 'Done' } }] },`,
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(
      /linear\.projects\[0\]\.statuses\.terminal must be an array/,
    );
  });

  it("caches the resolved config across calls", async () => {
    const path = writeConfigFile(
      temporary,
      configSource({
        linear: { ...VALID_LINEAR },
        workspace: VALID_WORKSPACE(temporary),
      }),
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
        linear: { ...VALID_LINEAR },
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

  it("falls back to the inherited usage block when the override sets `usage: undefined`", async () => {
    const path = writeConfigFile(
      temporary,
      configSource({
        linear: { ...VALID_LINEAR },
        workspace: VALID_WORKSPACE(temporary),
        models: {
          definitions: {
            claude: { cmd: "my-claude", usage: undefined },
          },
        },
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
        linear: { ...VALID_LINEAR },
        workspace: VALID_WORKSPACE(temporary),
        models: {
          definitions: {
            claude: { usage: { disabled: true } },
          },
        },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();

    const { claude } = actual.models.definitions;
    expect(claude).toBeDefined();
    expect(claude?.usage).toBeUndefined();
    // Other shipped fields stay intact.
    expect(claude?.cmd).toBe("claude --permission-mode bypassPermissions");
    // codex still gates by default — only claude was opted out.
    expect(actual.models.definitions["codex"]?.usage).toStrictEqual({
      codexbar: { provider: "codex" },
    });
  });

  it("treats `usage: { disabled: true }` on a brand-new model as no gating", async () => {
    const path = writeConfigFile(
      temporary,
      configSource({
        linear: { ...VALID_LINEAR },
        workspace: VALID_WORKSPACE(temporary),
        models: {
          definitions: {
            plain: { cmd: "plain", color: "#fff", usage: { disabled: true } },
          },
        },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();

    expect(actual.models.definitions["plain"]).toStrictEqual({
      cmd: "plain",
      color: "#fff",
    });
  });

  it("rejects legacy models.isolation config", async () => {
    const path = writeConfigFile(
      temporary,
      [
        "export default {",
        `  linear: ${JSON.stringify(VALID_LINEAR)},`,
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        "  models: { isolation: 'docker' },",
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(
      /models.isolation is no longer supported: set `local\.runner`/,
    );
  });

  it("rejects the legacy remote config block", async () => {
    const path = writeConfigFile(
      temporary,
      [
        "export default {",
        `  linear: ${JSON.stringify(VALID_LINEAR)},`,
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        "  remote: { provider: 'sprite' },",
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(
      /remote is no longer supported: groundcrew runs locally via safehouse\/sdx\/none/,
    );
  });

  it("rejects non-object model definitions", async () => {
    const path = writeConfigFile(
      temporary,
      [
        "export default {",
        `  linear: ${JSON.stringify(VALID_LINEAR)},`,
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        "  models: { definitions: [] },",
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(/models.definitions must be an object/);
  });

  it("rejects non-object per-model definitions", async () => {
    const path = writeConfigFile(
      temporary,
      [
        "export default {",
        `  linear: ${JSON.stringify(VALID_LINEAR)},`,
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        "  models: { definitions: { claude: null } },",
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(/models.definitions.claude must be an object/);
  });

  it("rejects legacy per-model isolation config", async () => {
    const path = writeConfigFile(
      temporary,
      [
        "export default {",
        `  linear: ${JSON.stringify(VALID_LINEAR)},`,
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        "  models: { definitions: { claude: { isolation: 'safehouse' } } },",
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(
      /models.definitions.claude.isolation is no longer supported: per-model isolation is no longer supported/,
    );
  });

  it("accepts a per-model sandbox config and surfaces it on the resolved definition", async () => {
    const path = writeConfigFile(
      temporary,
      [
        "export default {",
        `  linear: ${JSON.stringify(VALID_LINEAR)},`,
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        "  models: { definitions: { claude: { sandbox: { agent: 'claude', template: 'node-22', kits: ['npm-cache'], setupCommand: 'echo seed' } } } },",
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    const config = await loadConfig();
    expect(config.models.definitions["claude"]?.sandbox).toStrictEqual({
      agent: "claude",
      template: "node-22",
      kits: ["npm-cache"],
      setupCommand: "echo seed",
    });
  });

  it("accepts a per-model sandbox config with only the agent field", async () => {
    const path = writeConfigFile(
      temporary,
      [
        "export default {",
        `  linear: ${JSON.stringify(VALID_LINEAR)},`,
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        "  models: { definitions: { claude: { sandbox: { agent: 'claude' } } } },",
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    const config = await loadConfig();
    expect(config.models.definitions["claude"]?.sandbox).toStrictEqual({ agent: "claude" });
  });

  it("rejects a per-model sandbox config that omits agent", async () => {
    const path = writeConfigFile(
      temporary,
      [
        "export default {",
        `  linear: ${JSON.stringify(VALID_LINEAR)},`,
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        "  models: { definitions: { claude: { sandbox: {} } } },",
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(
      /models\.definitions\.claude\.sandbox\.agent must be a non-empty string/,
    );
  });

  it("rejects a per-model sandbox config with a whitespace-only agent", async () => {
    const path = writeConfigFile(
      temporary,
      [
        "export default {",
        `  linear: ${JSON.stringify(VALID_LINEAR)},`,
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        '  models: { definitions: { claude: { sandbox: { agent: "   " } } } },',
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(
      /models\.definitions\.claude\.sandbox\.agent must be a non-empty string/,
    );
  });

  it("trims surrounding whitespace from a per-model sandbox agent", async () => {
    const path = writeConfigFile(
      temporary,
      [
        "export default {",
        `  linear: ${JSON.stringify(VALID_LINEAR)},`,
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        '  models: { definitions: { claude: { sandbox: { agent: "  claude  " } } } },',
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    const config = await loadConfig();
    expect(config.models.definitions["claude"]?.sandbox).toStrictEqual({ agent: "claude" });
  });

  it("rejects a non-object local block", async () => {
    const path = writeConfigFile(
      temporary,
      [
        "export default {",
        `  linear: ${JSON.stringify(VALID_LINEAR)},`,
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        "  local: 'auto',",
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
        `  linear: ${JSON.stringify(VALID_LINEAR)},`,
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        "  models: { definitions: { claude: { sandbox: 'claude' } } },",
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(
      /models\.definitions\.claude\.sandbox must be an object/,
    );
  });

  it("defaults sandbox.gitDefaults to true when omitted", async () => {
    const path = writeConfigFile(
      temporary,
      configSource({
        linear: { ...VALID_LINEAR },
        workspace: VALID_WORKSPACE(temporary),
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();

    expect(actual.sandbox.gitDefaults).toBe(true);
  });

  it("threads an explicit sandbox.gitDefaults: false through to the resolved config", async () => {
    const path = writeConfigFile(
      temporary,
      [
        "export default {",
        `  linear: ${JSON.stringify(VALID_LINEAR)},`,
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        "  sandbox: { gitDefaults: false },",
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();

    expect(actual.sandbox.gitDefaults).toBe(false);
  });

  it("rejects a non-boolean sandbox.gitDefaults", async () => {
    const path = writeConfigFile(
      temporary,
      [
        "export default {",
        `  linear: ${JSON.stringify(VALID_LINEAR)},`,
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        "  sandbox: { gitDefaults: 'yes' },",
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(/sandbox\.gitDefaults must be a boolean/);
  });

  it("rejects an invalid local.runner value", async () => {
    const path = writeConfigFile(
      temporary,
      [
        "export default {",
        `  linear: ${JSON.stringify(VALID_LINEAR)},`,
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        "  local: { runner: 'bubblewrap' },",
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(
      /local\.runner must be one of auto, safehouse, sdx, none/,
    );
  });

  it("defaults local.runner to 'auto' when omitted", async () => {
    const path = writeConfigFile(
      temporary,
      [
        "export default {",
        `  linear: ${JSON.stringify(VALID_LINEAR)},`,
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    const config = await loadConfig();
    expect(config.local.runner).toBe("auto");
  });

  it("preserves an explicit local.runner value", async () => {
    const path = writeConfigFile(
      temporary,
      [
        "export default {",
        `  linear: ${JSON.stringify(VALID_LINEAR)},`,
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        "  local: { runner: 'sdx' },",
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    const config = await loadConfig();
    expect(config.local.runner).toBe("sdx");
  });

  it("rejects `disabled: false` on a model definition", async () => {
    const path = writeConfigFile(
      temporary,
      [
        "export default {",
        `  linear: ${JSON.stringify(VALID_LINEAR)},`,
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        "  models: { definitions: { codex: { disabled: false } } },",
        "};",
      ].join("\n"),
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
      [
        "export default {",
        `  linear: ${JSON.stringify(VALID_LINEAR)},`,
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        '  models: { definitions: { codex: { disabled: "true" } } },',
        "};",
      ].join("\n"),
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
      [
        "export default {",
        `  linear: ${JSON.stringify(VALID_LINEAR)},`,
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        "  models: { definitions: { codex: { disabled: true, cmd: 'override' } } },",
        "};",
      ].join("\n"),
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
      [
        "export default {",
        `  linear: ${JSON.stringify(VALID_LINEAR)},`,
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        "  models: { definitions: { codex: { disabled: true } } },",
        "};",
      ].join("\n"),
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
      [
        "export default {",
        `  linear: ${JSON.stringify(VALID_LINEAR)},`,
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        // cspell:disable-next-line
        "  models: { definitions: { codexx: { disabled: true } } },",
        "};",
      ].join("\n"),
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
      [
        "export default {",
        `  linear: ${JSON.stringify(VALID_LINEAR)},`,
        `  workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))},`,
        "  models: { default: 'codex', definitions: { codex: { disabled: true } } },",
        "};",
      ].join("\n"),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(
      /models\.default \("codex"\) is disabled\. Either re-enable it or set models\.default to an enabled model\./,
    );
  });

  it("defaults workspaceKind to auto when omitted", async () => {
    const path = writeConfigFile(
      temporary,
      configSource({
        linear: { ...VALID_LINEAR },
        workspace: VALID_WORKSPACE(temporary),
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();
    const resolved = await loadConfig();

    expect(resolved.workspaceKind).toBe("auto");
  });

  it("accepts a valid workspaceKind override", async () => {
    const path = writeConfigFile(
      temporary,
      configSource({
        linear: { ...VALID_LINEAR },
        workspace: VALID_WORKSPACE(temporary),
        workspaceKind: "tmux",
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();
    const resolved = await loadConfig();

    expect(resolved.workspaceKind).toBe("tmux");
  });

  it("rejects an unknown workspaceKind value", async () => {
    const path = writeConfigFile(
      temporary,
      configSource({
        linear: { ...VALID_LINEAR },
        workspace: VALID_WORKSPACE(temporary),
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- intentionally invalid value for the test
        workspaceKind: "screen" as never,
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(/workspaceKind must be one of/);
  });

  it("respects user-supplied prompts.initial", async () => {
    const path = writeConfigFile(
      temporary,
      configSource({
        linear: { ...VALID_LINEAR },
        workspace: VALID_WORKSPACE(temporary),
        prompts: { initial: "custom prompt" },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();

    expect(actual.prompts.initial).toBe("custom prompt");
  });

  it("allows known placeholders in prompts.initial", async () => {
    const path = writeConfigFile(
      temporary,
      configSource({
        linear: { ...VALID_LINEAR },
        workspace: VALID_WORKSPACE(temporary),
        prompts: {
          initial: "{{ticket}} {{worktree}} {{title}} {{description}}",
        },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();

    expect(actual.prompts.initial).toBe("{{ticket}} {{worktree}} {{title}} {{description}}");
  });

  it("fails when prompts.initial contains an unknown placeholder", async () => {
    const path = writeConfigFile(
      temporary,
      configSource({
        linear: { ...VALID_LINEAR },
        workspace: VALID_WORKSPACE(temporary),
        prompts: { initial: "Start {{ticket}} for {{assignee}}" },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(/unknown placeholder "{{assignee}}"/);
  });

  it("expands a leading ~ in workspace.projectDir", async () => {
    setEnvironmentVariable("HOME", temporary);
    const path = writeConfigFile(
      temporary,
      configSource({
        linear: { ...VALID_LINEAR },
        workspace: { ...VALID_WORKSPACE(temporary), projectDir: "~/projects" },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();

    expect(actual.workspace.projectDir).toBe(join(temporary, "projects"));
  });

  it("expands a bare ~ in workspace.projectDir", async () => {
    setEnvironmentVariable("HOME", temporary);
    const path = writeConfigFile(
      temporary,
      configSource({
        linear: { ...VALID_LINEAR },
        workspace: { ...VALID_WORKSPACE(temporary), projectDir: "~" },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();

    expect(actual.workspace.projectDir).toBe(temporary);
  });

  it("leaves non-tilde projectDir paths alone", async () => {
    const path = writeConfigFile(
      temporary,
      configSource({
        linear: { ...VALID_LINEAR },
        workspace: VALID_WORKSPACE(temporary),
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();

    expect(actual.workspace.projectDir).toBe(temporary);
  });

  it("defaults logging.file to the XDG state path", async () => {
    setEnvironmentVariable("XDG_STATE_HOME", join(temporary, "state"));
    const path = writeConfigFile(
      temporary,
      configSource({
        linear: { ...VALID_LINEAR },
        workspace: VALID_WORKSPACE(temporary),
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();

    expect(actual.logging.file).toBe(join(temporary, "state", "groundcrew", "groundcrew.log"));
  });

  it("uses HOME when XDG_STATE_HOME is unset", async () => {
    deleteEnvironmentVariable("XDG_STATE_HOME");
    setEnvironmentVariable("HOME", temporary);
    const path = writeConfigFile(
      temporary,
      configSource({
        linear: { ...VALID_LINEAR },
        workspace: VALID_WORKSPACE(temporary),
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();

    expect(actual.logging.file).toBe(
      join(temporary, ".local", "state", "groundcrew", "groundcrew.log"),
    );
  });

  it("respects a user-supplied logging.file", async () => {
    const overridePath = join(temporary, "custom", "crew.log");
    const path = writeConfigFile(
      temporary,
      configSource({
        linear: { ...VALID_LINEAR },
        workspace: VALID_WORKSPACE(temporary),
        logging: { file: overridePath },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();

    expect(actual.logging.file).toBe(overridePath);
  });

  it("expands a leading ~ in logging.file", async () => {
    setEnvironmentVariable("HOME", temporary);
    const path = writeConfigFile(
      temporary,
      configSource({
        linear: { ...VALID_LINEAR },
        workspace: VALID_WORKSPACE(temporary),
        logging: { file: "~/logs/crew.log" },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();

    expect(actual.logging.file).toBe(join(temporary, "logs", "crew.log"));
  });

  it("rejects an empty logging.file", async () => {
    const path = writeConfigFile(
      temporary,
      configSource({
        linear: { ...VALID_LINEAR },
        workspace: VALID_WORKSPACE(temporary),
        logging: { file: "   " },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(/logging.file/);
  });

  it("falls back to the XDG crew.config.ts when GROUNDCREW_CONFIG is unset", async () => {
    const xdgConfigHome = join(temporary, "xdg-config");
    setEnvironmentVariable("XDG_CONFIG_HOME", xdgConfigHome);
    const xdgConfigPath = join(xdgConfigHome, "groundcrew", "crew.config.ts");
    mkdirSync(dirname(xdgConfigPath), { recursive: true });
    writeFileSync(
      xdgConfigPath,
      configSource({
        linear: { ...VALID_LINEAR },
        workspace: VALID_WORKSPACE(temporary),
      }),
    );
    deleteEnvironmentVariable("GROUNDCREW_CONFIG");

    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();

    expect(actual.linear.projects[0]?.slugId).toBe("5152195762f3");
  });

  it("keeps reading legacy XDG ~/.config/groundcrew/config.ts during the back-compat window", async () => {
    const xdgConfigHome = join(temporary, "xdg-config");
    setEnvironmentVariable("XDG_CONFIG_HOME", xdgConfigHome);
    const xdgConfigPath = join(xdgConfigHome, "groundcrew", "config.ts");
    mkdirSync(dirname(xdgConfigPath), { recursive: true });
    writeFileSync(
      xdgConfigPath,
      configSource({
        linear: { ...VALID_LINEAR },
        workspace: VALID_WORKSPACE(temporary),
      }),
    );
    deleteEnvironmentVariable("GROUNDCREW_CONFIG");

    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();

    expect(actual.linear.projects[0]?.slugId).toBe("5152195762f3");
  });

  it("fails when the config file does not exist", async () => {
    setEnvironmentVariable("GROUNDCREW_CONFIG", join(temporary, "nope.ts"));

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(/not found/);
  });

  it("fails when the config file has no default or `config` export", async () => {
    const path = join(temporary, "no-export.ts");
    writeFileSync(path, "export const other = {};\n");
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(/must export a config object/);
  });

  it("fails when linear is not an object", async () => {
    const path = join(temporary, "bad.ts");
    writeFileSync(path, `export default { linear: 5, workspace: {} };\n`);
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(/linear must be an object/);
  });

  it("fails when projectSlug is empty", async () => {
    const path = writeConfigFile(
      temporary,
      configSource({
        linear: { projects: [{ projectSlug: "" }] },
        workspace: VALID_WORKSPACE(temporary),
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(
      /linear\.projects\[0\]\.projectSlug must be a non-empty string/,
    );
  });

  it("fails when projectSlug is missing the 12-char hex tail", async () => {
    const path = writeConfigFile(
      temporary,
      configSource({
        linear: { projects: [{ projectSlug: "no-hex-here" }] },
        workspace: VALID_WORKSPACE(temporary),
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(/12-character hex slugId/);
  });

  it("fails when workspace is not an object", async () => {
    const path = join(temporary, "bad-workspace.ts");
    writeFileSync(
      path,
      `export default { linear: { projects: [{ projectSlug: "x-aaaaaaaaaaaa" }] } };\n`,
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(/workspace must be an object/);
  });

  it("fails when knownRepositories is empty", async () => {
    const path = writeConfigFile(
      temporary,
      configSource({
        linear: { ...VALID_LINEAR },
        workspace: { ...VALID_WORKSPACE(temporary), knownRepositories: [] },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(/knownRepositories must be a non-empty array/);
  });

  it("fails when sessionLimitPercentage is out of range", async () => {
    const path = writeConfigFile(
      temporary,
      configSource({
        linear: { ...VALID_LINEAR },
        workspace: VALID_WORKSPACE(temporary),
        orchestrator: { sessionLimitPercentage: 0 },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(/sessionLimitPercentage must be a finite number in/);
  });

  it("fails when sessionLimitPercentage is greater than 100", async () => {
    const path = writeConfigFile(
      temporary,
      configSource({
        linear: { ...VALID_LINEAR },
        workspace: VALID_WORKSPACE(temporary),
        orchestrator: { sessionLimitPercentage: 101 },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(/sessionLimitPercentage must be a finite number in/);
  });

  // Regression: the previous inline check used `<= 0 || > 100`, both of
  // which return false for NaN. requirePercent now uses Number.isFinite to
  // close that gap.
  it("fails when sessionLimitPercentage is NaN", async () => {
    const path = writeConfigFile(
      temporary,
      `const config = ${JSON.stringify(
        {
          linear: { ...VALID_LINEAR },
          workspace: VALID_WORKSPACE(temporary),
        },
        undefined,
        2,
      )};
config.orchestrator = { sessionLimitPercentage: Number.NaN };
export default config;\n`,
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(/sessionLimitPercentage must be a finite number/);
  });

  it("fails when maximumInProgress is not a positive integer", async () => {
    const path = writeConfigFile(
      temporary,
      configSource({
        linear: { ...VALID_LINEAR },
        workspace: VALID_WORKSPACE(temporary),
        orchestrator: { maximumInProgress: 0 },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(/maximumInProgress must be an integer/);
  });

  it("fails when an override drops cmd to empty", async () => {
    const path = writeConfigFile(
      temporary,
      configSource({
        linear: { ...VALID_LINEAR },
        workspace: VALID_WORKSPACE(temporary),
        models: { definitions: { claude: { cmd: "" } } },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(/models.definitions.claude.cmd/);
  });

  it("fails when a brand-new model omits color", async () => {
    const path = writeConfigFile(
      temporary,
      configSource({
        linear: { ...VALID_LINEAR },
        workspace: VALID_WORKSPACE(temporary),
        models: { definitions: { cursor: { cmd: "cursor-agent" } } },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(/models.definitions.cursor.color/);
  });

  it('fails when models.definitions contains the reserved "any" name', async () => {
    const path = writeConfigFile(
      temporary,
      configSource({
        linear: { ...VALID_LINEAR },
        workspace: VALID_WORKSPACE(temporary),
        models: { definitions: { any: { cmd: "any-cmd", color: "#fff" } } },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(/reserved for the agent-any label/);
  });

  it("fails when models.default is unknown", async () => {
    const path = writeConfigFile(
      temporary,
      configSource({
        linear: { ...VALID_LINEAR },
        workspace: VALID_WORKSPACE(temporary),
        models: { default: "ghost" },
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(/models.default \("ghost"\) is not a key/);
  });

  it("fails when a custom usage block is malformed", async () => {
    const path = writeConfigFile(
      temporary,
      configSource({
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
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(/codexbar.provider/);
  });

  it("fails when usage is not an object", async () => {
    const path = join(temporary, "bad-usage.ts");
    writeFileSync(
      path,
      `export default {
  linear: { projects: [{ projectSlug: "ai-strategy-5152195762f3" }] },
  workspace: { projectDir: "${temporary}", knownRepositories: ["repo-a"] },
  models: { definitions: { cursor: { cmd: "cursor", color: "#fff", usage: 5 } } },
};
`,
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(/models.definitions.cursor.usage must be an object/);
  });

  it("fails when codexbar is not an object", async () => {
    const path = join(temporary, "bad-codexbar.ts");
    writeFileSync(
      path,
      `export default {
  linear: { projects: [{ projectSlug: "ai-strategy-5152195762f3" }] },
  workspace: { projectDir: "${temporary}", knownRepositories: ["repo-a"] },
  models: { definitions: { cursor: { cmd: "cursor", color: "#fff", usage: { codexbar: 5 } } } },
};
`,
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(/codexbar must be an object/);
  });

  it("discovers crew.config.ts via cosmiconfig project-walk from a nested cwd", async () => {
    // Stand up a fake project rooted at `temporary` with a deeper nested cwd.
    // cosmiconfig's "project" search strategy walks up until it finds a
    // package.json, so we plant one at the project root to scope the walk
    // and keep it from escaping into the real filesystem.
    writeFileSync(join(temporary, "package.json"), `{ "name": "fixture" }\n`);
    writeFileSync(
      join(temporary, "crew.config.ts"),
      configSource({
        linear: { ...VALID_LINEAR },
        workspace: VALID_WORKSPACE(temporary),
      }),
    );
    const nested = join(temporary, "src", "deep");
    mkdirSync(nested, { recursive: true });

    const originalCwd = process.cwd();
    vi.spyOn(process, "cwd").mockReturnValue(nested);
    deleteEnvironmentVariable("GROUNDCREW_CONFIG");

    try {
      const { loadConfig } = await loadFreshConfig();
      const actual = await loadConfig();

      expect(actual.linear.projects[0]?.slugId).toBe("5152195762f3");
    } finally {
      vi.spyOn(process, "cwd").mockReturnValue(originalCwd);
    }
  });

  it("loads a JSON config via cosmiconfig", async () => {
    const jsonPath = join(temporary, ".crewrc.json");
    writeFileSync(
      jsonPath,
      JSON.stringify({
        linear: { ...VALID_LINEAR },
        workspace: VALID_WORKSPACE(temporary),
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", jsonPath);

    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();

    expect(actual.linear.projects[0]?.slugId).toBe("5152195762f3");
  });

  it("accepts the legacy `export const config = {...}` shape for back-compat", async () => {
    const path = join(temporary, "legacy.ts");
    writeFileSync(
      path,
      `export const config = ${JSON.stringify({
        linear: { ...VALID_LINEAR },
        workspace: VALID_WORKSPACE(temporary),
      })};\n`,
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();

    expect(actual.linear.projects[0]?.slugId).toBe("5152195762f3");
  });

  it("env-var override wins over both project-walk and XDG fallback", async () => {
    // Plant decoys at every fallback location so the env override is the
    // only path that picks the right slug.
    const xdgConfigHome = join(temporary, "xdg-config");
    setEnvironmentVariable("XDG_CONFIG_HOME", xdgConfigHome);
    const xdgConfigPath = join(xdgConfigHome, "groundcrew", "crew.config.ts");
    mkdirSync(dirname(xdgConfigPath), { recursive: true });
    writeFileSync(
      xdgConfigPath,
      configSource({
        linear: { projects: [{ projectSlug: "xdg-decoy-aaaaaaaaaaaa" }] },
        workspace: VALID_WORKSPACE(temporary),
      }),
    );
    writeFileSync(join(temporary, "package.json"), `{ "name": "fixture" }\n`);
    writeFileSync(
      join(temporary, "crew.config.ts"),
      configSource({
        linear: { projects: [{ projectSlug: "project-decoy-bbbbbbbbbbbb" }] },
        workspace: VALID_WORKSPACE(temporary),
      }),
    );

    const overridePath = writeConfigFile(
      temporary,
      configSource({
        linear: { ...VALID_LINEAR },
        workspace: VALID_WORKSPACE(temporary),
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", overridePath);

    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();

    expect(actual.linear.projects[0]?.slugId).toBe("5152195762f3");
  });

  it("fails when the default export is not an object (e.g. a primitive)", async () => {
    const path = join(temporary, "primitive.ts");
    writeFileSync(path, "export default 5;\n");
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(/must export a config object/);
  });

  it("accepts multiple projects with divergent statuses", async () => {
    const path = writeConfigFile(
      temporary,
      configSource({
        linear: {
          projects: [
            { projectSlug: "alpha-aaaaaaaaaaaa" },
            {
              projectSlug: "beta-bbbbbbbbbbbb",
              statuses: { inProgress: "Doing", done: "Released", terminal: ["Released"] },
            },
          ],
        },
        workspace: VALID_WORKSPACE(temporary),
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();

    expect(actual.linear.projects).toHaveLength(2);
    expect(actual.linear.projects[0]?.slugId).toBe("aaaaaaaaaaaa");
    expect(actual.linear.projects[0]?.statuses).toStrictEqual({
      todo: "Todo",
      inProgress: "In Progress",
      done: "Done",
      terminal: ["Done"],
    });
    expect(actual.linear.projects[1]?.slugId).toBe("bbbbbbbbbbbb");
    expect(actual.linear.projects[1]?.statuses).toStrictEqual({
      todo: "Todo",
      inProgress: "Doing",
      done: "Released",
      terminal: ["Released"],
    });
  });

  it("rejects duplicate slugIds across projects", async () => {
    const path = writeConfigFile(
      temporary,
      configSource({
        linear: {
          projects: [
            { projectSlug: "alpha-1234567890ab" },
            { projectSlug: "another-1234567890ab" },
          ],
        },
        workspace: VALID_WORKSPACE(temporary),
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(
      /linear\.projects\[1\]\.projectSlug duplicates the slugId "1234567890ab"/,
    );
  });

  it("rejects projects that isn't an array", async () => {
    const path = join(temporary, "bad-projects.ts");
    writeFileSync(
      path,
      `export default { linear: { projects: 5 }, workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))} };\n`,
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(/linear\.projects must be a non-empty array/);
  });

  it("rejects a non-object entry inside linear.projects", async () => {
    const path = join(temporary, "non-object-project.ts");
    writeFileSync(
      path,
      `export default { linear: { projects: [42] }, workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))} };\n`,
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(/linear\.projects\[0\] must be an object/);
  });

  it("rejects a non-object statuses block inside a project entry", async () => {
    const path = join(temporary, "non-object-statuses.ts");
    writeFileSync(
      path,
      `export default { linear: { projects: [{ projectSlug: "${VALID_PROJECT_SLUG}", statuses: 5 }] }, workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))} };\n`,
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(/linear\.projects\[0\]\.statuses must be an object/);
  });

  it("rejects an empty projects array", async () => {
    const path = writeConfigFile(
      temporary,
      configSource({
        linear: { projects: [] },
        workspace: VALID_WORKSPACE(temporary),
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(/linear\.projects must be a non-empty array/);
  });

  it("rejects the legacy linear.projectSlug shape with a migration message", async () => {
    const path = join(temporary, "legacy-shape.ts");
    writeFileSync(
      path,
      `export default { linear: { projectSlug: "${VALID_PROJECT_SLUG}" }, workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))} };\n`,
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(
      /linear\.projectSlug \/ linear\.statuses are no longer supported/,
    );
    await expect(loadConfig()).rejects.toThrow(
      new RegExp(`projects: \\[\\{ projectSlug: "${VALID_PROJECT_SLUG}"`),
    );
  });

  it("rejects the legacy linear.statuses shape with a migration message", async () => {
    const path = join(temporary, "legacy-statuses.ts");
    writeFileSync(
      path,
      `export default { linear: { projects: [{ projectSlug: "${VALID_PROJECT_SLUG}" }], statuses: { todo: "Todo" } }, workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))} };\n`,
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(
      /linear\.projectSlug \/ linear\.statuses are no longer supported/,
    );
    // Migration hint should quote the actual slug from linear.projects[0],
    // not the placeholder, since the user already typed a real slug.
    await expect(loadConfig()).rejects.toThrow(
      new RegExp(`projects: \\[\\{ projectSlug: "${VALID_PROJECT_SLUG}"`),
    );
  });

  it("falls back to the placeholder slug when neither legacy projectSlug nor projects[0] resolves", async () => {
    const path = join(temporary, "statuses-only.ts");
    writeFileSync(
      path,
      `export default { linear: { statuses: { todo: "Todo" } }, workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))} };\n`,
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(/your-project-name-0123456789ab/);
  });

  it("defaults sources to an empty array when the field is omitted", async () => {
    const path = writeConfigFile(
      temporary,
      configSource({
        linear: { ...VALID_LINEAR },
        workspace: VALID_WORKSPACE(temporary),
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();

    expect(actual.sources).toStrictEqual([]);
  });

  it("preserves a valid sources array through resolution", async () => {
    const path = writeConfigFile(
      temporary,
      configSource({
        linear: { ...VALID_LINEAR },
        sources: [
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- minimal config for the structural-validation test
          {
            kind: "shell",
            name: "jira",
            commands: { fetch: "echo '[]'" },
          } as Config["sources"] extends (infer T)[] ? T : never,
        ],
        workspace: VALID_WORKSPACE(temporary),
      }),
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();
    const actual = await loadConfig();

    expect(actual.sources).toHaveLength(1);
    expect(actual.sources[0]?.kind).toBe("shell");
  });

  it("rejects sources when it isn't an array", async () => {
    const path = join(temporary, "bad-sources.ts");
    writeFileSync(
      path,
      `export default { linear: ${JSON.stringify(VALID_LINEAR)}, sources: "nope", workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))} };\n`,
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(/sources must be an array/);
  });

  it("rejects a source entry that isn't an object", async () => {
    const path = join(temporary, "bad-source-entry.ts");
    writeFileSync(
      path,
      `export default { linear: ${JSON.stringify(VALID_LINEAR)}, sources: ["not-an-object"], workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))} };\n`,
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(/sources\[0\] must be an object/);
  });

  it("rejects a source entry missing a string kind field", async () => {
    const path = join(temporary, "no-kind.ts");
    writeFileSync(
      path,
      `export default { linear: ${JSON.stringify(VALID_LINEAR)}, sources: [{ name: "x" }], workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))} };\n`,
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(/sources\[0\]\.kind/);
  });

  it("rejects duplicate source names", async () => {
    const path = join(temporary, "dup-names.ts");
    writeFileSync(
      path,
      `export default { linear: ${JSON.stringify(VALID_LINEAR)}, sources: [{ kind: "shell", name: "x", commands: { fetch: "echo []" } }, { kind: "shell", name: "x", commands: { fetch: "echo []" } }], workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))} };\n`,
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(/sources\[1\] would produce a source named "x"/);
  });

  it("rejects two unnamed sources of the same kind that would both default to the same name", async () => {
    // Two `{ kind: "linear" }` entries with no `name` field both default to
    // name="linear" at adapter-create time; without dedup on the effective
    // name, createBoard would catch this late. Config-load catches it now.
    const path = join(temporary, "dup-default-name.ts");
    writeFileSync(
      path,
      `export default { linear: ${JSON.stringify(VALID_LINEAR)}, sources: [{ kind: "linear" }, { kind: "linear" }], workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))} };\n`,
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(
      /sources\[1\] would produce a source named "linear".*default `kind`/,
    );
  });

  it("rejects a source entry where name is set but not a string", async () => {
    const path = join(temporary, "non-string-name.ts");
    writeFileSync(
      path,
      `export default { linear: ${JSON.stringify(VALID_LINEAR)}, sources: [{ kind: "shell", name: 123 }], workspace: ${JSON.stringify(VALID_WORKSPACE(temporary))} };\n`,
    );
    setEnvironmentVariable("GROUNDCREW_CONFIG", path);

    const { loadConfig } = await loadFreshConfig();

    await expect(loadConfig()).rejects.toThrow(/sources\[0\]\.name/);
  });

  it("fails with a discovery error when no config exists anywhere", async () => {
    // No env var, no project config (cwd is the empty temp dir), no XDG file.
    deleteEnvironmentVariable("GROUNDCREW_CONFIG");
    const originalCwd = process.cwd();
    vi.spyOn(process, "cwd").mockReturnValue(temporary);

    try {
      const { loadConfig } = await loadFreshConfig();

      await expect(loadConfig()).rejects.toThrow(/no crew config found/);
    } finally {
      vi.spyOn(process, "cwd").mockReturnValue(originalCwd);
    }
  });
});
