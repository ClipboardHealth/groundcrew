import { loadConfig, type ResolvedConfig } from "../lib/config.ts";
import { readRunState, updateRunState, type RunState } from "../lib/runState.ts";
import { workspaces } from "../lib/workspaces.ts";
import { captureConsoleLog, type ConsoleCapture } from "../testHelpers/consoleCapture.ts";
import { interruptWorkspace } from "./interruptWorkspace.ts";
import { resumeWorkspace } from "./resumeWorkspace.ts";
import { setAgentWorkspace, setAgentWorkspaceCli } from "./setAgent.ts";

vi.mock(import("../lib/config.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, loadConfig: vi.fn<typeof loadConfig>() };
});
vi.mock(import("../lib/runState.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    readRunState: vi.fn<typeof readRunState>(),
    updateRunState: vi.fn<typeof updateRunState>(),
  };
});
vi.mock(import("../lib/workspaces.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    workspaces: {
      ...actual.workspaces,
      probe: vi.fn<typeof actual.workspaces.probe>(),
    },
  };
});
vi.mock(import("./interruptWorkspace.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, interruptWorkspace: vi.fn<typeof interruptWorkspace>() };
});
vi.mock(import("./resumeWorkspace.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, resumeWorkspace: vi.fn<typeof resumeWorkspace>() };
});

const loadConfigMock = vi.mocked(loadConfig);
const readRunStateMock = vi.mocked(readRunState);
const updateRunStateMock = vi.mocked(updateRunState);
const probeMock = vi.mocked(workspaces.probe);
const interruptMock = vi.mocked(interruptWorkspace);
const resumeMock = vi.mocked(resumeWorkspace);

function makeConfig(): ResolvedConfig {
  return {
    sources: [],
    defaults: { hooks: {} },
    git: { remote: "origin", defaultBranch: "main" },
    workspace: {
      projectDir: "/work",
      knownRepositories: ["repo-a"],
      repositories: [{ name: "repo-a" }],
    },
    orchestrator: {
      maximumInProgress: 4,
      pollIntervalMilliseconds: 1000,
      sessionLimitPercentage: 85,
    },
    agents: {
      default: "claude",
      definitions: {
        claude: { cmd: "claude", color: "#fff" },
        "claude-opus": { cmd: "claude --model claude-opus-4-8", color: "#abc" },
      },
    },
    prompts: { initial: "x" },
    workspaceKind: "auto",
    local: { runner: "auto", networkEgress: "allowlisted" },
    logging: { file: "/tmp/groundcrew-test.log" },
  };
}

function makeRunState(overrides: Partial<RunState> = {}): RunState {
  return {
    task: "team-1",
    repository: "repo-a",
    agent: "claude",
    worktreeDir: "/work/repo-a-team-1",
    branchName: "dev-team-1",
    workspaceName: "team-1",
    state: "running",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    resumeCount: 0,
    ...overrides,
  };
}

