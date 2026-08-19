import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type * as nodeFs from "node:fs";

import { ensureClearance, type SafehouseCmuxIntegration } from "@clipboard-health/clearance";
import { fetchResolvedIssue } from "../lib/adapters/linear/fetch.ts";
import { getLinearClient } from "../lib/adapters/linear/client.ts";
import { loadConfig, type ResolvedConfig } from "../lib/config.ts";
import type { Board } from "../lib/board.ts";
import { detectHostCapabilities, type HostCapabilities } from "../lib/host.ts";
import { readRunState, recordRunState, type RunState } from "../lib/runState.ts";
import { seedLaunchWorkspaceTrust } from "../lib/seedLaunchWorkspaceTrust.ts";
import { canonicalShellIssue } from "../lib/testing/canonicalFixtures.ts";
import { safehouseCmuxIntegrationFixture } from "../testHelpers/safehouseCmuxIntegration.ts";
import { workspaces } from "../lib/workspaces.ts";
import { type WorktreeEntry, worktrees } from "../lib/worktrees.ts";
import { resumeWorkspace, resumeWorkspaceCli } from "./resumeWorkspace.ts";
import { captureConsoleLog } from "../testHelpers/consoleCapture.ts";
import { acquireLifecycleLock } from "./lifecycleCommand.ts";

interface NodeFsMock extends Omit<typeof nodeFs, "mkdtempSync" | "rmSync" | "writeFileSync"> {
  mkdtempSync: ReturnType<typeof vi.fn<typeof mkdtempSync>>;
  rmSync: ReturnType<typeof vi.fn<typeof rmSync>>;
  writeFileSync: ReturnType<typeof vi.fn<typeof writeFileSync>>;
}

const resolveSafehouseCmuxIntegrationMock = vi.hoisted(() =>
  vi.fn<() => SafehouseCmuxIntegration>(),
);

vi.mock("node:fs", async (importOriginal): Promise<NodeFsMock> => {
  const actual = await importOriginal<typeof nodeFs>();
  return {
    ...actual,
    mkdtempSync: vi.fn<typeof mkdtempSync>(),
    rmSync: vi.fn<typeof rmSync>(),
    writeFileSync: vi.fn<typeof writeFileSync>(),
  };
});
vi.mock(import("@clipboard-health/clearance"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    ensureClearance: vi.fn<typeof ensureClearance>(),
    resolveSafehouseCmuxIntegration: resolveSafehouseCmuxIntegrationMock,
  };
});
vi.mock(import("../lib/adapters/linear/fetch.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, fetchResolvedIssue: vi.fn<typeof fetchResolvedIssue>() };
});
vi.mock(import("../lib/adapters/linear/client.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, getLinearClient: vi.fn<typeof getLinearClient>() };
});
vi.mock(import("../lib/config.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, loadConfig: vi.fn<typeof loadConfig>() };
});
vi.mock(import("../lib/host.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, detectHostCapabilities: vi.fn<typeof detectHostCapabilities>() };
});
vi.mock(import("../lib/runState.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    readRunState: vi.fn<typeof readRunState>(),
    recordRunState: vi.fn<typeof recordRunState>(),
  };
});
vi.mock(import("../lib/util.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, log: vi.fn<typeof actual.log>() };
});
vi.mock(import("../lib/workspaces.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    workspaces: {
      ...actual.workspaces,
      close: vi.fn<typeof actual.workspaces.close>(),
      open: vi.fn<typeof actual.workspaces.open>(),
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
      findByTask: vi.fn<typeof actual.worktrees.findByTask>(),
      create: vi.fn<typeof actual.worktrees.create>(),
    },
  };
});
vi.mock(import("../lib/seedLaunchWorkspaceTrust.ts"), async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/seedLaunchWorkspaceTrust.ts")>();
  return { ...actual, seedLaunchWorkspaceTrust: vi.fn<typeof seedLaunchWorkspaceTrust>() };
});
const runCommandMock = vi.hoisted(() =>
  vi.fn<(cmd: string, arguments_: readonly string[]) => string>(),
);
vi.mock(import("../lib/commandRunner.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, runCommand: runCommandMock };
});

// Safehouse resolves the git common dir from the worktree; the worktree dir here
// is a fixture path, so stub the probe and return "" for anything else.
function stubRunCommand(): void {
  runCommandMock.mockImplementation((cmd: string, arguments_: readonly string[]) =>
    cmd === "git" && arguments_.includes("--git-common-dir")
      ? "/tmp/groundcrew-resume-team-1-x/.git"
      : "",
  );
}

const mkdtempMock = vi.mocked(mkdtempSync);
const rmSyncMock = vi.mocked(rmSync);
const writeFileMock = vi.mocked(writeFileSync);
const ensureClearanceMock = vi.mocked(ensureClearance);
const fetchResolvedIssueMock = vi.mocked(fetchResolvedIssue);
const loadConfigMock = vi.mocked(loadConfig);
const detectHostMock = vi.mocked(detectHostCapabilities);
const readRunStateMock = vi.mocked(readRunState);
const recordRunStateMock = vi.mocked(recordRunState);
const getLinearClientMock = vi.mocked(getLinearClient);
const seedLaunchWorkspaceTrustMock = vi.mocked(seedLaunchWorkspaceTrust);
const workspacesOpenMock = vi.mocked(workspaces.open);
const workspacesProbeMock = vi.mocked(workspaces.probe);
const findByTaskMock = vi.mocked(worktrees.findByTask);
const createMock = vi.mocked(worktrees.create);

type RecordedRunState = Parameters<typeof recordRunState>[0]["state"];
type IssueLookup = (id: string) => Promise<{
  title: string;
  description?: string | undefined;
  url?: string | undefined;
}>;

function lastRecordedRunState(): RecordedRunState {
  const input = recordRunStateMock.mock.calls.at(-1)?.[0];
  if (input === undefined) {
    throw new Error("recordRunState was not called");
  }
  return input.state;
}

function stagedLaunchScript(): string {
  const call = writeFileMock.mock.calls.find(
    (args) => args[0] === "/tmp/groundcrew-resume-team-1-x/launch.sh",
  );
  const content = call?.[1];
  if (typeof content !== "string") {
    throw new TypeError("launch.sh was not staged");
  }
  return content;
}

