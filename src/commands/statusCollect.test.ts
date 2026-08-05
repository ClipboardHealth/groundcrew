import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { type Board, createBoard } from "../lib/board.ts";
import type { ResolvedConfig } from "../lib/config.ts";
import { findPullRequestsForBranch } from "../lib/pullRequests.ts";
import { readRunState, type RunState } from "../lib/runState.ts";
import type { Blocker, Issue as SourceIssue } from "../lib/taskSource.ts";
import { workspaces } from "../lib/workspaces.ts";
import { type WorktreeEntry, worktrees } from "../lib/worktrees.ts";
import type { RemoteFetchResult, RemoteStatusPayload } from "../lib/statusSnapshot.ts";
import {
  collectLocalStatus,
  collectRemoteStatus,
  workspaceProbeUnavailableText,
} from "./statusCollect.ts";

vi.mock(import("../lib/board.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, createBoard: vi.fn<typeof actual.createBoard>() };
});
vi.mock(import("../lib/buildSources.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, buildSources: vi.fn<typeof actual.buildSources>().mockResolvedValue([]) };
});
vi.mock(import("../lib/pullRequests.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    findPullRequestsForBranch: vi
      .fn<typeof actual.findPullRequestsForBranch>()
      .mockResolvedValue([]),
  };
});
vi.mock(import("../lib/runState.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, readRunState: vi.fn<typeof readRunState>() };
});
vi.mock(import("../lib/workspaces.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    workspaces: {
      ...actual.workspaces,
      probe: vi.fn<typeof actual.workspaces.probe>(),
      accessHint: vi.fn<typeof actual.workspaces.accessHint>(),
    },
  };
});
vi.mock(import("../lib/worktrees.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    worktrees: {
      ...actual.worktrees,
      list: vi.fn<typeof actual.worktrees.list>(),
      probeWorkingTree: vi.fn<typeof actual.worktrees.probeWorkingTree>(),
    },
  };
});
vi.mock(import("../lib/worktreeRunState.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    effectiveBranchNameFromRunState: vi
      .fn<typeof actual.effectiveBranchNameFromRunState>()
      .mockResolvedValue("eng-220"),
  };
});

let directory: string;
let mockConfig: ResolvedConfig;

// The collector reads only these three fields; everything else it receives is
// passed straight to mocked collaborators. One assertion here beats scattering
// partial fixtures across the describe blocks.
function makeConfig(logDirectory: string): ResolvedConfig {
  return {
    sources: [],
    logging: { file: path.join(logDirectory, "groundcrew.log") },
    orchestrator: { maximumInProgress: 4 },
  } as unknown as ResolvedConfig;
}

function makeEntry(overrides: Partial<WorktreeEntry> = {}): WorktreeEntry {
  return {
    repository: "groundcrew",
    task: "eng-220",
    branchName: "eng-220",
    dir: "/repos/eng-220",
    kind: "host",
    ...overrides,
  };
}

function makeRunState(overrides: Partial<RunState> = {}): RunState {
  return {
    task: "eng-220",
    repository: "groundcrew",
    agent: "opus",
    worktreeDir: "/repos/eng-220",
    branchName: "eng-220",
    workspaceName: "eng-220",
    state: "running",
    createdAt: "2026-08-04T02:00:00.000Z",
    updatedAt: "2026-08-04T03:00:00.000Z",
    resumeCount: 0,
    title: "Some task",
    ...overrides,
  };
}

