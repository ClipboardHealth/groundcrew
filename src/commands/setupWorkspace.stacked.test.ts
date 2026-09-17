import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type * as nodeFs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensureClearance, type SafehouseCmuxIntegration } from "@clipboard-health/clearance";
import type { RunCommandOptions } from "../lib/commandRunner.ts";
import type { ResolvedConfig } from "../lib/config.ts";
import { detectHostCapabilities, type HostCapabilities } from "../lib/host.ts";
import { recordRunState } from "../lib/runState.ts";
import type * as utilModule from "../lib/util.ts";
import { StackedBaseBranchMismatchError, type WorktreeEntry, worktrees } from "../lib/worktrees.ts";
import type * as worktreesModule from "../lib/worktrees.ts";
import { safehouseCmuxIntegrationFixture } from "../testHelpers/safehouseCmuxIntegration.ts";
import { emptyTeardownResult } from "../testHelpers/teardownResult.ts";
import { setupWorkspace } from "./setupWorkspace.ts";

interface NodeFsMock extends Omit<
  typeof nodeFs,
  "existsSync" | "mkdtempSync" | "rmSync" | "writeFileSync"
> {
  existsSync: ReturnType<typeof vi.fn<typeof existsSync>>;
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
    existsSync: vi.fn<typeof existsSync>().mockReturnValue(true),
    mkdtempSync: vi.fn<typeof mkdtempSync>(),
    rmSync: vi.fn<typeof rmSync>(),
    writeFileSync: vi.fn<typeof writeFileSync>(),
  };
});
vi.mock(import("../lib/host.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, detectHostCapabilities: vi.fn<typeof detectHostCapabilities>() };
});
vi.mock(import("@clipboard-health/clearance"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    ensureClearance: vi.fn<typeof ensureClearance>(),
    resolveSafehouseCmuxIntegration: resolveSafehouseCmuxIntegrationMock,
  };
});
type RunCommandMock = (
  command: string,
  arguments_: readonly string[],
  options?: RunCommandOptions,
) => string;

const runCommandMock = vi.hoisted(() => vi.fn<RunCommandMock>());

vi.mock(import("../lib/commandRunner.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    runCommand: runCommandMock,
    runCommandAsync: runCommandMock as unknown as typeof actual.runCommandAsync,
  };
});
vi.mock(import("../lib/runState.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, recordRunState: vi.fn<typeof recordRunState>() };
});
vi.mock(import("../lib/util.ts"), async (importOriginal) => {
  const actual = await importOriginal<typeof utilModule>();
  return {
    ...actual,
    log: vi.fn<typeof actual.log>(),
    debug: vi.fn<typeof actual.debug>(),
    writeError: vi.fn<typeof actual.writeError>(),
  };
});
vi.mock(import("../lib/worktrees.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    worktrees: {
      ...actual.worktrees,
      create: vi.fn<typeof actual.worktrees.create>(),
      teardown: vi.fn<typeof actual.worktrees.teardown>(),
      findByTask: vi.fn<typeof actual.worktrees.findByTask>(),
      predictedEntry: vi.fn<typeof actual.worktrees.predictedEntry>(),
    },
  };
});

const existsSyncMock = vi.mocked(existsSync);
const mkdtempMock = vi.mocked(mkdtempSync);
const writeFileMock = vi.mocked(writeFileSync);
const detectHostMock = vi.mocked(detectHostCapabilities);
const ensureClearanceMock = vi.mocked(ensureClearance);
const recordRunStateMock = vi.mocked(recordRunState);
const createMock = vi.mocked(worktrees.create);
const teardownMock = vi.mocked(worktrees.teardown);
const findByTaskMock = vi.mocked(worktrees.findByTask);
const predictedEntryMock = vi.mocked(worktrees.predictedEntry);

type RecordedRunState = Parameters<typeof recordRunState>[0]["state"];

function lastRecordedRunState(): RecordedRunState {
  const input = recordRunStateMock.mock.calls.at(-1)?.[0];
  if (input === undefined) {
    throw new Error("recordRunState was not called");
  }
  return input.state;
}