function host(overrides: Partial<HostCapabilities> = {}): HostCapabilities {
  return {
    hasSafehouse: true,
    hasSbx: false,
    hasCmux: true,
    hasTmux: false,
    hasZellij: false,
    isMacOS: true,
    isLinux: false,
    isSafehouseSupported: true,
    isSdxSupported: true,
    ...overrides,
  };
}

function makeConfig(): ResolvedConfig {
  return {
    sources: [{ kind: "linear" }],
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
      definitions: { claude: { cmd: "claude --auto", color: "#fff" } },
    },
    prompts: { initial: "x" },
    workspaceKind: "auto",
    local: {
      runner: "auto",
      networkEgress: "allowlisted",
      safehouse: { enable: [] },
      readOnlyDirs: [],
    },
    logging: { file: "/tmp/groundcrew-resume-workspace-test.log" },
  };
}

function makeWorktree(): WorktreeEntry {
  return {
    repository: "repo-a",
    task: "team-1",
    branchName: "dev-team-1",
    dir: "/work/repo-a-team-1",
    kind: "host",
  };
}

function requireAcquiredLock(
  lock: ReturnType<typeof acquireLifecycleLock>,
): Extract<ReturnType<typeof acquireLifecycleLock>, { kind: "acquired" }> {
  if (lock.kind !== "acquired") {
    throw new Error("test could not acquire lifecycle lock");
  }
  return lock;
}

function makeRunState(overrides: Partial<RunState> = {}): RunState {
  const state: RunState = {
    task: "team-1",
    repository: "repo-a",
    agent: "claude",
    worktreeDir: "/work/repo-a-team-1",
    branchName: "dev-team-1",
    workspaceName: "team-1",
    state: "interrupted",
    reason: "wrong direction",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    resumeCount: 1,
    ...overrides,
  };
  return state;
}

function makeRunStateWithoutReason(overrides: Partial<RunState> = {}): RunState {
  const state = makeRunState(overrides);
  delete state.reason;
  return state;
}

function mockLinearIssue(): void {
  const issue = vi.fn<IssueLookup>().mockResolvedValue({ title: "Title", description: "Body" });
  getLinearClientMock.mockReturnValue({
    issue,
  } as unknown as ReturnType<typeof getLinearClient>);
}

function resolvedLinearTask(
  overrides: Partial<Awaited<ReturnType<typeof fetchResolvedIssue>>> = {},
): Awaited<ReturnType<typeof fetchResolvedIssue>> {
  return {
    uuid: "uuid-1",
    title: "Resolved title",
    description: "Resolved body for repo-a",
    repository: "repo-a",
    agent: "claude",
    teamId: "team-1",
    stateType: "unstarted",
    status: "Todo",
    statusId: "state-todo",
    assignee: "Alice",
    updatedAt: "2026-01-01T00:00:00Z",
    blockers: [],
    hasMoreBlockers: false,
    url: "https://linear.app/example/issue/TEAM-1",
    priority: 0,
    ...overrides,
  };
}

