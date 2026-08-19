import { loadConfig, type ResolvedConfig } from "../lib/config.ts";
import { readRunState, recordRunState, type RunState } from "../lib/runState.ts";
import { workspaces } from "../lib/workspaces.ts";
import { type WorktreeEntry, worktrees } from "../lib/worktrees.ts";
import { captureConsoleLog, type ConsoleCapture } from "../testHelpers/consoleCapture.ts";
import { interruptWorkspace, interruptWorkspaceCli } from "./interruptWorkspace.ts";
import { acquireLifecycleLock } from "./lifecycleCommand.ts";

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
      probe: vi.fn<typeof actual.workspaces.probe>(),
    },
  };
});
vi.mock(import("../lib/worktrees.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    worktrees: {
      ...actual.worktrees,
      findByTask: vi.fn<typeof actual.worktrees.findByTask>(),
      teardown: vi.fn<typeof actual.worktrees.teardown>(),
    },
  };
});

const loadConfigMock = vi.mocked(loadConfig);
const readRunStateMock = vi.mocked(readRunState);
const recordRunStateMock = vi.mocked(recordRunState);
const interruptMock = vi.mocked(workspaces.interrupt);
const probeMock = vi.mocked(workspaces.probe);
const findByTaskMock = vi.mocked(worktrees.findByTask);
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
      definitions: { claude: { cmd: "claude", color: "#fff" } },
    },
    prompts: { initial: "x" },
    workspaceKind: "auto",
    local: {
      runner: "auto",
      networkEgress: "allowlisted",
      safehouse: { enable: [] },
      readOnlyDirs: [],
    },
    logging: { file: "/tmp/groundcrew-interrupt-workspace-test.log" },
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

function makeWorktree(): WorktreeEntry {
  return {
    repository: "repo-a",
    task: "team-1",
    branchName: "dev-team-1",
    dir: "/work/repo-a-team-1",
    kind: "host",
  };
}

function requireAcquiredLock(
  lock: ReturnType<typeof acquireLifecycleLock>,
): Extract<ReturnType<typeof acquireLifecycleLock>, { kind: "acquired" }> {
  if (lock.kind !== "acquired") {
    throw new Error("test could not acquire lifecycle lock");
  }
  return lock;
}