describe("collectLocalStatus", () => {
  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "gc-collect-"));
    mockConfig = makeConfig(directory);
    vi.mocked(worktrees.list).mockReturnValue([makeEntry()]);
    vi.mocked(worktrees.probeWorkingTree).mockResolvedValue({ kind: "clean" });
    vi.mocked(workspaces.probe).mockResolvedValue({ kind: "ok", names: new Set(["eng-220"]) });
    vi.mocked(workspaces.accessHint).mockResolvedValue({
      kind: "attachCommand",
      command: "cmux open eng-220",
    });
    vi.mocked(readRunState).mockReturnValue(makeRunState());
  });

  afterEach(() => {
    rmSync(directory, { force: true, recursive: true });
    vi.clearAllMocks();
  });

  it("carries maximumInProgress from config, not from any fetch", async () => {
    const actual = await collectLocalStatus({ config: mockConfig });

    expect(actual.maximumInProgress).toBe(4);
  });

  it("records the run-state start instant rather than an elapsed duration", async () => {
    const actual = await collectLocalStatus({ config: mockConfig });

    expect(actual.tasks[0]?.startedAt).toBe("2026-08-04T02:00:00.000Z");
    expect(actual.tasks[0]).not.toHaveProperty("duration");
  });

  it("groups multiple worktrees under one task in list order", async () => {
    vi.mocked(worktrees.list).mockReturnValue([
      makeEntry({ repository: "groundcrew", dir: "/repos/a" }),
      makeEntry({ repository: "emdash", dir: "/repos/b" }),
    ]);

    const actual = await collectLocalStatus({ config: mockConfig });

    expect(actual.tasks).toHaveLength(1);
    expect(actual.tasks[0]?.worktrees.map((worktree) => worktree.dir)).toEqual([
      "/repos/a",
      "/repos/b",
    ]);
  });

  it("flags a run-state that says running when the session is gone", async () => {
    vi.mocked(workspaces.probe).mockResolvedValue({ kind: "ok", names: new Set() });

    const actual = await collectLocalStatus({ config: mockConfig });

    expect(actual.tasks[0]?.flags).toContain("session dead");
    expect(actual.tasks[0]?.session).toBe("not-live");
  });

  it("flags a worktree with no run state and a live session as stray", async () => {
    // An empty map misses, which yields undefined without writing it literally.
    const statesByTask = new Map<string, RunState>();
    vi.mocked(readRunState).mockImplementation((_config, task) => statesByTask.get(task));

    const actual = await collectLocalStatus({ config: mockConfig });

    expect(actual.tasks[0]?.lifecycle).toBe("idle");
    expect(actual.tasks[0]?.flags).toContain("stray session");
    expect(actual.tasks[0]?.hint).toContain("crew cleanup eng-220");
  });

  it("lists sessions with no worktree as orphaned", async () => {
    vi.mocked(workspaces.probe).mockResolvedValue({
      kind: "ok",
      names: new Set(["eng-220", "eng-199"]),
    });

    const actual = await collectLocalStatus({ config: mockConfig });

    expect(actual.orphanedSessions).toEqual(["eng-199"]);
  });

  it("reports an unavailable probe without failing the collection", async () => {
    vi.mocked(workspaces.probe).mockResolvedValue({ kind: "unavailable", error: undefined });

    const actual = await collectLocalStatus({ config: mockConfig });

    expect(actual.workspaceProbe.status).toBe("unavailable");
    expect(actual.tasks[0]?.session).toBe("unknown");
    expect(actual.tasks[0]?.flags).toEqual([]);
    expect(actual.tasks[0]?.hint).toBeUndefined();
  });

  it("carries the probe's failure reason into the document", async () => {
    vi.mocked(workspaces.probe).mockResolvedValue({
      kind: "unavailable",
      error: new Error("cmux unavailable"),
    });

    const actual = await collectLocalStatus({ config: mockConfig });

    expect(actual.workspaceProbe).toEqual({ status: "unavailable", error: "cmux unavailable" });
  });

  it("collects git dirtiness and branch for each worktree", async () => {
    vi.mocked(worktrees.probeWorkingTree).mockResolvedValue({
      kind: "dirty",
      modified: 2,
      untracked: 1,
    });

    const actual = await collectLocalStatus({ config: mockConfig });

    expect(actual.tasks[0]?.worktrees[0]?.git).toEqual({
      kind: "dirty",
      modified: 2,
      untracked: 1,
    });
    expect(actual.tasks[0]?.worktrees[0]?.branch).toBe("eng-220");
  });

  it("attaches only log lines that mention the task", async () => {
    writeFileSync(
      mockConfig.logging.file,
      ["[10:00:00] eng-220 dispatched", "[10:00:01] eng-999 dispatched"].join("\n"),
    );

    const actual = await collectLocalStatus({ config: mockConfig });

    expect(actual.tasks[0]?.recentLogLines).toEqual(["[10:00:00] eng-220 dispatched"]);
  });

  it("reads only the tail of a log larger than the bound", async () => {
    const filler = `${"x".repeat(200)}\n`.repeat(2000);
    writeFileSync(mockConfig.logging.file, `[09:00:00] eng-220 ancient\n${filler}`);

    const actual = await collectLocalStatus({ config: mockConfig });

    expect(actual.tasks[0]?.recentLogLines).toEqual([]);
  });

  it("discards the partial line a tail read starts in the middle of", async () => {
    // The cut lands inside this line, and its tail fragment mentions the task.
    // Treating that fragment as a log line would attribute text to eng-220
    // that was never written about it.
    const oversizedLine = `${"x".repeat(300_000)} eng-220 fragment`;
    writeFileSync(
      mockConfig.logging.file,
      [oversizedLine, "[10:00:00] eng-220 real line"].join("\n"),
    );

    const actual = await collectLocalStatus({ config: mockConfig });

    expect(actual.tasks[0]?.recentLogLines).toEqual(["[10:00:00] eng-220 real line"]);
  });

  it("survives a missing log file", async () => {
    const actual = await collectLocalStatus({ config: mockConfig });

    expect(actual.tasks[0]?.recentLogLines).toEqual([]);
  });
});

