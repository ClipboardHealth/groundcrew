import { loadConfig, type ResolvedConfig } from "../lib/config.ts";
import { readRunState, removeRunState, type RunState } from "../lib/runState.ts";
import { setVerbose } from "../lib/util.ts";
import { workspaces } from "../lib/workspaces.ts";
import { type WorktreeEntry, worktrees } from "../lib/worktrees.ts";
import { captureConsoleLog, type ConsoleCapture } from "../testHelpers/consoleCapture.ts";
import { emptyTeardownResult } from "../testHelpers/teardownResult.ts";
import { cleanupWorkspace, cleanupWorkspaceCli } from "./cleanupWorkspace.ts";

vi.mock(import("../lib/config.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, loadConfig: vi.fn<typeof loadConfig>() };
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
vi.mock(import("../lib/runState.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    readRunState: vi.fn<typeof readRunState>(),
    removeRunState: vi.fn<typeof removeRunState>(),
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

const loadConfigMock = vi.mocked(loadConfig);
const findByTaskMock = vi.mocked(worktrees.findByTask);
const teardownMock = vi.mocked(worktrees.teardown);
const readRunStateMock = vi.mocked(readRunState);
const removeRunStateMock = vi.mocked(removeRunState);
const workspaceProbeMock = vi.mocked(workspaces.probe);

const hostEntry: WorktreeEntry = {
  repository: "repo-a",
  task: "team-1",
  branchName: "dev-team-1",
  dir: "/work/repo-a-team-1",
  kind: "host",
};

const orphanRunState: RunState = {
  task: "team-1",
  repository: "repo-a",
  agent: "claude",
  worktreeDir: "/work/repo-a-team-1",
  branchName: "dev-team-1",
  workspaceName: "team-1",
  state: "running",
  createdAt: "2026-05-26T00:00:00.000Z",
  updatedAt: "2026-05-26T00:01:00.000Z",
  resumeCount: 0,
};

const config: ResolvedConfig = {
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
  local: { runner: "auto", clearance: { enabled: true } },
  logging: { file: "/tmp/groundcrew-test.log" },
};

describe(cleanupWorkspace, () => {
  let consoleLog: ConsoleCapture;

  beforeEach(() => {
    consoleLog = captureConsoleLog();
    teardownMock.mockResolvedValue(emptyTeardownResult());
    workspaceProbeMock.mockResolvedValue({ kind: "ok", names: new Set() });
    // `readRunStateMock` defaults to returning undefined (no orphaned
    // run-state); cases exercising the orphan path override it per-test.
    // Teardown sub-steps (Closed workspace, Worktree removed) and best-effort
    // run-state-cleanup failures are diagnostic (debug-tier), reaching the
    // console only under verbose — these cases assert that wording.
    setVerbose(true);
  });

  afterEach(() => {
    consoleLog.restore();
    setVerbose(false);
    vi.resetAllMocks();
  });

  it("hands the host worktree to teardown", async () => {
    findByTaskMock.mockReturnValue([hostEntry]);
    teardownMock.mockResolvedValue(emptyTeardownResult({ removed: [hostEntry] }));

    await cleanupWorkspace(config, { task: "team-1" });

    expect(teardownMock).toHaveBeenCalledWith(config, [hostEntry], { force: false });
    expect(removeRunStateMock).toHaveBeenCalledWith(config, "team-1");
  });

  it("passes --force through to teardown", async () => {
    findByTaskMock.mockReturnValue([hostEntry]);
    teardownMock.mockResolvedValue(emptyTeardownResult({ removed: [hostEntry] }));

    await cleanupWorkspace(config, { task: "team-1", force: true });

    expect(teardownMock).toHaveBeenCalledWith(config, [hostEntry], { force: true });
  });

  it("logs and returns without calling teardown when no worktree is found", async () => {
    findByTaskMock.mockReturnValue([]);

    await cleanupWorkspace(config, { task: "team-1" });

    expect(teardownMock).not.toHaveBeenCalled();
    expect(consoleLog.output()).toContain("nothing to clean up");
    expect(removeRunStateMock).not.toHaveBeenCalled();
    expect(workspaceProbeMock).not.toHaveBeenCalled();
  });

  it("clears an orphaned run-state when no worktree is found", async () => {
    findByTaskMock.mockReturnValue([]);
    readRunStateMock.mockReturnValue(orphanRunState);

    await cleanupWorkspace(config, { task: "team-1" });

    expect(teardownMock).not.toHaveBeenCalled();
    expect(removeRunStateMock).toHaveBeenCalledWith(config, "team-1");
    expect(consoleLog.output()).toContain("cleared stale run-state");
    expect(consoleLog.output()).not.toContain("nothing to clean up");
  });

  it("leaves run-state intact when no worktree is found but a workspace is present", async () => {
    findByTaskMock.mockReturnValue([]);
    readRunStateMock.mockReturnValue(orphanRunState);
    workspaceProbeMock.mockResolvedValue({ kind: "ok", names: new Set(["team-1"]) });

    await cleanupWorkspace(config, { task: "team-1" });

    expect(removeRunStateMock).not.toHaveBeenCalled();
    expect(consoleLog.output()).toContain("workspace still present; leaving run-state intact");
  });

  it("leaves run-state intact when no worktree is found and workspace probing is unavailable", async () => {
    findByTaskMock.mockReturnValue([]);
    readRunStateMock.mockReturnValue(orphanRunState);
    workspaceProbeMock.mockResolvedValue({ kind: "unavailable" });

    await cleanupWorkspace(config, { task: "team-1" });

    expect(removeRunStateMock).not.toHaveBeenCalled();
    expect(consoleLog.output()).toContain("workspace probe unavailable, leaving run-state intact");
  });

  it("clears an orphaned run-state without requiring --force", async () => {
    findByTaskMock.mockReturnValue([]);
    readRunStateMock.mockReturnValue(orphanRunState);

    await cleanupWorkspace(config, { task: "team-1", force: false });

    expect(removeRunStateMock).toHaveBeenCalledWith(config, "team-1");
  });

  it("is idempotent: a second cleanup of the same orphan reports nothing to clean up", async () => {
    findByTaskMock.mockReturnValue([]);
    // Second call falls through to the default undefined return.
    readRunStateMock.mockReturnValueOnce(orphanRunState);

    await cleanupWorkspace(config, { task: "team-1" });
    await cleanupWorkspace(config, { task: "team-1" });

    expect(removeRunStateMock).toHaveBeenCalledTimes(1);
    expect(consoleLog.output()).toContain("cleared stale run-state");
    expect(consoleLog.output()).toContain("nothing to clean up");
  });

  it("logs `workspace list failed: ...` when teardown reports a probe-throw error", async () => {
    findByTaskMock.mockReturnValue([hostEntry]);
    teardownMock.mockResolvedValue(
      emptyTeardownResult({
        workspaceProbe: { kind: "unavailable", error: new Error("cmux exploded") },
        removed: [hostEntry],
      }),
    );

    await cleanupWorkspace(config, { task: "team-1" });

    expect(consoleLog.output()).toContain("workspace list failed: cmux exploded");
  });

  it("logs and continues when marking removed run state fails", async () => {
    findByTaskMock.mockReturnValue([hostEntry]);
    teardownMock.mockResolvedValue(emptyTeardownResult({ removed: [hostEntry] }));
    removeRunStateMock.mockImplementation(() => {
      throw new Error("state write failed");
    });

    await cleanupWorkspace(config, { task: "team-1" });

    expect(consoleLog.output()).toContain("Run state cleanup failed");
  });

  it("stays silent on workspaceProbe.unavailable when no underlying error is reported", async () => {
    findByTaskMock.mockReturnValue([hostEntry]);
    teardownMock.mockResolvedValue(
      emptyTeardownResult({
        workspaceProbe: { kind: "unavailable" },
        removed: [hostEntry],
      }),
    );

    await cleanupWorkspace(config, { task: "team-1" });

    expect(consoleLog.output()).not.toContain("workspace list failed");
  });

  it("logs Closed workspace lines for each task teardown reports closed", async () => {
    findByTaskMock.mockReturnValue([hostEntry]);
    teardownMock.mockResolvedValue(
      emptyTeardownResult({ closed: ["team-1"], removed: [hostEntry] }),
    );

    await cleanupWorkspace(config, { task: "team-1" });

    expect(consoleLog.output()).toContain("Closed workspace team-1");
  });

  it("logs Cleanup complete with each removed worktree's dir and kind", async () => {
    findByTaskMock.mockReturnValue([hostEntry]);
    teardownMock.mockResolvedValue(emptyTeardownResult({ removed: [hostEntry] }));

    await cleanupWorkspace(config, { task: "team-1" });

    expect(consoleLog.output()).toContain("Cleanup complete for team-1 (host)");
    expect(consoleLog.output()).toContain("/work/repo-a-team-1 (removed)");
  });

  it("re-throws the first failure reported by teardown", async () => {
    findByTaskMock.mockReturnValue([hostEntry]);
    teardownMock.mockResolvedValue(
      emptyTeardownResult({
        failures: [
          { entry: hostEntry, step: "worktree_remove", error: new Error("worktree busy") },
        ],
      }),
    );

    await expect(cleanupWorkspace(config, { task: "team-1" })).rejects.toThrow(/worktree busy/);
  });

  it("logs workspace close failures from teardown", async () => {
    findByTaskMock.mockReturnValue([hostEntry]);
    teardownMock.mockResolvedValue(
      emptyTeardownResult({
        failures: [{ entry: hostEntry, step: "workspace_close", error: new Error("cmux down") }],
      }),
    );

    await expect(cleanupWorkspace(config, { task: "team-1" })).rejects.toThrow(/cmux down/);
    expect(consoleLog.output()).toContain("workspace close failed for team-1: cmux down");
  });

  it("logs Cleanup failed for a worktree_remove failure", async () => {
    findByTaskMock.mockReturnValue([hostEntry]);
    teardownMock.mockResolvedValue(
      emptyTeardownResult({
        failures: [{ entry: hostEntry, step: "worktree_remove", error: new Error("busy") }],
      }),
    );

    await expect(cleanupWorkspace(config, { task: "team-1" })).rejects.toThrow(/busy/);
    expect(consoleLog.output()).toContain("Cleanup failed for team-1 (host): busy");
  });
});

describe(cleanupWorkspaceCli, () => {
  let consoleLog: ConsoleCapture;

  beforeEach(() => {
    consoleLog = captureConsoleLog();
    findByTaskMock.mockReturnValue([hostEntry]);
    loadConfigMock.mockResolvedValue(config);
    teardownMock.mockResolvedValue(emptyTeardownResult({ removed: [hostEntry] }));
  });

  afterEach(() => {
    consoleLog.restore();
    vi.resetAllMocks();
  });

  it("parses the task from argv", async () => {
    await cleanupWorkspaceCli(["team-1"]);

    expect(findByTaskMock).toHaveBeenCalledWith(config, "team-1");
  });

  it("lowercases an uppercase task arg before lookup", async () => {
    await cleanupWorkspaceCli(["TEAM-1"]);

    expect(findByTaskMock).toHaveBeenCalledWith(config, "team-1");
  });

  it("recognizes --force anywhere in argv", async () => {
    await cleanupWorkspaceCli(["--force", "team-1"]);

    expect(teardownMock).toHaveBeenCalledWith(config, [hostEntry], { force: true });
  });

  it("throws a usage error when no task is provided", async () => {
    await expect(cleanupWorkspaceCli([])).rejects.toThrow(/Usage: crew cleanup/);
  });

  it("rejects unknown options instead of treating them as the task", async () => {
    await expect(cleanupWorkspaceCli(["--bogus", "team-1"])).rejects.toThrow(
      /Unknown option: --bogus/,
    );
    expect(findByTaskMock).not.toHaveBeenCalled();
  });

  it("rejects extra positional args", async () => {
    await expect(cleanupWorkspaceCli(["team-1", "extra"])).rejects.toThrow(/Usage: crew cleanup/);
    expect(findByTaskMock).not.toHaveBeenCalled();
  });
});
