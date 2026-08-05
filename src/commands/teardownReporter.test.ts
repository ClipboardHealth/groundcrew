import type { ResolvedConfig } from "../lib/config.ts";
import { createRepeatedFailureLog } from "../lib/repeatedFailures.ts";
import { removeRunState } from "../lib/runState.ts";
import { setVerbose } from "../lib/util.ts";
import { type TeardownResult, type WorktreeEntry, worktrees } from "../lib/worktrees.ts";
import { captureConsoleLog, type ConsoleCapture } from "../testHelpers/consoleCapture.ts";
import { emptyTeardownResult } from "../testHelpers/teardownResult.ts";
import {
  logTeardown,
  reapWorktrees,
  recordTeardownEvents,
  type TeardownReportOptions,
} from "./teardownReporter.ts";

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

// The teardown reporter's telemetry (logEvent) and sub-step lines (debug) are
// diagnostic, so they only reach the console under verbose. These cases assert
// that exact wording reaches the console, so each describe opts in.
function hostEntry(task: string): WorktreeEntry {
  return {
    repository: "repo-a",
    task,
    branchName: `dev-${task}`,
    dir: `/work/repo-a-${task}`,
    kind: "host",
  };
}

describe(logTeardown, () => {
  let consoleLog: ConsoleCapture;

  beforeEach(() => {
    consoleLog = captureConsoleLog();
    setVerbose(true);
  });

  afterEach(() => {
    consoleLog.restore();
    setVerbose(false);
  });

  it("emits nothing when the result is empty and the probe was clean", () => {
    logTeardown(emptyTeardownResult());

    expect(consoleLog.output()).toBe("");
  });

  it("logs `workspace list failed: ...` when the probe is unavailable and an error was captured", () => {
    const result: TeardownResult = emptyTeardownResult({
      workspaceProbe: { kind: "unavailable", error: new Error("cmux exploded") },
    });

    logTeardown(result);

    expect(consoleLog.output()).toContain("workspace list failed: cmux exploded");
  });

  it("stays silent on probe.unavailable when no underlying error was captured", () => {
    logTeardown(emptyTeardownResult({ workspaceProbe: { kind: "unavailable" } }));

    expect(consoleLog.output()).not.toContain("workspace list failed");
  });

  it("logs `Closed workspace <task>` for each task the result reports closed", () => {
    logTeardown(emptyTeardownResult({ closed: ["team-1", "team-2"] }));

    const out = consoleLog.output();
    expect(out).toContain("Closed workspace team-1");
    expect(out).toContain("Closed workspace team-2");
  });

  it("logs `Cleanup complete` and `Worktree: <dir> (removed)` for each removed entry", () => {
    logTeardown(emptyTeardownResult({ removed: [hostEntry("team-1"), hostEntry("team-2")] }));

    const out = consoleLog.output();
    expect(out).toContain("Cleanup complete for team-1 (host)");
    expect(out).toContain("/work/repo-a-team-1 (removed)");
    expect(out).toContain("Cleanup complete for team-2 (host)");
    expect(out).toContain("/work/repo-a-team-2 (removed)");
  });

  it("logs workspace_close failures with the standard wording", () => {
    logTeardown(
      emptyTeardownResult({
        failures: [
          { entry: hostEntry("team-1"), step: "workspace_close", error: new Error("cmux down") },
        ],
      }),
    );

    expect(consoleLog.output()).toContain("workspace close failed for team-1: cmux down");
  });

  it("logs worktree_remove failures with the standard wording", () => {
    logTeardown(
      emptyTeardownResult({
        failures: [
          { entry: hostEntry("team-1"), step: "worktree_remove", error: new Error("busy") },
        ],
      }),
    );

    expect(consoleLog.output()).toContain("Cleanup failed for team-1 (host): busy");
  });
});