function makeIssue(overrides: Partial<SourceIssue> & { id: string }): SourceIssue {
  return {
    source: "linear",
    title: "a title",
    description: "",
    status: "todo",
    repository: "groundcrew",
    agent: "opus",
    assignee: "paul",
    updatedAt: "2026-08-04T03:00:00.000Z",
    blockers: [],
    hasMoreBlockers: false,
    sourceRef: undefined,
    ...overrides,
  };
}

function makeBlocker(overrides: Partial<Blocker> & { id: string }): Blocker {
  return { title: "a blocker", status: "in-progress", ...overrides };
}

function mockBoard(fetch: Board["fetch"]): void {
  vi.mocked(createBoard).mockReturnValue({ fetch } as Board);
}

function mockBoardFetch(issues: SourceIssue[]): void {
  mockBoard(
    vi.fn<Board["fetch"]>(async () => ({
      timestamp: "2026-08-04T03:00:00.000Z",
      issues,
      parentSkips: [],
    })),
  );
}

function mockBoardFetchRejection(error: Error): void {
  mockBoard(
    vi.fn<Board["fetch"]>(async () => {
      throw error;
    }),
  );
}

/**
 * Narrows a fetch result to its payload so tests assert without branching.
 * A failed fetch fails the test here rather than inside an `if`.
 */
function expectPayload(result: RemoteFetchResult): RemoteStatusPayload {
  expect(result.kind).toBe("ok");
  if (result.kind !== "ok") {
    throw new Error("unreachable: the assertion above already failed");
  }
  return result.payload;
}

describe("workspaceProbeUnavailableText", () => {
  it("names the failure when the probe reports one", () => {
    const actual = workspaceProbeUnavailableText({
      kind: "unavailable",
      error: new Error("cmux unavailable"),
    });

    expect(actual).toBe("Workspace probe unavailable: cmux unavailable");
  });

  it("stays generic when the probe reports no reason", () => {
    const actual = workspaceProbeUnavailableText({ kind: "unavailable", error: undefined });

    expect(actual).toBe("Workspace probe unavailable");
  });
});

