import { loadConfig, type ResolvedConfig } from "../lib/config.ts";
import { readRunState, removeRunState, type RunState } from "../lib/runState.ts";
import { setVerbose } from "../lib/util.ts";
import { workspaces } from "../lib/workspaces.ts";
import { type WorktreeEntry, worktrees } from "../lib/worktrees.ts";
import { captureConsoleLog, type ConsoleCapture } from "../testHelpers/consoleCapture.ts";
import { emptyTeardownResult } from "../testHelpers/teardownResult.ts";
import { cleanupAllWorkspaces, cleanupWorkspace, cleanupWorkspaceCli } from "./cleanupWorkspace.ts";
import { acquireLifecycleLock } from "./lifecycleCommand.ts";

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
      list: vi.fn<typeof actual.worktrees.list>(),
      findByTask: vi.fn<typeof actual.worktrees.findByTask>(),
      teardown: vi.fn<typeof actual.worktrees.teardown>(),
      probeWorkingTree: vi.fn<typeof actual.worktrees.probeWorkingTree>(),
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
const listMock = vi.mocked(worktrees.list);
const findByTaskMock = vi.mocked(worktrees.findByTask);
const teardownMock = vi.mocked(worktrees.teardown);
const probeWorkingTreeMock = vi.mocked(worktrees.probeWorkingTree);
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

const secondEntry: WorktreeEntry = {
  repository: "repo-a",
  task: "team-2",
  branchName: "dev-team-2",
  dir: "/work/repo-a-team-2",
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
  local: {
    runner: "auto",
    networkEgress: "allowlisted",
    safehouse: { enable: [] },
    readOnlyDirs: [],
  },
  logging: { file: "/tmp/groundcrew-cleanup-workspace-test.log" },
};

function requireAcquiredLock(
  lock: ReturnType<typeof acquireLifecycleLock>,
): Extract<ReturnType<typeof acquireLifecycleLock>, { kind: "acquired" }> {
  if (lock.kind !== "acquired") {
    throw new Error("test could not acquire lifecycle lock");
  }
  return lock;
}

