import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildSources } from "../lib/buildSources.ts";
import { loadConfig, type ResolvedConfig } from "../lib/config.ts";
import { findPullRequestsForBranch } from "../lib/pullRequests.ts";
import { readRunState, type RunState } from "../lib/runState.ts";
import type { Issue as SourceIssue, TicketSource } from "../lib/ticketSource.ts";
import { type WorkspaceProbe, workspaces } from "../lib/workspaces.ts";
import { type WorktreeDirtiness, type WorktreeEntry, worktrees } from "../lib/worktrees.ts";
import { captureConsoleLog, type ConsoleCapture } from "../testHelpers/consoleCapture.ts";
import { status, statusCli } from "./status.ts";

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
      findByTicket: vi.fn<typeof actual.worktrees.findByTicket>(),
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

const loadConfigMock = vi.mocked(loadConfig);
const readRunStateMock = vi.mocked(readRunState);
const workspaceProbeMock = vi.mocked(workspaces.probe);
const workspaceAccessHintMock = vi.mocked(workspaces.accessHint);
const findByTicketMock = vi.mocked(worktrees.findByTicket);
const listWorktreesMock = vi.mocked(worktrees.list);
const probeWorkingTreeMock = vi.mocked(worktrees.probeWorkingTree);
const buildSourcesMock = vi.mocked(buildSources);
const findPullRequestsMock = vi.mocked(findPullRequestsForBranch);

function sourceIssue(overrides: Partial<SourceIssue> = {}): SourceIssue {
  return {
    id: "linear:team-1",
    source: "linear",
    title: "Queued ticket",
    description: "",
    status: "todo",
    repository: "repo-a",
    model: "claude",
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

const markInReview: TicketSource["markInReview"] = async () => ({ outcome: "applied" });

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
    fetch?: TicketSource["fetch"];
    resolveOne?: TicketSource["resolveOne"];
  } = {},
): TicketSource {
  const fetch: TicketSource["fetch"] = overrides.fetch ?? (async () => [...issues]);
  const resolveOne: TicketSource["resolveOne"] =
    overrides.resolveOne ??
    (async (naturalId) =>
      issues.find((issue) => issue.id === `${issue.source}:${naturalId.toLowerCase()}`));
  return {
    name: overrides.name ?? "linear",
    verify: noop,
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
      ...overrides.workspace,
    },
    orchestrator: {
      maximumInProgress: 4,
      pollIntervalMilliseconds: 1000,
      sessionLimitPercentage: 85,
      ...overrides.orchestrator,
    },
    models: {
      default: "claude",
      definitions: {
        claude: { cmd: "claude", color: "#fff" },
        codex: { cmd: "codex", color: "#000" },
      },
      ...overrides.models,
    },
    prompts: { initial: "x", ...overrides.prompts },
    workspaceKind: overrides.workspaceKind ?? "auto",
    local: { runner: "auto", ...overrides.local },
    logging: { file: "/tmp/groundcrew-test.log", ...overrides.logging },
  };
}

function worktree(overrides: Partial<WorktreeEntry> = {}): WorktreeEntry {
  return {
    repository: "repo-a",
    ticket: "team-1",
    branchName: "dev-team-1",
    dir: "/work/repo-a-team-1",
    kind: "host",
    ...overrides,
  };
}

