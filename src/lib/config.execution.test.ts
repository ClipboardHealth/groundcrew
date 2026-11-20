import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  deleteEnvironmentVariable,
  setEnvironmentVariable,
  snapshotEnvironmentVariables,
} from "../testHelpers/env.ts";
import { DEFAULT_CLOUD_PROMPT_INITIAL } from "./cloudPrompt.ts";
import type { Config, ResolvedConfig } from "./config.ts";

interface ConfigModule {
  loadConfig: () => Promise<Readonly<ResolvedConfig>>;
  resolveAgentExecution: (
    config: Pick<ResolvedConfig, "agents" | "execution">,
    agent: string,
  ) => "local" | "cloud";
}

async function loadFreshConfig(): Promise<ConfigModule> {
  vi.resetModules();
  return await import("./config.ts");
}

describe("config execution and cloud prompt", () => {
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

  async function loadWith(config: Omit<Config, "workspace">): Promise<ConfigModule> {
    const source = `export default ${JSON.stringify(
      { workspace: { projectDir: temporary, knownRepositories: ["repo-a"] }, ...config },
      undefined,
      2,
    )};\n`;
    const configPath = path.join(
      temporary,
      `crew-${Math.random().toString(36).slice(2)}.config.ts`,
    );
    writeFileSync(configPath, source);
    setEnvironmentVariable("GROUNDCREW_CONFIG", configPath);
    return await loadFreshConfig();
  }

  const claudeOnly = { definitions: { claude: {} } };

  it("execution defaults to local with a cap of 10", async () => {
    const { loadConfig } = await loadWith({ agents: claudeOnly });

    expect((await loadConfig()).execution).toStrictEqual({
      default: "local",
      maximumInProgress: 10,
    });
  });

  it("execution.default and execution.maximumInProgress are read from the user config", async () => {
    const { loadConfig } = await loadWith({
      agents: claudeOnly,
      execution: { default: "cloud", maximumInProgress: 3 },
    });

    expect((await loadConfig()).execution).toStrictEqual({
      default: "cloud",
      maximumInProgress: 3,
    });
  });

  it("rejects execution.default other than local or cloud", async () => {
    const { loadConfig } = await loadWith({
      agents: claudeOnly,
      // @ts-expect-error -- deliberately invalid
      execution: { default: "remote" },
    });

    await expect(loadConfig()).rejects.toThrow(/execution\.default/);
  });

  it("rejects a non-object execution block", async () => {
    const { loadConfig } = await loadWith({
      agents: claudeOnly,
      // @ts-expect-error -- deliberately invalid
      execution: "cloud",
    });

    await expect(loadConfig()).rejects.toThrow(/execution must be an object/);
  });

  it("rejects a non-positive-integer execution.maximumInProgress", async () => {
    const { loadConfig } = await loadWith({
      agents: claudeOnly,
      execution: { maximumInProgress: 0 },
    });

    await expect(loadConfig()).rejects.toThrow(/execution\.maximumInProgress/);
  });

  it("agent execution overrides the default", async () => {
    const localOverride = await loadWith({
      agents: { definitions: { claude: { execution: "local" } } },
      execution: { default: "cloud" },
    });
    const localConfig = await localOverride.loadConfig();
    const cloudOverride = await loadWith({
      agents: { definitions: { claude: { execution: "cloud" } } },
      execution: { default: "local" },
    });
    const cloudConfig = await cloudOverride.loadConfig();

    expect(localOverride.resolveAgentExecution(localConfig, "claude")).toBe("local");
    expect(cloudOverride.resolveAgentExecution(cloudConfig, "claude")).toBe("cloud");
  });

  it("rejects an invalid agent execution value", async () => {
    const { loadConfig } = await loadWith({
      // @ts-expect-error -- deliberately invalid
      agents: { definitions: { claude: { execution: "remote" } } },
    });

    await expect(loadConfig()).rejects.toThrow(/agents\.definitions\.claude\.execution/);
  });

  it("explicit cloud on a non-Claude profile fails validation", async () => {
    const { loadConfig } = await loadWith({
      agents: { definitions: { codex: { execution: "cloud" } } },
    });

    await expect(loadConfig()).rejects.toThrow(/agents\.definitions\.codex\.execution.*Claude/);
  });

  it("cloud default skips non-Claude profiles", async () => {
    const { loadConfig, resolveAgentExecution } = await loadWith({
      agents: { definitions: { claude: {}, codex: {} } },
      execution: { default: "cloud" },
    });
    const config = await loadConfig();

    expect(resolveAgentExecution(config, "claude")).toBe("cloud");
    expect(resolveAgentExecution(config, "codex")).toBe("local");
  });

  it("recognises a Claude command behind a path", async () => {
    const { loadConfig, resolveAgentExecution } = await loadWith({
      agents: {
        default: "pathed",
        definitions: {
          pathed: { cmd: "/usr/local/bin/claude --flag", color: "#111111" },
          other: { cmd: "claudette", color: "#222222" },
        },
      },
      execution: { default: "cloud" },
    });
    const config = await loadConfig();

    expect(resolveAgentExecution(config, "pathed")).toBe("cloud");
    expect(resolveAgentExecution(config, "other")).toBe("local");
  });

  it("resolveAgentExecution falls back to the default for unknown names", async () => {
    const { loadConfig, resolveAgentExecution } = await loadWith({
      agents: claudeOnly,
      execution: { default: "cloud" },
    });

    expect(resolveAgentExecution(await loadConfig(), "any")).toBe("cloud");
  });

  it("prompts.cloudInitial defaults to DEFAULT_CLOUD_PROMPT_INITIAL", async () => {
    const { loadConfig } = await loadWith({ agents: claudeOnly });

    expect((await loadConfig()).prompts.cloudInitial).toBe(DEFAULT_CLOUD_PROMPT_INITIAL);
  });

  it("inline cloudInitial overrides it", async () => {
    const { loadConfig } = await loadWith({
      agents: claudeOnly,
      prompts: { cloudInitial: "Cloud {{task}}" },
    });

    expect((await loadConfig()).prompts.cloudInitial).toBe("Cloud {{task}}");
  });

  it("cloudPromptFile is read relative to the config dir", async () => {
    writeFileSync(path.join(temporary, "cloud.md"), "From file {{title}}");
    const { loadConfig } = await loadWith({
      agents: claudeOnly,
      prompts: { cloudPromptFile: "cloud.md" },
    });

    expect((await loadConfig()).prompts.cloudInitial).toBe("From file {{title}}");
  });

  it("cloudInitial and cloudPromptFile together fail", async () => {
    const { loadConfig } = await loadWith({
      agents: claudeOnly,
      prompts: { cloudInitial: "a", cloudPromptFile: "b.md" },
    });

    await expect(loadConfig()).rejects.toThrow(
      "prompts: set either `cloudInitial` or `cloudPromptFile`, not both",
    );
  });

  it("cloudInitial accepts {{branch}}", async () => {
    const { loadConfig } = await loadWith({
      agents: claudeOnly,
      prompts: { cloudInitial: "Push to {{branch}} for {{task}}" },
    });

    expect((await loadConfig()).prompts.cloudInitial).toBe("Push to {{branch}} for {{task}}");
  });

  it("cloudInitial rejects {{worktree}}", async () => {
    const { loadConfig } = await loadWith({
      agents: claudeOnly,
      prompts: { cloudInitial: "in {{worktree}}" },
    });

    await expect(loadConfig()).rejects.toThrow(
      /prompts\.cloudInitial contains unknown placeholder "\{\{worktree\}\}".*\{\{task\}\}, \{\{title\}\}, \{\{description\}\}, \{\{branch\}\}/,
    );
  });
});
