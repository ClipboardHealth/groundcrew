import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import type { SafehouseCmuxIntegration } from "@clipboard-health/clearance";

import type { AgentDefinition, ResolvedConfig } from "./config.ts";
import { composeAgentLaunch, openAgentWorkspace } from "./agentLaunch.ts";
import { shellSingleQuote } from "./launchCommand.ts";
import { readEnvironmentVariable } from "./util.ts";
import { deleteEnvironmentVariable, setEnvironmentVariable } from "../testHelpers/env.ts";
import { safehouseCmuxIntegrationFixture } from "../testHelpers/safehouseCmuxIntegration.ts";

const runCommandMock = vi.hoisted(() =>
  vi.fn<(command: string, arguments_: readonly string[]) => string>(),
);
const resolveSafehouseCmuxIntegrationMock = vi.hoisted(() =>
  vi.fn<() => SafehouseCmuxIntegration>(),
);
const safehouseCmuxIntegrationWarningLinesMock = vi.hoisted(() =>
  vi.fn<
    (input: { commandName: string; unreviewedEnvNames: readonly string[] }) => readonly string[]
  >(),
);
const writeErrorMock = vi.hoisted(() => vi.fn<(message: string) => void>());
const openWorkspaceMock = vi.hoisted(() =>
  vi.fn<typeof import("./workspaces.ts").workspaces.open>(),
);
const installCmuxAgentHooksMock = vi.hoisted(() =>
  vi.fn<(input: { agent: string; configDir: string }) => void>(),
);

vi.mock(import("./commandRunner.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    runCommand: runCommandMock,
  };
});
vi.mock(import("@clipboard-health/clearance"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    resolveSafehouseCmuxIntegration: resolveSafehouseCmuxIntegrationMock,
    safehouseCmuxIntegrationWarningLines: safehouseCmuxIntegrationWarningLinesMock,
  };
});
vi.mock(import("./util.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    writeError: writeErrorMock,
  };
});
vi.mock(import("./workspaces.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    workspaces: { ...actual.workspaces, open: openWorkspaceMock },
  };
});
// Never actually shell out to cmux from a unit test — installCmuxAgentHooks is
// exercised on its own in cmuxAgentHookInstall.test.ts. Here we only assert
// that composeAgentLaunch calls it with the right agent/configDir.
vi.mock(import("./cmuxAgentHookInstall.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    installCmuxAgentHooks: installCmuxAgentHooksMock,
  };
});

const ORIGINAL_CMUX_SOCKET_PATH = readEnvironmentVariable("CMUX_SOCKET_PATH");
const ORIGINAL_CODEX_HOME = readEnvironmentVariable("CODEX_HOME");

function restoreEnvironmentVariable(name: string, originalValue: string | undefined): void {
  if (originalValue === undefined) {
    deleteEnvironmentVariable(name);
    return;
  }
  setEnvironmentVariable(name, originalValue);
}

function assertDefined<T>(value: T | undefined, label = "value"): T {
  if (value === undefined) {
    throw new TypeError(`Expected ${label} to be defined`);
  }
  return value;
}

function definition(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    cmd: "claude --permission-mode auto",
    color: "#fff",
    ...overrides,
  };
}