function provisioningRunState(): RecordedRunState {
  const call = recordRunStateMock.mock.calls.find(
    (entry) => entry[0].state.state === "provisioning",
  );
  if (call === undefined) {
    throw new Error("provisioning run state was not recorded");
  }
  return call[0].state;
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

function hostEntry(): WorktreeEntry {
  return {
    repository: "repo-a",
    task: "team-2",
    branchName: "dev-team-2",
    dir: "/work/repo-a-team-2",
    kind: "host",
  };
}

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
      maximumInProgress: 4,
      pollIntervalMilliseconds: 1000,
      sessionLimitPercentage: 85,
    },
    agents: {
      default: "claude",
      definitions: { claude: { cmd: "claude --auto", color: "#fff" } },
    },
    prompts: {
      initial: "Begin {{task}} ({{title}}) in {{worktree}}\n{{description}}",
    },
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

function clearanceResult(): Awaited<ReturnType<typeof ensureClearance>> {
  return {
    logPath: "/tmp/clearance/clearance.log",
    pidPath: "/tmp/clearance/clearance.pid",
    port: 19_999,
    status: "already-running",
  };
}

function mockCmuxNewWorkspaceOutput(output: string): void {
  runCommandMock.mockImplementation((cmd, arguments_) => {
    if (cmd === "git" && arguments_.includes("--git-common-dir")) {
      return "/tmp/groundcrew-team-2-x/.git";
    }
    return cmd === "cmux" && arguments_.includes("new-workspace") ? output : "";
  });
}

function writtenFileContent(filePath: string): string {
  const call = writeFileMock.mock.calls.find(([candidate]) => String(candidate) === filePath);
  const content = call?.[1];
  return typeof content === "string" ? content : "";
}

