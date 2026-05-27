import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LinearClient } from "@linear/sdk";

import { fetchRawLinearIssue, type RawLinearIssue } from "../lib/boardSource.ts";
import { loadConfig, type ResolvedConfig } from "../lib/config.ts";
import { readRunState, type RunState } from "../lib/runState.ts";
import { getLinearClient } from "../lib/util.ts";
import { type WorkspaceProbe, workspaces } from "../lib/workspaces.ts";
import { type WorktreeDirtiness, type WorktreeEntry, worktrees } from "../lib/worktrees.ts";
import { captureConsoleLog, type ConsoleCapture } from "../testHelpers/consoleCapture.ts";
import { status, statusCli } from "./status.ts";

vi.mock(import("../lib/config.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, loadConfig: vi.fn<typeof loadConfig>() };
});
vi.mock(import("../lib/boardSource.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, fetchRawLinearIssue: vi.fn<typeof fetchRawLinearIssue>() };
});
vi.mock(import("../lib/runState.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, readRunState: vi.fn<typeof readRunState>() };
});
vi.mock(import("../lib/util.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, getLinearClient: vi.fn<typeof getLinearClient>() };
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

const fetchRawLinearIssueMock = vi.mocked(fetchRawLinearIssue);
const getLinearClientMock = vi.mocked(getLinearClient);
const loadConfigMock = vi.mocked(loadConfig);
const readRunStateMock = vi.mocked(readRunState);
const workspaceProbeMock = vi.mocked(workspaces.probe);
const findByTicketMock = vi.mocked(worktrees.findByTicket);
const listWorktreesMock = vi.mocked(worktrees.list);
const probeWorkingTreeMock = vi.mocked(worktrees.probeWorkingTree);

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    sources: [],
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
    branchName: "rocky-team-1",
    dir: "/work/repo-a-team-1",
    kind: "host",
    ...overrides,
  };
}

function rawIssue(overrides: Partial<RawLinearIssue> = {}): RawLinearIssue {
  return {
    uuid: "uuid-1",
    title: "Fix the thing",
    description: "",
    teamId: "team-1",
    labels: [],
    stateName: "Todo",
    stateType: "unstarted",
    blockers: [],
    hasMoreBlockers: false,
    hasChildren: false,
    ...overrides,
  };
}

function runState(overrides: Partial<RunState> = {}): RunState {
  return {
    ticket: "team-1",
    repository: "repo-a",
    model: "claude",
    worktreeDir: "/work/repo-a-team-1",
    branchName: "rocky-team-1",
    workspaceName: "team-1",
    state: "running",
    createdAt: "2026-05-26T00:00:00.000Z",
    updatedAt: "2026-05-26T00:01:00.000Z",
    resumeCount: 0,
    ...overrides,
  };
}

function linearClient(): LinearClient {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- status tests never call the client directly; it is passed through to the mocked fetcher.
  return { client: {} } as unknown as LinearClient;
}

