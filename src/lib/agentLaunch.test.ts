import type { AgentDefinition } from "./config.ts";
import { composeAgentLaunch } from "./agentLaunch.ts";
import { readEnvironmentVariable } from "./util.ts";
import { deleteEnvironmentVariable, setEnvironmentVariable } from "../testHelpers/env.ts";
import { safehouseCmuxIntegrationFixture } from "../testHelpers/safehouseCmuxIntegration.ts";

const runCommandMock = vi.hoisted(() =>
  vi.fn<(command: string, arguments_: readonly string[]) => string>(),
);
const resolveSafehouseCmuxIntegrationMock = vi.hoisted(() => vi.fn<() => unknown>());
const writeErrorMock = vi.hoisted(() => vi.fn<(message: string) => void>());

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
  };
});
vi.mock(import("./util.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    writeError: writeErrorMock,
  };
});

const ORIGINAL_CMUX_SOCKET_PATH = readEnvironmentVariable("CMUX_SOCKET_PATH");

function restoreCmuxSocketPath(): void {
  if (ORIGINAL_CMUX_SOCKET_PATH === undefined) {
    deleteEnvironmentVariable("CMUX_SOCKET_PATH");
    return;
  }
  setEnvironmentVariable("CMUX_SOCKET_PATH", ORIGINAL_CMUX_SOCKET_PATH);
}

function definition(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    cmd: "claude --permission-mode auto",
    color: "#fff",
    ...overrides,
  };
}

function compose(overrides: Partial<Parameters<typeof composeAgentLaunch>[0]> = {}): string {
  return composeAgentLaunch({
    runner: "safehouse",
    task: "team-1",
    definition: definition(),
    promptFile: "/tmp/prompt-team-1/prompt.txt",
    worktreeDir: "/work/repo-a-team-1",
    workingDir: "/work/repo-a-team-1",
    workspaceKind: "cmux",
    ...overrides,
  }).launchCommand;
}

describe(composeAgentLaunch, () => {
  beforeEach(() => {
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
    writeErrorMock.mockReset();
    deleteEnvironmentVariable("CMUX_SOCKET_PATH");
  });

  afterEach(() => {
    vi.resetAllMocks();
    restoreCmuxSocketPath();
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
    expect(launchCommand).toContain('exec claude --permission-mode auto "$@"');
  });

  it("warns when clearance reports unreviewed cmux Claude wrapper env names", () => {
    resolveSafehouseCmuxIntegrationMock.mockReturnValue(
      safehouseCmuxIntegrationFixture({
        addDirsReadOnly: ["/Applications/cmux.app"],
        claudeCommandPrelude: "",
        envPass: ["CMUX_SOCKET_PATH"],
        unreviewedEnvNames: ["CMUX_NEW_REQUIRED_SETTING"],
      }),
    );

    compose();

    expect(writeErrorMock).toHaveBeenCalledWith(
      "groundcrew: cmux Claude wrapper references unreviewed env vars: CMUX_NEW_REQUIRED_SETTING",
    );
    expect(writeErrorMock).toHaveBeenCalledWith(
      "groundcrew: update @clipboard-health/clearance after reviewing the cmux change.",
    );
  });

  it("fails clearly when clearance returns an invalid cmux Safehouse integration", () => {
    resolveSafehouseCmuxIntegrationMock.mockReturnValue(null);

    expect(() => compose()).toThrow(
      "@clipboard-health/clearance returned an invalid cmux Safehouse integration.",
    );
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
    const launchCommand = compose({ workspaceKind: "tmux" });

    expect(launchCommand).not.toContain("--add-dirs-ro");
    expect(launchCommand).not.toContain("CMUX_SOCKET_PATH");
    expect(resolveSafehouseCmuxIntegrationMock).not.toHaveBeenCalled();
  });
});