describe(recordTeardownEvents, () => {
  let consoleLog: ConsoleCapture;

  beforeEach(() => {
    consoleLog = captureConsoleLog();
    setVerbose(true);
  });

  afterEach(() => {
    consoleLog.restore();
    setVerbose(false);
  });

  it("emits nothing when the result is empty and the probe was clean", () => {
    recordTeardownEvents(emptyTeardownResult());

    expect(consoleLog.output()).toBe("");
  });

  it("emits workspace_list_failed when the probe is unavailable", () => {
    recordTeardownEvents(emptyTeardownResult({ workspaceProbe: { kind: "unavailable" } }));

    expect(consoleLog.output()).toContain(
      "event=cleanup outcome=failed reason=workspace_list_failed",
    );
  });

  it("includes the underlying error in workspace_list_failed when one was captured", () => {
    recordTeardownEvents(
      emptyTeardownResult({
        workspaceProbe: { kind: "unavailable", error: new Error("cmux exploded") },
      }),
    );

    const out = consoleLog.output();
    expect(out).toContain("event=cleanup outcome=failed reason=workspace_list_failed");
    expect(out).toContain("cmux exploded");
  });

  it("emits workspace_closed events for each closed task", () => {
    recordTeardownEvents(emptyTeardownResult({ closed: ["team-1", "team-2"] }));

    const out = consoleLog.output();
    expect(out).toContain("event=cleanup outcome=workspace_closed task=team-1");
    expect(out).toContain("event=cleanup outcome=workspace_closed task=team-2");
  });

  it("emits cleaned events for each removed entry with repository and kind", () => {
    recordTeardownEvents(
      emptyTeardownResult({ removed: [hostEntry("team-1"), hostEntry("team-2")] }),
    );

    const out = consoleLog.output();
    expect(out).toContain("event=cleanup outcome=cleaned task=team-1 repository=repo-a kind=host");
    expect(out).toContain("event=cleanup outcome=cleaned task=team-2 repository=repo-a kind=host");
  });

  it("emits workspace_close_failed for workspace_close failures", () => {
    recordTeardownEvents(
      emptyTeardownResult({
        failures: [
          { entry: hostEntry("team-1"), step: "workspace_close", error: new Error("close down") },
        ],
      }),
    );

    const out = consoleLog.output();
    expect(out).toContain("event=cleanup outcome=failed reason=workspace_close_failed");
    expect(out).toContain("task=team-1");
    expect(out).toContain("close down");
  });

  it("emits failed events for worktree_remove failures with repository and kind", () => {
    recordTeardownEvents(
      emptyTeardownResult({
        failures: [
          { entry: hostEntry("team-1"), step: "worktree_remove", error: new Error("busy") },
        ],
      }),
    );

    const out = consoleLog.output();
    expect(out).toContain("event=cleanup outcome=failed");
    expect(out).toContain("task=team-1");
    expect(out).toContain("repository=repo-a");
    expect(out).toContain("kind=host");
    expect(out).toContain("busy");
  });
});

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
      maximumInProgress: 2,
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
    logging: { file: "/tmp/groundcrew-test.log" },
  };
}