describe(composeAgentLaunch, () => {
  let fakeHome: string;
  const stagedConfigDirs: string[] = [];

  function composeLaunch(
    overrides: Partial<Parameters<typeof composeAgentLaunch>[0]> = {},
  ): ReturnType<typeof composeAgentLaunch> {
    return composeAgentLaunch({
      runner: "safehouse",
      networkEgress: "allowlisted",
      task: "team-1",
      definition: definition(),
      promptFile: "/tmp/prompt-team-1/prompt.txt",
      worktreeDir: "/work/repo-a-team-1",
      workingDir: "/work/repo-a-team-1",
      workspaceKind: "cmux",
      readOnlyDirs: [],
      // Test-only seam so a codex-agent compose() never reads the real
      // ~/.codex — see composeAgentLaunch's homeDir input.
      homeDir: fakeHome,
      ...overrides,
    });
  }

  function compose(overrides: Partial<Parameters<typeof composeAgentLaunch>[0]> = {}): string {
    return composeLaunch(overrides).command;
  }

  beforeEach(() => {
    fakeHome = mkdtempSync(path.join(os.tmpdir(), "agent-launch-home-"));
    runCommandMock.mockReturnValue("/tmp/repo-a.git");
    resolveSafehouseCmuxIntegrationMock.mockReturnValue(
      safehouseCmuxIntegrationFixture({
        envPass: [
          "CMUX_SURFACE_ID",
          "CMUX_SOCKET_PATH",
          "CMUX_CLAUDE_WRAPPER_SHIM",
          "CMUX_CLAUDE_WRAPPER_SHIM_ROOT",
          "CMUX_CUSTOM_CLAUDE_PATH",
        ],
      }),
    );
    safehouseCmuxIntegrationWarningLinesMock.mockReturnValue([]);
    writeErrorMock.mockReset();
    installCmuxAgentHooksMock.mockImplementation((input) => {
      stagedConfigDirs.push(input.configDir);
    });
    deleteEnvironmentVariable("CMUX_SOCKET_PATH");
    deleteEnvironmentVariable("CODEX_HOME");
  });

  afterEach(() => {
    vi.resetAllMocks();
    restoreEnvironmentVariable("CMUX_SOCKET_PATH", ORIGINAL_CMUX_SOCKET_PATH);
    restoreEnvironmentVariable("CODEX_HOME", ORIGINAL_CODEX_HOME);
    rmSync(fakeHome, { recursive: true, force: true });
    for (const configDir of stagedConfigDirs) {
      rmSync(path.dirname(configDir), { recursive: true, force: true });
    }
    stagedConfigDirs.length = 0;
  });

  it("adds cmux Safehouse grants, env, and Claude real-binary prelude for cmux-hosted Claude", () => {
    const launchCommand = compose();

    expect(launchCommand).toContain("--add-dirs='/work/repo-a-team-1:/tmp/repo-a.git'");
    expect(resolveSafehouseCmuxIntegrationMock).toHaveBeenCalledTimes(1);
    expect(launchCommand).toContain(
      "--add-dirs-ro='/Applications/cmux.app:/Users/dev/.local/state/cmux'",
    );
    expect(launchCommand).toContain("CMUX_CLAUDE_WRAPPER_SHIM_ROOT");
    expect(launchCommand).toContain("CMUX_SOCKET_PATH");
    expect(launchCommand).toContain("CMUX_CUSTOM_CLAUDE_PATH");
    expect(launchCommand).toContain("export CMUX_CUSTOM_CLAUDE_PATH=/Users/dev/.local/bin/claude");
    expect(launchCommand).toContain("exec claude --permission-mode auto --settings ");
    expect(launchCommand).toContain('"$@"');
  });

  it("injects cmux activity-reporting hooks for a cmux-hosted Claude agent", () => {
    const launchCommand = compose();

    expect(launchCommand).toContain("--settings ");
    expect(launchCommand).toContain("set-progress");
    expect(launchCommand).toContain("running · claude");
    expect(launchCommand).toContain("SessionStart");
  });

  it("does not inject Claude activity hooks for a non-Claude cmux agent", () => {
    const launchCommand = compose({ definition: definition({ cmd: "codex", color: "#000" }) });

    expect(launchCommand).toContain('exec codex "$@"');
    expect(launchCommand).not.toContain("set-progress");
  });

  it("relocates + seeds CODEX_HOME under safehouse for a cmux-hosted codex agent and installs cmux hooks into it", () => {
    mkdirSync(path.join(fakeHome, ".codex"), { recursive: true });
    writeFileSync(path.join(fakeHome, ".codex", "auth.json"), '{"token":"x"}');
    writeFileSync(path.join(fakeHome, ".codex", "config.toml"), "model = 'gpt'\n");

    const launchCommand = compose({ definition: definition({ cmd: "codex", color: "#000" }) });

    expect(installCmuxAgentHooksMock).toHaveBeenCalledTimes(1);
    const call = assertDefined(
      installCmuxAgentHooksMock.mock.calls[0],
      "installCmuxAgentHooks call",
    );
    const [{ agent, configDir }] = call;
    expect(agent).toBe("codex");
    expect(path.basename(configDir)).toBe("codex-home");
    expect(readFileSync(path.join(configDir, "auth.json"), "utf8")).toBe('{"token":"x"}');
    expect(readFileSync(path.join(configDir, "config.toml"), "utf8")).toBe("model = 'gpt'\n");

    // CODEX_HOME reaches the sandboxed shell via a commandPrelude export. The
    // prelude itself is embedded inside the agent wrap's quoted `-c` argument
    // (unlike --add-dirs/rm -rf below, which are top-level shell tokens), so
    // its inner shellSingleQuote(configDir) is escaped again by the outer
    // quoting — assert the export appears with configDir shortly after it
    // rather than hand-computing the doubly-escaped literal.
    const exportIndex = launchCommand.indexOf("export CODEX_HOME=");
    expect(exportIndex).toBeGreaterThan(-1);
    const configDirIndexAfterExport = launchCommand.indexOf(configDir, exportIndex);
    expect(configDirIndexAfterExport).toBeGreaterThan(exportIndex);
    expect(configDirIndexAfterExport - exportIndex).toBeLessThan(30);
    // ...the staged dir is granted writable (--add-dirs), never merely
    // read-only (--add-dirs-ro) — codex writes session/state into it...
    expect(launchCommand).toContain(
      `--add-dirs='/work/repo-a-team-1:/tmp/repo-a.git:${configDir}'`,
    );
    expect(launchCommand).not.toContain(`--add-dirs-ro='${configDir}'`);
    // ...refreshed credentials are copied back by the host before the staged
    // directory is torn down alongside the shim dir.
    expect(launchCommand).toContain(
      `/bin/cp -P ${shellSingleQuote(path.join(configDir, "auth.json"))}`,
    );
    expect(launchCommand).toContain(
      `/usr/bin/cmp -s ${shellSingleQuote(realpathSync(path.join(fakeHome, ".codex", "auth.json")))} `,
    );
    expect(launchCommand).toContain(`rm -rf ${shellSingleQuote(path.dirname(configDir))}`);
  });

  it("seeds from the configured CODEX_HOME instead of the default ~/.codex", () => {
    const configuredCodexHome = mkdtempSync(path.join(os.tmpdir(), "agent-launch-codex-home-"));
    try {
      writeFileSync(path.join(configuredCodexHome, "auth.json"), '{"token":"custom"}');
      writeFileSync(path.join(configuredCodexHome, "config.toml"), "model = 'custom'\n");
      setEnvironmentVariable("CODEX_HOME", configuredCodexHome);

      compose({ definition: definition({ cmd: "codex", color: "#000" }) });

      const call = assertDefined(
        installCmuxAgentHooksMock.mock.calls[0],
        "installCmuxAgentHooks call",
      );
      const [{ configDir }] = call;
      expect(readFileSync(path.join(configDir, "auth.json"), "utf8")).toBe('{"token":"custom"}');
      expect(readFileSync(path.join(configDir, "config.toml"), "utf8")).toBe("model = 'custom'\n");
    } finally {
      rmSync(configuredCodexHome, { recursive: true, force: true });
    }
  });

  it("returns cleanup ownership for config staged before the workspace starts", () => {
    const result = composeLaunch({
      definition: definition({ cmd: "codex", color: "#000" }),
    });

    expect(result).toEqual(
      expect.objectContaining({ command: expect.any(String), cleanup: expect.any(Function) }),
    );
    const call = assertDefined(
      installCmuxAgentHooksMock.mock.calls[0],
      "installCmuxAgentHooks call",
    );
    const stagedParentDir = path.dirname(call[0].configDir);
    expect(existsSync(stagedParentDir)).toBe(true);

    result.cleanup();

    expect(existsSync(stagedParentDir)).toBe(false);
    expect(() => {
      result.cleanup();
    }).not.toThrow();
  });

  it("removes the staged parent when config seeding fails", () => {
    const sourceConfigDir = path.join(fakeHome, ".codex");
    mkdirSync(path.join(sourceConfigDir, "config.toml"), { recursive: true });
    deleteEnvironmentVariable("CODEX_HOME");
    const prefix = "groundcrew-safehouse-team-1-";
    const before = new Set(readdirSync(os.tmpdir()).filter((name) => name.startsWith(prefix)));

    expect(() =>
      compose({
        definition: definition({ cmd: "codex", color: "#000" }),
      }),
    ).toThrow(/config\.toml/);

    const leaked = readdirSync(os.tmpdir())
      .filter((name) => name.startsWith(prefix))
      .filter((name) => !before.has(name));
    try {
      expect(leaked).toStrictEqual([]);
    } finally {
      for (const name of leaked) {
        rmSync(path.join(os.tmpdir(), name), { recursive: true, force: true });
      }
    }
  });

  it("cleans staged config when launch command construction fails", () => {
    runCommandMock.mockImplementation(() => {
      throw new Error("git probe failed");
    });

    expect(() =>
      compose({
        definition: definition({ cmd: "codex", color: "#000" }),
      }),
    ).toThrow("git probe failed");

    const call = assertDefined(
      installCmuxAgentHooksMock.mock.calls.at(-1),
      "installCmuxAgentHooks call",
    );
    expect(existsSync(path.dirname(call[0].configDir))).toBe(false);
  });

  it("does not relocate CODEX_HOME or call installCmuxAgentHooks for a Claude agent", () => {
    const launchCommand = compose();

    expect(installCmuxAgentHooksMock).not.toHaveBeenCalled();
    expect(launchCommand).not.toContain("CODEX_HOME");
    expect(launchCommand).not.toContain("codex-home");
  });

  it("adds task source write paths only to the Safehouse agent wrap", () => {
    const launchCommand = compose({
      prepareWorktreeCommand: "npm ci",
      taskSourceWritePaths: ["/Users/dev/v", "/Users/dev/v/.tasks"],
    });

    const prepareWrapIndex = launchCommand.indexOf("safehouse-clearance' --add-dirs=");
    const prepareCommandIndex = launchCommand.indexOf("npm ci");
    const agentWrapIndex = launchCommand.indexOf('"$_safehouse_shim" -c');
    const prepareWrap = launchCommand.slice(prepareWrapIndex, prepareCommandIndex);
    const agentWrap = launchCommand.slice(prepareCommandIndex, agentWrapIndex + 200);

    expect(prepareWrap).toContain("--add-dirs='/work/repo-a-team-1:/tmp/repo-a.git'");
    expect(prepareWrap).not.toContain("/Users/dev/v");
    expect(agentWrap).toContain(
      "--add-dirs='/work/repo-a-team-1:/tmp/repo-a.git:/Users/dev/v:/Users/dev/v/.tasks'",
    );
  });

  it("warns when clearance reports unreviewed cmux Claude wrapper env names", () => {
    safehouseCmuxIntegrationWarningLinesMock.mockReturnValue([
      "groundcrew: clearance-owned warning one",
      "groundcrew: clearance-owned warning two",
    ]);
    resolveSafehouseCmuxIntegrationMock.mockReturnValue(
      safehouseCmuxIntegrationFixture({
        addDirsReadOnly: ["/Applications/cmux.app"],
        claudeCommandPrelude: "",
        envPass: ["CMUX_SOCKET_PATH"],
        unreviewedEnvNames: ["CMUX_NEW_REQUIRED_SETTING"],
      }),
    );

    compose();

    expect(safehouseCmuxIntegrationWarningLinesMock).toHaveBeenCalledWith({
      commandName: "groundcrew",
      unreviewedEnvNames: ["CMUX_NEW_REQUIRED_SETTING"],
    });
    expect(writeErrorMock.mock.calls.map((call) => call[0])).toStrictEqual([
      "groundcrew: clearance-owned warning one",
      "groundcrew: clearance-owned warning two",
    ]);
  });

  it("adds the runtime cmux socket directory when the launch environment provides it", () => {
    setEnvironmentVariable("CMUX_SOCKET_PATH", "/tmp/cmux-state/cmux.sock");

    const launchCommand = compose({
      definition: definition({ cmd: "codex", color: "#000" }),
    });

    expect(resolveSafehouseCmuxIntegrationMock).toHaveBeenCalledTimes(1);
    expect(launchCommand).toContain("CMUX_SOCKET_PATH");
    expect(launchCommand).not.toContain("export CMUX_CUSTOM_CLAUDE_PATH");
    expect(launchCommand).toContain('exec codex "$@"');
  });

  it("does not add cmux Safehouse integration for non-cmux workspace backends", () => {
    const launchCommand = compose({
      workspaceKind: "tmux",
      definition: definition({ cmd: "codex", color: "#000" }),
    });

    expect(launchCommand).not.toContain("--add-dirs-ro");
    expect(launchCommand).not.toContain("CMUX_SOCKET_PATH");
    expect(resolveSafehouseCmuxIntegrationMock).not.toHaveBeenCalled();
    // A non-cmux workspace has no sidebar to report status to, so codex must
    // not relocate CODEX_HOME or shell out to `cmux hooks` either.
    expect(installCmuxAgentHooksMock).not.toHaveBeenCalled();
    expect(launchCommand).not.toContain("CODEX_HOME");
  });

  it("grants existing readOnlyDirs read-only to the Safehouse agent wrap", () => {
    const existing = mkdtempSync(path.join(os.tmpdir(), "gc-ro-"));
    try {
      const launchCommand = compose({ workspaceKind: "tmux", readOnlyDirs: [existing] });

      expect(launchCommand).toContain(`--add-dirs-ro='${existing}'`);
    } finally {
      rmSync(existing, { recursive: true, force: true });
    }
  });

  it("drops nonexistent readOnlyDirs (Safehouse rejects absent --add-dirs-ro paths)", () => {
    const launchCommand = compose({
      workspaceKind: "tmux",
      readOnlyDirs: ["/no/such/dir/groundcrew-absent"],
    });

    expect(launchCommand).not.toContain("--add-dirs-ro");
  });

  it("omits --add-dirs-ro for non-safehouse runners", () => {
    const launchCommand = compose({ runner: "none", readOnlyDirs: [os.tmpdir()] });

    expect(launchCommand).not.toContain("--add-dirs-ro");
  });

  it("treats omitted readOnlyDirs as empty under safehouse", () => {
    const launchCommand = compose({ workspaceKind: "tmux", readOnlyDirs: undefined });

    expect(launchCommand).not.toContain("--add-dirs-ro");
  });

  it("forwards prepareWorktreeUnsandboxed into the launch command", () => {
    const launchCommand = compose({
      runner: "none",
      prepareWorktreeUnsandboxedCommand: "bin/setup",
    });

    expect(launchCommand).toContain("(bin/setup); prepare_status=$?");
  });
});

