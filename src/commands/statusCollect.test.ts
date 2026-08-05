import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ResolvedConfig } from "../lib/config.ts";
import { readRunState, type RunState } from "../lib/runState.ts";
import { workspaces } from "../lib/workspaces.ts";
import { type WorktreeEntry, worktrees } from "../lib/worktrees.ts";
import { collectLocalStatus } from "./statusCollect.ts";

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
