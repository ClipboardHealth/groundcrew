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
import { collectLocalStatus, collectRemoteStatus } from "./statusCollect.ts";

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
    mockConfig = {
      logging: { file: path.join(directory, "groundcrew.log") },
      orchestrator: { maximumInProgress: 4 },
    } as ResolvedConfig;
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
    expect(Object.keys(actual.tasks[0] ?? {})).not.toContain("duration");
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
    vi.mocked(readRunState).mockReturnValue(undefined);

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

function mockBoardFetch(issues: SourceIssue[]): void {
  const mockBoard: Pick<Board, "fetch"> = {
    fetch: vi.fn(async () => ({ timestamp: "2026-08-04T03:00:00.000Z", issues, parentSkips: [] })),
  };
  vi.mocked(createBoard).mockReturnValue(mockBoard as Board);
}

function mockBoardFetchRejection(error: Error): void {
  const mockBoard: Pick<Board, "fetch"> = {
    fetch: vi.fn(async () => {
      throw error;
    }),
  };
  vi.mocked(createBoard).mockReturnValue(mockBoard as Board);
}

describe("collectRemoteStatus", () => {
  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "gc-remote-"));
    mockConfig = {
      logging: { file: path.join(directory, "groundcrew.log") },
      orchestrator: { maximumInProgress: 4 },
      sources: [],
    } as unknown as ResolvedConfig;
    vi.mocked(worktrees.list).mockReturnValue([makeEntry()]);
    vi.mocked(readRunState).mockReturnValue(makeRunState());
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

    const actual = await collectRemoteStatus({ config: mockConfig, localTasks: [] });

    expect(actual.kind).toBe("ok");
    if (actual.kind !== "ok") {
      return;
    }
    expect(actual.payload.inProgress.map((issue) => issue.naturalId)).toEqual(["eng-220"]);
    expect(actual.payload.queueReady.map((issue) => issue.naturalId)).toEqual(["eng-225"]);
    expect(actual.payload.queueBlocked.map((issue) => issue.naturalId)).toEqual(["eng-215"]);
  });

  it("keeps an in-progress issue in the payload even when it has a local worktree", async () => {
    mockBoardFetch([makeIssue({ id: "linear:eng-220", status: "in-progress" })]);

    const actual = await collectRemoteStatus({ config: mockConfig, localTasks: ["eng-220"] });

    expect(actual.kind === "ok" && actual.payload.inProgress).toHaveLength(1);
  });

  it("excludes a todo that no agent or repository can dispatch", async () => {
    mockBoardFetch([makeIssue({ id: "linear:eng-225", status: "todo", agent: undefined })]);

    const actual = await collectRemoteStatus({ config: mockConfig, localTasks: [] });

    expect(actual.kind === "ok" && actual.payload.queueReady).toEqual([]);
  });

  it("treats a todo whose blockers are all done as ready", async () => {
    mockBoardFetch([
      makeIssue({
        id: "linear:eng-225",
        status: "todo",
        blockers: [makeBlocker({ id: "linear:eng-201", status: "done" })],
      }),
    ]);

    const actual = await collectRemoteStatus({ config: mockConfig, localTasks: [] });

    expect(actual.kind === "ok" && actual.payload.queueReady.map((issue) => issue.naturalId)).toEqual([
      "eng-225",
    ]);
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

    const actual = await collectRemoteStatus({ config: mockConfig, localTasks: [] });

    expect(actual.kind === "ok" && actual.payload.queueBlocked[0]?.blockedBy).toEqual([
      { id: "linear:eng-201", status: "in-progress", nativeStatus: "In Progress" },
    ]);
  });

  it("omits an ambiguous natural id from statusByTask", async () => {
    mockBoardFetch([
      makeIssue({ id: "linear:eng-220", status: "in-progress" }),
      makeIssue({ id: "shell:eng-220", status: "todo", source: "shell" }),
    ]);

    const actual = await collectRemoteStatus({ config: mockConfig, localTasks: [] });

    expect(actual.kind === "ok" && actual.payload.statusByTask["eng-220"]).toBeUndefined();
  });

  it("collects pull requests only for tasks with a local worktree", async () => {
    mockBoardFetch([]);
    vi.mocked(findPullRequestsForBranch).mockResolvedValue([
      { url: "https://example.test/1", number: 1, state: "open", title: "PR" },
    ]);

    const actual = await collectRemoteStatus({ config: mockConfig, localTasks: ["eng-220"] });

    expect(actual.kind === "ok" && actual.payload.pullRequestsByTask["eng-220"]).toHaveLength(1);
    expect(findPullRequestsForBranch).toHaveBeenCalledTimes(1);
  });

  it("skips pull request lookups entirely when no task has a worktree", async () => {
    mockBoardFetch([]);

    await collectRemoteStatus({ config: mockConfig, localTasks: [] });

    expect(findPullRequestsForBranch).not.toHaveBeenCalled();
  });

  it("returns an error result rather than throwing when the fetch fails", async () => {
    mockBoardFetchRejection(new Error("Linear: 401 unauthorized"));

    const actual = await collectRemoteStatus({ config: mockConfig, localTasks: [] });

    expect(actual).toEqual({ kind: "error", message: "Linear: 401 unauthorized" });
  });
});
