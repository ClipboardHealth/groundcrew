import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type * as nodeFs from "node:fs";

import { ensureClearance, type SafehouseCmuxIntegration } from "@clipboard-health/clearance";

import { fetchResolvedIssue } from "../lib/adapters/linear/fetch.ts";
import { getLinearClient } from "../lib/adapters/linear/client.ts";
import { loadConfig, type ResolvedConfig } from "../lib/config.ts";
import { detectHostCapabilities, type HostCapabilities } from "../lib/host.ts";
import { readRunState, recordRunState, type RunState } from "../lib/runState.ts";
import { safehouseCmuxIntegrationFixture } from "../testHelpers/safehouseCmuxIntegration.ts";
import { workspaces } from "../lib/workspaces.ts";
import { type WorktreeEntry, worktrees } from "../lib/worktrees.ts";
import { resumeWorkspace, resumeWorkspaceCli } from "./resumeWorkspace.ts";

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
vi.mock(import("../lib/workspaces.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    workspaces: {
      ...actual.workspaces,
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
const runCommandMock = vi.hoisted(() =>
  vi.fn<(cmd: string, arguments_: readonly string[]) => string>(),
);
vi.mock(import("../lib/commandRunner.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, runCommand: runCommandMock };
});

// buildAndStageSrtLaunch resolves the sandbox's gitCommonDir from the worktree
// via `git rev-parse --git-common-dir`; the worktree dir here is a fixture path,
// so stub the probe to a non-empty path and return "" for anything else.
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
// oxlint-disable-next-line typescript/unbound-method -- workspaces is mocked to plain vi.fn properties in this file.
const workspacesOpenMock = vi.mocked(workspaces.open);
const workspacesProbeMock = vi.mocked(workspaces.probe);
const findByTaskMock = vi.mocked(worktrees.findByTask);
const createMock = vi.mocked(worktrees.create);

type RecordedRunState = Parameters<typeof recordRunState>[0]["state"];
type FetchResolvedIssueInput = Parameters<typeof fetchResolvedIssue>[0];
type IssueLookup = (id: string) => Promise<{ title: string; description?: string | undefined }>;

function lastRecordedRunState(): RecordedRunState {
  const input = recordRunStateMock.mock.calls.at(-1)?.[0];
  if (input === undefined) {
    throw new Error("recordRunState was not called");
  }
  return input.state;
}

function firstFetchResolvedIssueInput(): FetchResolvedIssueInput {
  const input = fetchResolvedIssueMock.mock.calls[0]?.[0];
  if (input === undefined) {
    throw new Error("fetchResolvedIssue was not called");
  }
  return input;
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
    hasBubblewrap: false,
    hasSocat: false,
    hasRipgrep: false,
    isMacOS: true,
    isLinux: false,
    isSafehouseSupported: true,
    isSrtSupported: true,
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
    local: { runner: "auto" },
    logging: { file: "/tmp/groundcrew-test.log" },
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
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- resume tests stub only the issue lookup surface.
  getLinearClientMock.mockReturnValue({
    issue,
  } as unknown as ReturnType<typeof getLinearClient>);
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
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- resume tests stub only the issue lookup surface.
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

  it("renders empty task details and no previous reason when state has neither", async () => {
    readRunStateMock.mockReturnValue(makeRunStateWithoutReason());
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- resume tests stub only the issue lookup surface.
    getLinearClientMock.mockReturnValue({
      issue: vi.fn<IssueLookup>().mockResolvedValue({ title: "Title" }),
    } as unknown as ReturnType<typeof getLinearClient>);

    await resumeWorkspace(config, { task: "team-1" });

    expect(writeFileMock).toHaveBeenCalledWith(
      "/tmp/groundcrew-resume-team-1-x/prompt.txt",
      expect.stringContaining("Previous interrupt reason: none recorded"),
    );
  });

  it("falls back to Linear resolution when state is missing", async () => {
    readRunStateMock.mockReset();
    fetchResolvedIssueMock.mockResolvedValue({
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
    });

    await resumeWorkspace(config, { task: "team-1" });

    const fetchInput = firstFetchResolvedIssueInput();
    expect(fetchInput.config).toBe(config);
    expect(fetchInput.task).toBe("team-1");
    expect(fetchInput.client).toBeDefined();
    expect(workspacesOpenMock).toHaveBeenCalledWith(
      config,
      expect.objectContaining({ name: "team-1" }),
    );
  });

  it("rejects with a clear error when state is missing and Linear is disabled", async () => {
    readRunStateMock.mockReset();
    const noLinearConfig: ResolvedConfig = {
      ...makeConfig(),
      sources: [{ kind: "linear", enabled: false }],
    };

    await expect(resumeWorkspace(noLinearConfig, { task: "team-1" })).rejects.toThrow(
      /no run state recorded and Linear is disabled/,
    );
    expect(getLinearClientMock).not.toHaveBeenCalled();
  });

  it("stages neutral prepare + agent srt settings and wraps the resumed agent under srt", async () => {
    const srtConfig = { ...makeConfig(), local: { runner: "srt" as const } };

    await resumeWorkspace(srtConfig, { task: "team-1" });

    expect(writeFileMock).toHaveBeenCalledWith(
      "/tmp/groundcrew-resume-team-1-x/agent-settings.json",
      expect.any(String),
    );
    // The staged launch script wraps the resumed agent under srt with the agent
    // settings, not safehouse.
    const launchScript = stagedLaunchScript();
    expect(launchScript).toMatch(
      /sandbox-runtime\/dist\/cli\.js' --settings .*agent-settings\.json/,
    );
    expect(launchScript).not.toContain("safehouse-clearance");
  });

  it("does not add task source sandbox grants for unsandboxed resume runners", async () => {
    const noneConfig: ResolvedConfig = {
      ...makeConfig(),
      local: { runner: "none" },
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

  it("cleans up the staged srt settings dir when the resumed launch fails to open", async () => {
    const srtConfig = { ...makeConfig(), local: { runner: "srt" as const } };
    workspacesOpenMock.mockRejectedValue(new Error("cmux down"));

    await expect(resumeWorkspace(srtConfig, { task: "team-1" })).rejects.toThrow("cmux down");

    // The settings dir is torn down on the pre-launch failure path (the launch
    // command's own teardown never ran).
    expect(rmSyncMock).toHaveBeenCalledWith(
      "/tmp/groundcrew-resume-team-1-x",
      expect.objectContaining({ recursive: true }),
    );
  });

  it("fails when the worktree is absent", async () => {
    findByTaskMock.mockReturnValue([]);

    await expect(resumeWorkspace(config, { task: "team-1" })).rejects.toThrow(/No worktree found/);
  });

  it("fails when recorded run state refers to an unknown agent", async () => {
    readRunStateMock.mockReturnValue(makeRunState({ agent: "missing-agent" }));

    await expect(resumeWorkspace(config, { task: "team-1" })).rejects.toThrow(
      /Unknown agent: missing-agent/,
    );
  });

  it("fails when the workspace is already live", async () => {
    workspacesProbeMock.mockResolvedValue({ kind: "ok", names: new Set(["team-1"]) });

    await expect(resumeWorkspace(config, { task: "team-1" })).rejects.toThrow(/already live/);
    expect(workspacesOpenMock).not.toHaveBeenCalled();
  });

  it("fails closed when workspace liveness cannot be verified", async () => {
    workspacesProbeMock.mockResolvedValue({ kind: "unavailable" });

    await expect(resumeWorkspace(config, { task: "team-1" })).rejects.toThrow(
      /Could not verify whether workspace for team-1 is already live/,
    );
    expect(workspacesOpenMock).not.toHaveBeenCalled();
    expect(recordRunStateMock).not.toHaveBeenCalled();
    expect(mkdtempMock).not.toHaveBeenCalled();
  });

  it("includes probe error details when workspace liveness verification fails", async () => {
    workspacesProbeMock.mockResolvedValue({
      kind: "unavailable",
      error: new Error("cmux down"),
    });

    await expect(resumeWorkspace(config, { task: "team-1" })).rejects.toThrow(
      /cmux down.*inspect the workspace backend/,
    );
    expect(workspacesOpenMock).not.toHaveBeenCalled();
    expect(recordRunStateMock).not.toHaveBeenCalled();
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
    vi.resetAllMocks();
  });

  it("parses the task argument", async () => {
    await resumeWorkspaceCli(["TEAM-1"]);

    expect(loadConfigMock).toHaveBeenCalledTimes(1);
    expect(workspacesOpenMock).toHaveBeenCalledWith(
      config,
      expect.objectContaining({ name: "team-1" }),
    );
  });

  it("strips a source prefix so the canonical id resumes the natural-id worktree", async () => {
    await resumeWorkspaceCli(["linear:TEAM-1"]);

    expect(findByTaskMock).toHaveBeenCalledWith(config, "team-1");
    expect(workspacesOpenMock).toHaveBeenCalledWith(
      config,
      expect.objectContaining({ name: "team-1" }),
    );
  });

  it("rejects missing task", async () => {
    await expect(resumeWorkspaceCli([])).rejects.toThrow(/Usage: crew resume/);
  });

  it("rejects extra positional args", async () => {
    await expect(resumeWorkspaceCli(["team-1", "extra"])).rejects.toThrow(/Usage: crew resume/);
  });
});