function configWithTitleFlag(enabled: boolean): ResolvedConfig {
  return { workspace: { useTaskTitleForPanelName: enabled } } as unknown as ResolvedConfig;
}

describe("openAgentWorkspace", () => {
  beforeEach(() => {
    openWorkspaceMock.mockReset();
    openWorkspaceMock.mockResolvedValue();
  });

  it("passes the ticket title as displayName when useTaskTitleForPanelName is enabled", async () => {
    await openAgentWorkspace({
      config: configWithTitleFlag(true),
      name: "team-1",
      displayName: "Fix the login bug",
      cwd: "/work/repo-a-team-1",
      command: "exec claude",
      agent: "claude",
      color: "#fff",
    });

    expect(openWorkspaceMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ name: "team-1", displayName: "Fix the login bug" }),
    );
  });

  it("omits displayName when the flag is off even if a title is supplied", async () => {
    await openAgentWorkspace({
      config: configWithTitleFlag(false),
      name: "team-1",
      displayName: "Fix the login bug",
      cwd: "/work/repo-a-team-1",
      command: "exec claude",
      agent: "claude",
      color: "#fff",
    });

    const spec = openWorkspaceMock.mock.calls[0]?.[1];
    expect(spec).toMatchObject({ name: "team-1" });
    expect(spec).not.toHaveProperty("displayName");
  });

  it("omits displayName when the flag is unset even if a title is supplied", async () => {
    await openAgentWorkspace({
      config: { workspace: {} } as unknown as ResolvedConfig,
      name: "team-1",
      displayName: "Fix the login bug",
      cwd: "/work/repo-a-team-1",
      command: "exec claude",
      agent: "claude",
      color: "#fff",
    });

    const spec = openWorkspaceMock.mock.calls[0]?.[1];
    expect(spec).toMatchObject({ name: "team-1" });
    expect(spec).not.toHaveProperty("displayName");
  });
});
