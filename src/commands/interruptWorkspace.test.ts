import { loadConfig, type ResolvedConfig } from "../lib/config.ts";
import { readRunState, recordRunState, type RunState } from "../lib/runState.ts";
import { workspaces } from "../lib/workspaces.ts";
import { type WorktreeEntry, worktrees } from "../lib/worktrees.ts";
import { captureConsoleLog, type ConsoleCapture } from "../testHelpers/consoleCapture.ts";
import { interruptWorkspace, interruptWorkspaceCli } from "./interruptWorkspace.ts";

vi.mock(import("../lib/config.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, loadConfig: vi.fn<typeof loadConfig>() };
});
vi.mock(import("../lib/runState.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    readRunState: vi.fn<typeof readRunState>(),
    recordRunState: vi.fn<typeof recordRunState>(),
  };
});
vi.mock(import("../lib/workspaces.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    workspaces: {
      ...actual.workspaces,
      interrupt: vi.fn<typeof actual.workspaces.interrupt>(),
    },
  };
});
vi.mock(import("../lib/worktrees.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    worktrees: {
      ...actual.worktrees,
      findByTicket: vi.fn<typeof actual.worktrees.findByTicket>(),
      teardown: vi.fn<typeof actual.worktrees.teardown>(),
    },
  };
});

const loadConfigMock = vi.mocked(loadConfig);
const readRunStateMock = vi.mocked(readRunState);
const recordRunStateMock = vi.mocked(recordRunState);
const interruptMock = vi.mocked(workspaces.interrupt);
const findByTicketMock = vi.mocked(worktrees.findByTicket);
const teardownMock = vi.mocked(worktrees.teardown);

type RecordedRunState = Parameters<typeof recordRunState>[0]["state"];

function lastRecordedRunState(): RecordedRunState {
  const input = recordRunStateMock.mock.calls.at(-1)?.[0];
  if (input === undefined) {
    throw new Error("recordRunState was not called");
  }
  return input.state;
}

function makeConfig(): ResolvedConfig {
  return {
    linear: {
      projects: [
        {
          projectSlug: "x-aaaaaaaaaaaa",
          slugId: "aaaaaaaaaaaa",
          statuses: { todo: "Todo", inProgress: "In Progress", done: "Done", terminal: ["Done"] },
        },
      ],
    },
    sources: [],
    git: { remote: "origin", defaultBranch: "main" },
    workspace: { projectDir: "/work", knownRepositories: ["repo-a"] },
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
    sandbox: { authRecipes: {}, gitDefaults: false },
    logging: { file: "/tmp/groundcrew-test.log" },
  };
}

function makeRunState(overrides: Partial<RunState> = {}): RunState {
  return {
    ticket: "team-1",
    repository: "repo-a",
    model: "claude",
    worktreeDir: "/work/repo-a-team-1",
    branchName: "rocky-team-1",
    workspaceName: "team-1",
    state: "running",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    resumeCount: 0,
    ...overrides,
  };
}

function makeWorktree(): WorktreeEntry {
  return {
    repository: "repo-a",
    ticket: "team-1",
    branchName: "rocky-team-1",
    dir: "/work/repo-a-team-1",
    kind: "host",
  };
}

describe(interruptWorkspace, () => {
  let consoleLog: ConsoleCapture;
  const config = makeConfig();

  beforeEach(() => {
    consoleLog = captureConsoleLog();
    readRunStateMock.mockReturnValue(makeRunState());
    findByTicketMock.mockReturnValue([makeWorktree()]);
    interruptMock.mockResolvedValue({ kind: "interrupted" });
  });

  afterEach(() => {
    consoleLog.restore();
    vi.resetAllMocks();
  });

  it("interrupts the recorded workspace and preserves the worktree", async () => {
    await interruptWorkspace(config, { ticket: "TEAM-1", reason: "wrong direction" });

    expect(interruptMock).toHaveBeenCalledWith(config, "team-1");
    expect(lastRecordedRunState()).toMatchObject({
      ticket: "team-1",
      state: "interrupted",
      reason: "wrong direction",
      worktreeDir: "/work/repo-a-team-1",
    });
    expect(teardownMock).not.toHaveBeenCalled();
    expect(consoleLog.output()).toContain("worktree preserved");
  });

  it("records an interrupted state from a worktree when state is missing", async () => {
    readRunStateMock.mockReset();

    await interruptWorkspace(config, { ticket: "team-1" });

    expect(lastRecordedRunState()).toMatchObject({
      model: "claude",
      repository: "repo-a",
      state: "interrupted",
    });
  });

  it("records workspace missing detail without failing", async () => {
    interruptMock.mockResolvedValue({ kind: "missing" });

    await interruptWorkspace(config, { ticket: "team-1" });

    expect(lastRecordedRunState()).toMatchObject({
      state: "interrupted",
      detail: "workspace missing",
    });
  });

  it("fails when there is no run state or worktree", async () => {
    readRunStateMock.mockReset();
    findByTicketMock.mockReturnValue([]);

    await expect(interruptWorkspace(config, { ticket: "team-1" })).rejects.toThrow(
      /nothing to interrupt/,
    );
  });

  it("fails when the workspace backend is unavailable", async () => {
    interruptMock.mockResolvedValue({ kind: "unavailable", error: new Error("cmux down") });

    await expect(interruptWorkspace(config, { ticket: "team-1" })).rejects.toThrow(/cmux down/);
    expect(recordRunStateMock).not.toHaveBeenCalled();
  });

  it("uses a generic error when the workspace backend is unavailable without details", async () => {
    interruptMock.mockResolvedValue({ kind: "unavailable" });

    await expect(interruptWorkspace(config, { ticket: "team-1" })).rejects.toThrow(
      /workspace adapter unavailable/,
    );
  });
});

describe(interruptWorkspaceCli, () => {
  const config = makeConfig();

  beforeEach(() => {
    loadConfigMock.mockResolvedValue(config);
    readRunStateMock.mockReturnValue(makeRunState());
    findByTicketMock.mockReturnValue([makeWorktree()]);
    interruptMock.mockResolvedValue({ kind: "interrupted" });
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it("parses ticket and reason", async () => {
    await interruptWorkspaceCli(["TEAM-1", "--reason", "wrong direction"]);

    expect(lastRecordedRunState()).toMatchObject({
      ticket: "team-1",
      reason: "wrong direction",
    });
  });

  it("parses a ticket without a reason", async () => {
    await interruptWorkspaceCli(["TEAM-1"]);

    expect(lastRecordedRunState()).toMatchObject({ ticket: "team-1", state: "interrupted" });
    expect(lastRecordedRunState().reason).toBeUndefined();
  });

  it("rejects missing ticket", async () => {
    await expect(interruptWorkspaceCli([])).rejects.toThrow(/Usage: crew interrupt/);
  });

  it("rejects missing reason text", async () => {
    await expect(interruptWorkspaceCli(["team-1", "--reason"])).rejects.toThrow(
      /reason text is required/,
    );
  });

  it("rejects unknown options", async () => {
    await expect(interruptWorkspaceCli(["--bogus", "team-1"])).rejects.toThrow(
      /Unknown option: --bogus/,
    );
  });
});