describe(interruptWorkspace, () => {
  let consoleLog: ConsoleCapture;
  const config = makeConfig();

  beforeEach(() => {
    consoleLog = captureConsoleLog();
    readRunStateMock.mockReturnValue(makeRunState());
    findByTaskMock.mockReturnValue([makeWorktree()]);
    interruptMock.mockResolvedValue({ kind: "interrupted" });
    probeMock.mockResolvedValue({ kind: "ok", names: new Set() });
  });

  afterEach(() => {
    consoleLog.restore();
    vi.resetAllMocks();
  });

  it("interrupts the recorded workspace and preserves the worktree", async () => {
    const actual = await interruptWorkspace(config, {
      task: "TEAM-1",
      reason: "wrong direction",
    });

    expect(interruptMock).toHaveBeenCalledWith(config, "team-1");
    expect(lastRecordedRunState()).toMatchObject({
      task: "team-1",
      state: "interrupted",
      reason: "wrong direction",
      worktreeDir: "/work/repo-a-team-1",
    });
    expect(teardownMock).not.toHaveBeenCalled();
    expect(actual).toMatchObject({ outcome: "stopped", state: "interrupted" });
    expect(consoleLog.output()).toBe("");
  });

  it("records an interrupted state from a worktree when state is missing", async () => {
    readRunStateMock.mockReset();

    await interruptWorkspace(config, { task: "team-1" });

    expect(lastRecordedRunState()).toMatchObject({
      agent: "claude",
      repository: "repo-a",
      state: "interrupted",
    });
  });

  it("records workspace missing detail without failing", async () => {
    interruptMock.mockResolvedValue({ kind: "missing" });

    const actual = await interruptWorkspace(config, { task: "team-1" });

    expect(lastRecordedRunState()).toMatchObject({
      state: "interrupted",
      detail: "workspace missing",
    });
    expect(actual.outcome).toBe("workspace-missing");
  });

  it("returns already-stopped when persisted state and workspace absence agree", async () => {
    readRunStateMock.mockReturnValue(makeRunState({ state: "interrupted" }));
    interruptMock.mockResolvedValue({ kind: "missing" });

    const actual = await interruptWorkspace(config, { task: "team-1" });

    expect(actual).toMatchObject({ outcome: "already-stopped", state: "interrupted" });
  });

  it("closes the live workspace when there is no run state or worktree", async () => {
    readRunStateMock.mockReset();
    findByTaskMock.mockReturnValue([]);

    const actual = await interruptWorkspace(config, { task: "orphan-1" });

    expect(interruptMock).toHaveBeenCalledWith(config, "orphan-1");
    expect(recordRunStateMock).not.toHaveBeenCalled();
    expect(actual).toMatchObject({ outcome: "stopped", state: "absent" });
    expect(consoleLog.output()).toBe("");
  });

  it("returns not-found when there is no local context or live workspace", async () => {
    readRunStateMock.mockReset();
    findByTaskMock.mockReturnValue([]);
    interruptMock.mockResolvedValue({ kind: "missing" });

    await expect(interruptWorkspace(config, { task: "team-1" })).resolves.toMatchObject({
      outcome: "not-found",
      state: "absent",
    });
    expect(recordRunStateMock).not.toHaveBeenCalled();
  });

  it("returns conflict when the workspace backend is unavailable", async () => {
    interruptMock.mockResolvedValue({ kind: "unavailable", error: new Error("cmux down") });

    await expect(interruptWorkspace(config, { task: "team-1" })).resolves.toMatchObject({
      outcome: "conflict",
      problems: [
        { code: "workspace-status-unavailable", message: expect.stringContaining("cmux down") },
      ],
    });
    expect(recordRunStateMock).not.toHaveBeenCalled();
  });

  it("uses a generic problem when the workspace backend is unavailable without details", async () => {
    interruptMock.mockResolvedValue({ kind: "unavailable" });

    await expect(interruptWorkspace(config, { task: "team-1" })).resolves.toMatchObject({
      outcome: "conflict",
      problems: [{ message: expect.stringContaining("workspace adapter unavailable") }],
    });
  });

  it("returns partial when the workspace stops but durable state cannot be recorded", async () => {
    recordRunStateMock.mockImplementation(() => {
      throw new Error("disk full");
    });

    await expect(interruptWorkspace(config, { task: "team-1" })).resolves.toMatchObject({
      outcome: "partial",
      state: "interrupted",
      problems: [{ code: "state-write-failed", message: expect.stringContaining("disk full") }],
    });
  });

  it("preserves canonical task identity from durable state", async () => {
    readRunStateMock.mockReturnValue(
      makeRunState({ completionTaskId: "linear:TEAM-1", url: "https://example.test/TEAM-1" }),
    );

    await expect(interruptWorkspace(config, { task: "team-1" })).resolves.toMatchObject({
      task: {
        id: "team-1",
        canonicalId: "linear:TEAM-1",
        url: "https://example.test/TEAM-1",
      },
    });
  });

  it("returns conflict when an orphan workspace cannot be inspected", async () => {
    readRunStateMock.mockReset();
    findByTaskMock.mockReturnValue([]);
    interruptMock.mockResolvedValue({ kind: "unavailable", error: new Error("backend down") });

    await expect(interruptWorkspace(config, { task: "team-1" })).resolves.toMatchObject({
      outcome: "conflict",
      resources: {},
      problems: [{ code: "workspace-status-unavailable" }],
    });
  });

  it("uses a generic conflict when an orphan workspace probe has no error detail", async () => {
    readRunStateMock.mockReset();
    findByTaskMock.mockReturnValue([]);
    interruptMock.mockResolvedValue({ kind: "unavailable" });

    await expect(interruptWorkspace(config, { task: "team-1" })).resolves.toMatchObject({
      outcome: "conflict",
      problems: [{ message: expect.stringContaining("workspace adapter unavailable") }],
    });
  });

  it("threads an AbortSignal into an orphan workspace interruption", async () => {
    readRunStateMock.mockReset();
    findByTaskMock.mockReturnValue([]);
    interruptMock.mockResolvedValue({ kind: "unavailable" });
    const signal = new AbortController().signal;

    await interruptWorkspace(config, { task: "team-1" }, { signal });

    expect(interruptMock).toHaveBeenCalledWith(config, "team-1", signal);
  });

  it("reports unknown state when a worktree-only workspace cannot be inspected", async () => {
    readRunStateMock.mockReset();
    interruptMock.mockResolvedValue({ kind: "unavailable" });

    await expect(interruptWorkspace(config, { task: "team-1" })).resolves.toMatchObject({
      outcome: "conflict",
      state: "unknown",
    });
  });
});

