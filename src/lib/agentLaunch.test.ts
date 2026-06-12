import type { AgentDefinition } from "./config.ts";
import { composeAgentLaunch } from "./agentLaunch.ts";
import { readEnvironmentVariable } from "./util.ts";
import { xdgStatePath } from "./xdg.ts";
import { deleteEnvironmentVariable, setEnvironmentVariable } from "../testHelpers/env.ts";

const runCommandMock = vi.hoisted(() =>
  vi.fn<(command: string, arguments_: readonly string[]) => string>(),
);

vi.mock(import("./commandRunner.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    runCommand: runCommandMock,
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
    deleteEnvironmentVariable("CMUX_SOCKET_PATH");
  });

  afterEach(() => {
    vi.resetAllMocks();
    restoreCmuxSocketPath();
  });

  it("adds cmux Safehouse grants, env, and Claude real-binary prelude for cmux-hosted Claude", () => {
    const launchCommand = compose();

    expect(launchCommand).toContain("--add-dirs='/work/repo-a-team-1:/tmp/repo-a.git'");
    expect(launchCommand).toContain(
      `--add-dirs-ro='/Applications/cmux.app:${xdgStatePath("cmux")}'`,
    );
    expect(launchCommand).toContain("CMUX_CLAUDE_WRAPPER_SHIM_ROOT");
    expect(launchCommand).toContain("CMUX_SOCKET_PATH");
    expect(launchCommand).toContain("CMUX_CUSTOM_CLAUDE_PATH");
    expect(launchCommand).toContain("*/cmux-cli-shims/*|*/cmux-cli-shims)");
    expect(launchCommand).toContain(
      'export CMUX_CUSTOM_CLAUDE_PATH="$_groundcrew_cmux_real_claude"',
    );
    expect(launchCommand).toContain('exec claude --permission-mode auto "$@"');
  });

  it("adds the runtime cmux socket directory when the launch environment provides it", () => {
    setEnvironmentVariable("CMUX_SOCKET_PATH", "/tmp/cmux-state/cmux.sock");

    const launchCommand = compose({
      definition: definition({ cmd: "codex", color: "#000" }),
    });

    expect(launchCommand).toContain("/tmp/cmux-state");
    expect(launchCommand).toContain("CMUX_SOCKET_PATH");
    expect(launchCommand).not.toContain(
      'export CMUX_CUSTOM_CLAUDE_PATH="$_groundcrew_cmux_real_claude"',
    );
    expect(launchCommand).toContain('exec codex "$@"');
  });

  it("does not add cmux Safehouse integration for non-cmux workspace backends", () => {
    const launchCommand = compose({ workspaceKind: "tmux" });

    expect(launchCommand).not.toContain("--add-dirs-ro");
    expect(launchCommand).not.toContain("CMUX_SOCKET_PATH");
    expect(launchCommand).not.toContain("cmux-cli-shims");
  });
});
