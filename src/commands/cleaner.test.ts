import type { ResolvedConfig } from "../lib/config.ts";
import { removeRunState } from "../lib/runState.ts";
import { setVerbose } from "../lib/util.ts";
import { canonicalLinearIssue } from "../lib/testing/canonicalFixtures.ts";
import type { BoardState } from "../lib/taskSource.ts";
import { type WorktreeEntry, worktrees } from "../lib/worktrees.ts";
import { captureConsoleLog, type ConsoleCapture } from "../testHelpers/consoleCapture.ts";
import { emptyTeardownResult } from "../testHelpers/teardownResult.ts";
import { createCleaner } from "./cleaner.ts";

vi.mock(import("../lib/worktrees.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    worktrees: {
      ...actual.worktrees,
      teardown: vi.fn<typeof actual.worktrees.teardown>(),
    },
  };
});
vi.mock(import("../lib/runState.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, removeRunState: vi.fn<typeof removeRunState>() };
});

const teardownMock = vi.mocked(worktrees.teardown);
const removeRunStateMock = vi.mocked(removeRunState);

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    sources: [],
    defaults: { hooks: {} },
    git: { remote: "origin", defaultBranch: "main", ...overrides.git },
    workspace: {
      projectDir: "/work",
      knownRepositories: ["repo-a"],
      repositories: [{ name: "repo-a" }],
      ...overrides.workspace,
    },
    orchestrator: {
      maximumInProgress: 2,
      pollIntervalMilliseconds: 1000,
      sessionLimitPercentage: 85,
      ...overrides.orchestrator,
    },
    agents: {
      default: "claude",
      definitions: { claude: { cmd: "claude", color: "#fff" } },
      ...overrides.agents,
    },
    prompts: { initial: "x", ...overrides.prompts },
    workspaceKind: overrides.workspaceKind ?? "auto",
    local: { runner: "auto", clearance: { enabled: true } },
    logging: { file: "/tmp/groundcrew-test.log", ...overrides.logging },
  };
}

function boardOf(issues: BoardState["issues"]): BoardState {
  return { timestamp: "2025-01-01T00:00:00.000Z", issues, parentSkips: [] };
}

function hostEntryFor(repository: string, task: string): WorktreeEntry {
  return {
    repository,
    task,
    branchName: `dev-${task.toLowerCase()}`,
    dir: `/work/${repository}-${task}`,
    kind: "host",
  };
}

