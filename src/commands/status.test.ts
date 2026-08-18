/* oxlint-disable eslint/max-lines -- status text and JSON share one mocked collection boundary. */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildSources } from "../lib/buildSources.ts";
import { loadConfig, type ResolvedConfig } from "../lib/config.ts";
import { findPullRequestsForBranch, type PullRequestSummary } from "../lib/pullRequests.ts";
import { readRunState, type RunState } from "../lib/runState.ts";
import type { Issue as SourceIssue, TaskSource } from "../lib/taskSource.ts";
import { log, setVerbose } from "../lib/util.ts";
import { type WorkspaceProbe, workspaces } from "../lib/workspaces.ts";
import { type WorktreeDirtiness, type WorktreeEntry, worktrees } from "../lib/worktrees.ts";
import { probeEffectiveBranchNameFromRunState } from "../lib/worktreeRunState.ts";
import { captureConsoleLog, type ConsoleCapture } from "../testHelpers/consoleCapture.ts";
import { collectStatus, renderStatusJson, renderStatusText, status, statusCli } from "./status.ts";

vi.mock(import("../lib/config.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, loadConfig: vi.fn<typeof loadConfig>() };
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
      findByTask: vi.fn<typeof actual.worktrees.findByTask>(),
      list: vi.fn<typeof actual.worktrees.list>(),
      probeWorkingTree: vi.fn<typeof actual.worktrees.probeWorkingTree>(),
    },
  };
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
vi.mock(import("../lib/worktreeRunState.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    probeEffectiveBranchNameFromRunState:
      vi.fn<typeof actual.probeEffectiveBranchNameFromRunState>(),
  };
});

const loadConfigMock = vi.mocked(loadConfig);
const readRunStateMock = vi.mocked(readRunState);
const workspaceProbeMock = vi.mocked(workspaces.probe);
const workspaceAccessHintMock = vi.mocked(workspaces.accessHint);
const findByTaskMock = vi.mocked(worktrees.findByTask);
const listWorktreesMock = vi.mocked(worktrees.list);
const probeWorkingTreeMock = vi.mocked(worktrees.probeWorkingTree);
const buildSourcesMock = vi.mocked(buildSources);
const findPullRequestsMock = vi.mocked(findPullRequestsForBranch);
const probeEffectiveBranchMock = vi.mocked(probeEffectiveBranchNameFromRunState);

function sourceIssue(overrides: Partial<SourceIssue> = {}): SourceIssue {
  return {
    id: "linear:team-1",
    source: "linear",
    title: "Queued task",
    description: "",
    status: "todo",
    repository: "repo-a",
    agent: "claude",
    assignee: "me",
    updatedAt: "2026-05-26T00:00:00.000Z",
    blockers: [],
    hasMoreBlockers: false,
    sourceRef: {},
    ...overrides,
  };
}

async function noop(): Promise<void> {
  await Promise.resolve();
}

const markInReview: TaskSource["markInReview"] = async () => ({ outcome: "applied" });

async function flushMicrotasks(count = 10): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    // oxlint-disable-next-line no-await-in-loop -- test helper intentionally drains queued promise work.
    await Promise.resolve();
  }
}

function fakeSource(
  issues: readonly SourceIssue[],
  overrides: {
    name?: string;
    listTasks?: TaskSource["listTasks"];
    getTask?: TaskSource["getTask"];
    fetch?: TaskSource["fetch"];
    resolveOne?: TaskSource["resolveOne"];
  } = {},
): TaskSource {
  const listTasks: TaskSource["listTasks"] =
    overrides.listTasks ?? overrides.fetch ?? (async () => [...issues]);
  const getTask: TaskSource["getTask"] =
    overrides.getTask ??
    (overrides.resolveOne === undefined
      ? async (naturalId) =>
          issues.find((issue) => issue.id === `${issue.source}:${naturalId.toLowerCase()}`) ?? null
      : async (naturalId) => (await overrides.resolveOne?.(naturalId)) ?? null);
  const fetch: TaskSource["fetch"] = overrides.fetch ?? listTasks;
  const resolveOne: TaskSource["resolveOne"] =
    overrides.resolveOne ?? (async (naturalId) => (await getTask(naturalId)) ?? undefined);
  return {
    name: overrides.name ?? "linear",
    verify: noop,
    listTasks,
    getTask,
    fetch,
    resolveOne,
    markInProgress: noop,
    markInReview,
  };
}

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    sources: overrides.sources ?? [],
    defaults: { hooks: {} },
    git: { remote: "origin", defaultBranch: "main", ...overrides.git },
    workspace: {
      projectDir: "/work",
      knownRepositories: ["repo-a", "repo-b"],
      repositories: [{ name: "repo-a" }, { name: "repo-b" }],
      ...overrides.workspace,
    },
    orchestrator: {
      maximumInProgress: 4,
      pollIntervalMilliseconds: 1000,
      sessionLimitPercentage: 85,
      ...overrides.orchestrator,
    },
    agents: {
      default: "claude",
      definitions: {
        claude: { cmd: "claude", color: "#fff" },
        codex: { cmd: "codex", color: "#000" },
      },
      ...overrides.agents,
    },
    prompts: { initial: "x", ...overrides.prompts },
    workspaceKind: overrides.workspaceKind ?? "auto",
    local: {
      runner: "auto",
      networkEgress: "allowlisted",
      safehouse: { enable: [] },
      readOnlyDirs: [],
      ...overrides.local,
    },
    logging: { file: "/tmp/groundcrew-test.log", ...overrides.logging },
  };
}

function worktree(overrides: Partial<WorktreeEntry> = {}): WorktreeEntry {
  return {
    repository: "repo-a",
    task: "team-1",
    branchName: "dev-team-1",
    dir: "/work/repo-a-team-1",
    kind: "host",
    ...overrides,
  };
}

/** Each worktree directory gets its own pull requests; anything else gets none. */
function stubPullRequestsByDirectory(prsByDirectory: Record<string, PullRequestSummary[]>): void {
  findPullRequestsMock.mockImplementation(async ({ cwd }) => prsByDirectory[cwd] ?? []);
}

function runState(overrides: Partial<RunState> = {}): RunState {
  return {
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
    ...overrides,
  };
}