describe("collectRemoteStatus", () => {
  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "gc-remote-"));
    mockConfig = makeConfig(directory);
  });

  afterEach(() => {
    rmSync(directory, { force: true, recursive: true });
    vi.clearAllMocks();
  });

  it("classifies board issues without subtracting local worktrees", async () => {
    mockBoardFetch([
      makeIssue({ id: "linear:eng-220", status: "in-progress" }),
      makeIssue({ id: "linear:eng-225", status: "todo" }),
      makeIssue({
        id: "linear:eng-215",
        status: "todo",
        blockers: [makeBlocker({ id: "linear:eng-201" })],
      }),
    ]);

    const actual = expectPayload(
      await collectRemoteStatus({ config: mockConfig, pullRequestTargets: [] }),
    );

    expect(actual.inProgress.map((issue) => issue.naturalId)).toEqual(["eng-220"]);
    expect(actual.queueReady.map((issue) => issue.naturalId)).toEqual(["eng-225"]);
    expect(actual.queueBlocked.map((issue) => issue.naturalId)).toEqual(["eng-215"]);
  });

  it("keeps an in-progress issue in the payload even when it has a local worktree", async () => {
    mockBoardFetch([makeIssue({ id: "linear:eng-220", status: "in-progress" })]);

    const actual = expectPayload(
      await collectRemoteStatus({
        config: mockConfig,
        pullRequestTargets: [{ task: "eng-220", dir: "/repos/eng-220", branch: "eng-220" }],
      }),
    );

    expect(actual.inProgress).toHaveLength(1);
  });

  it("excludes a todo that no agent can dispatch", async () => {
    mockBoardFetch([makeIssue({ id: "linear:eng-225", status: "todo", agent: undefined })]);

    const actual = expectPayload(
      await collectRemoteStatus({ config: mockConfig, pullRequestTargets: [] }),
    );

    expect(actual.queueReady).toEqual([]);
  });

  it("treats a todo whose blockers are all done as ready", async () => {
    mockBoardFetch([
      makeIssue({
        id: "linear:eng-225",
        status: "todo",
        blockers: [makeBlocker({ id: "linear:eng-201", status: "done" })],
      }),
    ]);

    const actual = expectPayload(
      await collectRemoteStatus({ config: mockConfig, pullRequestTargets: [] }),
    );

    expect(actual.queueReady.map((issue) => issue.naturalId)).toEqual(["eng-225"]);
  });

  it("keeps only the open blockers on a blocked issue", async () => {
    mockBoardFetch([
      makeIssue({
        id: "linear:eng-215",
        status: "todo",
        blockers: [
          makeBlocker({ id: "linear:eng-200", status: "done" }),
          makeBlocker({ id: "linear:eng-201", status: "in-progress", nativeStatus: "In Progress" }),
        ],
      }),
    ]);

    const actual = expectPayload(
      await collectRemoteStatus({ config: mockConfig, pullRequestTargets: [] }),
    );

    expect(actual.queueBlocked[0]?.blockedBy).toEqual([
      {
        id: "linear:eng-201",
        naturalId: "eng-201",
        status: "in-progress",
        nativeStatus: "In Progress",
      },
    ]);
  });

  it("omits an ambiguous natural id from statusByTask", async () => {
    mockBoardFetch([
      makeIssue({ id: "linear:eng-220", status: "in-progress" }),
      makeIssue({ id: "shell:eng-220", status: "todo", source: "shell" }),
    ]);

    const actual = expectPayload(
      await collectRemoteStatus({ config: mockConfig, pullRequestTargets: [] }),
    );

    expect(actual.statusByTask["eng-220"]).toBeUndefined();
  });

  it("looks up pull requests with the branch the local tier already resolved", async () => {
    mockBoardFetch([]);
    vi.mocked(findPullRequestsForBranch).mockResolvedValue([
      { url: "https://example.test/1", number: 1, state: "open", title: "PR" },
    ]);

    const actual = expectPayload(
      await collectRemoteStatus({
        config: mockConfig,
        pullRequestTargets: [{ task: "eng-220", dir: "/repos/eng-220", branch: "adopted-branch" }],
      }),
    );

    expect(actual.pullRequestsByWorktree["/repos/eng-220"]).toHaveLength(1);
    expect(findPullRequestsForBranch).toHaveBeenCalledWith({
      cwd: "/repos/eng-220",
      branchName: "adopted-branch",
    });
  });

  it("never reads run state, since the local tier already did", async () => {
    mockBoardFetch([]);

    await collectRemoteStatus({
      config: mockConfig,
      pullRequestTargets: [{ task: "eng-220", dir: "/repos/eng-220", branch: "eng-220" }],
    });

    expect(readRunState).not.toHaveBeenCalled();
  });

  it("skips pull request lookups entirely when no task has a worktree", async () => {
    mockBoardFetch([]);

    await collectRemoteStatus({ config: mockConfig, pullRequestTargets: [] });

    expect(findPullRequestsForBranch).not.toHaveBeenCalled();
  });

  it("returns an error result rather than throwing when the fetch fails", async () => {
    mockBoardFetchRejection(new Error("Linear: 401 unauthorized"));

    const actual = await collectRemoteStatus({ config: mockConfig, pullRequestTargets: [] });

    expect(actual).toEqual({ kind: "error", message: "Linear: 401 unauthorized" });
  });
});