describe(cleanupWorkspace, () => {
  let consoleLog: ConsoleCapture;

  beforeEach(() => {
    consoleLog = captureConsoleLog();
    teardownMock.mockResolvedValue(emptyTeardownResult());
    probeWorkingTreeMock.mockResolvedValue({ kind: "clean" });
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

  it("refuses a dirty worktree before closing or removing anything", async () => {
    findByTaskMock.mockReturnValue([hostEntry]);
    workspaceProbeMock.mockResolvedValue({ kind: "ok", names: new Set() });
    probeWorkingTreeMock.mockResolvedValue({ kind: "dirty", modified: 2, untracked: 1 });

    const actual = await cleanupWorkspace(config, { task: "team-1" });

    expect(actual).toMatchObject({
      outcome: "refused",
      problems: [{ code: "worktree-dirty" }],
    });
    expect(actual.problems[0]?.message).not.toContain("--force");
    expect(teardownMock).not.toHaveBeenCalled();
  });

  it("refuses cleanup when worktree cleanliness cannot be verified", async () => {
    findByTaskMock.mockReturnValue([hostEntry]);
    probeWorkingTreeMock.mockResolvedValue({ kind: "unknown" });

    const actual = await cleanupWorkspace(config, { task: "team-1" });

    expect(actual).toMatchObject({
      outcome: "refused",
      problems: [{ code: "worktree-status-unknown" }],
    });
    expect(teardownMock).not.toHaveBeenCalled();
  });

  it("returns nothing-to-clean when no local artifacts are found", async () => {
    findByTaskMock.mockReturnValue([]);

    const actual = await cleanupWorkspace(config, { task: "team-1" });

    expect(teardownMock).not.toHaveBeenCalled();
    expect(actual).toMatchObject({ outcome: "nothing-to-clean", state: "absent" });
    expect(consoleLog.output()).toBe("");
    expect(removeRunStateMock).not.toHaveBeenCalled();
    expect(workspaceProbeMock).toHaveBeenCalledWith(config);
  });

  it("clears an orphaned run-state when no worktree is found", async () => {
    findByTaskMock.mockReturnValue([]);
    readRunStateMock.mockReturnValue(orphanRunState);

    const actual = await cleanupWorkspace(config, { task: "team-1" });

    expect(teardownMock).not.toHaveBeenCalled();
    expect(removeRunStateMock).toHaveBeenCalledWith(config, "team-1");
    expect(actual).toMatchObject({ outcome: "state-cleared", state: "absent" });
  });

  it("returns partial when stale run-state cannot be cleared", async () => {
    findByTaskMock.mockReturnValue([]);
    readRunStateMock.mockReturnValue(orphanRunState);
    removeRunStateMock.mockImplementation(() => {
      throw new Error("state directory is read-only");
    });

    await expect(cleanupWorkspace(config, { task: "team-1" })).resolves.toMatchObject({
      outcome: "partial",
      state: "running",
      problems: [{ code: "state-write-failed", message: expect.stringContaining("read-only") }],
    });
  });

  it("refuses cleanup when no worktree is found but a workspace is present", async () => {
    findByTaskMock.mockReturnValue([]);
    readRunStateMock.mockReturnValue(orphanRunState);
    workspaceProbeMock.mockResolvedValue({ kind: "ok", names: new Set(["team-1"]) });

    const actual = await cleanupWorkspace(config, { task: "team-1" });

    expect(removeRunStateMock).not.toHaveBeenCalled();
    expect(actual).toMatchObject({ outcome: "refused", state: "running" });
  });

  it("returns conflict when workspace probing is unavailable", async () => {
    findByTaskMock.mockReturnValue([]);
    readRunStateMock.mockReturnValue(orphanRunState);
    workspaceProbeMock.mockResolvedValue({ kind: "unavailable" });

    const actual = await cleanupWorkspace(config, { task: "team-1" });

    expect(removeRunStateMock).not.toHaveBeenCalled();
    expect(actual).toMatchObject({ outcome: "conflict" });
  });

  it("returns unknown state when probing is unavailable without persisted context", async () => {
    findByTaskMock.mockReturnValue([]);
    workspaceProbeMock.mockResolvedValue({ kind: "unavailable" });

    await expect(cleanupWorkspace(config, { task: "team-1" })).resolves.toMatchObject({
      outcome: "conflict",
      state: "unknown",
    });
  });

  it("refuses a live workspace before inspecting its worktree", async () => {
    findByTaskMock.mockReturnValue([hostEntry]);
    workspaceProbeMock.mockResolvedValue({ kind: "ok", names: new Set(["team-1"]) });

    await expect(cleanupWorkspace(config, { task: "team-1" })).resolves.toMatchObject({
      outcome: "refused",
      state: "running",
      problems: [{ code: "workspace-busy" }],
    });
    expect(probeWorkingTreeMock).not.toHaveBeenCalled();
  });

  it("returns conflict before inspecting a worktree when workspace status is unavailable", async () => {
    findByTaskMock.mockReturnValue([hostEntry]);
    workspaceProbeMock.mockResolvedValue({ kind: "unavailable" });

    await expect(cleanupWorkspace(config, { task: "team-1" })).resolves.toMatchObject({
      outcome: "conflict",
      problems: [{ code: "workspace-status-unavailable" }],
    });
    expect(probeWorkingTreeMock).not.toHaveBeenCalled();
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

    const first = await cleanupWorkspace(config, { task: "team-1" });
    const second = await cleanupWorkspace(config, { task: "team-1" });

    expect(removeRunStateMock).toHaveBeenCalledTimes(1);
    expect(first.outcome).toBe("state-cleared");
    expect(second.outcome).toBe("nothing-to-clean");
  });

  it("preserves a teardown workspace-probe failure in the result", async () => {
    findByTaskMock.mockReturnValue([hostEntry]);
    teardownMock.mockResolvedValue(
      emptyTeardownResult({
        workspaceProbe: { kind: "unavailable", error: new Error("cmux exploded") },
        removed: [hostEntry],
      }),
    );

    const actual = await cleanupWorkspace(config, { task: "team-1" });

    expect(actual).toMatchObject({
      outcome: "partial",
      problems: [
        { code: "workspace-status-unavailable", message: expect.stringContaining("cmux exploded") },
      ],
    });
  });

  it("returns partial with removed resources when clearing durable run state fails", async () => {
    findByTaskMock.mockReturnValue([hostEntry]);
    readRunStateMock.mockReturnValue(orphanRunState);
    teardownMock.mockResolvedValue(emptyTeardownResult({ removed: [hostEntry] }));
    removeRunStateMock.mockImplementation(() => {
      throw new Error("state write failed");
    });

    const actual = await cleanupWorkspace(config, { task: "team-1" });

    expect(actual).toMatchObject({
      outcome: "partial",
      state: "running",
      resources: {
        worktrees: [{ worktreeDir: hostEntry.dir, removed: true }],
      },
      problems: [
        { code: "state-write-failed", message: expect.stringContaining("state write failed") },
      ],
    });
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

  it("returns each workspace teardown reports closed", async () => {
    findByTaskMock.mockReturnValue([hostEntry]);
    teardownMock.mockResolvedValue(
      emptyTeardownResult({ closed: ["team-1"], removed: [hostEntry] }),
    );

    const actual = await cleanupWorkspace(config, { task: "team-1" });

    expect(actual.resources.workspaces).toContainEqual({ name: "team-1", closed: true });
  });

  it("returns each removed worktree", async () => {
    findByTaskMock.mockReturnValue([hostEntry]);
    teardownMock.mockResolvedValue(emptyTeardownResult({ removed: [hostEntry] }));

    const actual = await cleanupWorkspace(config, { task: "team-1" });

    expect(actual.resources.worktrees).toContainEqual({
      repository: "repo-a",
      branch: "dev-team-1",
      worktreeDir: "/work/repo-a-team-1",
      removed: true,
    });
  });

  it("returns partial with every teardown failure", async () => {
    findByTaskMock.mockReturnValue([hostEntry]);
    teardownMock.mockResolvedValue(
      emptyTeardownResult({
        failures: [
          { entry: hostEntry, step: "worktree_remove", error: new Error("worktree busy") },
        ],
      }),
    );

    await expect(cleanupWorkspace(config, { task: "team-1" })).resolves.toMatchObject({
      outcome: "partial",
      problems: [
        { code: "worktree-remove-failed", message: expect.stringContaining("worktree busy") },
      ],
    });
  });

  it("preserves removed worktrees alongside failures in a partial result", async () => {
    const failedEntry: WorktreeEntry = {
      ...hostEntry,
      repository: "repo-b",
      branchName: "dev-team-1-b",
      dir: "/work/repo-b-team-1",
    };
    findByTaskMock.mockReturnValue([hostEntry, failedEntry]);
    teardownMock.mockResolvedValue(
      emptyTeardownResult({
        removed: [hostEntry],
        failures: [{ entry: failedEntry, step: "worktree_remove", error: new Error("git busy") }],
      }),
    );

    const actual = await cleanupWorkspace(config, { task: "team-1" });

    expect(actual.outcome).toBe("partial");
    expect(actual.resources.worktrees).toEqual([
      expect.objectContaining({ worktreeDir: hostEntry.dir, removed: true }),
      expect.objectContaining({ worktreeDir: failedEntry.dir, removed: false }),
    ]);
    expect(actual.problems).toEqual([expect.objectContaining({ code: "worktree-remove-failed" })]);
  });

  it("preserves teardown progress when cooperative cancellation stops cleanup", async () => {
    findByTaskMock.mockReturnValue([hostEntry, secondEntry]);
    teardownMock.mockResolvedValue({
      ...emptyTeardownResult({ removed: [hostEntry] }),
      cancelled: true,
    });

    const actual = await cleanupWorkspace(config, { task: "team-1" });

    expect(actual).toMatchObject({
      outcome: "partial",
      problems: [{ code: "cancelled" }],
    });
    expect(actual.resources.worktrees).toEqual([
      expect.objectContaining({ worktreeDir: hostEntry.dir, removed: true }),
      expect.objectContaining({ worktreeDir: secondEntry.dir, removed: false }),
    ]);
  });

  it("returns workspace close failures from teardown", async () => {
    findByTaskMock.mockReturnValue([hostEntry]);
    teardownMock.mockResolvedValue(
      emptyTeardownResult({
        failures: [{ entry: hostEntry, step: "workspace_close", error: new Error("cmux down") }],
      }),
    );

    await expect(cleanupWorkspace(config, { task: "team-1" })).resolves.toMatchObject({
      outcome: "partial",
      problems: [{ code: "workspace-close-failed", message: expect.stringContaining("cmux down") }],
    });
  });

  it("returns worktree removal failures", async () => {
    findByTaskMock.mockReturnValue([hostEntry]);
    teardownMock.mockResolvedValue(
      emptyTeardownResult({
        failures: [{ entry: hostEntry, step: "worktree_remove", error: new Error("busy") }],
      }),
    );

    await expect(cleanupWorkspace(config, { task: "team-1" })).resolves.toMatchObject({
      outcome: "partial",
      problems: [{ code: "worktree-remove-failed", message: expect.stringContaining("busy") }],
    });
  });

  it("removes shell remediation flags from JSON teardown problems", async () => {
    findByTaskMock.mockReturnValue([hostEntry]);
    teardownMock.mockResolvedValue(
      emptyTeardownResult({
        failures: [
          {
            entry: hostEntry,
            step: "worktree_remove",
            error: new Error("git worktree remove --force failed"),
          },
        ],
      }),
    );

    const actual = await cleanupWorkspace(config, { task: "team-1" });

    expect(actual.problems).toEqual([
      {
        code: "worktree-remove-failed",
        message: "Worktree could not be removed safely; inspect it for uncommitted changes.",
      },
    ]);
    expect(JSON.stringify(actual)).not.toContain("--force");
  });
});

describe(cleanupAllWorkspaces, () => {
  let consoleLog: ConsoleCapture;

  beforeEach(() => {
    consoleLog = captureConsoleLog();
    teardownMock.mockResolvedValue(emptyTeardownResult());
    workspaceProbeMock.mockResolvedValue({ kind: "ok", names: new Set() });
  });

  afterEach(() => {
    consoleLog.restore();
    process.exitCode = undefined;
    vi.resetAllMocks();
  });

  it("emits exactly one structured cleanup receipt in JSON mode", async () => {
    const jsonLog = captureConsoleLog();
    loadConfigMock.mockResolvedValue(config);
    readRunStateMock.mockReturnValue({
      ...orphanRunState,
      completionTaskId: "linear:TEAM-1",
      url: "https://example.test/TEAM-1",
    });
    findByTaskMock.mockReturnValue([hostEntry]);
    workspaceProbeMock.mockResolvedValue({ kind: "ok", names: new Set() });
    probeWorkingTreeMock.mockResolvedValue({ kind: "clean" });
    teardownMock.mockResolvedValue(emptyTeardownResult({ removed: [hostEntry] }));

    try {
      const actual = await cleanupWorkspaceCli(["team-1", "--json"]);

      expect(actual).toMatchObject({
        action: "cleanup",
        task: {
          id: "team-1",
          canonicalId: "linear:TEAM-1",
          url: "https://example.test/TEAM-1",
        },
        outcome: "cleaned",
        state: "absent",
        resources: {
          worktrees: [
            {
              repository: "repo-a",
              branch: "dev-team-1",
              worktreeDir: "/work/repo-a-team-1",
              removed: true,
            },
          ],
          workspaces: [{ name: "team-1", closed: false }],
        },
        problems: [],
      });
      expect(jsonLog.calls).toHaveLength(1);
      expect(JSON.parse(jsonLog.output())).toStrictEqual(actual);
    } finally {
      jsonLog.restore();
    }
  });

  it("tears down every worktree when no workspace is in use", async () => {
    listMock.mockReturnValue([hostEntry, secondEntry]);
    teardownMock.mockResolvedValue(emptyTeardownResult({ removed: [hostEntry, secondEntry] }));

    await cleanupAllWorkspaces(config, {});

    expect(teardownMock).toHaveBeenCalledWith(config, [hostEntry, secondEntry], { force: false });
    expect(removeRunStateMock).toHaveBeenCalledWith(config, "team-1");
    expect(removeRunStateMock).toHaveBeenCalledWith(config, "team-2");
  });

  it("skips worktrees whose workspace is live and tears down the rest", async () => {
    listMock.mockReturnValue([hostEntry, secondEntry]);
    workspaceProbeMock.mockResolvedValue({ kind: "ok", names: new Set(["team-1"]) });
    teardownMock.mockResolvedValue(emptyTeardownResult({ removed: [secondEntry] }));

    await cleanupAllWorkspaces(config, {});

    expect(teardownMock).toHaveBeenCalledWith(config, [secondEntry], { force: false });
    expect(consoleLog.output()).toContain("team-1");
    expect(consoleLog.output()).toContain("in use");
  });

  it("treats an exited workspace session as idle and cleans it up", async () => {
    listMock.mockReturnValue([hostEntry]);
    workspaceProbeMock.mockResolvedValue({
      kind: "ok",
      names: new Set(["team-1"]),
      exitedNames: new Set(["team-1"]),
    });
    teardownMock.mockResolvedValue(emptyTeardownResult({ removed: [hostEntry] }));

    await cleanupAllWorkspaces(config, {});

    expect(teardownMock).toHaveBeenCalledWith(config, [hostEntry], { force: false });
  });

  it("cleans up nothing when the workspace probe is unavailable", async () => {
    listMock.mockReturnValue([hostEntry, secondEntry]);
    workspaceProbeMock.mockResolvedValue({ kind: "unavailable" });

    await cleanupAllWorkspaces(config, {});

    expect(teardownMock).not.toHaveBeenCalled();
    expect(consoleLog.output()).toContain("probe unavailable");
  });

  it("logs and returns when there are no worktrees at all", async () => {
    listMock.mockReturnValue([]);

    await cleanupAllWorkspaces(config, {});

    expect(teardownMock).not.toHaveBeenCalled();
    expect(workspaceProbeMock).not.toHaveBeenCalled();
    expect(consoleLog.output()).toContain("nothing to clean up");
  });

  it("logs and returns when every worktree is in use", async () => {
    listMock.mockReturnValue([hostEntry]);
    workspaceProbeMock.mockResolvedValue({ kind: "ok", names: new Set(["team-1"]) });

    await cleanupAllWorkspaces(config, {});

    expect(teardownMock).not.toHaveBeenCalled();
    expect(consoleLog.output()).toContain("No idle worktrees");
  });

  it("passes --force through to teardown", async () => {
    listMock.mockReturnValue([hostEntry]);
    teardownMock.mockResolvedValue(emptyTeardownResult({ removed: [hostEntry] }));

    await cleanupAllWorkspaces(config, { force: true });

    expect(teardownMock).toHaveBeenCalledWith(config, [hostEntry], { force: true });
  });

  it("re-throws the first failure reported by teardown", async () => {
    listMock.mockReturnValue([hostEntry]);
    teardownMock.mockResolvedValue(
      emptyTeardownResult({
        failures: [
          { entry: hostEntry, step: "worktree_remove", error: new Error("worktree busy") },
        ],
      }),
    );

    await expect(cleanupAllWorkspaces(config, {})).rejects.toThrow(/worktree busy/);
  });
});

describe(cleanupWorkspaceCli, () => {
  let consoleLog: ConsoleCapture;

  beforeEach(() => {
    consoleLog = captureConsoleLog();
    findByTaskMock.mockReturnValue([hostEntry]);
    loadConfigMock.mockResolvedValue(config);
    teardownMock.mockResolvedValue(emptyTeardownResult({ removed: [hostEntry] }));
    workspaceProbeMock.mockResolvedValue({ kind: "ok", names: new Set() });
    probeWorkingTreeMock.mockResolvedValue({ kind: "clean" });
  });

  afterEach(() => {
    consoleLog.restore();
    process.exitCode = undefined;
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

    expect(teardownMock).toHaveBeenCalledWith(config, [hostEntry], {
      force: true,
      signal: expect.any(AbortSignal),
    });
  });

  it("returns a stable conflict when another lifecycle command owns the task", async () => {
    const lock = requireAcquiredLock(acquireLifecycleLock({ config, task: "team-1" }));

    try {
      const actual = await cleanupWorkspaceCli(["team-1", "--json"]);

      expect(actual).toMatchObject({
        action: "cleanup",
        outcome: "conflict",
        problems: [{ code: "lifecycle-lock-held" }],
      });
      expect(teardownMock).not.toHaveBeenCalled();
      expect(JSON.parse(consoleLog.output())).toStrictEqual(actual);
    } finally {
      lock.release();
    }
  });

  it("returns partial when cooperative cancellation escapes cleanup", async () => {
    teardownMock.mockImplementationOnce(async () => {
      process.listeners("SIGTERM").at(-1)?.("SIGTERM");
      throw new Error("Signal: SIGTERM");
    });

    const actual = await cleanupWorkspaceCli(["team-1", "--json"]);

    expect(actual).toMatchObject({
      action: "cleanup",
      outcome: "partial",
      problems: [{ code: "cancelled", message: expect.stringContaining("SIGTERM") }],
    });
    expect(process.exitCode).toBe(1);
  });

  it("preserves persisted lifecycle state in a cancellation receipt", async () => {
    readRunStateMock.mockReturnValue(orphanRunState);
    teardownMock.mockImplementationOnce(async () => {
      process.listeners("SIGINT").at(-1)?.("SIGINT");
      throw new Error("Signal: SIGINT");
    });

    await expect(cleanupWorkspaceCli(["team-1", "--json"])).resolves.toMatchObject({
      outcome: "partial",
      state: "running",
    });
  });

  it("reports absent when cancellation finds no state or worktree", async () => {
    findByTaskMock.mockReturnValue([]);
    workspaceProbeMock.mockImplementationOnce(async () => {
      process.listeners("SIGTERM").at(-1)?.("SIGTERM");
      throw new Error("Signal: SIGTERM");
    });

    await expect(cleanupWorkspaceCli(["unknown-1", "--json"])).resolves.toMatchObject({
      outcome: "partial",
      state: "absent",
      resources: { worktrees: [], workspaces: [] },
    });
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

  it("routes --all to the batch cleanup instead of a single task", async () => {
    listMock.mockReturnValue([hostEntry]);
    teardownMock.mockResolvedValue(emptyTeardownResult({ removed: [hostEntry] }));

    await cleanupWorkspaceCli(["--all"]);

    expect(listMock).toHaveBeenCalledWith(config);
    expect(findByTaskMock).not.toHaveBeenCalled();
    expect(teardownMock).toHaveBeenCalledWith(config, [hostEntry], { force: false });
  });

  it("passes --force through with --all", async () => {
    listMock.mockReturnValue([hostEntry]);
    teardownMock.mockResolvedValue(emptyTeardownResult({ removed: [hostEntry] }));

    await cleanupWorkspaceCli(["--all", "--force"]);

    expect(teardownMock).toHaveBeenCalledWith(config, [hostEntry], { force: true });
  });

  it("rejects --all combined with a task argument", async () => {
    await expect(cleanupWorkspaceCli(["--all", "team-1"])).rejects.toThrow(/Usage: crew cleanup/);
    expect(listMock).not.toHaveBeenCalled();
    expect(findByTaskMock).not.toHaveBeenCalled();
  });

  it("rejects JSON mode for batch cleanup", async () => {
    await expect(cleanupWorkspaceCli(["--all", "--json"])).rejects.toThrow(
      /--json requires a task argument/,
    );
    expect(listMock).not.toHaveBeenCalled();
  });
});