describe("setupWorkspace stacking", () => {
  beforeEach(() => {
    detectHostMock.mockResolvedValue(host());
    createMock.mockImplementation(async () => hostEntry());
    findByTaskMock.mockReturnValue([]);
    predictedEntryMock.mockReturnValue({
      branchName: "dev-team-2",
      worktreeDir: "/work/repo-a-team-2",
    });
    ensureClearanceMock.mockResolvedValue(clearanceResult());
    resolveSafehouseCmuxIntegrationMock.mockReturnValue(safehouseCmuxIntegrationFixture());
    mkdtempMock.mockReturnValue("/tmp/groundcrew-team-2-x");
    runCommandMock.mockReturnValue("");
    teardownMock.mockResolvedValue(emptyTeardownResult());
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it("threads baseBranch/parentTask through the spec, worker env, and run state", async () => {
    const config = makeConfig();
    mockCmuxNewWorkspaceOutput(JSON.stringify({ ref: "workspace:42" }));

    await setupWorkspace(config, {
      task: "team-2",
      repository: "repo-a",
      agent: "claude",
      baseBranch: "dev-team-1",
      parentTask: "team-1",
      details: { title: "Test Title", description: "Body" },
    });

    expect(createMock).toHaveBeenCalledWith(
      config,
      expect.objectContaining({ repository: "repo-a", task: "team-2", baseBranch: "dev-team-1" }),
    );
    const launchScript = writtenFileContent("/tmp/groundcrew-team-2-x/launch.sh");
    expect(launchScript).toContain("export GROUNDCREW_BASE_BRANCH='dev-team-1'");
    expect(launchScript).toContain(
      "--env-pass=GROUNDCREW_TASK_ID,GROUNDCREW_COMPLETE,GROUNDCREW_BASE_BRANCH,CMUX_SURFACE_ID,CMUX_SOCKET_PATH",
    );
    expect(provisioningRunState()).toMatchObject({
      baseBranch: "dev-team-1",
      parentTask: "team-1",
    });
    expect(lastRecordedRunState()).toMatchObject({
      state: "running",
      baseBranch: "dev-team-1",
      parentTask: "team-1",
    });
  });

  it("omits baseBranch/parentTask from the spec, worker env, and run state when unstacked", async () => {
    const config = makeConfig();
    mockCmuxNewWorkspaceOutput(JSON.stringify({ ref: "workspace:42" }));

    await setupWorkspace(config, {
      task: "team-2",
      repository: "repo-a",
      agent: "claude",
      details: { title: "Test Title", description: "Body" },
    });

    expect(createMock).toHaveBeenCalledWith(
      config,
      expect.not.objectContaining({ baseBranch: expect.anything() }),
    );
    const launchScript = writtenFileContent("/tmp/groundcrew-team-2-x/launch.sh");
    expect(launchScript).not.toContain("GROUNDCREW_BASE_BRANCH");
    expect(launchScript).toContain(
      "--env-pass=GROUNDCREW_TASK_ID,GROUNDCREW_COMPLETE,CMUX_SURFACE_ID,CMUX_SOCKET_PATH",
    );
    expect(provisioningRunState()).not.toHaveProperty("baseBranch");
    const recorded = lastRecordedRunState();
    expect(recorded).not.toHaveProperty("baseBranch");
    expect(recorded).not.toHaveProperty("parentTask");
  });

  it("fires the reattach guard through the real dispatch path when the recorded baseBranch differs from the one now requested", async () => {
    const actualFs = await vi.importActual<typeof nodeFs>("node:fs");
    const actualRunStateModule =
      await vi.importActual<typeof import("../lib/runState.ts")>("../lib/runState.ts");
    const actualWorktreesModule =
      await vi.importActual<typeof worktreesModule>("../lib/worktrees.ts");
    const stateRoot = actualFs.mkdtempSync(path.join(tmpdir(), "groundcrew-setup-guard-"));
    try {
      const config: ResolvedConfig = {
        ...makeConfig(),
        logging: { file: path.join(stateRoot, "groundcrew.log") },
      };

      // writeJsonAtomic (called by the real recordRunState below) goes
      // through node:fs's writeFileSync, which this file mocks to a no-op by
      // default; give it a real implementation so the run-state writes in
      // this test actually land on disk.
      writeFileMock.mockImplementation(actualFs.writeFileSync);
      // existsSync's default `true` stub (set once when the node:fs mock
      // factory runs) doesn't survive a prior test's vi.resetAllMocks(); the
      // real create() below needs it to find the repo clone dir.
      existsSyncMock.mockReturnValue(true);

      // Simulate a prior dispatch attempt that recorded baseBranch "dev-team-0"
      // on real disk, before this call's preflight overwrites it.
      actualRunStateModule.recordRunState({
        config,
        state: {
          task: "team-2",
          repository: "repo-a",
          agent: "claude",
          worktreeDir: "/work/repo-a-team-2",
          branchName: "dev-team-2",
          workspaceName: "team-2",
          state: "provisioning",
          baseBranch: "dev-team-0",
          parentTask: "team-0",
        },
      });

      // preflightProvisioningGate's own "provisioning" stamp must also hit real
      // disk here so the test can distinguish reading recordedBaseBranch before
      // that stamp (fixed) from reading it after (buggy: it would trivially
      // match the requested baseBranch and the guard would never fire).
      recordRunStateMock.mockImplementation(actualRunStateModule.recordRunState);
      // Run the real create() so the reattach guard actually executes; the
      // show-ref probe it calls resolves through the mocked runCommandAsync,
      // which by default reports the local branch as already existing.
      createMock.mockImplementation(actualWorktreesModule.worktrees.create);

      const error = await setupWorkspace(config, {
        task: "team-2",
        repository: "repo-a",
        agent: "claude",
        baseBranch: "dev-team-1",
        parentTask: "team-1",
        details: { title: "Test Title", description: "Body" },
      }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(StackedBaseBranchMismatchError);
      expect((error as Error).message).toContain("crew cleanup team-2");
    } finally {
      actualFs.rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it("clears baseBranch/parentTask/needsRebase on the failed-to-launch run state instead of carrying them forward from the provisioning row", async () => {
    const config = makeConfig();
    createMock.mockRejectedValueOnce(new Error("boom"));

    await expect(
      setupWorkspace(config, {
        task: "team-2",
        repository: "repo-a",
        agent: "claude",
        baseBranch: "dev-team-1",
        parentTask: "team-1",
        details: { title: "Test Title", description: "Body" },
      }),
    ).rejects.toThrow("boom");

    const failedCall = recordRunStateMock.mock.calls.find(
      (entry) => entry[0].state.state === "failed-to-launch",
    );
    expect(failedCall).toBeDefined();
    expect(failedCall?.[0].state.clearFields).toEqual([
      "baseBranch",
      "parentTask",
      "needsRebase",
      "stackRegistered",
    ]);
    expect(failedCall?.[0].state).not.toHaveProperty("baseBranch");
    expect(failedCall?.[0].state).not.toHaveProperty("parentTask");
  });
});