describe(setAgentWorkspace, () => {
  let consoleLog: ConsoleCapture;
  const config = makeConfig();

  beforeEach(() => {
    consoleLog = captureConsoleLog();
    readRunStateMock.mockReturnValue(makeRunState());
    probeMock.mockResolvedValue({ kind: "ok", names: new Set() });
    interruptMock.mockResolvedValue();
    resumeMock.mockResolvedValue();
  });

  afterEach(() => {
    consoleLog.restore();
    vi.resetAllMocks();
  });

  it("rejects an agent that is not defined in config", async () => {
    await expect(setAgentWorkspace(config, { task: "team-1", agent: "bogus" })).rejects.toThrow(
      /Unknown agent: bogus/,
    );
    expect(updateRunStateMock).not.toHaveBeenCalled();
  });

  it("rejects an inherited Object key that is not an own agent definition", async () => {
    await expect(setAgentWorkspace(config, { task: "team-1", agent: "toString" })).rejects.toThrow(
      /Unknown agent: toString/,
    );
    expect(updateRunStateMock).not.toHaveBeenCalled();
  });

  it("fails when no run state exists for the task", async () => {
    readRunStateMock.mockReset();

    await expect(
      setAgentWorkspace(config, { task: "team-1", agent: "claude-opus" }),
    ).rejects.toThrow(/No run state for team-1/);
  });

  it("is a no-op when the agent is unchanged", async () => {
    await setAgentWorkspace(config, { task: "TEAM-1", agent: "claude" });

    expect(updateRunStateMock).not.toHaveBeenCalled();
    expect(probeMock).not.toHaveBeenCalled();
    expect(consoleLog.output()).toContain("already claude");
  });

  it("persists the new agent without restarting when the workspace is not live", async () => {
    await setAgentWorkspace(config, { task: "team-1", agent: "claude-opus" });

    expect(updateRunStateMock).toHaveBeenCalledWith({
      config,
      task: "team-1",
      patch: { state: "running", agent: "claude-opus" },
    });
    expect(interruptMock).not.toHaveBeenCalled();
    expect(resumeMock).not.toHaveBeenCalled();
    expect(consoleLog.output()).toContain("takes effect on next 'crew resume --new team-1'");
  });

  it("stops then resumes with the new agent when the workspace is live", async () => {
    probeMock.mockResolvedValue({ kind: "ok", names: new Set(["team-1"]) });

    await setAgentWorkspace(config, { task: "team-1", agent: "claude-opus" });

    expect(updateRunStateMock).toHaveBeenCalledWith({
      config,
      task: "team-1",
      patch: { state: "running", agent: "claude-opus" },
    });
    expect(interruptMock).toHaveBeenCalledWith(config, { task: "team-1" });
    expect(resumeMock).toHaveBeenCalledWith(config, { task: "team-1", fresh: true });
    expect(consoleLog.output()).toContain("Switched team-1 to claude-opus and resumed");
  });

  it("persists the new agent before interrupting so the restart uses it", async () => {
    probeMock.mockResolvedValue({ kind: "ok", names: new Set(["team-1"]) });
    const sequence: string[] = [];
    updateRunStateMock.mockImplementation(() => {
      sequence.push("persist");
      return makeRunState({ agent: "claude-opus" });
    });
    interruptMock.mockImplementation(async () => {
      sequence.push("interrupt");
    });
    resumeMock.mockImplementation(async () => {
      sequence.push("resume");
    });

    await setAgentWorkspace(config, { task: "team-1", agent: "claude-opus" });

    expect(sequence).toStrictEqual(["persist", "interrupt", "resume"]);
  });

  it("preserves the existing lifecycle state when switching a stopped task's agent", async () => {
    readRunStateMock.mockReturnValue(makeRunState({ state: "interrupted" }));

    await setAgentWorkspace(config, { task: "team-1", agent: "claude-opus" });

    expect(updateRunStateMock).toHaveBeenCalledWith({
      config,
      task: "team-1",
      patch: { state: "interrupted", agent: "claude-opus" },
    });
  });

  it("fails when the workspace backend cannot be probed", async () => {
    probeMock.mockResolvedValue({ kind: "unavailable", error: new Error("cmux down") });

    await expect(
      setAgentWorkspace(config, { task: "team-1", agent: "claude-opus" }),
    ).rejects.toThrow(/cmux down/);
    expect(updateRunStateMock).not.toHaveBeenCalled();
  });

  it("fails with a generic message when the probe is unavailable without detail", async () => {
    probeMock.mockResolvedValue({ kind: "unavailable" });

    await expect(
      setAgentWorkspace(config, { task: "team-1", agent: "claude-opus" }),
    ).rejects.toThrow(/Could not verify whether workspace for team-1 is live/);
  });
});

describe(setAgentWorkspaceCli, () => {
  const config = makeConfig();

  beforeEach(() => {
    loadConfigMock.mockResolvedValue(config);
    readRunStateMock.mockReturnValue(makeRunState());
    probeMock.mockResolvedValue({ kind: "ok", names: new Set() });
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it("parses task and agent positionals", async () => {
    await setAgentWorkspaceCli(["TEAM-1", "claude-opus"]);

    expect(updateRunStateMock).toHaveBeenCalledWith({
      config,
      task: "team-1",
      patch: { state: "running", agent: "claude-opus" },
    });
  });

  it("rejects when the task is missing", async () => {
    await expect(setAgentWorkspaceCli([])).rejects.toThrow(/Usage: crew set-agent/);
  });

  it("rejects when the agent is missing", async () => {
    await expect(setAgentWorkspaceCli(["team-1"])).rejects.toThrow(/Usage: crew set-agent/);
  });

  it("rejects extra positionals", async () => {
    await expect(setAgentWorkspaceCli(["team-1", "claude-opus", "extra"])).rejects.toThrow(
      /Usage: crew set-agent/,
    );
  });

  it("rejects unknown options", async () => {
    await expect(setAgentWorkspaceCli(["--bogus", "team-1", "claude-opus"])).rejects.toThrow(
      /Unknown option: --bogus/,
    );
  });
});