describe(status, () => {
  let consoleLog: ConsoleCapture;
  let temporaryDirectory: string;

  beforeEach(() => {
    consoleLog = captureConsoleLog();
    temporaryDirectory = mkdtempSync(join(tmpdir(), "groundcrew-status-test-"));
    getLinearClientMock.mockReturnValue(linearClient());
    fetchRawLinearIssueMock.mockResolvedValue(rawIssue());
    readRunStateMock.mockReturnValue(runState({ reason: "manual pause" }));
    workspaceProbeMock.mockResolvedValue({ kind: "ok", names: new Set(["team-1"]) });
    findByTicketMock.mockReturnValue([worktree()]);
    listWorktreesMock.mockReturnValue([worktree()]);
    probeWorkingTreeMock.mockResolvedValue({ kind: "clean" });
  });

  afterEach(() => {
    consoleLog.restore();
    rmSync(temporaryDirectory, { recursive: true, force: true });
    vi.resetAllMocks();
  });

  it("prints the read-only per-ticket status dump", async () => {
    const logFile = join(temporaryDirectory, "groundcrew.log");
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
      worktree({ repository: "repo-b", dir: "/work/repo-b-team-1", branchName: "rocky-team-1-b" }),
      worktree({
        repository: "repo-b",
        dir: "/work/repo-b-team-1-alt",
        branchName: "rocky-team-1-c",
      }),
    ];
    findByTicketMock.mockReturnValue(entries);
    probeWorkingTreeMock
      .mockResolvedValueOnce({ kind: "clean" } satisfies WorktreeDirtiness)
      .mockResolvedValueOnce({ kind: "dirty", modified: 2, untracked: 1 })
      .mockResolvedValueOnce({ kind: "unknown" });
    fetchRawLinearIssueMock.mockResolvedValue(
      rawIssue({ title: "Fix status", stateName: "In Progress", stateType: "started" }),
    );

    await status(config, { ticket: "team-1" });

    const output = consoleLog.output();
    expect(output).toContain("groundcrew status TEAM-1");
    expect(output).toContain("Config snapshot");
    expect(output).toContain("projectDir: /work");
    expect(output).toContain("repositories: repo-a, repo-b");
    expect(output).toContain("models: default=claude; enabled=claude, codex");
    expect(output).toContain("Worktree state");
    expect(output).toContain("repo-a host");
    expect(output).toContain("git: clean");
    expect(output).toContain("git: dirty (2 modified, 1 untracked)");
    expect(output).toContain("git: unknown");
    expect(output).toContain("Workspace probe");
    expect(output).toContain("live: yes");
    expect(output).toContain("Run state");
    expect(output).toContain("running; model=claude; updated=2026-05-26T00:01:00.000Z; resumes=0");
    expect(output).toContain("manual pause");
    expect(output).toContain("Recent logs");
    expect(output).toContain("event=dispatch outcome=started ticket=team-1");
    expect(output).not.toContain("ticket=team-10");
    expect(output).toContain('Workspace "TEAM-1" launched');
    expect(output).not.toContain("unrelated ticket");
    expect(output).toContain("Last Linear status");
    expect(output).toContain("In Progress (state.type=started) — Fix status");
  });

  it("prints unavailable fields without attempting recovery", async () => {
    const config = makeConfig({ logging: { file: join(temporaryDirectory, "missing.log") } });
    findByTicketMock.mockReturnValue([]);
    workspaceProbeMock.mockResolvedValue({ kind: "ok", names: new Set() });
    readRunStateMock.mockReset();
    fetchRawLinearIssueMock.mockRejectedValue(new Error("Linear down"));

    await status(config, { ticket: "team-404" });

    const output = consoleLog.output();
    expect(output).toContain("ticket: team-404");
    expect(output).toContain("Worktree state");
    expect(output).toContain("(none)");
    expect(output).toContain("live: no");
    expect(output).toContain("Run state");
    expect(output).toContain("(none)");
    expect(output).toContain("Recent logs");
    expect(output).toContain("(none)");
    expect(output).toContain("unavailable: Linear down");
  });

  it("rejects an empty direct-call ticket", async () => {
    await expect(status(makeConfig(), { ticket: "   " })).rejects.toThrow(
      "ticket must be a non-empty value",
    );

    expect(findByTicketMock).not.toHaveBeenCalled();
    expect(listWorktreesMock).not.toHaveBeenCalled();
  });

  it("prints a run-state summary without optional detail", async () => {
    const issueWithoutStateType = rawIssue({ title: "No state type" });
    delete issueWithoutStateType.stateType;
    readRunStateMock.mockReturnValue(runState());
    fetchRawLinearIssueMock.mockResolvedValue(issueWithoutStateType);

    await status(makeConfig(), { ticket: "team-1" });

    const output = consoleLog.output();
    expect(output).toContain("running; model=claude; updated=2026-05-26T00:01:00.000Z; resumes=0");
    expect(output).toContain("Todo (state.type=unknown) — No state type");
  });

  it("prints run-state detail when only detail is recorded", async () => {
    readRunStateMock.mockReturnValue(
      runState({ state: "failed-to-launch", detail: "spawn failed" }),
    );

    await status(makeConfig(), { ticket: "team-1" });

    expect(consoleLog.output()).toContain("failed-to-launch");
    expect(consoleLog.output()).toContain("spawn failed");
  });

  it("prints an inventory when no ticket is provided", async () => {
    listWorktreesMock.mockReturnValue([
      worktree({ ticket: "team-1", repository: "repo-a" }),
      worktree({ ticket: "team-1", repository: "repo-b", branchName: "rocky-team-1-b" }),
      worktree({ ticket: "team-2", repository: "repo-b", branchName: "rocky-team-2" }),
    ]);
    const statesByTicket = new Map([["team-1", runState({ ticket: "team-1" })]]);
    readRunStateMock.mockImplementation((_config, ticket) => statesByTicket.get(ticket));
    workspaceProbeMock.mockResolvedValue({
      kind: "ok",
      names: new Set(["team-2", "orphan-workspace"]),
    });

    await status(makeConfig());

    const output = consoleLog.output();
    expect(output).toContain("groundcrew status");
    expect(output).toContain("Worktrees");
    expect(output).toContain("team-1  repo-a  host  workspace=no  run=running");
    expect(output).toContain("team-1  repo-b  host  workspace=no  run=running");
    expect(output).toContain("team-2  repo-b  host  workspace=yes  run=none");
    expect(output).toContain("Live workspaces");
    expect(output).toContain("team-2");
    expect(output).toContain("orphan-workspace");
    expect(readRunStateMock).toHaveBeenCalledTimes(2);
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
    expect(output).toContain("team-1  repo-a  host  workspace=unknown  run=running");
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
    readRunStateMock.mockReset();
    fetchRawLinearIssueMock.mockResolvedValue(rawIssue());
    getLinearClientMock.mockReturnValue(linearClient());
  });

  afterEach(() => {
    consoleLog.restore();
    vi.resetAllMocks();
  });

  it("loads config and normalizes a ticket argument", async () => {
    await statusCli(["TEAM-1"]);

    expect(findByTicketMock).toHaveBeenCalledWith(expect.any(Object), "team-1");
    expect(consoleLog.output()).toContain("groundcrew status TEAM-1");
  });

  it("loads config and prints inventory with no ticket argument", async () => {
    workspaceProbeMock.mockResolvedValue({ kind: "ok", names: new Set() });

    await statusCli([]);

    expect(listWorktreesMock).toHaveBeenCalledWith(expect.any(Object));
    expect(consoleLog.output()).toContain("groundcrew status");
    expect(consoleLog.output()).toContain("(none)");
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