describe(reapWorktrees, () => {
  let consoleLog: ConsoleCapture;

  beforeEach(() => {
    consoleLog = captureConsoleLog();
    teardownMock.mockResolvedValue(emptyTeardownResult());
    setVerbose(true);
  });

  afterEach(() => {
    consoleLog.restore();
    setVerbose(false);
    vi.clearAllMocks();
  });

  it("calls worktrees.teardown with the given entries", async () => {
    const entry = hostEntry("team-1");

    await reapWorktrees(makeConfig(), [entry]);

    expect(teardownMock).toHaveBeenCalledWith(expect.anything(), [entry]);
  });

  it("passes the signal into worktrees.teardown when provided", async () => {
    const { signal } = new AbortController();
    const entry = hostEntry("team-1");

    await reapWorktrees(makeConfig(), [entry], { signal });

    expect(teardownMock).toHaveBeenCalledWith(expect.anything(), [entry], { signal });
  });

  it("calls removeRunState for each removed entry", async () => {
    const entry = hostEntry("team-1");
    teardownMock.mockResolvedValue(emptyTeardownResult({ removed: [entry] }));

    await reapWorktrees(makeConfig(), [entry]);

    expect(removeRunStateMock).toHaveBeenCalledWith(expect.anything(), "team-1");
  });

  it("logs cleanup complete for a removed entry", async () => {
    const entry = hostEntry("team-1");
    teardownMock.mockResolvedValue(emptyTeardownResult({ removed: [entry] }));

    await reapWorktrees(makeConfig(), [entry]);

    expect(consoleLog.output()).toContain("event=cleanup outcome=cleaned task=team-1");
  });

  it("returns the TeardownResult from worktrees.teardown", async () => {
    const entry = hostEntry("team-1");
    const expected = emptyTeardownResult({ removed: [entry] });
    teardownMock.mockResolvedValue(expected);

    const actual = await reapWorktrees(makeConfig(), [entry]);

    expect(actual).toBe(expected);
  });

  function linesContaining(needle: string): string[] {
    return consoleLog.calls.map((call) => call.join(" ")).filter((line) => line.includes(needle));
  }

  function removeFailure(message: string): TeardownResult {
    return emptyTeardownResult({
      failures: [
        { entry: hostEntry("team-1"), step: "worktree_remove", error: new Error(message) },
      ],
    });
  }

  async function reapTimes(count: number, options: TeardownReportOptions): Promise<void> {
    for (let attempt = 0; attempt < count; attempt += 1) {
      // oxlint-disable-next-line no-await-in-loop -- each poll must observe the previous poll's outcome
      await reapWorktrees(makeConfig(), [hostEntry("team-1")], options);
    }
  }

  it("logs a repeated worktree_remove failure only once", async () => {
    const failureLog = createRepeatedFailureLog();
    teardownMock.mockResolvedValue(removeFailure("worktree has 1 modified file"));

    await reapTimes(2, { failureLog });

    expect(linesContaining("Cleanup failed for team-1")).toHaveLength(1);
    expect(teardownMock).toHaveBeenCalledTimes(2);
  });

  it("logs a failure again when its message changes", async () => {
    const failureLog = createRepeatedFailureLog();
    teardownMock.mockResolvedValue(removeFailure("worktree has 1 modified file"));
    await reapWorktrees(makeConfig(), [hostEntry("team-1")], { failureLog });
    teardownMock.mockResolvedValue(removeFailure("worktree has 2 modified files"));

    await reapWorktrees(makeConfig(), [hostEntry("team-1")], { failureLog });

    expect(linesContaining("Cleanup failed for team-1")).toEqual([
      expect.stringContaining("worktree has 1 modified file"),
      expect.stringContaining("worktree has 2 modified files"),
    ]);
  });

  it("logs a still-blocked summary on the thirtieth unchanged attempt", async () => {
    const failureLog = createRepeatedFailureLog();
    teardownMock.mockResolvedValue(removeFailure("worktree has 1 modified file"));

    await reapTimes(30, { failureLog });

    expect(linesContaining("Cleanup failed for team-1")).toHaveLength(1);
    expect(linesContaining("Cleanup still blocked for team-1 (host) after 30 attempts")).toEqual([
      expect.stringContaining("worktree has 1 modified file"),
    ]);
  });

  it("logs a still-failing summary for a repeated workspace_close failure", async () => {
    const failureLog = createRepeatedFailureLog();
    teardownMock.mockResolvedValue(
      emptyTeardownResult({
        failures: [
          { entry: hostEntry("team-1"), step: "workspace_close", error: new Error("cmux down") },
        ],
      }),
    );

    await reapTimes(30, { failureLog });

    expect(linesContaining("workspace close failed for team-1")).toHaveLength(1);
    expect(linesContaining("workspace close still failing for team-1 after 30 attempts")).toEqual([
      expect.stringContaining("cmux down"),
    ]);
  });

  it("emits the repeat count on cleanup failure events", async () => {
    const failureLog = createRepeatedFailureLog();
    teardownMock.mockResolvedValue(removeFailure("worktree has 1 modified file"));

    await reapWorktrees(makeConfig(), [hostEntry("team-1")], { failureLog });
    expect(linesContaining("event=cleanup outcome=failed")).toEqual([
      expect.stringContaining("repeats=1"),
    ]);

    const beforeSuppressedPoll = consoleLog.calls.length;
    await reapWorktrees(makeConfig(), [hostEntry("team-1")], { failureLog });
    expect(consoleLog.calls.slice(beforeSuppressedPoll)).toEqual([]);

    await reapTimes(28, { failureLog });
    expect(linesContaining("event=cleanup outcome=failed")).toEqual([
      expect.stringContaining("repeats=1"),
      expect.stringContaining("repeats=30"),
    ]);
  });

  it("reports every occurrence when no failure log is given", async () => {
    teardownMock.mockResolvedValue(removeFailure("worktree has 1 modified file"));

    await reapWorktrees(makeConfig(), [hostEntry("team-1")]);
    await reapWorktrees(makeConfig(), [hostEntry("team-1")]);

    expect(linesContaining("Cleanup failed for team-1")).toHaveLength(2);
  });

  it("announces a repeated workspace list failure once", async () => {
    const failureLog = createRepeatedFailureLog();
    teardownMock.mockResolvedValue(
      emptyTeardownResult({
        workspaceProbe: { kind: "unavailable", error: new Error("cmux exploded") },
      }),
    );

    await reapTimes(2, { failureLog });

    expect(linesContaining("workspace list failed:")).toHaveLength(1);
    expect(linesContaining("reason=workspace_list_failed")).toHaveLength(1);
  });
});