describe(status, () => {
  let consoleLog: ConsoleCapture;
  let temporaryDirectory: string;

  beforeEach(() => {
    // Pin the clock to createdAt + 2h 14m so `state: running (...)` lines
    // include a deterministic `2h 14m` duration token.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-05-26T02:14:30.000Z"));
    consoleLog = captureConsoleLog();
    temporaryDirectory = mkdtempSync(path.join(tmpdir(), "groundcrew-status-test-"));
    readRunStateMock.mockReturnValue(runState({ reason: "manual pause" }));
    workspaceProbeMock.mockResolvedValue({ kind: "ok", names: new Set(["team-1"]) });
    workspaceAccessHintMock.mockReset();
    findPullRequestsMock.mockResolvedValue([]);
    buildSourcesMock.mockResolvedValue([]);
    findByTaskMock.mockReturnValue([worktree()]);
    listWorktreesMock.mockReturnValue([worktree()]);
    probeWorkingTreeMock.mockResolvedValue({ kind: "clean" });
    probeEffectiveBranchMock.mockImplementation(async ({ entry, runState }) => ({
      branch: runState?.branchName ?? entry.branchName,
    }));
  });

  afterEach(() => {
    consoleLog.restore();
    rmSync(temporaryDirectory, { recursive: true, force: true });
    vi.resetAllMocks();
    vi.useRealTimers();
  });

  it("prints the read-only per-task status dump", async () => {
    const logFile = path.join(temporaryDirectory, "groundcrew.log");
    writeFileSync(
      logFile,
      [
        "[09:00:00] unrelated task",
        "event=dispatch outcome=started task=team-1",
        "event=dispatch outcome=started task=team-10",
        '[09:01:00] Workspace "TEAM-1" launched',
      ].join("\n"),
    );
    const config = makeConfig({ logging: { file: logFile } });
    const entries = [
      worktree({ repository: "repo-a", dir: "/work/repo-a-team-1" }),
      worktree({ repository: "repo-b", dir: "/work/repo-b-team-1", branchName: "dev-team-1-b" }),
      worktree({
        repository: "repo-b",
        dir: "/work/repo-b-team-1-alt",
        branchName: "dev-team-1-c",
      }),
    ];
    findByTaskMock.mockReturnValue(entries);
    probeWorkingTreeMock
      .mockResolvedValueOnce({ kind: "clean" } satisfies WorktreeDirtiness)
      .mockResolvedValueOnce({ kind: "dirty", modified: 2, untracked: 1 })
      .mockResolvedValueOnce({ kind: "unknown" });
    buildSourcesMock.mockResolvedValue([
      fakeSource([
        sourceIssue({
          title: "Fix status",
          status: "in-progress",
          url: "https://linear.app/example/issue/TEAM-1",
        }),
      ]),
    ]);

    await status(config, { task: "team-1" });

    const output = consoleLog.output();
    expect(output).toContain("groundcrew status TEAM-1");
    expect(output).not.toContain("Config snapshot");
    expect(output).toContain(
      "run: running; agent=claude; updated=2026-05-26T00:01:00.000Z; resumes=0",
    );
    expect(output).toContain("manual pause");
    expect(output).toContain("workspace: live");
    expect(output).toContain("Worktrees");
    expect(output).toContain("repo-a host");
    expect(output).not.toContain("  task: team-1");
    expect(output).toContain("git: clean");
    expect(output).toContain("git: dirty (2 modified, 1 untracked)");
    expect(output).toContain("git: unknown");
    expect(output).toContain("Recent logs");
    expect(output).toContain("event=dispatch outcome=started task=team-1");
    expect(output).not.toContain("task=team-10");
    expect(output).toContain('Workspace "TEAM-1" launched');
    expect(output).not.toContain("unrelated task");
    expect(output).not.toContain("Task source");
    expect(output).toContain("task: team-1  in-progress  https://linear.app/example/issue/TEAM-1");
    expect(output).toContain("title: Fix status");
  });

  it("collects silently and renders task text and JSON from the same snapshot", async () => {
    const logFile = path.join(temporaryDirectory, "groundcrew.log");
    writeFileSync(logFile, "[09:01:00] Workspace team-1 launched\n");
    buildSourcesMock.mockResolvedValue([
      fakeSource([
        sourceIssue({
          title: "Fix status",
          status: "in-progress",
          url: "https://linear.app/example/issue/TEAM-1",
        }),
      ]),
    ]);

    const snapshot = await collectStatus(makeConfig({ logging: { file: logFile } }), {
      task: "team-1",
    });

    expect(consoleLog.output()).toBe("");
    renderStatusText({ ...snapshot });
    expect(consoleLog.output()).toContain("groundcrew status TEAM-1");
    expect(consoleLog.output()).toContain("Workspace team-1 launched");
    consoleLog.restore();
    consoleLog = captureConsoleLog();

    renderStatusJson(snapshot);

    expect(JSON.parse(consoleLog.output())).toMatchObject({ kind: "task" });
    expect(consoleLog.output()).not.toContain("Workspace team-1 launched");
  });

  it("shows the run-state branch (not the derived one) for an opened PR worktree", async () => {
    readRunStateMock.mockReturnValue(runState({ branchName: "jdoe/fix-thing" }));
    findByTaskMock.mockReturnValue([worktree({ branchName: "dev-team-1" })]);
    probeWorkingTreeMock.mockResolvedValue({ kind: "clean" });
    buildSourcesMock.mockResolvedValue([fakeSource([])]);

    await status(makeConfig(), { task: "team-1" });

    expect(consoleLog.output()).toContain("branch: jdoe/fix-thing");
    expect(findPullRequestsMock).toHaveBeenCalledWith(
      expect.objectContaining({ branchName: "jdoe/fix-thing" }),
    );
  });

  it("prints unavailable fields without attempting recovery", async () => {
    const config = makeConfig({ logging: { file: path.join(temporaryDirectory, "missing.log") } });
    findByTaskMock.mockReturnValue([]);
    workspaceProbeMock.mockResolvedValue({ kind: "ok", names: new Set() });
    readRunStateMock.mockReset();
    buildSourcesMock.mockRejectedValue(new Error("source down"));

    await status(config, { task: "team-404" });

    const output = consoleLog.output();
    expect(output).toContain("task: team-404  source unavailable: source down");
    expect(output).toContain("run: (none)");
    expect(output).toContain("workspace: not live");
    expect(output).toContain("Worktrees");
    expect(output).toContain("(none)");
    expect(output).not.toContain("Recent logs");
    expect(output).not.toContain("Task source");
  });

  it("prints exited workspace status and attach command when a kept tmux window has exited", async () => {
    workspaceProbeMock.mockResolvedValue({
      kind: "ok",
      names: new Set(["team-1"]),
      exitedNames: new Set(["team-1"]),
    });
    workspaceAccessHintMock.mockResolvedValue({
      kind: "attachCommand",
      command: "tmux attach -t groundcrew:team-1",
    });

    await status(makeConfig(), { task: "team-1" });

    const output = consoleLog.output();
    expect(output).toContain("workspace: exited");
    expect(output).toContain("attach: tmux attach -t groundcrew:team-1");
  });

  it("still prints exited workspace status when the attach hint lookup fails", async () => {
    workspaceProbeMock.mockResolvedValue({
      kind: "ok",
      names: new Set(["team-1"]),
      exitedNames: new Set(["team-1"]),
    });
    workspaceAccessHintMock.mockRejectedValue(new Error("tmux unavailable"));

    await status(makeConfig(), { task: "team-1" });

    const output = consoleLog.output();
    expect(output).toContain("workspace: exited");
    expect(output).not.toContain("attach:");
    expect(output).not.toContain("tmux unavailable");
  });

  it("rejects an empty direct-call task", async () => {
    await expect(status(makeConfig(), { task: "   " })).rejects.toThrow(
      "task must be a non-empty value",
    );

    expect(findByTaskMock).not.toHaveBeenCalled();
    expect(listWorktreesMock).not.toHaveBeenCalled();
  });

  it.each(["   ", "-invalid"])("rejects invalid direct collection task %j", async (task) => {
    await expect(collectStatus(makeConfig(), { task })).rejects.toThrow(
      "task must be a non-empty value",
    );
  });

  it("prints a run-state summary without optional detail and source status", async () => {
    readRunStateMock.mockReturnValue(runState());
    buildSourcesMock.mockResolvedValue([
      fakeSource([sourceIssue({ title: "No state type", status: "other" })]),
    ]);

    await status(makeConfig(), { task: "team-1" });

    const output = consoleLog.output();
    expect(output).toContain("running; agent=claude; updated=2026-05-26T00:01:00.000Z; resumes=0");
    expect(output).toContain("task: team-1  other");
    expect(output).toContain("title: No state type");
  });

  it("prints run-state detail when only detail is recorded", async () => {
    readRunStateMock.mockReturnValue(
      runState({ state: "failed-to-launch", detail: "spawn failed" }),
    );

    await status(makeConfig(), { task: "team-1" });

    expect(consoleLog.output()).toContain("failed-to-launch");
    expect(consoleLog.output()).toContain("spawn failed");
  });

  it("flags the per-task run: line as `session dead` when running but no session is live", async () => {
    readRunStateMock.mockReturnValue(runState({ state: "running" }));
    workspaceProbeMock.mockResolvedValue({ kind: "ok", names: new Set() });

    await status(makeConfig(), { task: "team-1" });

    expect(consoleLog.output()).toContain(
      "run: running (session dead); agent=claude; updated=2026-05-26T00:01:00.000Z; resumes=0",
    );
  });

  it("flags the per-task run: line as `session exited` when the kept tmux window has exited", async () => {
    readRunStateMock.mockReturnValue(runState({ state: "running" }));
    workspaceProbeMock.mockResolvedValue({
      kind: "ok",
      names: new Set(["team-1"]),
      exitedNames: new Set(["team-1"]),
    });

    await status(makeConfig(), { task: "team-1" });

    expect(consoleLog.output()).toContain(
      "run: running (session exited); agent=claude; updated=2026-05-26T00:01:00.000Z; resumes=0",
    );
  });

  it("renders the per-task run: line as bare `provisioning` while the worktree is being created", async () => {
    // Provisioning runs before worktrees.create() resolves, so there is no
    // live workspace yet — make sure the status view doesn't decorate the
    // line with `session dead` (running/resumed only) or any duration token.
    readRunStateMock.mockReturnValue(runState({ state: "provisioning" }));
    workspaceProbeMock.mockResolvedValue({ kind: "ok", names: new Set() });

    await status(makeConfig(), { task: "team-1" });

    const output = consoleLog.output();
    expect(output).toContain("run: provisioning;");
    expect(output).not.toContain("idle");
    expect(output).not.toContain("session dead");
    expect(output).not.toContain("session exited");
  });

  it("leaves the per-task run: line as bare `running` when the session is live", async () => {
    readRunStateMock.mockReturnValue(runState({ state: "running" }));
    workspaceProbeMock.mockResolvedValue({ kind: "ok", names: new Set(["team-1"]) });

    await status(makeConfig(), { task: "team-1" });

    const output = consoleLog.output();
    expect(output).toContain("run: running; agent=claude;");
    expect(output).not.toContain("session dead");
    expect(output).not.toContain("session exited");
  });

  it("leaves the per-task run: line unflagged when the workspace probe is unavailable", async () => {
    readRunStateMock.mockReturnValue(runState({ state: "running" }));
    workspaceProbeMock.mockResolvedValue({ kind: "unavailable" });

    await status(makeConfig(), { task: "team-1" });

    const output = consoleLog.output();
    expect(output).toContain("run: running; agent=claude;");
    expect(output).not.toContain("session dead");
    expect(output).not.toContain("session exited");
  });

  it("keeps the per-task run: line as `(none)` when a stray session is live but no run-state exists", async () => {
    // With no run-state, the `run:` line stays `(none)` even though the probe
    // sees a live session for this task. The stray-session disagreement is
    // surfaced by the `workspace: live` line (and the inventory view's
    // `hint: crew cleanup`), not by decorating the per-task `run:` line.
    readRunStateMock.mockReset();
    workspaceProbeMock.mockResolvedValue({ kind: "ok", names: new Set(["team-1"]) });

    await status(makeConfig(), { task: "team-1" });

    const output = consoleLog.output();
    expect(output).toContain("run: (none)");
    expect(output).not.toContain("stray session");
    expect(output).toContain("workspace: live");
  });

  it("surfaces the cached task title at the top of the per-task view", async () => {
    readRunStateMock.mockReturnValue(runState({ title: "Improve crew status command" }));

    await status(makeConfig(), { task: "team-1" });

    const output = consoleLog.output();
    const titleIndex = output.indexOf("title: Improve crew status command");
    const runIndex = output.indexOf("run:");
    expect(titleIndex).toBeGreaterThanOrEqual(0);
    expect(runIndex).toBeGreaterThan(titleIndex);
  });

  it("omits duplicate source title when it matches the cached title", async () => {
    readRunStateMock.mockReturnValue(runState({ title: "Improve crew status command" }));
    buildSourcesMock.mockResolvedValue([
      fakeSource([sourceIssue({ title: "Improve crew status command" })]),
    ]);

    await status(makeConfig(), { task: "team-1" });

    expect(consoleLog.output().match(/title: Improve crew status command/g)).toHaveLength(1);
  });

  it("prints a changed source title separately from the cached title", async () => {
    readRunStateMock.mockReturnValue(runState({ title: "Cached title" }));
    buildSourcesMock.mockResolvedValue([fakeSource([sourceIssue({ title: "Current title" })])]);

    await status(makeConfig(), { task: "team-1" });

    const output = consoleLog.output();
    expect(output).toContain("title: Cached title");
    expect(output).toContain("source title: Current title");
  });

  it("omits the cached title line when no run state has a title", async () => {
    readRunStateMock.mockReturnValue(runState());

    await status(makeConfig(), { task: "team-1" });

    const output = consoleLog.output();
    const headerSection = output.slice(0, output.indexOf("run:"));
    expect(headerSection).not.toContain("title:");
  });

  it("prints an inventory when no task is provided", async () => {
    listWorktreesMock.mockReturnValue([
      worktree({ task: "team-1", repository: "repo-a", dir: "/work/repo-a-team-1" }),
      worktree({
        task: "team-1",
        repository: "repo-b",
        branchName: "dev-team-1-b",
        dir: "/work/repo-b-team-1",
      }),
      worktree({
        task: "team-2",
        repository: "repo-b",
        branchName: "dev-team-2",
        dir: "/work/repo-b-team-2",
      }),
    ]);
    const statesByTask = new Map([["team-1", runState({ task: "team-1" })]]);
    readRunStateMock.mockImplementation((_config, task) => statesByTask.get(task));
    workspaceProbeMock.mockResolvedValue({
      kind: "ok",
      names: new Set(["team-2", "orphan-workspace"]),
    });

    await status(makeConfig());

    const output = consoleLog.output();
    expect(output).not.toContain("groundcrew status\n");
    expect(output).toContain("Worktrees");
    // No `host` kind in the new layout; rows are labeled key-value.
    expect(output).not.toContain("host  workspace=");
    // team-1 has a running RunState but workspace probe says no — orphan.
    expect(output).toContain("team-1\n  state:     running (session dead, 2h 14m)");
    expect(output).toContain("  repo:      repo-a");
    expect(output).toContain("  worktree:  /work/repo-a-team-1");
    // Inventory rows intentionally omit `branch:` — derivable, low signal.
    // The per-task view (`crew status TEAM-1`) still surfaces it.
    expect(output).not.toContain("  branch:");
    // team-2 has no RunState but the probe sees a session — stray session.
    expect(output).toContain("team-2\n  state:     idle (stray session)");
    expect(output).toContain("Orphaned sessions (no matching worktree)");
    expect(output).toContain(
      "What to do: run 'crew stop <task>' to close the session, or 'tmux kill-session -t <task>' if no run-state exists.",
    );
    // team-1/team-2 sessions are tied to worktrees and should NOT appear as strays.
    expect(output).toMatch(
      /Orphaned sessions \(no matching worktree\)\n-+\nWhat to do: [^\n]+\norphan-workspace\n/,
    );
    expect(readRunStateMock).toHaveBeenCalledTimes(2);
  });

  it("prints the cached task title and attach hint in the inventory when available", async () => {
    listWorktreesMock.mockReturnValue([
      worktree({ task: "team-1", repository: "repo-a" }),
      worktree({ task: "team-2", repository: "repo-b", branchName: "dev-team-2" }),
    ]);
    const statesByTask = new Map([
      ["team-1", runState({ task: "team-1", title: "Improve crew status command" })],
      // team-2 has a run state but no cached title — title line must be omitted.
      ["team-2", runState({ task: "team-2" })],
    ]);
    readRunStateMock.mockImplementation((_config, task) => statesByTask.get(task));
    // Worktrees iterate in sorted-task order: team-1 first, then team-2.
    // First call returns a hint; second (team-2) falls through to the
    // default `vi.fn` return of undefined.
    workspaceAccessHintMock.mockResolvedValueOnce({
      kind: "attachCommand",
      command: "tmux attach -t crew:team-1",
    });

    await status(makeConfig());

    const output = consoleLog.output();
    expect(output).toContain("  title:     Improve crew status command");
    expect(output).toContain("  attach:    tmux attach -t crew:team-1");
    // team-2 has neither a cached title nor an access hint; no extra lines.
    expect(output).not.toMatch(/team-2[\s\S]* {2}title:/);
    expect(output).not.toMatch(/team-2[\s\S]* {2}attach:/);
  });

  it("omits only the failed attach hint when one workspace access hint lookup rejects", async () => {
    listWorktreesMock.mockReturnValue([
      worktree({ task: "team-1", repository: "repo-a" }),
      worktree({ task: "team-2", repository: "repo-b", branchName: "dev-team-2" }),
    ]);
    workspaceAccessHintMock
      .mockRejectedValueOnce(new Error("tmux unavailable"))
      .mockResolvedValueOnce({
        kind: "attachCommand",
        command: "tmux attach -t crew:team-2",
      });

    await status(makeConfig());

    const output = consoleLog.output();
    expect(output).toContain("team-1\n  state:");
    expect(output).toContain("team-2\n  state:");
    expect(output).not.toContain("tmux unavailable");
    expect(output).toContain("  attach:    tmux attach -t crew:team-2");
  });

  it("omits only the failed pull request row when one PR lookup rejects", async () => {
    listWorktreesMock.mockReturnValue([
      worktree({ task: "team-1", repository: "repo-a", dir: "/work/repo-a-team-1" }),
      worktree({
        task: "team-2",
        repository: "repo-b",
        dir: "/work/repo-b-team-2",
        branchName: "dev-team-2",
      }),
    ]);
    findPullRequestsMock.mockRejectedValueOnce(new Error("gh rate limited")).mockResolvedValueOnce([
      {
        url: "https://github.com/acme/widgets/pull/42",
        number: 42,
        state: "open",
        title: "Wire up auth",
      },
    ]);

    await status(makeConfig());

    const output = consoleLog.output();
    expect(output).toContain("team-1\n  state:");
    expect(output).toContain("team-2\n  state:");
    expect(output).not.toContain("gh rate limited");
    expect(output).toContain("  pr:        https://github.com/acme/widgets/pull/42 (open)");
  });

  it("hides the Orphaned sessions section when every live session matches a worktree", async () => {
    listWorktreesMock.mockReturnValue([worktree({ task: "team-1", repository: "repo-a" })]);
    workspaceProbeMock.mockResolvedValue({ kind: "ok", names: new Set(["team-1"]) });

    await status(makeConfig());

    expect(consoleLog.output()).not.toContain("Orphaned sessions");
  });

  it("formats durations across <1m / Nm / Nh / Nh Mm / Nd / Nd Mh ranges", async () => {
    listWorktreesMock.mockReturnValue([
      worktree({ task: "team-1", repository: "repo-a" }),
      worktree({ task: "team-2", repository: "repo-b", branchName: "dev-team-2" }),
      worktree({ task: "team-3", repository: "repo-b", branchName: "dev-team-3" }),
      worktree({ task: "team-4", repository: "repo-b", branchName: "dev-team-4" }),
      worktree({ task: "team-5", repository: "repo-b", branchName: "dev-team-5" }),
      worktree({ task: "team-6", repository: "repo-b", branchName: "dev-team-6" }),
    ]);
    workspaceProbeMock.mockResolvedValue({
      kind: "ok",
      names: new Set(["team-1", "team-2", "team-3", "team-4", "team-5", "team-6"]),
    });
    // beforeEach pinned now to 2026-05-26T02:14:30Z.
    const statesByTask = new Map<string, RunState>([
      // ~30s old → `<1m`
      ["team-1", runState({ task: "team-1", createdAt: "2026-05-26T02:14:00.000Z" })],
      // 12m old → `12m`
      ["team-2", runState({ task: "team-2", createdAt: "2026-05-26T02:02:30.000Z" })],
      // 3d 7h old → `3d 7h`
      ["team-3", runState({ task: "team-3", createdAt: "2026-05-22T19:14:30.000Z" })],
      // Malformed createdAt → no duration token
      ["team-4", runState({ task: "team-4", createdAt: "not a date" })],
      // Exactly 5h old → `5h` (whole-hour branch)
      ["team-5", runState({ task: "team-5", createdAt: "2026-05-25T21:14:30.000Z" })],
      // Exactly 4d old → `4d` (whole-day branch)
      ["team-6", runState({ task: "team-6", createdAt: "2026-05-22T02:14:30.000Z" })],
    ]);
    readRunStateMock.mockImplementation((_config, task) => statesByTask.get(task));

    await status(makeConfig());

    const output = consoleLog.output();
    expect(output).toContain("team-1\n  state:     running (<1m)");
    expect(output).toContain("team-2\n  state:     running (12m)");
    expect(output).toContain("team-3\n  state:     running (3d 7h)");
    // Malformed createdAt → no duration token.
    expect(output).toContain("team-4\n  state:     running\n");
    expect(output).toContain("team-5\n  state:     running (5h)");
    expect(output).toContain("team-6\n  state:     running (4d)");
  });

  it("omits the duration from non-running states (interrupted, idle)", async () => {
    listWorktreesMock.mockReturnValue([
      worktree({ task: "team-1", repository: "repo-a" }),
      worktree({ task: "team-2", repository: "repo-b", branchName: "dev-team-2" }),
    ]);
    workspaceProbeMock.mockResolvedValue({ kind: "ok", names: new Set() });
    const statesByTask = new Map<string, RunState>([
      ["team-1", runState({ task: "team-1", state: "interrupted" })],
    ]);
    readRunStateMock.mockImplementation((_config, task) => statesByTask.get(task));

    await status(makeConfig());

    const output = consoleLog.output();
    expect(output).toContain("  state:     interrupted\n");
    expect(output).toContain("  state:     idle\n");
  });

  it("suggests `crew cleanup` next to stray-session rows", async () => {
    listWorktreesMock.mockReturnValue([worktree({ task: "team-1", repository: "repo-a" })]);
    // idle (no run-state) + live session => stray.
    readRunStateMock.mockReset();
    workspaceProbeMock.mockResolvedValue({ kind: "ok", names: new Set(["team-1"]) });

    await status(makeConfig());

    expect(consoleLog.output()).toContain(
      "  hint:      run 'crew cleanup team-1' to clear this stray session",
    );
  });

  it("suggests `crew resume` next to session-dead rows", async () => {
    listWorktreesMock.mockReturnValue([worktree({ task: "team-1", repository: "repo-a" })]);
    // running run-state + no live session => session dead.
    readRunStateMock.mockReturnValue(runState({ state: "running" }));
    workspaceProbeMock.mockResolvedValue({ kind: "ok", names: new Set() });

    await status(makeConfig());

    expect(consoleLog.output()).toContain(
      "  hint:      run 'crew resume team-1' to bring the session back",
    );
  });

  it("marks running inventory rows as exited when a kept tmux window has exited", async () => {
    listWorktreesMock.mockReturnValue([worktree({ task: "team-1", repository: "repo-a" })]);
    readRunStateMock.mockReturnValue(runState({ state: "running" }));
    workspaceProbeMock.mockResolvedValue({
      kind: "ok",
      names: new Set(["team-1"]),
      exitedNames: new Set(["team-1"]),
    });
    workspaceAccessHintMock.mockResolvedValue({
      kind: "attachCommand",
      command: "tmux attach -t groundcrew:team-1",
    });

    await status(makeConfig());

    const output = consoleLog.output();
    expect(output).toContain("  state:     running (session exited, 2h 14m)");
    expect(output).toContain("  attach:    tmux attach -t groundcrew:team-1");
    expect(output).toContain(
      "  hint:      attach to inspect scrollback, then run 'crew resume team-1'",
    );
  });

  it("marks idle inventory rows as stray exited sessions when a kept tmux window has exited", async () => {
    listWorktreesMock.mockReturnValue([worktree({ task: "team-1", repository: "repo-a" })]);
    readRunStateMock.mockReset();
    workspaceProbeMock.mockResolvedValue({
      kind: "ok",
      names: new Set(["team-1"]),
      exitedNames: new Set(["team-1"]),
    });

    await status(makeConfig());

    const output = consoleLog.output();
    expect(output).toContain("  state:     idle (stray exited session)");
    expect(output).toContain(
      "  hint:      run 'crew cleanup team-1' to clear this stray exited session",
    );
  });

  it("omits the `hint:` line on healthy rows", async () => {
    listWorktreesMock.mockReturnValue([worktree({ task: "team-1", repository: "repo-a" })]);
    readRunStateMock.mockReturnValue(runState({ state: "running" }));
    workspaceProbeMock.mockResolvedValue({ kind: "ok", names: new Set(["team-1"]) });

    await status(makeConfig());

    expect(consoleLog.output()).not.toContain("  hint:");
  });

  it("omits the `hint:` line when the workspace probe is unavailable", async () => {
    listWorktreesMock.mockReturnValue([worktree({ task: "team-1", repository: "repo-a" })]);
    workspaceProbeMock.mockResolvedValue({ kind: "unavailable" });

    await status(makeConfig());

    expect(consoleLog.output()).not.toContain("  hint:");
  });

  it("labels run state as `idle` when no RunState file exists and no session is live", async () => {
    listWorktreesMock.mockReturnValue([worktree({ task: "team-1", repository: "repo-a" })]);
    readRunStateMock.mockReset();
    workspaceProbeMock.mockResolvedValue({ kind: "ok", names: new Set() });

    await status(makeConfig());

    const output = consoleLog.output();
    expect(output).toContain("team-1\n  state:     idle\n");
    expect(output).not.toContain("session dead");
    expect(output).not.toContain("stray session");
  });

  it("renders a `pr:` line in inventory rows when gh finds a pull request", async () => {
    listWorktreesMock.mockReturnValue([
      worktree({ task: "team-1", repository: "repo-a", dir: "/work/repo-a-team-1" }),
    ]);
    findPullRequestsMock.mockResolvedValue([
      {
        url: "https://github.com/acme/widgets/pull/42",
        number: 42,
        state: "open",
        title: "Wire up auth",
      },
    ]);

    await status(makeConfig());

    expect(consoleLog.output()).toContain(
      "  pr:        https://github.com/acme/widgets/pull/42 (open)",
    );
    expect(findPullRequestsMock).toHaveBeenCalledWith({
      cwd: "/work/repo-a-team-1",
      branchName: "dev-team-1",
    });
  });

  it("joins multiple PRs on one line in inventory rows", async () => {
    listWorktreesMock.mockReturnValue([worktree({ task: "team-1", repository: "repo-a" })]);
    findPullRequestsMock.mockResolvedValue([
      {
        url: "https://x/pull/1",
        number: 1,
        state: "open",
        title: "a",
      },
      {
        url: "https://x/pull/2",
        number: 2,
        state: "merged",
        title: "b",
      },
    ]);

    await status(makeConfig());

    expect(consoleLog.output()).toContain(
      "  pr:        https://x/pull/1 (open), https://x/pull/2 (merged)",
    );
  });

  it("omits the `pr:` line in inventory rows when gh returns nothing", async () => {
    listWorktreesMock.mockReturnValue([worktree({ task: "team-1", repository: "repo-a" })]);
    findPullRequestsMock.mockResolvedValue([]);

    await status(makeConfig());

    expect(consoleLog.output()).not.toContain("  pr:");
  });

  it("renders a `pr:` line in the per-task Worktrees section when present", async () => {
    findByTaskMock.mockReturnValue([
      worktree({ task: "team-1", repository: "repo-a", dir: "/work/repo-a-team-1" }),
    ]);
    findPullRequestsMock.mockResolvedValue([
      {
        url: "https://github.com/acme/widgets/pull/99",
        number: 99,
        state: "open",
        title: "Something",
      },
    ]);

    await status(makeConfig(), { task: "team-1" });

    expect(consoleLog.output()).toContain("  pr: https://github.com/acme/widgets/pull/99 (open)");
    expect(findPullRequestsMock).toHaveBeenCalledWith({
      cwd: "/work/repo-a-team-1",
      branchName: "dev-team-1",
    });
  });

  it("renders the cached task url next to the inventory task id", async () => {
    listWorktreesMock.mockReturnValue([worktree({ task: "team-1", repository: "repo-a" })]);
    readRunStateMock.mockReturnValue(
      runState({ task: "team-1", url: "https://linear.app/example/issue/TEAM-1" }),
    );
    workspaceProbeMock.mockResolvedValue({ kind: "ok", names: new Set(["team-1"]) });

    await status(makeConfig());

    expect(consoleLog.output()).toContain("team-1  https://linear.app/example/issue/TEAM-1\n");
  });

  it("renders the cached task url next to the per-task header", async () => {
    readRunStateMock.mockReturnValue(runState({ url: "https://linear.app/example/issue/TEAM-1" }));

    await status(makeConfig(), { task: "team-1" });

    expect(consoleLog.output()).toContain("task: team-1  https://linear.app/example/issue/TEAM-1");
  });

  it("prints `slots: N/M used` reflecting in-progress source issues against the orchestrator cap", async () => {
    listWorktreesMock.mockReturnValue([]);
    workspaceProbeMock.mockResolvedValue({ kind: "ok", names: new Set() });
    buildSourcesMock.mockResolvedValue([
      fakeSource([
        sourceIssue({ id: "linear:team-901", status: "in-progress" }),
        sourceIssue({ id: "linear:team-902", status: "in-progress" }),
        sourceIssue({ id: "linear:team-903", status: "todo" }),
        sourceIssue({ id: "linear:team-904", status: "done" }),
      ]),
    ]);

    await status(
      makeConfig({
        sources: [{ kind: "linear", name: "linear" }],
        orchestrator: {
          maximumInProgress: 4,
          pollIntervalMilliseconds: 1000,
          sessionLimitPercentage: 85,
        },
      }),
    );

    expect(consoleLog.output()).toContain("slots: 2/4 used");
  });

  it("lists in-progress tasks with no local worktree so the slot count is explainable", async () => {
    // team-901 is in-progress AND has a local worktree, so it already shows in
    // the Worktrees section. team-902 is in-progress with no local worktree
    // (its worktree was removed or lives outside this config's scope) — it
    // counts toward the slot total but is otherwise invisible, so it belongs
    // in the new section.
    listWorktreesMock.mockReturnValue([worktree({ task: "team-901", repository: "repo-a" })]);
    workspaceProbeMock.mockResolvedValue({ kind: "ok", names: new Set() });
    buildSourcesMock.mockResolvedValue([
      fakeSource([
        sourceIssue({ id: "linear:team-901", status: "in-progress" }),
        sourceIssue({
          id: "linear:team-902",
          status: "in-progress",
          title: "Type the boundary",
          repository: "repo-b",
          url: "https://linear.app/example/issue/TEAM-902",
        }),
        sourceIssue({ id: "linear:team-903", status: "todo" }),
      ]),
    ]);

    await status(makeConfig({ sources: [{ kind: "linear", name: "linear" }] }));

    const output = consoleLog.output();
    expect(output).toContain(
      "Slot holders with no local worktree\n-----------------------------------",
    );
    expect(output).toContain(
      "What to do: transition the ticket off 'in-progress' on the board, or run 'crew run <task>' to recreate the worktree locally.",
    );
    expect(output).toContain("team-902  https://linear.app/example/issue/TEAM-902");
    expect(output).toContain("  title:     Type the boundary");
    expect(output).toContain("  repo:      repo-b");
    expect(output).toContain("slots: 2/4 used");
    // team-901 has a worktree, so it belongs in the Worktrees section only and
    // must not be duplicated under the new section (which sits just above the
    // slots line).
    const sectionStart = output.indexOf("Slot holders with no local worktree");
    const section = output.slice(sectionStart, output.indexOf("slots:", sectionStart));
    expect(section).toContain("team-902");
    expect(section).not.toContain("team-901");
  });

  it("hides the slot-holders-without-worktree section when every in-progress task has a worktree", async () => {
    listWorktreesMock.mockReturnValue([worktree({ task: "team-901", repository: "repo-a" })]);
    workspaceProbeMock.mockResolvedValue({ kind: "ok", names: new Set() });
    buildSourcesMock.mockResolvedValue([
      fakeSource([sourceIssue({ id: "linear:team-901", status: "in-progress" })]),
    ]);

    await status(makeConfig({ sources: [{ kind: "linear", name: "linear" }] }));

    expect(consoleLog.output()).not.toContain("Slot holders with no local worktree");
  });

  it("omits the repo line for an in-progress task with no repository", async () => {
    listWorktreesMock.mockReturnValue([]);
    workspaceProbeMock.mockResolvedValue({ kind: "ok", names: new Set() });
    buildSourcesMock.mockResolvedValue([
      fakeSource([
        sourceIssue({
          id: "linear:team-905",
          status: "in-progress",
          title: "Task without a repo",
          repository: undefined,
        }),
      ]),
    ]);

    await status(makeConfig({ sources: [{ kind: "linear", name: "linear" }] }));

    const output = consoleLog.output();
    expect(output).toContain("team-905");
    expect(output).toContain("  title:     Task without a repo");
    const sectionStart = output.indexOf("Slot holders with no local worktree");
    const section = output.slice(sectionStart, output.indexOf("slots:", sectionStart));
    expect(section).not.toContain("repo:");
  });

  it("omits the slots line when the source fetch fails", async () => {
    listWorktreesMock.mockReturnValue([]);
    workspaceProbeMock.mockResolvedValue({ kind: "ok", names: new Set() });
    buildSourcesMock.mockResolvedValue([
      fakeSource([], {
        fetch: async () => {
          throw new Error("linear down");
        },
      }),
    ]);

    await status(makeConfig({ sources: [{ kind: "linear", name: "linear" }] }));

    const output = consoleLog.output();
    expect(output).not.toContain("slots:");
    // Queue section still surfaces the diagnostic.
    expect(output).toContain("unavailable: linear down");
  });

  it("waits for the task source before rendering the inventory so each row can show its status", async () => {
    // The inventory intentionally blocks on the board fetch: every Worktrees
    // row carries the remote task status, which isn't known until the source
    // resolves. So nothing renders while the fetch is pending.
    listWorktreesMock.mockReturnValue([worktree({ task: "team-1", repository: "repo-a" })]);
    workspaceProbeMock.mockResolvedValue({ kind: "ok", names: new Set(["team-1"]) });
    let resolveFetch: ((issues: SourceIssue[]) => void) | undefined;
    const pendingFetch = new Promise<SourceIssue[]>((resolve) => {
      resolveFetch = resolve;
    });
    buildSourcesMock.mockResolvedValue([
      fakeSource([], {
        fetch: async () => await pendingFetch,
      }),
    ]);

    const statusPromise = status(makeConfig({ sources: [{ kind: "linear", name: "linear" }] }));
    await flushMicrotasks();

    expect(consoleLog.output()).not.toContain("Worktrees");

    const completeFetch = resolveFetch;
    expect(completeFetch).toBeTypeOf("function");
    completeFetch?.([sourceIssue({ id: "linear:team-1", status: "in-progress" })]);
    await statusPromise;

    const output = consoleLog.output();
    expect(output).toContain("Worktrees");
    expect(output).toContain("team-1\n  state:");
    expect(output).toContain("  task:      in-progress (slot held)");
  });

  it("annotates an in-progress worktree row with the slot-held task status", async () => {
    listWorktreesMock.mockReturnValue([
      worktree({ task: "team-901", repository: "repo-a", dir: "/work/repo-a-team-901" }),
    ]);
    workspaceProbeMock.mockResolvedValue({ kind: "ok", names: new Set(["team-901"]) });
    buildSourcesMock.mockResolvedValue([
      fakeSource([sourceIssue({ id: "linear:team-901", status: "in-progress" })]),
    ]);

    await status(makeConfig({ sources: [{ kind: "linear", name: "linear" }] }));

    expect(consoleLog.output()).toContain("  task:      in-progress (slot held)");
  });

  it("shows the bare canonical status for a worktree whose task holds no slot", async () => {
    listWorktreesMock.mockReturnValue([
      worktree({ task: "team-902", repository: "repo-a", dir: "/work/repo-a-team-902" }),
    ]);
    workspaceProbeMock.mockResolvedValue({ kind: "ok", names: new Set(["team-902"]) });
    buildSourcesMock.mockResolvedValue([
      fakeSource([sourceIssue({ id: "linear:team-902", status: "in-review" })]),
    ]);

    await status(makeConfig({ sources: [{ kind: "linear", name: "linear" }] }));

    const output = consoleLog.output();
    expect(output).toContain("  task:      in-review");
    expect(output).not.toContain("slot held");
  });

  it("omits the task field for a worktree whose task is absent from the board", async () => {
    listWorktreesMock.mockReturnValue([
      worktree({ task: "team-903", repository: "repo-a", dir: "/work/repo-a-team-903" }),
    ]);
    workspaceProbeMock.mockResolvedValue({ kind: "ok", names: new Set(["team-903"]) });
    buildSourcesMock.mockResolvedValue([
      fakeSource([sourceIssue({ id: "linear:team-700", status: "todo" })]),
    ]);

    await status(makeConfig({ sources: [{ kind: "linear", name: "linear" }] }));

    expect(consoleLog.output()).not.toContain("  task:");
  });

  it("omits the task field when multiple sources return the same natural task id", async () => {
    listWorktreesMock.mockReturnValue([
      worktree({ task: "team-906", repository: "repo-a", dir: "/work/repo-a-team-906" }),
    ]);
    workspaceProbeMock.mockResolvedValue({ kind: "ok", names: new Set(["team-906"]) });
    buildSourcesMock.mockResolvedValue([
      fakeSource([sourceIssue({ id: "linear:team-906", source: "linear", status: "in-progress" })]),
      fakeSource([sourceIssue({ id: "shell:team-906", source: "shell", status: "done" })], {
        name: "shell",
      }),
    ]);

    await status(makeConfig({ sources: [{ kind: "linear", name: "linear" }] }));

    const output = consoleLog.output();
    expect(output).toContain("team-906\n  state:");
    expect(output).not.toContain("  task:");
  });

  it("omits the task field on worktree rows when the board fetch fails", async () => {
    listWorktreesMock.mockReturnValue([
      worktree({ task: "team-904", repository: "repo-a", dir: "/work/repo-a-team-904" }),
    ]);
    workspaceProbeMock.mockResolvedValue({ kind: "ok", names: new Set(["team-904"]) });
    buildSourcesMock.mockResolvedValue([
      fakeSource([], {
        fetch: async () => {
          throw new Error("linear down");
        },
      }),
    ]);

    await status(makeConfig({ sources: [{ kind: "linear", name: "linear" }] }));

    const output = consoleLog.output();
    expect(output).toContain("Worktrees");
    expect(output).not.toContain("  task:");
  });

  it("annotates in-progress rows with no local worktree as slot holders", async () => {
    listWorktreesMock.mockReturnValue([]);
    workspaceProbeMock.mockResolvedValue({ kind: "ok", names: new Set() });
    buildSourcesMock.mockResolvedValue([
      fakeSource([
        sourceIssue({
          id: "linear:team-905",
          status: "in-progress",
          title: "Type the boundary",
          repository: "repo-b",
          url: "https://linear.app/example/issue/TEAM-905",
        }),
      ]),
    ]);

    await status(makeConfig({ sources: [{ kind: "linear", name: "linear" }] }));

    const output = consoleLog.output();
    expect(output).toContain("Slot holders with no local worktree");
    expect(output).toContain("  task:      in-progress (slot held)");
  });

  it("hides the Queue section entirely when the source has no eligible Todos", async () => {
    listWorktreesMock.mockReturnValue([]);
    workspaceProbeMock.mockResolvedValue({ kind: "ok", names: new Set() });
    // buildSources resolves to an implicit Linear source whose fetch returns
    // no eligible Todos — the Queue section should not appear at all.
    buildSourcesMock.mockResolvedValue([fakeSource([])]);

    await status(makeConfig({ sources: [] }));

    expect(consoleLog.output()).not.toContain("Queue");
    expect(consoleLog.output()).not.toContain("Blocked");
  });

  it("renders queue + blocked sections from the configured source", async () => {
    listWorktreesMock.mockReturnValue([]);
    workspaceProbeMock.mockResolvedValue({ kind: "ok", names: new Set() });
    buildSourcesMock.mockResolvedValue([
      fakeSource([
        // Eligible Todo with url and clean blockers list.
        sourceIssue({
          id: "linear:team-101",
          title: "Wire up auth",
          url: "https://linear.app/example/issue/TEAM-101",
          repository: "repo-a",
          agent: "claude",
        }),
        // Eligible Todo blocked by another in-progress task.
        sourceIssue({
          id: "linear:team-102",
          title: "Polish UI",
          url: "https://linear.app/example/issue/TEAM-102",
          repository: "repo-b",
          agent: "codex",
          blockers: [
            {
              id: "linear:team-50",
              title: "Migrate db",
              status: "in-progress",
              nativeStatus: "In Progress",
            },
          ],
        }),
        // Ineligible (no agent/repo) — excluded from Queue.
        sourceIssue({
          id: "linear:team-103",
          title: "No label",
          repository: undefined,
          agent: undefined,
        }),
        // Not Todo — excluded.
        sourceIssue({ id: "linear:team-104", status: "in-progress" }),
      ]),
    ]);

    await status(makeConfig({ sources: [{ kind: "linear", name: "linear" }] }));

    const output = consoleLog.output();
    expect(output).toContain("Queue\n-----");
    expect(output).toContain("team-101  https://linear.app/example/issue/TEAM-101");
    expect(output).toContain("  title:     Wire up auth");
    expect(output).toContain("  repo:      repo-a");
    expect(output).toContain("  agent:     claude");
    expect(output).toContain("Blocked\n-------");
    expect(output).toContain("team-102  https://linear.app/example/issue/TEAM-102");
    expect(output).toContain("  blocked by:  team-50 (In Progress)");
    // team-103 is an ineligible Todo (no repo/agent) — surfaced nowhere.
    expect(output).not.toContain("team-103");
    // team-104 is in-progress, so it's excluded from the Queue but now appears
    // in the "Slot holders with no local worktree" section above the slots line.
    const queueSection = output.slice(output.indexOf("Queue\n-----"));
    expect(queueSection).not.toContain("team-104");
    expect(output).toContain("Slot holders with no local worktree");
    expect(output).toContain("team-104");
  });

  it("excludes Queue and Blocked rows whose task already has a local worktree", async () => {
    // Reproduces the "queued + provisioning at the same time" bug: when a task
    // has been dispatched (worktree exists, local run state is provisioning)
    // but the board still reports it as todo, it must not appear in the Queue.
    listWorktreesMock.mockReturnValue([
      worktree({ repository: "repo-a", task: "team-101" }),
      worktree({ repository: "repo-b", task: "team-102", dir: "/work/repo-b-team-102" }),
    ]);
    const runStatesByTask = new Map<string, RunState>([
      ["team-101", runState({ task: "team-101", repository: "repo-a", state: "provisioning" })],
      ["team-102", runState({ task: "team-102", repository: "repo-b", state: "provisioning" })],
    ]);
    readRunStateMock.mockImplementation((_config, task) => runStatesByTask.get(task));
    workspaceProbeMock.mockResolvedValue({ kind: "ok", names: new Set() });
    buildSourcesMock.mockResolvedValue([
      fakeSource([
        // Dispatched todo — should NOT appear in Queue.
        sourceIssue({
          id: "linear:team-101",
          title: "Already dispatched",
          repository: "repo-a",
          agent: "claude",
        }),
        // Dispatched todo, blocked — should NOT appear in Blocked.
        sourceIssue({
          id: "linear:team-102",
          title: "Dispatched but blocked upstream",
          repository: "repo-b",
          agent: "claude",
          blockers: [{ id: "linear:team-50", title: "x", status: "in-progress" }],
        }),
        // Not yet dispatched — should still appear in Queue as a control.
        sourceIssue({
          id: "linear:team-777",
          title: "Genuinely queued",
          repository: "repo-a",
          agent: "claude",
        }),
      ]),
    ]);

    await status(makeConfig({ sources: [{ kind: "linear", name: "linear" }] }));

    const output = consoleLog.output();
    const queueSection = output.slice(output.indexOf("Queue\n-----"));
    expect(queueSection).not.toContain("team-101");
    expect(queueSection).not.toContain("team-102");
    expect(queueSection).toContain("team-777");
    expect(output).not.toContain("Blocked\n-------");
  });

  it("hides the Queue section when the source has only non-Todo issues", async () => {
    listWorktreesMock.mockReturnValue([]);
    workspaceProbeMock.mockResolvedValue({ kind: "ok", names: new Set() });
    buildSourcesMock.mockResolvedValue([
      fakeSource([sourceIssue({ id: "linear:team-201", status: "in-progress" })]),
    ]);

    await status(makeConfig({ sources: [{ kind: "linear", name: "linear" }] }));

    // No eligible Todos -> no Queue section. (The lone in-progress task
    // surfaces in the "Slot holders with no local worktree" section instead, so
    // match the Queue section header rather than the bare word "Queue", which
    // also appears in the default "Queued task" title.)
    expect(consoleLog.output()).not.toContain("Queue\n-----");
  });

  it("separates multiple Queue and Blocked rows with blank lines", async () => {
    listWorktreesMock.mockReturnValue([]);
    workspaceProbeMock.mockResolvedValue({ kind: "ok", names: new Set() });
    const ready1 = sourceIssue({ id: "linear:team-301", title: "First ready" });
    const ready2 = sourceIssue({ id: "linear:team-302", title: "Second ready" });
    const blockedA = sourceIssue({
      id: "linear:team-401",
      title: "First blocked",
      blockers: [{ id: "linear:team-9", title: "x", status: "in-progress" }],
    });
    const blockedB = sourceIssue({
      id: "linear:team-402",
      title: "Second blocked",
      blockers: [{ id: "linear:team-10", title: "y", status: "in-progress" }],
    });
    buildSourcesMock.mockResolvedValue([fakeSource([ready1, ready2, blockedA, blockedB])]);

    await status(makeConfig({ sources: [{ kind: "linear", name: "linear" }] }));

    const output = consoleLog.output();
    // Queue rows split by a blank line.
    expect(output).toMatch(/First ready[\s\S]*\n\nteam-302/);
    // Blocked rows split by a blank line.
    expect(output).toMatch(/First blocked[\s\S]*\n\nteam-402/);
  });

  it("prints `unavailable` in the Queue section when source fetch fails", async () => {
    listWorktreesMock.mockReturnValue([]);
    workspaceProbeMock.mockResolvedValue({ kind: "ok", names: new Set() });
    buildSourcesMock.mockResolvedValue([
      fakeSource([], {
        fetch: async () => {
          throw new Error("linear down");
        },
      }),
    ]);

    await status(makeConfig({ sources: [{ kind: "linear", name: "linear" }] }));

    expect(consoleLog.output()).toContain("Queue\n-----\nunavailable: linear down");
  });

  it("marks partial source inventory as degraded while retaining healthy queue rows", async () => {
    listWorktreesMock.mockReturnValue([]);
    workspaceProbeMock.mockResolvedValue({ kind: "ok", names: new Set() });
    buildSourcesMock.mockResolvedValue([
      fakeSource(
        [sourceIssue({ id: "healthy:team-2", source: "healthy", title: "Healthy task" })],
        { name: "healthy" },
      ),
      fakeSource([], {
        name: "broken",
        listTasks: async () => await Promise.reject(new Error("source unavailable")),
      }),
    ]);

    await status(makeConfig());

    const output = consoleLog.output();
    expect(output).toContain("Source problems\n---------------\nbroken: source unavailable");
    expect(output).toContain("slots: unknown/4 used (source data incomplete)");
    expect(output).toContain("Healthy task");
  });

  it("prints inventory probe failures and empty worktrees", async () => {
    listWorktreesMock.mockReturnValue([]);
    workspaceProbeMock.mockResolvedValue({
      kind: "unavailable",
      error: new Error("tmux unavailable"),
    } satisfies WorkspaceProbe);

    await status(makeConfig());

    const output = consoleLog.output();
    expect(output).toContain("Worktrees");
    expect(output).toContain("(none)");
    expect(output).toContain("Workspace probe unavailable: tmux unavailable");
  });

  it("prints unknown workspace presence when inventory probing is unavailable", async () => {
    listWorktreesMock.mockReturnValue([worktree({ task: "team-1", repository: "repo-a" })]);
    workspaceProbeMock.mockResolvedValue({
      kind: "unavailable",
      error: new Error("cmux unavailable"),
    });

    await status(makeConfig());

    const output = consoleLog.output();
    // probe=unknown shouldn't be flagged as orphaned ("session dead") because
    // we don't actually know — the probe failed. Duration still shows.
    expect(output).toContain("team-1\n  state:     running (2h 14m)\n");
    expect(output).not.toContain("session dead");
    expect(output).toContain("Workspace probe unavailable: cmux unavailable");
  });

  describe("--json", () => {
    function jsonConfig(): ResolvedConfig {
      return makeConfig({ logging: { file: path.join(temporaryDirectory, "groundcrew.log") } });
    }

    it("emits one stable inventory snapshot", async () => {
      probeWorkingTreeMock.mockResolvedValue({ kind: "dirty", modified: 2, untracked: 1 });
      workspaceProbeMock.mockResolvedValue({
        kind: "ok",
        names: new Set(["team-1", "orphan"]),
      });
      findPullRequestsMock.mockResolvedValue([
        {
          url: "https://github.com/acme/widgets/pull/42",
          number: 42,
          state: "open",
          title: "Wire up status JSON",
        },
      ]);
      buildSourcesMock.mockResolvedValue([
        fakeSource([
          sourceIssue({
            status: "in-progress",
            title: "Active task",
            url: "https://linear.app/example/issue/TEAM-1",
          }),
          sourceIssue({
            id: "linear:team-2",
            title: "Ready task",
            repository: "repo-b",
          }),
          sourceIssue({
            id: "linear:team-3",
            status: "in-progress",
            title: "Remote slot holder",
            repository: "repo-b",
          }),
          sourceIssue({
            id: "linear:team-4",
            title: "Blocked task",
            repository: "repo-b",
            blockers: [
              {
                id: "linear:team-0",
                title: "Blocking task",
                status: "in-progress",
              },
            ],
          }),
        ]),
      ]);

      await status(jsonConfig(), { json: true });

      const actual: unknown = JSON.parse(consoleLog.output());
      expect(actual).toMatchObject({
        kind: "inventory",
        generatedAt: "2026-05-26T02:14:30.000Z",
        slots: { used: 2, maximum: 4 },
        worktrees: [
          {
            task: {
              id: "linear:team-1",
              naturalId: "team-1",
              title: "Active task",
              status: "in-progress",
              url: "https://linear.app/example/issue/TEAM-1",
            },
            run: {
              lifecycle: "running",
              agent: "claude",
              startedAt: "2026-05-26T00:00:00.000Z",
              updatedAt: "2026-05-26T00:01:00.000Z",
              resumeCount: 0,
              reason: "manual pause",
            },
            workspace: { state: "live" },
            repository: "repo-a",
            branch: "dev-team-1",
            directory: "/work/repo-a-team-1",
            dirtiness: { kind: "dirty", modified: 2, untracked: 1 },
            pullRequests: [
              {
                url: "https://github.com/acme/widgets/pull/42",
                number: 42,
                state: "open",
                title: "Wire up status JSON",
              },
            ],
            recommendedActions: ["stop", "open-task", "open-pr", "open-worktree"],
          },
        ],
        inProgressWithoutWorktrees: [
          {
            task: {
              id: "linear:team-3",
              naturalId: "team-3",
              title: "Remote slot holder",
              status: "in-progress",
            },
            repository: "repo-b",
            agent: "claude",
            recommendedActions: ["run"],
          },
        ],
        queue: {
          ready: [
            {
              task: {
                id: "linear:team-2",
                naturalId: "team-2",
                title: "Ready task",
                status: "todo",
              },
              repository: "repo-b",
              agent: "claude",
              recommendedActions: [],
            },
          ],
          blocked: [
            {
              task: {
                id: "linear:team-4",
                naturalId: "team-4",
                title: "Blocked task",
                status: "todo",
              },
              repository: "repo-b",
              agent: "claude",
              recommendedActions: [],
              blockedBy: [
                {
                  id: "linear:team-0",
                  naturalId: "team-0",
                  status: "in-progress",
                },
              ],
            },
          ],
        },
        straySessions: [
          {
            name: "orphan",
            state: "live",
            recommendedActions: ["stop"],
          },
        ],
        problems: [],
      });
      expect(JSON.stringify(actual)).not.toContain("recentLogLines");
      expect(JSON.stringify(actual)).not.toContain('"text"');
    });

    it("emits one stable task snapshot without recent logs", async () => {
      const config = jsonConfig();
      writeFileSync(config.logging.file, "[09:01:00] team-1 private log contents\n");
      probeWorkingTreeMock.mockResolvedValue({ kind: "dirty", modified: 1, untracked: 0 });
      findPullRequestsMock.mockResolvedValue([
        {
          url: "https://github.com/acme/widgets/pull/99",
          number: 99,
          state: "open",
          title: "Status contract",
        },
      ]);
      buildSourcesMock.mockResolvedValue([
        fakeSource([
          sourceIssue({
            title: "Current task title",
            status: "in-progress",
            url: "https://linear.app/example/issue/TEAM-1",
          }),
        ]),
      ]);

      await status(config, { task: "team-1", json: true });

      const actual: unknown = JSON.parse(consoleLog.output());
      expect(actual).toEqual({
        kind: "task",
        generatedAt: "2026-05-26T02:14:30.000Z",
        task: {
          id: "linear:team-1",
          naturalId: "team-1",
          title: "Current task title",
          status: "in-progress",
          url: "https://linear.app/example/issue/TEAM-1",
        },
        repository: "repo-a",
        run: {
          lifecycle: "running",
          agent: "claude",
          startedAt: "2026-05-26T00:00:00.000Z",
          updatedAt: "2026-05-26T00:01:00.000Z",
          resumeCount: 0,
          reason: "manual pause",
        },
        workspace: { state: "live" },
        worktrees: [
          {
            repository: "repo-a",
            kind: "host",
            branch: "dev-team-1",
            directory: "/work/repo-a-team-1",
            dirtiness: { kind: "dirty", modified: 1, untracked: 0 },
            pullRequests: [
              {
                url: "https://github.com/acme/widgets/pull/99",
                number: 99,
                state: "open",
                title: "Status contract",
              },
            ],
          },
        ],
        recommendedActions: ["stop", "open-task", "open-pr", "open-worktree"],
        problems: [],
      });
      expect(consoleLog.output()).not.toContain("private log contents");
      expect(consoleLog.output()).not.toContain('"text"');
    });

    it("accepts a canonical task id while using its natural id for local lookups", async () => {
      const config = jsonConfig();
      buildSourcesMock.mockResolvedValue([
        fakeSource([
          sourceIssue({
            title: "Canonical task",
            status: "in-progress",
            url: "https://linear.app/example/issue/TEAM-1",
          }),
        ]),
      ]);

      await status(config, { task: "linear:team-1", json: true });

      expect(JSON.parse(consoleLog.output())).toMatchObject({
        task: {
          id: "linear:team-1",
          naturalId: "team-1",
          title: "Canonical task",
        },
      });
      expect(readRunStateMock).toHaveBeenCalledWith(config, "team-1");
      expect(findByTaskMock).toHaveBeenCalledWith(config, "team-1");
    });

    it("does not collect recent logs for task JSON", async () => {
      const config = jsonConfig();
      writeFileSync(config.logging.file, "[09:01:00] team-1 private log contents\n");

      const snapshot = await collectStatus(config, { task: "team-1", json: true });

      expect(snapshot).toMatchObject({
        kind: "task",
        text: { recentLogLines: [] },
      });
    });

    it("falls back to the run repository when the task source omits it", async () => {
      buildSourcesMock.mockResolvedValue([
        fakeSource([sourceIssue({ repository: undefined, status: "in-progress" })]),
      ]);

      await status(jsonConfig(), { task: "team-1", json: true });

      expect(JSON.parse(consoleLog.output())).toMatchObject({ repository: "repo-a" });
    });

    it("preserves inventory data when source, workspace, git, and GitHub probes fail", async () => {
      buildSourcesMock.mockRejectedValue(new Error("source down"));
      workspaceProbeMock.mockResolvedValue({
        kind: "unavailable",
        error: new Error("workspace down"),
      });
      probeWorkingTreeMock.mockResolvedValue({ kind: "unknown" });
      findPullRequestsMock.mockRejectedValue(new Error("GitHub down"));

      await status(jsonConfig(), { json: true });

      const actual: unknown = JSON.parse(consoleLog.output());
      expect(actual).toMatchObject({
        kind: "inventory",
        slots: { maximum: 4 },
        worktrees: [
          {
            directory: "/work/repo-a-team-1",
            dirtiness: { kind: "unknown" },
            pullRequests: [],
          },
        ],
        queue: { ready: [], blocked: [] },
        problems: [
          { code: "source-probe-failed", message: "Source probe failed" },
          { code: "workspace-probe-failed", message: "Workspace probe failed" },
          {
            code: "git-probe-failed",
            task: "team-1",
            worktreeDirectory: "/work/repo-a-team-1",
          },
          {
            code: "github-probe-failed",
            message: "GitHub probe failed",
            task: "team-1",
            worktreeDirectory: "/work/repo-a-team-1",
          },
        ],
      });
      expect(consoleLog.calls).toHaveLength(1);
    });

    it("retains healthy inventory data when one configured source fails", async () => {
      buildSourcesMock.mockResolvedValue([
        fakeSource(
          [
            sourceIssue({
              id: "healthy:team-2",
              source: "healthy",
              title: "Healthy queue entry",
            }),
          ],
          { name: "healthy" },
        ),
        fakeSource([], {
          name: "broken",
          listTasks: async () => await Promise.reject(new Error("source unavailable")),
        }),
      ]);

      await status(jsonConfig(), { json: true });

      expect(JSON.parse(consoleLog.output())).toMatchObject({
        queue: {
          ready: [{ task: { naturalId: "team-2", title: "Healthy queue entry" } }],
        },
        slots: { maximum: 4 },
        problems: [
          {
            code: "source-probe-failed",
            source: "broken",
            message: 'Source "broken" probe failed',
          },
        ],
      });
      expect(consoleLog.output()).not.toContain("source unavailable");
    });

    it("retains a resolved task while reporting a failed sibling source", async () => {
      buildSourcesMock.mockResolvedValue([
        fakeSource(
          [sourceIssue({ id: "healthy:team-1", source: "healthy", title: "Healthy match" })],
          { name: "healthy" },
        ),
        fakeSource([], {
          name: "broken",
          getTask: async () => await Promise.reject(new Error("token=private-source-detail")),
        }),
      ]);

      await status(jsonConfig(), { task: "team-1", json: true });

      expect(JSON.parse(consoleLog.output())).toMatchObject({
        task: { id: "healthy:team-1", title: "Healthy match" },
        problems: [
          {
            code: "source-probe-failed",
            source: "broken",
            task: "team-1",
            message: 'Source "broken" probe failed',
          },
        ],
      });
      expect(consoleLog.output()).not.toContain("private-source-detail");
    });

    it("preserves task data when source, workspace, git, and GitHub probes fail", async () => {
      buildSourcesMock.mockRejectedValue(new Error("source down"));
      workspaceProbeMock.mockResolvedValue({
        kind: "unavailable",
        error: new Error("workspace down"),
      });
      probeWorkingTreeMock.mockResolvedValue({ kind: "unknown" });
      findPullRequestsMock.mockRejectedValue(new Error("GitHub down"));

      await status(jsonConfig(), { task: "team-1", json: true });

      const actual: unknown = JSON.parse(consoleLog.output());
      expect(actual).toMatchObject({
        kind: "task",
        task: { naturalId: "team-1" },
        repository: "repo-a",
        run: { lifecycle: "running" },
        workspace: { state: "unknown" },
        worktrees: [
          {
            repository: "repo-a",
            directory: "/work/repo-a-team-1",
            dirtiness: { kind: "unknown" },
            pullRequests: [],
          },
        ],
        problems: [
          { code: "source-probe-failed", message: "Source probe failed", task: "team-1" },
          { code: "workspace-probe-failed", message: "Workspace probe failed", task: "team-1" },
          {
            code: "git-probe-failed",
            task: "team-1",
            worktreeDirectory: "/work/repo-a-team-1",
          },
          {
            code: "github-probe-failed",
            message: "GitHub probe failed",
            task: "team-1",
            worktreeDirectory: "/work/repo-a-team-1",
          },
        ],
      });
      expect(consoleLog.calls).toHaveLength(1);
    });

    it("distinguishes live and exited stray sessions", async () => {
      listWorktreesMock.mockReturnValue([]);
      workspaceProbeMock.mockResolvedValue({
        kind: "ok",
        names: new Set(["live-orphan", "exited-orphan"]),
        exitedNames: new Set(["exited-orphan"]),
      });

      await status(jsonConfig(), { json: true });

      const actual: unknown = JSON.parse(consoleLog.output());
      expect(actual).toMatchObject({
        straySessions: [
          { name: "exited-orphan", state: "exited", recommendedActions: ["stop"] },
          { name: "live-orphan", state: "live", recommendedActions: ["stop"] },
        ],
      });
    });

    it("uses cleanup and resume action codes for workspace reconciliation", async () => {
      readRunStateMock.mockReset();
      workspaceProbeMock.mockResolvedValue({ kind: "ok", names: new Set(["team-1"]) });

      await status(jsonConfig(), { json: true });

      const straySnapshot: unknown = JSON.parse(consoleLog.output());
      expect(straySnapshot).toMatchObject({
        worktrees: [{ recommendedActions: ["cleanup", "open-worktree"] }],
      });
      consoleLog.restore();
      consoleLog = captureConsoleLog();
      readRunStateMock.mockReturnValue(runState());
      workspaceProbeMock.mockResolvedValue({ kind: "ok", names: new Set() });

      await status(jsonConfig(), { task: "team-1", json: true });

      const deadSnapshot: unknown = JSON.parse(consoleLog.output());
      expect(deadSnapshot).toMatchObject({ recommendedActions: ["resume", "open-worktree"] });
    });

    it("offers resume for interrupted tasks only when the workspace is confirmed absent", async () => {
      readRunStateMock.mockReturnValue(runState({ state: "interrupted" }));
      workspaceProbeMock.mockResolvedValue({ kind: "ok", names: new Set() });

      await status(jsonConfig(), { task: "team-1", json: true });

      expect(JSON.parse(consoleLog.output())).toMatchObject({
        recommendedActions: ["resume", "open-worktree"],
      });
      consoleLog.restore();
      consoleLog = captureConsoleLog();
      workspaceProbeMock.mockResolvedValue({ kind: "unavailable", error: new Error("probe down") });

      await status(jsonConfig(), { task: "team-1", json: true });

      expect(JSON.parse(consoleLog.output())).toMatchObject({
        recommendedActions: ["open-worktree"],
      });
      consoleLog.restore();
      consoleLog = captureConsoleLog();
      workspaceProbeMock.mockResolvedValue({ kind: "ok", names: new Set() });

      await status(jsonConfig(), { json: true });

      expect(JSON.parse(consoleLog.output())).toMatchObject({
        worktrees: [{ recommendedActions: ["resume", "open-worktree"] }],
      });
    });

    it("uses stop rather than cleanup for a live session with no worktree or run state", async () => {
      readRunStateMock.mockReset();
      findByTaskMock.mockReturnValue([]);
      workspaceProbeMock.mockResolvedValue({ kind: "ok", names: new Set(["team-1"]) });

      await status(jsonConfig(), { task: "team-1", json: true });

      expect(JSON.parse(consoleLog.output())).toMatchObject({ recommendedActions: ["stop"] });
    });

    it("omits queue actions whose required task data is unavailable", async () => {
      listWorktreesMock.mockReturnValue([]);
      workspaceProbeMock.mockResolvedValue({ kind: "ok", names: new Set() });
      const ineligibleIssue = {
        ...sourceIssue({ id: "linear:team-2", status: "in-progress" }),
        repository: undefined,
        agent: undefined,
      } satisfies SourceIssue;
      buildSourcesMock.mockResolvedValue([fakeSource([ineligibleIssue])]);

      await status(jsonConfig(), { json: true });

      expect(JSON.parse(consoleLog.output())).toMatchObject({
        inProgressWithoutWorktrees: [{ recommendedActions: [] }],
      });
    });

    it("reports a degraded branch probe while retaining the fallback branch", async () => {
      probeEffectiveBranchMock.mockResolvedValue({
        branch: "dev-team-1",
        problem: "Could not determine the current branch: HEAD is detached",
      });

      await status(jsonConfig(), { json: true });

      expect(JSON.parse(consoleLog.output())).toMatchObject({
        worktrees: [{ branch: "dev-team-1" }],
        problems: [
          {
            code: "git-probe-failed",
            message: "Git probe failed",
            task: "team-1",
            worktreeDirectory: "/work/repo-a-team-1",
          },
        ],
      });
      consoleLog.restore();
      consoleLog = captureConsoleLog();

      await status(jsonConfig(), { task: "team-1", json: true });

      expect(JSON.parse(consoleLog.output())).toMatchObject({
        worktrees: [{ branch: "dev-team-1" }],
        problems: [
          {
            code: "git-probe-failed",
            message: "Git probe failed",
            task: "team-1",
            worktreeDirectory: "/work/repo-a-team-1",
          },
        ],
      });
    });

    it("reports one git problem when both branch and dirtiness probes fail", async () => {
      probeEffectiveBranchMock.mockResolvedValue({
        branch: "dev-team-1",
        problem: "Could not determine the current branch: HEAD is detached",
      });
      probeWorkingTreeMock.mockResolvedValue({ kind: "unknown" });
      const expectedProblem = {
        code: "git-probe-failed",
        message: "Git probe failed",
        task: "team-1",
        worktreeDirectory: "/work/repo-a-team-1",
      };

      await status(jsonConfig(), { json: true });

      expect(JSON.parse(consoleLog.output())).toMatchObject({ problems: [expectedProblem] });
      consoleLog.restore();
      consoleLog = captureConsoleLog();

      await status(jsonConfig(), { task: "team-1", json: true });

      expect(JSON.parse(consoleLog.output())).toMatchObject({ problems: [expectedProblem] });
    });

    it("writes no JSON when inventory collection fails fatally", async () => {
      listWorktreesMock.mockImplementation(() => {
        throw new Error("worktree inventory unreadable");
      });

      await expect(status(jsonConfig(), { json: true })).rejects.toThrow(
        "worktree inventory unreadable",
      );

      expect(consoleLog.output()).toBe("");
    });
  });

  it("still shows pull request links when the board fetch fails", async () => {
    // The board and `gh` share no data, so losing one must not hide the other.
    buildSourcesMock.mockRejectedValue(new Error("source down"));
    stubPullRequestsByDirectory({
      "/work/repo-a-team-1": [
        { url: "https://example.test/a", number: 1, state: "open", title: "A" },
      ],
    });

    await status(makeConfig());

    const output = consoleLog.output();

    expect(output).toContain("unavailable: source down");
    expect(output).toContain("pr:        https://example.test/a (open)");
  });

  it("shows each worktree only its own pull requests when a task has two", async () => {
    listWorktreesMock.mockReturnValue([
      worktree({ repository: "repo-a", dir: "/work/repo-a-team-1" }),
      worktree({ repository: "repo-b", dir: "/work/repo-b-team-1" }),
    ]);
    stubPullRequestsByDirectory({
      "/work/repo-a-team-1": [
        { url: "https://example.test/a", number: 1, state: "open", title: "A" },
      ],
      "/work/repo-b-team-1": [
        { url: "https://example.test/b", number: 2, state: "open", title: "B" },
      ],
    });

    await status(makeConfig());

    const output = consoleLog.output();
    const rowA = output.slice(output.indexOf("/work/repo-a-team-1"));
    const rowB = output.slice(output.indexOf("/work/repo-b-team-1"));

    expect(rowA).toContain("https://example.test/a");
    expect(rowA.slice(0, rowA.indexOf("/work/repo-b-team-1"))).not.toContain(
      "https://example.test/b",
    );
    expect(rowB).toContain("https://example.test/b");
  });

  // The snapshot document groups worktrees under one task while the inventory
  // prints one row per worktree. This pins the flatten order across that
  // regrouping.
  it("prints one row per worktree, in list order, when a task has two", async () => {
    listWorktreesMock.mockReturnValue([
      worktree({ repository: "repo-a", dir: "/work/repo-a-team-1" }),
      worktree({ repository: "repo-b", dir: "/work/repo-b-team-1" }),
    ]);

    await status(makeConfig());

    const output = consoleLog.output();

    expect(output).toContain("/work/repo-a-team-1");
    expect(output).toContain("/work/repo-b-team-1");
    expect(output.indexOf("/work/repo-a-team-1")).toBeLessThan(
      output.indexOf("/work/repo-b-team-1"),
    );
  });
});