describe(createCleaner, () => {
  let consoleLog: ConsoleCapture;

  beforeEach(() => {
    consoleLog = captureConsoleLog();
    teardownMock.mockResolvedValue(emptyTeardownResult());
    // Cleanup telemetry (event= lines) is diagnostic, so it only reaches the
    // console under verbose — these cases assert that wording.
    setVerbose(true);
  });

  afterEach(() => {
    consoleLog.restore();
    setVerbose(false);
    vi.clearAllMocks();
  });

  it("calls teardown for a done task's worktree", async () => {
    const cleaner = createCleaner({ config: makeConfig() });
    const entry = hostEntryFor("repo-a", "team-1");
    teardownMock.mockResolvedValue(emptyTeardownResult({ removed: [entry] }));

    await cleaner.runOnce({
      state: boardOf([canonicalLinearIssue({ naturalId: "team-1", status: "done" })]),
      worktreeEntries: [entry],
      dryRun: false,
    });

    expect(teardownMock).toHaveBeenCalledWith(expect.anything(), [entry]);
    expect(removeRunStateMock).toHaveBeenCalledWith(expect.anything(), "team-1");
    expect(consoleLog.output()).toContain("event=cleanup outcome=cleaned task=team-1");
  });

  it("ignores worktrees whose task is not in the terminal set", async () => {
    const cleaner = createCleaner({ config: makeConfig() });

    await cleaner.runOnce({
      state: boardOf([canonicalLinearIssue({ naturalId: "team-1", status: "done" })]),
      worktreeEntries: [hostEntryFor("repo-a", "other-1")],
      dryRun: false,
    });

    expect(teardownMock).not.toHaveBeenCalled();
  });

  it("does not act when there are no terminal tasks", async () => {
    const cleaner = createCleaner({ config: makeConfig() });

    await cleaner.runOnce({
      state: boardOf([canonicalLinearIssue({ naturalId: "team-1", status: "todo" })]),
      worktreeEntries: [hostEntryFor("repo-a", "team-1")],
      dryRun: false,
    });

    expect(teardownMock).not.toHaveBeenCalled();
  });

  it("treats in-progress tasks as non-terminal", async () => {
    const cleaner = createCleaner({ config: makeConfig() });

    await cleaner.runOnce({
      state: boardOf([canonicalLinearIssue({ naturalId: "team-1", status: "in-progress" })]),
      worktreeEntries: [hostEntryFor("repo-a", "team-1")],
      dryRun: false,
    });

    expect(teardownMock).not.toHaveBeenCalled();
  });

  it("logs workspace_closed events for tasks reported by teardown", async () => {
    const cleaner = createCleaner({ config: makeConfig() });
    teardownMock.mockResolvedValue(emptyTeardownResult({ closed: ["team-1"] }));

    await cleaner.runOnce({
      state: boardOf([canonicalLinearIssue({ naturalId: "team-1", status: "done" })]),
      worktreeEntries: [hostEntryFor("repo-a", "team-1")],
      dryRun: false,
    });

    expect(consoleLog.output()).toContain("event=cleanup outcome=workspace_closed task=team-1");
  });

  it("logs workspace_list_failed when teardown reports the adapter unavailable", async () => {
    const cleaner = createCleaner({ config: makeConfig() });
    teardownMock.mockResolvedValue(
      emptyTeardownResult({ workspaceProbe: { kind: "unavailable" } }),
    );

    await cleaner.runOnce({
      state: boardOf([canonicalLinearIssue({ naturalId: "team-1", status: "done" })]),
      worktreeEntries: [hostEntryFor("repo-a", "team-1")],
      dryRun: false,
    });

    expect(consoleLog.output()).toContain(
      "event=cleanup outcome=failed reason=workspace_list_failed",
    );
  });

  it("includes the underlying error in workspace_list_failed when teardown captured one", async () => {
    const cleaner = createCleaner({ config: makeConfig() });
    teardownMock.mockResolvedValue(
      emptyTeardownResult({
        workspaceProbe: { kind: "unavailable", error: new Error("cmux exploded") },
      }),
    );

    await cleaner.runOnce({
      state: boardOf([canonicalLinearIssue({ naturalId: "team-1", status: "done" })]),
      worktreeEntries: [hostEntryFor("repo-a", "team-1")],
      dryRun: false,
    });

    const out = consoleLog.output();
    expect(out).toContain("event=cleanup outcome=failed reason=workspace_list_failed");
    expect(out).toContain("cmux exploded");
  });

  it("logs workspace_close_failed for a workspace_close failure", async () => {
    const entry = hostEntryFor("repo-a", "team-1");
    const cleaner = createCleaner({ config: makeConfig() });
    teardownMock.mockResolvedValue(
      emptyTeardownResult({
        failures: [{ entry, step: "workspace_close", error: new Error("close down") }],
      }),
    );

    await cleaner.runOnce({
      state: boardOf([canonicalLinearIssue({ naturalId: "team-1", status: "done" })]),
      worktreeEntries: [entry],
      dryRun: false,
    });

    expect(consoleLog.output()).toContain("workspace close failed for team-1: close down");
    expect(consoleLog.output()).toContain(
      "event=cleanup outcome=failed reason=workspace_close_failed",
    );
  });

  it("logs Cleanup failed for a worktree_remove failure", async () => {
    const entry = hostEntryFor("repo-a", "team-1");
    const cleaner = createCleaner({ config: makeConfig() });
    teardownMock.mockResolvedValue(
      emptyTeardownResult({
        failures: [{ entry, step: "worktree_remove", error: new Error("cleanup boom") }],
      }),
    );

    await cleaner.runOnce({
      state: boardOf([canonicalLinearIssue({ naturalId: "team-1", status: "done" })]),
      worktreeEntries: [entry],
      dryRun: false,
    });

    expect(consoleLog.output()).toContain("Cleanup failed for team-1");
  });

  it("emits a dry-run notice and does not invoke teardown", async () => {
    const cleaner = createCleaner({ config: makeConfig() });

    await cleaner.runOnce({
      state: boardOf([canonicalLinearIssue({ naturalId: "team-1", status: "done" })]),
      worktreeEntries: [hostEntryFor("repo-a", "team-1")],
      dryRun: true,
    });

    expect(teardownMock).not.toHaveBeenCalled();
    const out = consoleLog.output();
    expect(out).toContain("[dry-run]");
    expect(out).toContain("worktree(s) due for cleanup");
    expect(out).toContain("event=cleanup outcome=skipped reason=dry_run");
  });

  it("passes the shutdown signal into teardown", async () => {
    const { signal } = new AbortController();
    const entry = hostEntryFor("repo-a", "team-1");
    const cleaner = createCleaner({ config: makeConfig() });

    await cleaner.runOnce({
      state: boardOf([canonicalLinearIssue({ naturalId: "team-1", status: "done" })]),
      worktreeEntries: [entry],
      dryRun: false,
      signal,
    });

    expect(teardownMock).toHaveBeenCalledWith(expect.anything(), [entry], { signal });
  });
});