describe(resumeWorkspace, () => {
  const config = makeConfig();

  beforeEach(() => {
    mkdtempMock.mockReturnValue("/tmp/groundcrew-resume-team-1-x");
    stubRunCommand();
    mockLinearIssue();
    readRunStateMock.mockReturnValue(makeRunState());
    findByTaskMock.mockReturnValue([makeWorktree()]);
    workspacesProbeMock.mockResolvedValue({ kind: "ok", names: new Set<string>() });
    workspacesOpenMock.mockResolvedValue();
    detectHostMock.mockResolvedValue(host());
    ensureClearanceMock.mockResolvedValue({
      logPath: "/tmp/clearance/clearance.log",
      pidPath: "/tmp/clearance/clearance.pid",
      port: 19_999,
      status: "already-running",
    });
    resolveSafehouseCmuxIntegrationMock.mockReturnValue(safehouseCmuxIntegrationFixture());
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it("opens a new workspace in the existing worktree and records a resume", async () => {
    await resumeWorkspace(config, { task: "TEAM-1" });

    expect(createMock).not.toHaveBeenCalled();
    expect(workspacesOpenMock).toHaveBeenCalledWith(
      config,
      expect.objectContaining({
        name: "team-1",
        cwd: "/work/repo-a-team-1",
      }),
    );
    expect(lastRecordedRunState()).toMatchObject({
      task: "team-1",
      state: "resumed",
      resumeCount: 2,
      reason: "wrong direction",
    });
    expect(seedLaunchWorkspaceTrustMock).toHaveBeenCalledWith({
      agentCommandName: "claude",
      launchDir: "/work/repo-a-team-1",
    });
  });

  it("reuses the exact task URL cached in run state", async () => {
    readRunStateMock.mockReturnValue(
      makeRunState({ url: "https://linear.app/example/issue/TEAM-1/source-slug" }),
    );

    await resumeWorkspace(config, { task: "team-1" });

    expect(workspacesOpenMock).toHaveBeenCalledWith(
      config,
      expect.objectContaining({
        name: "team-1",
        url: "https://linear.app/example/issue/TEAM-1/source-slug",
      }),
    );
  });

  it("uses the source URL fetched for legacy run state without one", async () => {
    fetchResolvedIssueMock.mockResolvedValue(
      resolvedLinearTask({ url: "https://linear.app/example/issue/TEAM-1/fetched-slug" }),
    );

    await resumeWorkspace(config, { task: "team-1" });

    expect(workspacesOpenMock).toHaveBeenCalledWith(
      config,
      expect.objectContaining({
        name: "team-1",
        url: "https://linear.app/example/issue/TEAM-1/fetched-slug",
      }),
    );
  });

  it("omits the task URL when an injected Board resolves details without one", async () => {
    const board: Board = {
      verify: vi.fn<Board["verify"]>(),
      fetch: vi.fn<Board["fetch"]>(),
      resolveOne: vi
        .fn<Board["resolveOne"]>()
        .mockResolvedValue(
          canonicalShellIssue({ naturalId: "team-1", repository: "repo-a", agent: "claude" }),
        ),
      markInProgress: vi.fn<Board["markInProgress"]>(),
      markInReview: vi.fn<Board["markInReview"]>(),
      markDone: vi.fn<Board["markDone"]>(),
    };

    await resumeWorkspace(config, { task: "team-1" }, { board });

    expect(workspacesOpenMock.mock.calls[0]?.[1]).not.toHaveProperty("url");
  });

  it("does not attach a colliding Linear URL to a URL-less task from another source", async () => {
    const multiSourceConfig: ResolvedConfig = {
      ...config,
      sources: [
        { kind: "linear" },
        {
          kind: "todo-txt",
          name: "todo",
          todoPath: "todo.txt",
          tasksDir: ".tasks",
          idPrefix: "TEAM",
          timezone: "UTC",
        },
      ],
    };
    readRunStateMock.mockReturnValue(makeRunState({ completionTaskId: "todo:team-1" }));
    getLinearClientMock.mockReturnValue({
      issue: vi.fn<IssueLookup>().mockResolvedValue({
        title: "Unrelated Linear task",
        description: "Body",
        url: "https://linear.app/example/issue/TEAM-1/unrelated",
      }),
    } as unknown as ReturnType<typeof getLinearClient>);

    await resumeWorkspace(multiSourceConfig, { task: "team-1" });

    expect(workspacesOpenMock.mock.calls[0]?.[1]).not.toHaveProperty("url");
    expect(lastRecordedRunState()).not.toHaveProperty("url");
  });

  function resumeArgsConfig(): ResolvedConfig {
    return {
      ...config,
      agents: {
        default: "claude",
        definitions: {
          claude: { cmd: "claude --auto", color: "#fff", resumeArgs: "--continue" },
        },
      },
    };
  }

  it("appends resumeArgs by default so the agent reopens its conversation", async () => {
    await resumeWorkspace(resumeArgsConfig(), { task: "team-1" });

    expect(stagedLaunchScript()).toContain("--continue");
  });

  it("cold-starts without resume args when --new is passed", async () => {
    await resumeWorkspace(resumeArgsConfig(), { task: "team-1", fresh: true });

    expect(stagedLaunchScript()).not.toContain("--continue");
  });

  it("does not append resume args for agents without resumeArgs", async () => {
    await resumeWorkspace(config, { task: "team-1" });

    expect(stagedLaunchScript()).not.toContain("--continue");
  });

  it("prefers the run-state branch over the task-derived worktree branch", async () => {
    readRunStateMock.mockReturnValue(makeRunState({ branchName: "jdoe/fix-thing" }));
    findByTaskMock.mockReturnValue([makeWorktree()]);

    await resumeWorkspace(config, { task: "team-1" });

    expect(writeFileMock).toHaveBeenCalledWith(
      "/tmp/groundcrew-resume-team-1-x/prompt.txt",
      expect.stringContaining("Branch: jdoe/fix-thing"),
    );
    expect(lastRecordedRunState().branchName).toBe("jdoe/fix-thing");
  });

  it("includes continuation context in the staged prompt", async () => {
    await resumeWorkspace(config, { task: "team-1" });

    expect(writeFileMock).toHaveBeenCalledWith(
      "/tmp/groundcrew-resume-team-1-x/prompt.txt",
      expect.stringContaining("Previous interrupt reason: wrong direction"),
    );
    expect(writeFileMock).toHaveBeenCalledWith(
      "/tmp/groundcrew-resume-team-1-x/prompt.txt",
      expect.stringContaining("inspect the current git status and diff"),
    );
  });

  it("omits worker self-completion command when the recorded source cannot mark done", async () => {
    readRunStateMock.mockReturnValue(makeRunState({ completionTaskId: "linear:team-1" }));

    await resumeWorkspace(config, { task: "team-1" });

    const launchScript = stagedLaunchScript();
    expect(launchScript).toContain("export GROUNDCREW_TASK_ID='linear:team-1'");
    expect(launchScript).not.toContain("GROUNDCREW_COMPLETE");
    expect(lastRecordedRunState().completionTaskId).toBe("linear:team-1");
  });

  it("omits worker self-completion command for old state when the only source cannot mark done", async () => {
    readRunStateMock.mockReturnValue(makeRunState());

    await resumeWorkspace(config, { task: "team-1" });

    const launchScript = stagedLaunchScript();
    expect(launchScript).toContain("export GROUNDCREW_TASK_ID='team-1'");
    expect(launchScript).not.toContain("GROUNDCREW_COMPLETE");
    expect(lastRecordedRunState().completionTaskId).toBe("team-1");
  });

  it("omits worker self-completion command for old state when no source can be inferred", async () => {
    const noSourceConfig: ResolvedConfig = { ...config, sources: [] };
    readRunStateMock.mockReturnValue(makeRunState());

    await resumeWorkspace(noSourceConfig, { task: "team-1" });

    const launchScript = stagedLaunchScript();
    expect(launchScript).toContain("export GROUNDCREW_TASK_ID='team-1'");
    expect(launchScript).not.toContain("GROUNDCREW_COMPLETE");
    expect(lastRecordedRunState().completionTaskId).toBe("team-1");
  });

  it("omits worker self-completion command for old state when multiple sources are possible", async () => {
    const multiSourceConfig: ResolvedConfig = {
      ...config,
      sources: [
        { kind: "linear" },
        {
          kind: "todo-txt",
          name: "todo",
          todoPath: "todo.txt",
          tasksDir: ".tasks",
          idPrefix: "GC",
          timezone: "UTC",
        },
      ],
    };
    readRunStateMock.mockReturnValue(makeRunState());

    await resumeWorkspace(multiSourceConfig, { task: "team-1" });

    const launchScript = stagedLaunchScript();
    expect(launchScript).toContain("export GROUNDCREW_TASK_ID='team-1'");
    expect(launchScript).not.toContain("GROUNDCREW_COMPLETE");
    expect(lastRecordedRunState().completionTaskId).toBe("team-1");
  });

  it("sets worker self-completion command when the recorded source can mark done", async () => {
    const todoConfig: ResolvedConfig = {
      ...config,
      sources: [
        {
          kind: "todo-txt",
          name: "todo",
          todoPath: "todo.txt",
          tasksDir: ".tasks",
          idPrefix: "GC",
          timezone: "UTC",
        },
      ],
    };
    readRunStateMock.mockReturnValue(makeRunState({ completionTaskId: "todo:sweep-1" }));

    await resumeWorkspace(todoConfig, { task: "team-1" });

    const launchScript = stagedLaunchScript();
    expect(launchScript).toContain("export GROUNDCREW_TASK_ID='todo:sweep-1'");
    expect(launchScript).toContain("export GROUNDCREW_COMPLETE='crew task done todo:sweep-1'");
    expect(lastRecordedRunState().completionTaskId).toBe("todo:sweep-1");
  });

  it("falls back to the task id when Linear detail lookup fails during state resume", async () => {
    getLinearClientMock.mockReturnValue({
      issue: vi.fn<IssueLookup>().mockRejectedValue(new Error("offline")),
    } as unknown as ReturnType<typeof getLinearClient>);

    await resumeWorkspace(config, { task: "team-1" });

    expect(writeFileMock).toHaveBeenCalledWith(
      "/tmp/groundcrew-resume-team-1-x/prompt.txt",
      expect.stringContaining("task team-1 (TEAM-1)"),
    );
  });

  it("skips the Linear lookup during state resume when Linear is disabled", async () => {
    const noLinearConfig: ResolvedConfig = {
      ...makeConfig(),
      sources: [{ kind: "linear", enabled: false }],
    };

    await resumeWorkspace(noLinearConfig, { task: "team-1" });

    expect(getLinearClientMock).not.toHaveBeenCalled();
    expect(writeFileMock).toHaveBeenCalledWith(
      "/tmp/groundcrew-resume-team-1-x/prompt.txt",
      expect.stringContaining("task team-1 (TEAM-1)"),
    );
  });

  it("prefers the cached run-state title over the task id when Linear detail lookup fails", async () => {
    readRunStateMock.mockReturnValue(makeRunState({ title: "Cached Title" }));
    getLinearClientMock.mockReturnValue({
      issue: vi.fn<IssueLookup>().mockRejectedValue(new Error("offline")),
    } as unknown as ReturnType<typeof getLinearClient>);

    await resumeWorkspace(config, { task: "team-1" });

    expect(writeFileMock).toHaveBeenCalledWith(
      "/tmp/groundcrew-resume-team-1-x/prompt.txt",
      expect.stringContaining("task team-1 (Cached Title)"),
    );
  });

  it("prefers the cached run-state title over the task id during state resume when Linear is disabled", async () => {
    readRunStateMock.mockReturnValue(makeRunState({ title: "Cached Title" }));
    const noLinearConfig: ResolvedConfig = {
      ...makeConfig(),
      sources: [{ kind: "linear", enabled: false }],
    };

    await resumeWorkspace(noLinearConfig, { task: "team-1" });

    expect(getLinearClientMock).not.toHaveBeenCalled();
    expect(writeFileMock).toHaveBeenCalledWith(
      "/tmp/groundcrew-resume-team-1-x/prompt.txt",
      expect.stringContaining("task team-1 (Cached Title)"),
    );
  });

  it("renders empty task details and no previous reason when state has neither", async () => {
    readRunStateMock.mockReturnValue(makeRunStateWithoutReason());
    getLinearClientMock.mockReturnValue({
      issue: vi.fn<IssueLookup>().mockResolvedValue({ title: "Title" }),
    } as unknown as ReturnType<typeof getLinearClient>);

    await resumeWorkspace(config, { task: "team-1" });

    expect(writeFileMock).toHaveBeenCalledWith(
      "/tmp/groundcrew-resume-team-1-x/prompt.txt",
      expect.stringContaining("Previous interrupt reason: none recorded"),
    );
  });

  it("resolves cold resume through an injected Board without configured sources", async () => {
    readRunStateMock.mockReset();
    const resolved = canonicalShellIssue({
      naturalId: "team-1",
      sourceName: "todo",
      repository: "repo-a",
      agent: "claude",
      title: "Resolved title",
      description: "Resolved body for repo-a",
      url: "https://tasks.example/team-1",
    });
    const board: Board = {
      verify: vi.fn<Board["verify"]>(),
      fetch: vi.fn<Board["fetch"]>(),
      resolveOne: vi.fn<Board["resolveOne"]>().mockResolvedValue(resolved),
      markInProgress: vi.fn<Board["markInProgress"]>(),
      markInReview: vi.fn<Board["markInReview"]>(),
      markDone: vi.fn<Board["markDone"]>(),
    };
    const todoConfig: ResolvedConfig = {
      ...config,
      sources: [],
    };

    await resumeWorkspace(todoConfig, { task: "team-1", taskSourceId: "todo:team-1" }, { board });

    expect(board.resolveOne).toHaveBeenCalledWith("todo:team-1");
    expect(workspacesOpenMock).toHaveBeenCalledWith(
      todoConfig,
      expect.objectContaining({
        name: "team-1",
        url: "https://tasks.example/team-1",
      }),
    );
  });

  it("preserves a source-qualified id while reconstructing state through an injected Board", async () => {
    const sourceFreeConfig: ResolvedConfig = { ...config, sources: [] };
    const board: Board = {
      verify: vi.fn<Board["verify"]>(),
      fetch: vi.fn<Board["fetch"]>(),
      resolveOne: vi.fn<Board["resolveOne"]>().mockResolvedValue(
        canonicalShellIssue({
          naturalId: "team-1",
          sourceName: "todo",
          repository: "repo-a",
          agent: "claude",
          title: "Board title",
        }),
      ),
      markInProgress: vi.fn<Board["markInProgress"]>(),
      markInReview: vi.fn<Board["markInReview"]>(),
      markDone: vi.fn<Board["markDone"]>(),
    };

    await resumeWorkspace(
      sourceFreeConfig,
      { task: "team-1", taskSourceId: "todo:team-1" },
      { board },
    );

    expect(board.resolveOne).toHaveBeenCalledWith("todo:team-1");
    expect(lastRecordedRunState()).toMatchObject({ completionTaskId: "todo:team-1" });
    expect(writeFileMock).toHaveBeenCalledWith(
      "/tmp/groundcrew-resume-team-1-x/prompt.txt",
      expect.stringContaining("task team-1 (Board title)"),
    );
  });

  it("cold-resumes an eligible Board task without inventing a URL", async () => {
    readRunStateMock.mockReset();
    const board: Board = {
      verify: vi.fn<Board["verify"]>(),
      fetch: vi.fn<Board["fetch"]>(),
      resolveOne: vi
        .fn<Board["resolveOne"]>()
        .mockResolvedValue(
          canonicalShellIssue({ naturalId: "team-1", repository: "repo-a", agent: "claude" }),
        ),
      markInProgress: vi.fn<Board["markInProgress"]>(),
      markInReview: vi.fn<Board["markInReview"]>(),
      markDone: vi.fn<Board["markDone"]>(),
    };

    await resumeWorkspace(config, { task: "team-1" }, { board });

    expect(workspacesOpenMock.mock.calls[0]?.[1]).not.toHaveProperty("url");
  });

  it("rejects clearly when state is missing and no source is configured", async () => {
    readRunStateMock.mockReset();
    const noLinearConfig: ResolvedConfig = {
      ...makeConfig(),
      sources: [{ kind: "linear", enabled: false }],
    };

    await expect(resumeWorkspace(noLinearConfig, { task: "team-1" })).rejects.toThrow(
      /no run state recorded and no task source is configured/,
    );
    expect(getLinearClientMock).not.toHaveBeenCalled();
  });

  it("builds the configured task sources for a cold resume when no Board is injected", async () => {
    readRunStateMock.mockReset();
    fetchResolvedIssueMock.mockResolvedValue(resolvedLinearTask());

    await expect(resumeWorkspace(config, { task: "team-1" })).resolves.toMatchObject({
      action: "resume",
      outcome: "resumed",
      task: { canonicalId: "linear:team-1" },
    });
    expect(fetchResolvedIssueMock).toHaveBeenCalled();
  });

  it("rejects a cold-resolved task that is not groundcrew eligible", async () => {
    readRunStateMock.mockReset();
    const board: Board = {
      verify: vi.fn<Board["verify"]>(),
      fetch: vi.fn<Board["fetch"]>(),
      resolveOne: vi
        .fn<Board["resolveOne"]>()
        .mockResolvedValue(canonicalShellIssue({ naturalId: "team-1" })),
      markInProgress: vi.fn<Board["markInProgress"]>(),
      markInReview: vi.fn<Board["markInReview"]>(),
      markDone: vi.fn<Board["markDone"]>(),
    };

    await expect(resumeWorkspace(config, { task: "team-1" }, { board })).rejects.toThrow(
      /isn't groundcrew-eligible/,
    );
  });

  it("rejects a cold task that the configured Board cannot resolve", async () => {
    readRunStateMock.mockReset();
    const board: Board = {
      verify: vi.fn<Board["verify"]>(),
      fetch: vi.fn<Board["fetch"]>(),
      // oxlint-disable-next-line unicorn/no-useless-undefined -- explicitly model no task match
      resolveOne: vi.fn<Board["resolveOne"]>().mockResolvedValue(undefined),
      markInProgress: vi.fn<Board["markInProgress"]>(),
      markInReview: vi.fn<Board["markInReview"]>(),
      markDone: vi.fn<Board["markDone"]>(),
    };

    await expect(resumeWorkspace(config, { task: "team-1" }, { board })).rejects.toThrow(
      /Task team-1 not found across configured sources/,
    );
  });

  it("returns already-running when the matching workspace is already live", async () => {
    readRunStateMock.mockReturnValue(makeRunState({ state: "resumed" }));
    workspacesProbeMock.mockResolvedValue({ kind: "ok", names: new Set(["team-1"]) });

    await expect(resumeWorkspace(config, { task: "team-1" })).resolves.toMatchObject({
      outcome: "already-running",
      state: "resumed",
      resources: { workspace: { name: "team-1" } },
    });
    expect(workspacesOpenMock).not.toHaveBeenCalled();
  });

  it("returns conflict for a live workspace without matching local context", async () => {
    readRunStateMock.mockReset();
    findByTaskMock.mockReturnValue([]);
    workspacesProbeMock.mockResolvedValue({ kind: "ok", names: new Set(["team-1"]) });

    await expect(resumeWorkspace(config, { task: "team-1" })).resolves.toMatchObject({
      outcome: "conflict",
      state: "running",
      problems: [{ code: "workspace-conflict" }],
    });
  });

  it("wraps with bare safehouse and skips the clearance daemon when networkEgress is open", async () => {
    const openEgress = {
      ...makeConfig(),
      local: {
        runner: "safehouse" as const,
        networkEgress: "open" as const,
        safehouse: { enable: [] },
        readOnlyDirs: [],
      },
    };

    await resumeWorkspace(openEgress, { task: "team-1" });

    // Filesystem sandbox stays (the profile shim) under the bare safehouse
    // binary, but no clearance layer and no clearance-ensure daemon call.
    const launchScript = stagedLaunchScript();
    expect(launchScript).toContain('ln -s /bin/sh "$_safehouse_shim"');
    expect(launchScript).toContain("safehouse --add-dirs=");
    expect(launchScript).toMatch(/safehouse .*"\$_safehouse_shim" -c/);
    expect(launchScript).not.toContain("safehouse-clearance");
    expect(launchScript).not.toContain("CLEARANCE_ALLOW_HOSTS_FILES");
    expect(ensureClearanceMock).not.toHaveBeenCalled();
  });

  it("keeps networkEgress:open a no-op for a cmd-owned safehouse wrap (still rejected upstream)", async () => {
    // The user owns the wrap, so groundcrew injects nothing and `networkEgress`
    // has no effect: it is rejected by the same worker-env guard as allowlisted.
    const cmdOwned: ResolvedConfig = {
      ...makeConfig(),
      local: {
        runner: "safehouse",
        networkEgress: "open",
        safehouse: { enable: [] },
        readOnlyDirs: [],
      },
      agents: {
        default: "claude",
        definitions: { claude: { cmd: "safehouse claude --auto", color: "#fff" } },
      },
    };

    await expect(resumeWorkspace(cmdOwned, { task: "team-1" })).rejects.toThrow(
      /cannot inject worker self-completion env when 'cmd' already starts with 'safehouse'/,
    );
  });

  it("does not add task source sandbox grants for unsandboxed resume runners", async () => {
    const noneConfig: ResolvedConfig = {
      ...makeConfig(),
      local: {
        runner: "none",
        networkEgress: "allowlisted",
        safehouse: { enable: [] },
        readOnlyDirs: [],
      },
      sources: [
        { kind: "linear" },
        {
          kind: "todo-txt",
          name: "todo",
          todoPath: "/Users/dev/v/todo.md",
          tasksDir: "/Users/dev/v/.tasks",
          idPrefix: "GC",
          timezone: "UTC",
        },
      ],
    };
    readRunStateMock.mockReturnValue(makeRunState({ completionTaskId: "todo:gc-1" }));

    await resumeWorkspace(noneConfig, { task: "team-1" });

    expect(stagedLaunchScript()).not.toContain("/Users/dev/v");
  });

  it("cds into the configured workdir subproject on resume", async () => {
    const cfg = makeConfig();
    cfg.workspace.repositories = [
      {
        name: "repo-a",
        provision: { create: "graft new x", remove: "graft rm x" },
        workdir: "services/api",
      },
    ];

    await resumeWorkspace(cfg, { task: "team-1" });

    expect(stagedLaunchScript()).toContain("cd '/work/repo-a-team-1/services/api'");
  });

  it("returns not-found when the worktree is absent", async () => {
    findByTaskMock.mockReturnValue([]);

    await expect(resumeWorkspace(config, { task: "team-1" })).resolves.toMatchObject({
      outcome: "not-found",
      state: "absent",
    });
  });

  it("fails when recorded run state refers to an unknown agent", async () => {
    readRunStateMock.mockReturnValue(makeRunState({ agent: "missing-agent" }));

    await expect(resumeWorkspace(config, { task: "team-1" })).rejects.toThrow(
      /Unknown agent: missing-agent/,
    );
  });

  it("returns already-running when the same workspace is already live", async () => {
    workspacesProbeMock.mockResolvedValue({ kind: "ok", names: new Set(["team-1"]) });

    await expect(resumeWorkspace(config, { task: "team-1" })).resolves.toMatchObject({
      outcome: "already-running",
      state: "running",
    });
    expect(workspacesOpenMock).not.toHaveBeenCalled();
  });

  it("returns conflict when workspace liveness cannot be verified", async () => {
    workspacesProbeMock.mockResolvedValue({ kind: "unavailable" });

    await expect(resumeWorkspace(config, { task: "team-1" })).resolves.toMatchObject({
      outcome: "conflict",
      problems: [{ code: "workspace-status-unavailable" }],
    });
    expect(workspacesOpenMock).not.toHaveBeenCalled();
    expect(recordRunStateMock).not.toHaveBeenCalled();
    expect(mkdtempMock).not.toHaveBeenCalled();
  });

  it("includes probe error details when workspace liveness verification fails", async () => {
    workspacesProbeMock.mockResolvedValue({
      kind: "unavailable",
      error: new Error("cmux down"),
    });

    await expect(resumeWorkspace(config, { task: "team-1" })).resolves.toMatchObject({
      outcome: "conflict",
      problems: [{ message: expect.stringContaining("cmux down") }],
    });
    expect(workspacesOpenMock).not.toHaveBeenCalled();
    expect(recordRunStateMock).not.toHaveBeenCalled();
  });

  it("reports unknown state when liveness fails without persisted state", async () => {
    readRunStateMock.mockReset();
    workspacesProbeMock.mockResolvedValue({ kind: "unavailable" });

    await expect(resumeWorkspace(config, { task: "team-1" })).resolves.toMatchObject({
      outcome: "conflict",
      state: "unknown",
    });
  });

  it("preserves canonical identity when liveness cannot be verified", async () => {
    readRunStateMock.mockReturnValue(
      makeRunState({
        completionTaskId: "linear:TEAM-1",
        url: "https://example.test/TEAM-1",
      }),
    );
    workspacesProbeMock.mockResolvedValue({ kind: "unavailable" });

    await expect(resumeWorkspace(config, { task: "team-1" })).resolves.toMatchObject({
      task: {
        id: "team-1",
        canonicalId: "linear:TEAM-1",
        url: "https://example.test/TEAM-1",
      },
    });
  });

  it("removes the staged prompt directory when opening the workspace fails", async () => {
    workspacesOpenMock.mockRejectedValue(new Error("cmux failed"));

    await expect(resumeWorkspace(config, { task: "team-1" })).rejects.toThrow(/cmux failed/);
    expect(rmSyncMock).toHaveBeenCalledWith("/tmp/groundcrew-resume-team-1-x", {
      recursive: true,
      force: true,
    });
    expect(recordRunStateMock).not.toHaveBeenCalled();
  });

  it("preserves the workspace failure when staged prompt cleanup also fails", async () => {
    workspacesOpenMock.mockRejectedValue(new Error("cmux failed"));
    rmSyncMock.mockImplementationOnce(() => {
      throw new Error("cleanup failed");
    });

    await expect(resumeWorkspace(config, { task: "team-1" })).rejects.toThrow(/cmux failed/);
  });

  it("returns partial while preserving the opened workspace when run-state write fails", async () => {
    recordRunStateMock.mockImplementation(() => {
      throw new Error("state directory is read-only");
    });

    await expect(resumeWorkspace(config, { task: "team-1" })).resolves.toMatchObject({
      outcome: "partial",
      state: "resumed",
      problems: [
        {
          code: "state-write-failed",
          message: expect.stringContaining("state directory is read-only"),
        },
      ],
    });
    expect(workspaces.close).not.toHaveBeenCalled();
    expect(rmSyncMock).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
  });
});

describe(resumeWorkspaceCli, () => {
  const config = makeConfig();

  beforeEach(() => {
    loadConfigMock.mockResolvedValue(config);
    mkdtempMock.mockReturnValue("/tmp/groundcrew-resume-team-1-x");
    mockLinearIssue();
    readRunStateMock.mockReturnValue(makeRunState());
    findByTaskMock.mockReturnValue([makeWorktree()]);
    workspacesProbeMock.mockResolvedValue({ kind: "ok", names: new Set<string>() });
    detectHostMock.mockResolvedValue(host());
    ensureClearanceMock.mockResolvedValue({
      logPath: "/tmp/clearance/clearance.log",
      pidPath: "/tmp/clearance/clearance.pid",
      port: 19_999,
      status: "already-running",
    });
    resolveSafehouseCmuxIntegrationMock.mockReturnValue(safehouseCmuxIntegrationFixture());
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.resetAllMocks();
  });

  it("emits exactly one structured resume receipt in JSON mode", async () => {
    const consoleLog = captureConsoleLog();

    try {
      const actual = await resumeWorkspaceCli(["TEAM-1", "--json"]);

      expect(actual).toMatchObject({
        action: "resume",
        task: { id: "team-1" },
        outcome: "resumed",
        state: "resumed",
        resources: {
          repository: "repo-a",
          branch: "dev-team-1",
          worktreeDir: "/work/repo-a-team-1",
          workspace: { name: "team-1" },
          agent: "claude",
        },
        problems: [],
      });
      expect(consoleLog.calls).toHaveLength(1);
      expect(JSON.parse(consoleLog.output())).toStrictEqual(actual);
    } finally {
      consoleLog.restore();
    }
  });

  it("reconciles a live resumed workspace after cooperative cancellation", async () => {
    workspacesProbeMock
      .mockResolvedValueOnce({ kind: "ok", names: new Set() })
      .mockResolvedValueOnce({ kind: "ok", names: new Set(["team-1"]) });
    workspacesOpenMock.mockImplementationOnce(async () => {
      process.listeners("SIGTERM").at(-1)?.("SIGTERM");
      throw new Error("Signal: SIGTERM");
    });
    const consoleLog = captureConsoleLog();

    try {
      const actual = await resumeWorkspaceCli(["TEAM-1", "--json"]);

      expect(actual).toMatchObject({
        action: "resume",
        outcome: "partial",
        state: "resumed",
        problems: [{ code: "cancelled", message: expect.stringContaining("SIGTERM") }],
      });
      expect(lastRecordedRunState()).toMatchObject({
        task: "team-1",
        state: "resumed",
        resumeCount: 2,
      });
      expect(consoleLog.calls).toHaveLength(1);
      expect(process.exitCode).toBe(1);
    } finally {
      consoleLog.restore();
    }
  });

  it("finishes durable reconciliation when cancellation arrives after workspace open", async () => {
    workspacesOpenMock.mockImplementationOnce(async () => {
      process.listeners("SIGTERM").at(-1)?.("SIGTERM");
    });
    const consoleLog = captureConsoleLog();

    try {
      const actual = await resumeWorkspaceCli(["TEAM-1", "--json"]);

      expect(actual).toMatchObject({
        outcome: "partial",
        state: "resumed",
        problems: [{ code: "cancelled", message: expect.stringContaining("opened") }],
      });
      expect(lastRecordedRunState()).toMatchObject({ state: "resumed", resumeCount: 2 });
    } finally {
      consoleLog.restore();
    }
  });

  it("reports a stable conflict when another lifecycle command owns the task", async () => {
    const lock = requireAcquiredLock(acquireLifecycleLock({ config, task: "team-1" }));
    const consoleLog = captureConsoleLog();

    try {
      const actual = await resumeWorkspaceCli(["TEAM-1", "--json"]);

      expect(actual).toMatchObject({
        action: "resume",
        outcome: "conflict",
        problems: [{ code: "lifecycle-lock-held" }],
      });
      expect(workspacesOpenMock).not.toHaveBeenCalled();
      expect(JSON.parse(consoleLog.output())).toStrictEqual(actual);
    } finally {
      consoleLog.restore();
      lock.release();
    }
  });

  it("reports unknown state when a lock is held for a task without local context", async () => {
    readRunStateMock.mockReset();
    findByTaskMock.mockReturnValue([]);
    const lock = requireAcquiredLock(acquireLifecycleLock({ config, task: "unknown-1" }));
    const consoleLog = captureConsoleLog();

    try {
      await expect(resumeWorkspaceCli(["unknown-1", "--json"])).resolves.toMatchObject({
        outcome: "conflict",
        state: "unknown",
      });
    } finally {
      consoleLog.restore();
      lock.release();
    }
  });

  it("reports state reconciliation failure after a cancelled live resume", async () => {
    readRunStateMock.mockReturnValue(
      makeRunState({
        completionTaskId: "linear:TEAM-1",
        url: "https://example.test/TEAM-1",
      }),
    );
    workspacesProbeMock
      .mockResolvedValueOnce({ kind: "ok", names: new Set() })
      .mockResolvedValueOnce({ kind: "ok", names: new Set(["team-1"]) });
    workspacesOpenMock.mockImplementationOnce(async () => {
      process.listeners("SIGINT").at(-1)?.("SIGINT");
      throw new Error("Signal: SIGINT");
    });
    recordRunStateMock.mockImplementation(() => {
      throw new Error("disk full");
    });
    const consoleLog = captureConsoleLog();

    try {
      const actual = await resumeWorkspaceCli(["TEAM-1", "--json"]);

      expect(actual.problems).toEqual([
        expect.objectContaining({ code: "cancelled" }),
        expect.objectContaining({ code: "state-write-failed" }),
      ]);
    } finally {
      consoleLog.restore();
    }
  });

  it("reconciles source identity and resolved agent when a cold resume is cancelled before state persistence", async () => {
    const coldConfig: ResolvedConfig = {
      ...config,
      agents: {
        ...config.agents,
        definitions: {
          ...config.agents.definitions,
          codex: { cmd: "codex --auto", color: "#000" },
        },
      },
    };
    loadConfigMock.mockResolvedValue(coldConfig);
    readRunStateMock.mockReset();
    fetchResolvedIssueMock.mockResolvedValue(resolvedLinearTask({ agent: "codex" }));
    workspacesProbeMock
      .mockResolvedValueOnce({ kind: "ok", names: new Set() })
      .mockResolvedValueOnce({ kind: "ok", names: new Set(["team-1"]) });
    workspacesOpenMock.mockImplementationOnce(async () => {
      process.listeners("SIGTERM").at(-1)?.("SIGTERM");
      throw new Error("Signal: SIGTERM");
    });
    const consoleLog = captureConsoleLog();

    try {
      const actual = await resumeWorkspaceCli(["linear:TEAM-1", "--json"]);

      expect(actual).toMatchObject({
        outcome: "partial",
        task: { canonicalId: "linear:team-1" },
        resources: { agent: "codex", workspace: { name: "team-1" } },
        problems: [{ code: "cancelled" }],
      });
      expect(lastRecordedRunState()).toMatchObject({
        task: "team-1",
        agent: "codex",
        completionTaskId: "linear:team-1",
        state: "resumed",
      });
    } finally {
      consoleLog.restore();
    }
  });

  it("preserves the observed interrupted state when cancellation opens no workspace", async () => {
    workspacesProbeMock.mockResolvedValue({ kind: "ok", names: new Set() });
    workspacesOpenMock.mockImplementationOnce(async () => {
      process.listeners("SIGTERM").at(-1)?.("SIGTERM");
      throw new Error("Signal: SIGTERM");
    });
    const consoleLog = captureConsoleLog();

    try {
      const actual = await resumeWorkspaceCli(["TEAM-1", "--json"]);

      expect(actual).toMatchObject({ outcome: "partial", state: "interrupted" });
      expect(recordRunStateMock).not.toHaveBeenCalled();
    } finally {
      consoleLog.restore();
    }
  });

  it("reports unknown when cancellation loses state and observes no workspace", async () => {
    readRunStateMock
      .mockReturnValueOnce(makeRunState())
      .mockReturnValueOnce(makeRunState())
      // oxlint-disable-next-line unicorn/no-useless-undefined -- simulate state disappearing during reconciliation
      .mockReturnValueOnce(undefined);
    findByTaskMock
      .mockReturnValueOnce([makeWorktree()])
      .mockReturnValueOnce([makeWorktree()])
      .mockReturnValueOnce([]);
    workspacesProbeMock.mockResolvedValue({ kind: "ok", names: new Set() });
    workspacesOpenMock.mockImplementationOnce(async () => {
      process.listeners("SIGTERM").at(-1)?.("SIGTERM");
      throw new Error("Signal: SIGTERM");
    });
    const consoleLog = captureConsoleLog();

    try {
      await expect(resumeWorkspaceCli(["TEAM-1", "--json"])).resolves.toMatchObject({
        outcome: "partial",
        state: "unknown",
      });
    } finally {
      consoleLog.restore();
    }
  });

  it("uses the resolved launch context when cancellation later loses local context", async () => {
    readRunStateMock
      .mockReturnValueOnce(makeRunState())
      .mockReturnValueOnce(makeRunState())
      // oxlint-disable-next-line unicorn/no-useless-undefined -- simulate state disappearing during reconciliation
      .mockReturnValueOnce(undefined);
    findByTaskMock
      .mockReturnValueOnce([makeWorktree()])
      .mockReturnValueOnce([makeWorktree()])
      .mockReturnValueOnce([]);
    workspacesProbeMock
      .mockResolvedValueOnce({ kind: "ok", names: new Set() })
      .mockResolvedValueOnce({ kind: "ok", names: new Set(["team-1"]) });
    workspacesOpenMock.mockImplementationOnce(async () => {
      process.listeners("SIGTERM").at(-1)?.("SIGTERM");
      throw new Error("Signal: SIGTERM");
    });
    const consoleLog = captureConsoleLog();

    try {
      const actual = await resumeWorkspaceCli(["TEAM-1", "--json"]);

      expect(actual).toMatchObject({
        outcome: "partial",
        state: "resumed",
        resources: { workspace: { name: "team-1" } },
      });
      expect(lastRecordedRunState()).toMatchObject({
        task: "team-1",
        repository: "repo-a",
        agent: "claude",
        completionTaskId: "TEAM-1",
        state: "resumed",
        resumeCount: 2,
      });
    } finally {
      consoleLog.restore();
    }
  });

  it("prefers resolved launch context while reconciling a cancelled live workspace", async () => {
    readRunStateMock
      .mockReturnValueOnce(makeRunState())
      .mockReturnValueOnce(makeRunState())
      // oxlint-disable-next-line unicorn/no-useless-undefined -- simulate state disappearing during reconciliation
      .mockReturnValueOnce(undefined);
    findByTaskMock
      .mockReturnValueOnce([makeWorktree()])
      .mockReturnValueOnce([makeWorktree()])
      .mockReturnValueOnce([makeWorktree()]);
    workspacesProbeMock
      .mockResolvedValueOnce({ kind: "ok", names: new Set() })
      .mockResolvedValueOnce({ kind: "ok", names: new Set(["team-1"]) });
    workspacesOpenMock.mockImplementationOnce(async () => {
      process.listeners("SIGINT").at(-1)?.("SIGINT");
      throw new Error("Signal: SIGINT");
    });
    const consoleLog = captureConsoleLog();

    try {
      await resumeWorkspaceCli(["TEAM-1", "--json"]);

      expect(lastRecordedRunState()).toMatchObject({
        task: "team-1",
        repository: "repo-a",
        agent: "claude",
        workspaceName: "team-1",
        state: "resumed",
        resumeCount: 2,
        reason: "wrong direction",
      });
    } finally {
      consoleLog.restore();
    }
  });

  it("parses the task argument", async () => {
    await resumeWorkspaceCli(["TEAM-1"]);

    expect(loadConfigMock).toHaveBeenCalledTimes(1);
    expect(workspacesOpenMock).toHaveBeenCalledWith(
      config,
      expect.objectContaining({ name: "team-1" }),
      expect.any(AbortSignal),
    );
  });

  it("strips a source prefix so the canonical id resumes the natural-id worktree", async () => {
    await resumeWorkspaceCli(["linear:TEAM-1"]);

    expect(findByTaskMock).toHaveBeenCalledWith(config, "team-1");
    expect(workspacesOpenMock).toHaveBeenCalledWith(
      config,
      expect.objectContaining({ name: "team-1" }),
      expect.any(AbortSignal),
    );
  });

  it("rejects missing task", async () => {
    await expect(resumeWorkspaceCli([])).rejects.toThrow(
      "Usage: crew resume [--new] [--json] <task>",
    );
  });

  it("rejects extra positional args", async () => {
    await expect(resumeWorkspaceCli(["team-1", "extra"])).rejects.toThrow(/Usage: crew resume/);
  });

  it("consumes the --new flag before the task without treating it as a positional", async () => {
    await resumeWorkspaceCli(["--new", "TEAM-1"]);

    expect(workspacesOpenMock).toHaveBeenCalledWith(
      config,
      expect.objectContaining({ name: "team-1" }),
      expect.any(AbortSignal),
    );
  });

  it("accepts the --new flag after the task", async () => {
    await resumeWorkspaceCli(["team-1", "--new"]);

    expect(workspacesOpenMock).toHaveBeenCalledWith(
      config,
      expect.objectContaining({ name: "team-1" }),
      expect.any(AbortSignal),
    );
  });
});