describe(statusCli, () => {
  let consoleLog: ConsoleCapture;

  beforeEach(() => {
    consoleLog = captureConsoleLog();
    loadConfigMock.mockResolvedValue(makeConfig());
    listWorktreesMock.mockReturnValue([]);
    findByTaskMock.mockReturnValue([]);
    workspaceProbeMock.mockResolvedValue({ kind: "unavailable" });
    workspaceAccessHintMock.mockReset();
    findPullRequestsMock.mockResolvedValue([]);
    readRunStateMock.mockReset();
    buildSourcesMock.mockResolvedValue([]);
  });

  afterEach(() => {
    consoleLog.restore();
    vi.resetAllMocks();
    setVerbose(false);
  });

  it("loads config and normalizes a task argument", async () => {
    await statusCli(["TEAM-1"]);

    expect(findByTaskMock.mock.calls[0]?.[1]).toBe("team-1");
    expect(consoleLog.output()).toContain("groundcrew status TEAM-1");
  });

  it("loads config and prints inventory with no task argument", async () => {
    workspaceProbeMock.mockResolvedValue({ kind: "ok", names: new Set() });

    await statusCli([]);

    expect(listWorktreesMock.mock.calls.length).toBeGreaterThan(0);
    expect(consoleLog.output()).toContain("Worktrees\n---------\n(none)");
  });

  it("suppresses configuration diagnostics in JSON mode", async () => {
    setVerbose(true);
    loadConfigMock.mockImplementation(async () => {
      log("configuration diagnostic");
      return makeConfig();
    });

    await statusCli(["--json"]);

    expect(consoleLog.calls).toHaveLength(1);
    expect(JSON.parse(consoleLog.output())).toMatchObject({ kind: "inventory" });
    expect(consoleLog.output()).not.toContain("configuration diagnostic");
  });

  it("rejects an empty task argument", async () => {
    await expect(statusCli([""])).rejects.toThrow(/Usage: crew status/);

    expect(loadConfigMock).not.toHaveBeenCalled();
  });

  it("rejects unknown flags", async () => {
    await expect(statusCli(["--task", "TEAM-1"])).rejects.toThrow(/Usage: crew status/);

    expect(loadConfigMock).not.toHaveBeenCalled();
  });

  it("rejects --local-only because status exposes only the two documented JSON modes", async () => {
    await expect(statusCli(["--json", "--local-only"])).rejects.toThrow(
      "unknown option: --local-only",
    );

    expect(loadConfigMock).not.toHaveBeenCalled();
  });

  it("rejects extra positional arguments", async () => {
    await expect(statusCli(["TEAM-1", "extra"])).rejects.toThrow(/Usage: crew status/);

    expect(loadConfigMock).not.toHaveBeenCalled();
  });
});