describe(interruptWorkspaceCli, () => {
  const config = makeConfig();

  beforeEach(() => {
    loadConfigMock.mockResolvedValue(config);
    readRunStateMock.mockReturnValue(makeRunState());
    findByTaskMock.mockReturnValue([makeWorktree()]);
    interruptMock.mockResolvedValue({ kind: "interrupted" });
    probeMock.mockResolvedValue({ kind: "ok", names: new Set() });
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.resetAllMocks();
  });

  it("emits exactly one structured stop receipt in JSON mode", async () => {
    const consoleLog = captureConsoleLog();

    try {
      const actual = await interruptWorkspaceCli(["TEAM-1", "--json"]);

      expect(actual).toMatchObject({
        action: "stop",
        task: { id: "team-1" },
        outcome: "stopped",
        state: "interrupted",
        resources: {
          repository: "repo-a",
          branch: "dev-team-1",
          worktreeDir: "/work/repo-a-team-1",
          workspace: { name: "team-1" },
        },
        problems: [],
      });
      expect(consoleLog.calls).toHaveLength(1);
      expect(JSON.parse(consoleLog.output())).toStrictEqual(actual);
    } finally {
      consoleLog.restore();
    }
  });

  it("reconciles durable stopped state after cooperative cancellation", async () => {
    interruptMock.mockImplementationOnce(async () => {
      process.listeners("SIGTERM").at(-1)?.("SIGTERM");
      throw new Error("Signal: SIGTERM");
    });
    const consoleLog = captureConsoleLog();

    try {
      const actual = await interruptWorkspaceCli([
        "TEAM-1",
        "--reason",
        "wrong direction",
        "--json",
      ]);

      expect(actual).toMatchObject({
        action: "stop",
        outcome: "partial",
        state: "interrupted",
        problems: [{ code: "cancelled", message: expect.stringContaining("SIGTERM") }],
      });
      expect(lastRecordedRunState()).toMatchObject({
        task: "team-1",
        state: "interrupted",
        detail: "workspace missing after cancellation",
        reason: "wrong direction",
      });
      expect(consoleLog.calls).toHaveLength(1);
      expect(process.exitCode).toBe(1);
    } finally {
      consoleLog.restore();
    }
  });

  it("returns a stable conflict when another lifecycle command owns the task", async () => {
    const lock = requireAcquiredLock(acquireLifecycleLock({ config, task: "team-1" }));
    const consoleLog = captureConsoleLog();

    try {
      const actual = await interruptWorkspaceCli(["TEAM-1", "--json"]);

      expect(actual).toMatchObject({
        action: "stop",
        outcome: "conflict",
        problems: [{ code: "lifecycle-lock-held" }],
      });
      expect(interruptMock).not.toHaveBeenCalled();
      expect(JSON.parse(consoleLog.output())).toStrictEqual(actual);
    } finally {
      consoleLog.restore();
      lock.release();
    }
  });

  it("returns a lock conflict without inventing resources for an unknown task", async () => {
    readRunStateMock.mockReset();
    findByTaskMock.mockReturnValue([]);
    const lock = requireAcquiredLock(acquireLifecycleLock({ config, task: "unknown-1" }));
    const consoleLog = captureConsoleLog();

    try {
      const actual = await interruptWorkspaceCli(["unknown-1", "--json"]);

      expect(actual).toMatchObject({
        outcome: "conflict",
        state: "unknown",
        resources: {},
      });
    } finally {
      consoleLog.restore();
      lock.release();
    }
  });

  it("reports cancellation reconciliation failure alongside cancellation", async () => {
    interruptMock.mockImplementationOnce(async () => {
      process.listeners("SIGINT").at(-1)?.("SIGINT");
      throw new Error("Signal: SIGINT");
    });
    recordRunStateMock.mockImplementation(() => {
      throw new Error("disk full");
    });
    const consoleLog = captureConsoleLog();

    try {
      const actual = await interruptWorkspaceCli(["TEAM-1", "--json"]);

      expect(actual.problems).toEqual([
        expect.objectContaining({ code: "cancelled" }),
        expect.objectContaining({ code: "state-write-failed" }),
      ]);
    } finally {
      consoleLog.restore();
    }
  });

  it("does not record interruption when cancellation still observes a live workspace", async () => {
    interruptMock.mockImplementationOnce(async () => {
      process.listeners("SIGTERM").at(-1)?.("SIGTERM");
      throw new Error("Signal: SIGTERM");
    });
    probeMock.mockResolvedValue({ kind: "ok", names: new Set(["team-1"]) });
    const consoleLog = captureConsoleLog();

    try {
      const actual = await interruptWorkspaceCli(["TEAM-1", "--json"]);

      expect(actual).toMatchObject({ outcome: "partial", state: "running" });
      expect(recordRunStateMock).not.toHaveBeenCalled();
    } finally {
      consoleLog.restore();
    }
  });

  it("does not invent run state when an orphan interruption is cancelled", async () => {
    readRunStateMock.mockReset();
    findByTaskMock.mockReturnValue([]);
    interruptMock.mockImplementationOnce(async () => {
      process.listeners("SIGINT").at(-1)?.("SIGINT");
      throw new Error("Signal: SIGINT");
    });
    const consoleLog = captureConsoleLog();

    try {
      const actual = await interruptWorkspaceCli(["orphan-1", "--json"]);

      expect(actual).toMatchObject({ outcome: "partial", state: "interrupted", resources: {} });
      expect(recordRunStateMock).not.toHaveBeenCalled();
    } finally {
      consoleLog.restore();
    }
  });

  it("reports unknown state when a cancelled orphan workspace remains live", async () => {
    readRunStateMock.mockReset();
    findByTaskMock.mockReturnValue([]);
    interruptMock.mockImplementationOnce(async () => {
      process.listeners("SIGTERM").at(-1)?.("SIGTERM");
      throw new Error("Signal: SIGTERM");
    });
    probeMock.mockResolvedValue({ kind: "ok", names: new Set(["orphan-1"]) });
    const consoleLog = captureConsoleLog();

    try {
      await expect(interruptWorkspaceCli(["orphan-1", "--json"])).resolves.toMatchObject({
        outcome: "partial",
        state: "unknown",
      });
    } finally {
      consoleLog.restore();
    }
  });

  it("parses task and reason", async () => {
    await interruptWorkspaceCli(["TEAM-1", "--reason", "wrong direction"]);

    expect(lastRecordedRunState()).toMatchObject({
      task: "team-1",
      reason: "wrong direction",
    });
  });

  it("parses a task without a reason", async () => {
    await interruptWorkspaceCli(["TEAM-1"]);

    expect(lastRecordedRunState()).toMatchObject({ task: "team-1", state: "interrupted" });
    expect(lastRecordedRunState().reason).toBeUndefined();
  });

  it("rejects missing task", async () => {
    await expect(interruptWorkspaceCli([])).rejects.toThrow(
      "Usage: crew stop <task> [--reason <text>] [--json]",
    );
  });

  it("rejects missing reason text", async () => {
    await expect(interruptWorkspaceCli(["team-1", "--reason"])).rejects.toThrow(
      /reason text is required/,
    );
  });

  it("rejects unknown options", async () => {
    await expect(interruptWorkspaceCli(["--bogus", "team-1"])).rejects.toThrow(
      /Unknown option: --bogus.*\[--json\]/s,
    );
  });
});