function runState(overrides: Partial<RunState> = {}): RunState {
  return {
    ticket: "team-1",
    repository: "repo-a",
    model: "claude",
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
    findByTicketMock.mockReturnValue([worktree()]);
    listWorktreesMock.mockReturnValue([worktree()]);
    probeWorkingTreeMock.mockResolvedValue({ kind: "clean" });
  });

  afterEach(() => {
    consoleLog.restore();
    rmSync(temporaryDirectory, { recursive: true, force: true });
    vi.resetAllMocks();
    vi.useRealTimers();
  });

  it("prints the read-only per-ticket status dump", async () => {
    const logFile = path.join(temporaryDirectory, "groundcrew.log");
    writeFileSync(
      logFile,
      [
        "[09:00:00] unrelated ticket",
        "event=dispatch outcome=started ticket=team-1",
        "event=dispatch outcome=started ticket=team-10",
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
    findByTicketMock.mockReturnValue(entries);
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

    await status(config, { ticket: "team-1" });

    const output = consoleLog.output();
    expect(output).toContain("groundcrew status TEAM-1");
    expect(output).not.toContain("Config snapshot");
    expect(output).toContain(
      "run: running; model=claude; updated=2026-05-26T00:01:00.000Z; resumes=0",
    );
    expect(output).toContain("manual pause");
    expect(output).toContain("workspace: live");
    expect(output).toContain("Worktrees");
    expect(output).toContain("repo-a host");
    expect(output).not.toContain("  ticket: team-1");
    expect(output).toContain("git: clean");
    expect(output).toContain("git: dirty (2 modified, 1 untracked)");
    expect(output).toContain("git: unknown");
    expect(output).toContain("Recent logs");
    expect(output).toContain("event=dispatch outcome=started ticket=team-1");
    expect(output).not.toContain("ticket=team-10");
    expect(output).toContain('Workspace "TEAM-1" launched');
    expect(output).not.toContain("unrelated ticket");
    expect(output).not.toContain("Ticket source");
    expect(output).toContain(
      "ticket: team-1  in-progress  https://linear.app/example/issue/TEAM-1",
    );
    expect(output).toContain("title: Fix status");
  });

  it("prints unavailable fields without attempting recovery", async () => {
    const config = makeConfig({ logging: { file: path.join(temporaryDirectory, "missing.log") } });
    findByTicketMock.mockReturnValue([]);
    workspaceProbeMock.mockResolvedValue({ kind: "ok", names: new Set() });
    readRunStateMock.mockReset();
    buildSourcesMock.mockRejectedValue(new Error("source down"));

    await status(config, { ticket: "team-404" });

    const output = consoleLog.output();
    expect(output).toContain("ticket: team-404  source unavailable: source down");
    expect(output).toContain("run: (none)");
    expect(output).toContain("workspace: not live");
    expect(output).toContain("Worktrees");
    expect(output).toContain("(none)");
    expect(output).not.toContain("Recent logs");
    expect(output).not.toContain("Ticket source");
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

    await status(makeConfig(), { ticket: "team-1" });

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

    await status(makeConfig(), { ticket: "team-1" });

    const output = consoleLog.output();
    expect(output).toContain("workspace: exited");
    expect(output).not.toContain("attach:");
    expect(output).not.toContain("tmux unavailable");
  });

  it("rejects an empty direct-call ticket", async () => {
    await expect(status(makeConfig(), { ticket: "   " })).rejects.toThrow(
      "ticket must be a non-empty value",
    );

    expect(findByTicketMock).not.toHaveBeenCalled();
    expect(listWorktreesMock).not.toHaveBeenCalled();
  });

  it("prints a run-state summary without optional detail and source status", async () => {
    readRunStateMock.mockReturnValue(runState());
    buildSourcesMock.mockResolvedValue([
      fakeSource([sourceIssue({ title: "No state type", status: "other" })]),
    ]);

    await status(makeConfig(), { ticket: "team-1" });

    const output = consoleLog.output();
    expect(output).toContain("running; model=claude; updated=2026-05-26T00:01:00.000Z; resumes=0");
    expect(output).toContain("ticket: team-1  other");
    expect(output).toContain("title: No state type");
  });

  it("prints run-state detail when only detail is recorded", async () => {
    readRunStateMock.mockReturnValue(
      runState({ state: "failed-to-launch", detail: "spawn failed" }),
    );

    await status(makeConfig(), { ticket: "team-1" });

    expect(consoleLog.output()).toContain("failed-to-launch");
    expect(consoleLog.output()).toContain("spawn failed");
  });

  it("flags the per-ticket run: line as `session dead` when running but no session is live", async () => {
    readRunStateMock.mockReturnValue(runState({ state: "running" }));
    workspaceProbeMock.mockResolvedValue({ kind: "ok", names: new Set() });

    await status(makeConfig(), { ticket: "team-1" });

    expect(consoleLog.output()).toContain(
      "run: running (session dead); model=claude; updated=2026-05-26T00:01:00.000Z; resumes=0",
    );
  });

  it("flags the per-ticket run: line as `session exited` when the kept tmux window has exited", async () => {
    readRunStateMock.mockReturnValue(runState({ state: "running" }));
    workspaceProbeMock.mockResolvedValue({
      kind: "ok",
      names: new Set(["team-1"]),
      exitedNames: new Set(["team-1"]),
    });

    await status(makeConfig(), { ticket: "team-1" });

    expect(consoleLog.output()).toContain(
      "run: running (session exited); model=claude; updated=2026-05-26T00:01:00.000Z; resumes=0",
    );
  });

  it("leaves the per-ticket run: line as bare `running` when the session is live", async () => {
    readRunStateMock.mockReturnValue(runState({ state: "running" }));
    workspaceProbeMock.mockResolvedValue({ kind: "ok", names: new Set(["team-1"]) });

    await status(makeConfig(), { ticket: "team-1" });

    const output = consoleLog.output();
    expect(output).toContain("run: running; model=claude;");
    expect(output).not.toContain("session dead");
    expect(output).not.toContain("session exited");
  });

  it("leaves the per-ticket run: line unflagged when the workspace probe is unavailable", async () => {
    readRunStateMock.mockReturnValue(runState({ state: "running" }));
    workspaceProbeMock.mockResolvedValue({ kind: "unavailable" });

    await status(makeConfig(), { ticket: "team-1" });

    const output = consoleLog.output();
    expect(output).toContain("run: running; model=claude;");
    expect(output).not.toContain("session dead");
    expect(output).not.toContain("session exited");
  });

  it("keeps the per-ticket run: line as `(none)` when a stray session is live but no run-state exists", async () => {
    // With no run-state, the `run:` line stays `(none)` even though the probe
    // sees a live session for this ticket. The stray-session disagreement is
    // surfaced by the `workspace: live` line (and the inventory view's
    // `hint: crew cleanup`), not by decorating the per-ticket `run:` line.
    readRunStateMock.mockReset();
    workspaceProbeMock.mockResolvedValue({ kind: "ok", names: new Set(["team-1"]) });

    await status(makeConfig(), { ticket: "team-1" });

    const output = consoleLog.output();
    expect(output).toContain("run: (none)");
    expect(output).not.toContain("stray session");
    expect(output).toContain("workspace: live");
  });

  it("surfaces the cached ticket title at the top of the per-ticket view", async () => {
    readRunStateMock.mockReturnValue(runState({ title: "Improve crew status command" }));

    await status(makeConfig(), { ticket: "team-1" });

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

    await status(makeConfig(), { ticket: "team-1" });

    expect(consoleLog.output().match(/title: Improve crew status command/g)).toHaveLength(1);
  });

  it("prints a changed source title separately from the cached title", async () => {
    readRunStateMock.mockReturnValue(runState({ title: "Cached title" }));
    buildSourcesMock.mockResolvedValue([fakeSource([sourceIssue({ title: "Current title" })])]);

    await status(makeConfig(), { ticket: "team-1" });

    const output = consoleLog.output();
    expect(output).toContain("title: Cached title");
    expect(output).toContain("source title: Current title");
  });

  it("omits the cached title line when no run state has a title", async () => {
    readRunStateMock.mockReturnValue(runState());

    await status(makeConfig(), { ticket: "team-1" });

    const output = consoleLog.output();
    const headerSection = output.slice(0, output.indexOf("run:"));
    expect(headerSection).not.toContain("title:");
  });

  it("prints an inventory when no ticket is provided", async () => {
    listWorktreesMock.mockReturnValue([
      worktree({ ticket: "team-1", repository: "repo-a", dir: "/work/repo-a-team-1" }),
      worktree({
        ticket: "team-1",
        repository: "repo-b",
        branchName: "dev-team-1-b",
        dir: "/work/repo-b-team-1",
      }),
      worktree({
        ticket: "team-2",
        repository: "repo-b",
        branchName: "dev-team-2",
        dir: "/work/repo-b-team-2",
      }),
    ]);
    const statesByTicket = new Map([["team-1", runState({ ticket: "team-1" })]]);
    readRunStateMock.mockImplementation((_config, ticket) => statesByTicket.get(ticket));
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
    // The per-ticket view (`crew status TEAM-1`) still surfaces it.
    expect(output).not.toContain("  branch:");
    // team-2 has no RunState but the probe sees a session — stray session.
    expect(output).toContain("team-2\n  state:     idle (stray session)");
    expect(output).toContain("Stray sessions");
    // team-1/team-2 sessions are tied to worktrees and should NOT appear as strays.
    expect(output).toMatch(/Stray sessions\n-+\norphan-workspace\n/);
    expect(readRunStateMock).toHaveBeenCalledTimes(2);
  });

  it("prints the cached ticket title and attach hint in the inventory when available", async () => {
    listWorktreesMock.mockReturnValue([
      worktree({ ticket: "team-1", repository: "repo-a" }),
      worktree({ ticket: "team-2", repository: "repo-b", branchName: "dev-team-2" }),
    ]);
    const statesByTicket = new Map([
      ["team-1", runState({ ticket: "team-1", title: "Improve crew status command" })],
      // team-2 has a run state but no cached title — title line must be omitted.
      ["team-2", runState({ ticket: "team-2" })],
    ]);
    readRunStateMock.mockImplementation((_config, ticket) => statesByTicket.get(ticket));
    // Worktrees iterate in sorted-ticket order: team-1 first, then team-2.
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
      worktree({ ticket: "team-1", repository: "repo-a" }),
      worktree({ ticket: "team-2", repository: "repo-b", branchName: "dev-team-2" }),
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
      worktree({ ticket: "team-1", repository: "repo-a", dir: "/work/repo-a-team-1" }),
      worktree({
        ticket: "team-2",
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

  it("hides the Stray sessions section when every live session matches a worktree", async () => {
    listWorktreesMock.mockReturnValue([worktree({ ticket: "team-1", repository: "repo-a" })]);
    workspaceProbeMock.mockResolvedValue({ kind: "ok", names: new Set(["team-1"]) });

    await status(makeConfig());

    expect(consoleLog.output()).not.toContain("Stray sessions");
  });

  it("formats durations across <1m / Nm / Nh / Nh Mm / Nd / Nd Mh ranges", async () => {
    listWorktreesMock.mockReturnValue([
      worktree({ ticket: "team-1", repository: "repo-a" }),
      worktree({ ticket: "team-2", repository: "repo-b", branchName: "dev-team-2" }),
      worktree({ ticket: "team-3", repository: "repo-b", branchName: "dev-team-3" }),
      worktree({ ticket: "team-4", repository: "repo-b", branchName: "dev-team-4" }),
      worktree({ ticket: "team-5", repository: "repo-b", branchName: "dev-team-5" }),
      worktree({ ticket: "team-6", repository: "repo-b", branchName: "dev-team-6" }),
    ]);
    workspaceProbeMock.mockResolvedValue({
      kind: "ok",
      names: new Set(["team-1", "team-2", "team-3", "team-4", "team-5", "team-6"]),
    });
    // beforeEach pinned now to 2026-05-26T02:14:30Z.
    const statesByTicket = new Map<string, RunState>([
      // ~30s old → `<1m`
      ["team-1", runState({ ticket: "team-1", createdAt: "2026-05-26T02:14:00.000Z" })],
      // 12m old → `12m`
      ["team-2", runState({ ticket: "team-2", createdAt: "2026-05-26T02:02:30.000Z" })],
      // 3d 7h old → `3d 7h`
      ["team-3", runState({ ticket: "team-3", createdAt: "2026-05-22T19:14:30.000Z" })],
      // Malformed createdAt → no duration token
      ["team-4", runState({ ticket: "team-4", createdAt: "not a date" })],
      // Exactly 5h old → `5h` (whole-hour branch)
      ["team-5", runState({ ticket: "team-5", createdAt: "2026-05-25T21:14:30.000Z" })],
      // Exactly 4d old → `4d` (whole-day branch)
      ["team-6", runState({ ticket: "team-6", createdAt: "2026-05-22T02:14:30.000Z" })],
    ]);
    readRunStateMock.mockImplementation((_config, ticket) => statesByTicket.get(ticket));

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
      worktree({ ticket: "team-1", repository: "repo-a" }),
      worktree({ ticket: "team-2", repository: "repo-b", branchName: "dev-team-2" }),
    ]);
    workspaceProbeMock.mockResolvedValue({ kind: "ok", names: new Set() });
    const statesByTicket = new Map<string, RunState>([
      ["team-1", runState({ ticket: "team-1", state: "interrupted" })],
    ]);
    readRunStateMock.mockImplementation((_config, ticket) => statesByTicket.get(ticket));

    await status(makeConfig());

    const output = consoleLog.output();
    expect(output).toContain("  state:     interrupted\n");
    expect(output).toContain("  state:     idle\n");
  });

  it("suggests `crew cleanup` next to stray-session rows", async () => {
    listWorktreesMock.mockReturnValue([worktree({ ticket: "team-1", repository: "repo-a" })]);
    // idle (no run-state) + live session => stray.
    readRunStateMock.mockReset();
    workspaceProbeMock.mockResolvedValue({ kind: "ok", names: new Set(["team-1"]) });

    await status(makeConfig());

    expect(consoleLog.output()).toContain(
      "  hint:      run 'crew cleanup team-1' to clear this stray session",
    );
  });

  it("suggests `crew resume` next to session-dead rows", async () => {
    listWorktreesMock.mockReturnValue([worktree({ ticket: "team-1", repository: "repo-a" })]);
    // running run-state + no live session => session dead.
    readRunStateMock.mockReturnValue(runState({ state: "running" }));
    workspaceProbeMock.mockResolvedValue({ kind: "ok", names: new Set() });

    await status(makeConfig());

    expect(consoleLog.output()).toContain(
      "  hint:      run 'crew resume team-1' to bring the session back",
    );
  });

  it("marks running inventory rows as exited when a kept tmux window has exited", async () => {
    listWorktreesMock.mockReturnValue([worktree({ ticket: "team-1", repository: "repo-a" })]);
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
    listWorktreesMock.mockReturnValue([worktree({ ticket: "team-1", repository: "repo-a" })]);
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
    listWorktreesMock.mockReturnValue([worktree({ ticket: "team-1", repository: "repo-a" })]);
    readRunStateMock.mockReturnValue(runState({ state: "running" }));
    workspaceProbeMock.mockResolvedValue({ kind: "ok", names: new Set(["team-1"]) });

    await status(makeConfig());

    expect(consoleLog.output()).not.toContain("  hint:");
  });

  it("omits the `hint:` line when the workspace probe is unavailable", async () => {
    listWorktreesMock.mockReturnValue([worktree({ ticket: "team-1", repository: "repo-a" })]);
    workspaceProbeMock.mockResolvedValue({ kind: "unavailable" });

    await status(makeConfig());

    expect(consoleLog.output()).not.toContain("  hint:");
  });

  it("labels run state as `idle` when no RunState file exists and no session is live", async () => {
    listWorktreesMock.mockReturnValue([worktree({ ticket: "team-1", repository: "repo-a" })]);
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
      worktree({ ticket: "team-1", repository: "repo-a", dir: "/work/repo-a-team-1" }),
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
    listWorktreesMock.mockReturnValue([worktree({ ticket: "team-1", repository: "repo-a" })]);
    findPullRequestsMock.mockResolvedValue([
      { url: "https://x/pull/1", number: 1, state: "open", title: "a" },
      { url: "https://x/pull/2", number: 2, state: "merged", title: "b" },
    ]);

    await status(makeConfig());

    expect(consoleLog.output()).toContain(
      "  pr:        https://x/pull/1 (open), https://x/pull/2 (merged)",
    );
  });

  it("omits the `pr:` line in inventory rows when gh returns nothing", async () => {
    listWorktreesMock.mockReturnValue([worktree({ ticket: "team-1", repository: "repo-a" })]);
    findPullRequestsMock.mockResolvedValue([]);

    await status(makeConfig());

    expect(consoleLog.output()).not.toContain("  pr:");
  });

  it("renders a `pr:` line in the per-ticket Worktrees section when present", async () => {
    findByTicketMock.mockReturnValue([
      worktree({ ticket: "team-1", repository: "repo-a", dir: "/work/repo-a-team-1" }),
    ]);
    findPullRequestsMock.mockResolvedValue([
      {
        url: "https://github.com/acme/widgets/pull/99",
        number: 99,
        state: "open",
        title: "Something",
      },
    ]);

    await status(makeConfig(), { ticket: "team-1" });

    expect(consoleLog.output()).toContain("  pr: https://github.com/acme/widgets/pull/99 (open)");
    expect(findPullRequestsMock).toHaveBeenCalledWith({
      cwd: "/work/repo-a-team-1",
      branchName: "dev-team-1",
    });
  });

  it("renders the cached ticket url next to the inventory ticket id", async () => {
    listWorktreesMock.mockReturnValue([worktree({ ticket: "team-1", repository: "repo-a" })]);
    readRunStateMock.mockReturnValue(
      runState({ ticket: "team-1", url: "https://linear.app/example/issue/TEAM-1" }),
    );
    workspaceProbeMock.mockResolvedValue({ kind: "ok", names: new Set(["team-1"]) });

    await status(makeConfig());

    expect(consoleLog.output()).toContain("team-1  https://linear.app/example/issue/TEAM-1\n");
  });

  it("renders the cached ticket url next to the per-ticket header", async () => {
    readRunStateMock.mockReturnValue(runState({ url: "https://linear.app/example/issue/TEAM-1" }));

    await status(makeConfig(), { ticket: "team-1" });

    expect(consoleLog.output()).toContain(
      "ticket: team-1  https://linear.app/example/issue/TEAM-1",
    );
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

  it("lists in-progress tickets with no local worktree so the slot count is explainable", async () => {
    // team-901 is in-progress AND has a local worktree, so it already shows in
    // the Worktrees section. team-902 is in-progress with no local worktree
    // (its worktree was removed or lives outside this config's scope) — it
    // counts toward the slot total but is otherwise invisible, so it belongs
    // in the new section.
    listWorktreesMock.mockReturnValue([worktree({ ticket: "team-901", repository: "repo-a" })]);
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
    expect(output).toContain("In progress (no local worktree)\n-------------------------------");
    expect(output).toContain("team-902  https://linear.app/example/issue/TEAM-902");
    expect(output).toContain("  title:     Type the boundary");
    expect(output).toContain("  repo:      repo-b");
    expect(output).toContain("slots: 2/4 used");
    // team-901 has a worktree, so it belongs in the Worktrees section only and
    // must not be duplicated under the new section (which sits just above the
    // slots line).
    const sectionStart = output.indexOf("In progress (no local worktree)");
    const section = output.slice(sectionStart, output.indexOf("slots:", sectionStart));
    expect(section).toContain("team-902");
    expect(section).not.toContain("team-901");
  });

  it("hides the in-progress-without-worktree section when every in-progress ticket has a worktree", async () => {
    listWorktreesMock.mockReturnValue([worktree({ ticket: "team-901", repository: "repo-a" })]);
    workspaceProbeMock.mockResolvedValue({ kind: "ok", names: new Set() });
    buildSourcesMock.mockResolvedValue([
      fakeSource([sourceIssue({ id: "linear:team-901", status: "in-progress" })]),
    ]);

    await status(makeConfig({ sources: [{ kind: "linear", name: "linear" }] }));

    expect(consoleLog.output()).not.toContain("In progress (no local worktree)");
  });

  it("omits the repo line for an in-progress ticket with no repository", async () => {
    listWorktreesMock.mockReturnValue([]);
    workspaceProbeMock.mockResolvedValue({ kind: "ok", names: new Set() });
    buildSourcesMock.mockResolvedValue([
      fakeSource([
        sourceIssue({
          id: "linear:team-905",
          status: "in-progress",
          title: "Ticket without a repo",
          repository: undefined,
        }),
      ]),
    ]);

    await status(makeConfig({ sources: [{ kind: "linear", name: "linear" }] }));

    const output = consoleLog.output();
    expect(output).toContain("team-905");
    expect(output).toContain("  title:     Ticket without a repo");
    const sectionStart = output.indexOf("In progress (no local worktree)");
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

  it("waits for the ticket source before rendering the inventory so each row can show its status", async () => {
    // The inventory intentionally blocks on the board fetch: every Worktrees
    // row carries the remote ticket status, which isn't known until the source
    // resolves. So nothing renders while the fetch is pending.
    listWorktreesMock.mockReturnValue([worktree({ ticket: "team-1", repository: "repo-a" })]);
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
    expect(output).toContain("  ticket:    in-progress (slot held)");
  });

  it("annotates an in-progress worktree row with the slot-held ticket status", async () => {
    listWorktreesMock.mockReturnValue([
      worktree({ ticket: "team-901", repository: "repo-a", dir: "/work/repo-a-team-901" }),
    ]);
    workspaceProbeMock.mockResolvedValue({ kind: "ok", names: new Set(["team-901"]) });
    buildSourcesMock.mockResolvedValue([
      fakeSource([sourceIssue({ id: "linear:team-901", status: "in-progress" })]),
    ]);

    await status(makeConfig({ sources: [{ kind: "linear", name: "linear" }] }));

    expect(consoleLog.output()).toContain("  ticket:    in-progress (slot held)");
  });

  it("shows the bare canonical status for a worktree whose ticket holds no slot", async () => {
    listWorktreesMock.mockReturnValue([
      worktree({ ticket: "team-902", repository: "repo-a", dir: "/work/repo-a-team-902" }),
    ]);
    workspaceProbeMock.mockResolvedValue({ kind: "ok", names: new Set(["team-902"]) });
    buildSourcesMock.mockResolvedValue([
      fakeSource([sourceIssue({ id: "linear:team-902", status: "in-review" })]),
    ]);

    await status(makeConfig({ sources: [{ kind: "linear", name: "linear" }] }));

    const output = consoleLog.output();
    expect(output).toContain("  ticket:    in-review");
    expect(output).not.toContain("slot held");
  });

  it("omits the ticket field for a worktree whose ticket is absent from the board", async () => {
    listWorktreesMock.mockReturnValue([
      worktree({ ticket: "team-903", repository: "repo-a", dir: "/work/repo-a-team-903" }),
    ]);
    workspaceProbeMock.mockResolvedValue({ kind: "ok", names: new Set(["team-903"]) });
    buildSourcesMock.mockResolvedValue([
      fakeSource([sourceIssue({ id: "linear:team-700", status: "todo" })]),
    ]);

    await status(makeConfig({ sources: [{ kind: "linear", name: "linear" }] }));

    expect(consoleLog.output()).not.toContain("  ticket:");
  });

  it("omits the ticket field when multiple sources return the same natural ticket id", async () => {
    listWorktreesMock.mockReturnValue([
      worktree({ ticket: "team-906", repository: "repo-a", dir: "/work/repo-a-team-906" }),
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
    expect(output).not.toContain("  ticket:");
  });

  it("omits the ticket field on worktree rows when the board fetch fails", async () => {
    listWorktreesMock.mockReturnValue([
      worktree({ ticket: "team-904", repository: "repo-a", dir: "/work/repo-a-team-904" }),
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
    expect(output).not.toContain("  ticket:");
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
    expect(output).toContain("In progress (no local worktree)");
    expect(output).toContain("  ticket:    in-progress (slot held)");
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
          model: "claude",
        }),
        // Eligible Todo blocked by another in-progress ticket.
        sourceIssue({
          id: "linear:team-102",
          title: "Polish UI",
          url: "https://linear.app/example/issue/TEAM-102",
          repository: "repo-b",
          model: "codex",
          blockers: [
            {
              id: "linear:team-50",
              title: "Migrate db",
              status: "in-progress",
              nativeStatus: "In Progress",
            },
          ],
        }),
        // Ineligible (no model/repo) — excluded from Queue.
        sourceIssue({
          id: "linear:team-103",
          title: "No label",
          repository: undefined,
          model: undefined,
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
    expect(output).toContain("  model:     claude");
    expect(output).toContain("Blocked\n-------");
    expect(output).toContain("team-102  https://linear.app/example/issue/TEAM-102");
    expect(output).toContain("  blocked by:  team-50 (In Progress)");
    // team-103 is an ineligible Todo (no repo/model) — surfaced nowhere.
    expect(output).not.toContain("team-103");
    // team-104 is in-progress, so it's excluded from the Queue but now appears
    // in the "In progress (no local worktree)" section above the slots line.
    const queueSection = output.slice(output.indexOf("Queue\n-----"));
    expect(queueSection).not.toContain("team-104");
    expect(output).toContain("In progress (no local worktree)");
    expect(output).toContain("team-104");
  });

  it("hides the Queue section when the source has only non-Todo issues", async () => {
    listWorktreesMock.mockReturnValue([]);
    workspaceProbeMock.mockResolvedValue({ kind: "ok", names: new Set() });
    buildSourcesMock.mockResolvedValue([
      fakeSource([sourceIssue({ id: "linear:team-201", status: "in-progress" })]),
    ]);

    await status(makeConfig({ sources: [{ kind: "linear", name: "linear" }] }));

    // No eligible Todos -> no Queue section. (The lone in-progress ticket
    // surfaces in the "In progress (no local worktree)" section instead, so
    // match the Queue section header rather than the bare word "Queue", which
    // also appears in the default "Queued ticket" title.)
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
    listWorktreesMock.mockReturnValue([worktree({ ticket: "team-1", repository: "repo-a" })]);
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
});

describe(statusCli, () => {
  let consoleLog: ConsoleCapture;

  beforeEach(() => {
    consoleLog = captureConsoleLog();
    loadConfigMock.mockResolvedValue(makeConfig());
    listWorktreesMock.mockReturnValue([]);
    findByTicketMock.mockReturnValue([]);
    workspaceProbeMock.mockResolvedValue({ kind: "unavailable" });
    workspaceAccessHintMock.mockReset();
    findPullRequestsMock.mockResolvedValue([]);
    readRunStateMock.mockReset();
    buildSourcesMock.mockResolvedValue([]);
  });

  afterEach(() => {
    consoleLog.restore();
    vi.resetAllMocks();
  });

  it("loads config and normalizes a ticket argument", async () => {
    await statusCli(["TEAM-1"]);

    expect(findByTicketMock.mock.calls[0]?.[1]).toBe("team-1");
    expect(consoleLog.output()).toContain("groundcrew status TEAM-1");
  });

  it("loads config and prints inventory with no ticket argument", async () => {
    workspaceProbeMock.mockResolvedValue({ kind: "ok", names: new Set() });

    await statusCli([]);

    expect(listWorktreesMock.mock.calls.length).toBeGreaterThan(0);
    expect(consoleLog.output()).toContain("Worktrees\n---------\n(none)");
  });

  it("rejects an empty ticket argument", async () => {
    await expect(statusCli([""])).rejects.toThrow(/Usage: crew status/);

    expect(loadConfigMock).not.toHaveBeenCalled();
  });

  it("rejects unknown flags", async () => {
    await expect(statusCli(["--ticket", "TEAM-1"])).rejects.toThrow(/Usage: crew status/);

    expect(loadConfigMock).not.toHaveBeenCalled();
  });

  it("rejects extra positional arguments", async () => {
    await expect(statusCli(["TEAM-1", "extra"])).rejects.toThrow(/Usage: crew status/);

    expect(loadConfigMock).not.toHaveBeenCalled();
  });
});
