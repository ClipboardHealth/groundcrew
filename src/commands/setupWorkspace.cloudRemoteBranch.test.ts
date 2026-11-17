import { agentTrustDir } from "agent-trust";

import type { RunCommandOptions } from "../lib/commandRunner.ts";
import { launchCloudSession } from "../lib/cloudLauncher.ts";
import { DEFAULT_CLOUD_PROMPT_INITIAL } from "../lib/cloudPrompt.ts";
import type { ResolvedConfig } from "../lib/config.ts";
import { readRunState, recordRunState, type RunState } from "../lib/runState.ts";
import type * as utilModule from "../lib/util.ts";
import { log } from "../lib/util.ts";
import { worktrees, type WorktreeEntry } from "../lib/worktrees.ts";
import { makeCmuxConfig } from "../testHelpers/cmuxConfig.ts";
import { makeExecutionConfig } from "../testHelpers/executionConfig.ts";
import { makeLocalConfig } from "../testHelpers/localConfig.ts";
import { emptyTeardownResult } from "../testHelpers/teardownResult.ts";
import { setupWorkspace, type SetupWorkspaceOptions } from "./setupWorkspace.ts";

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
    runCommandAsync: runCommandMock as unknown as typeof actual.runCommandAsync,
  };
});
vi.mock(import("../lib/cloudLauncher.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, launchCloudSession: vi.fn<typeof actual.launchCloudSession>() };
});
vi.mock(import("agent-trust"), async (importOriginal) => {
  const actual = await importOriginal<typeof import("agent-trust")>();
  return { ...actual, agentTrustDir: vi.fn<typeof agentTrustDir>() };
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
  const actual = await importOriginal<typeof utilModule>();
  return { ...actual, log: vi.fn<typeof actual.log>(), debug: vi.fn<typeof actual.debug>() };
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

const agentTrustDirMock = vi.mocked(agentTrustDir);
const logMock = vi.mocked(log);
const launchCloudSessionMock = vi.mocked(launchCloudSession);
const readRunStateMock = vi.mocked(readRunState);
const createMock = vi.mocked(worktrees.create);

const REMOTE_TIP = "b".repeat(40);
const REMOTE_BRANCH_DELETE_ARGUMENTS = [
  "-C",
  "/work/repo-a",
  "push",
  "--no-verify",
  "origin",
  "--delete",
  "dev-team-1",
];

const cloudOptions: SetupWorkspaceOptions = {
  task: "team-1",
  repository: "repo-a",
  agent: "claude",
  details: { title: "Cloud Title", description: "Do the cloud thing" },
};

const entry: WorktreeEntry = {
  repository: "repo-a",
  task: "team-1",
  branchName: "dev-team-1",
  dir: "/work/repo-a-team-1",
  kind: "host",
};

function makeCloudConfig(): ResolvedConfig {
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
      definitions: { claude: { cmd: "claude", color: "#fff", execution: "cloud" } },
    },
    execution: makeExecutionConfig(),
    prompts: { initial: "x", cloudInitial: DEFAULT_CLOUD_PROMPT_INITIAL },
    workspaceKind: "auto",
    local: makeLocalConfig(),
    cmux: makeCmuxConfig(),
    logging: { file: "/tmp/groundcrew-test.log" },
  };
}

function fakeRemoteBranch(failing: readonly string[] = []): void {
  runCommandMock.mockImplementation((_command, arguments_) => {
    const failedStep = failing.find((step) => arguments_.includes(step));
    if (failedStep !== undefined) {
      throw new Error(`git ${failedStep} failed`);
    }
    return arguments_.includes("ls-remote") ? `${REMOTE_TIP}\trefs/heads/dev-team-1\n` : "";
  });
}

function deleteCalls(): readonly (readonly string[])[] {
  return runCommandMock.mock.calls
    .map(([, arguments_]) => arguments_)
    .filter((arguments_) => arguments_.includes("--delete"));
}

async function expectLaunchFailure(): Promise<void> {
  launchCloudSessionMock.mockRejectedValue(new Error("launch failed"));
  await expect(setupWorkspace(makeCloudConfig(), cloudOptions)).rejects.toThrow("launch failed");
}

describe("setupWorkspace cloud launch failure and the remote branch", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    runCommandMock.mockReturnValue("");
    agentTrustDirMock.mockReturnValue({ ok: true } as ReturnType<typeof agentTrustDir>);
    createMock.mockResolvedValue(entry);
    vi.mocked(worktrees.findByTask).mockReturnValue([]);
    vi.mocked(worktrees.predictedEntry).mockReturnValue({
      worktreeDir: entry.dir,
      branchName: entry.branchName,
    });
    vi.mocked(worktrees.teardown).mockResolvedValue(emptyTeardownResult());
  });

  it("deletes the pushed branch when the launch fails and the branch carries no work", async () => {
    fakeRemoteBranch();

    await expectLaunchFailure();

    expect(deleteCalls()).toStrictEqual([REMOTE_BRANCH_DELETE_ARGUMENTS]);
  });

  it.each(["--is-ancestor", "cat-file"])(
    "keeps the branch and logs when the %s check fails after a failed launch",
    async (failingStep) => {
      fakeRemoteBranch([failingStep]);

      await expectLaunchFailure();

      expect(deleteCalls()).toStrictEqual([]);
      expect(logMock).toHaveBeenCalledWith(
        expect.stringContaining("Kept remote branch dev-team-1"),
      );
    },
  );

  it("makes no delete call when the remote does not have the branch", async () => {
    await expectLaunchFailure();

    expect(deleteCalls()).toStrictEqual([]);
  });

  it("rethrows the launch error when the remote delete fails", async () => {
    fakeRemoteBranch(["--delete"]);

    await expectLaunchFailure();

    expect(deleteCalls()).toStrictEqual([REMOTE_BRANCH_DELETE_ARGUMENTS]);
  });

  it("passes the base branch recorded in run state to worktree creation", async () => {
    launchCloudSessionMock.mockResolvedValue({
      sessionId: "session_abc",
      url: "https://claude.ai/code/session_abc",
    });
    const recorded: Partial<RunState> = { baseBranch: "dev-team-0" };
    readRunStateMock.mockReturnValue(recorded as RunState);

    await setupWorkspace(makeCloudConfig(), cloudOptions);

    expect(createMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ recordedBaseBranch: "dev-team-0" }),
    );
  });

  it("seeds workspace trust for the launch dir before launching the cloud session", async () => {
    launchCloudSessionMock.mockResolvedValue({
      sessionId: "session_abc",
      url: "https://claude.ai/code/session_abc",
    });

    await setupWorkspace(makeCloudConfig(), cloudOptions);

    expect(agentTrustDirMock).toHaveBeenCalledWith(
      expect.objectContaining({ agent: "claude", dirPath: entry.dir }),
    );
    expect(agentTrustDirMock.mock.invocationCallOrder[0]).toBeLessThan(
      launchCloudSessionMock.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("still launches when trust seeding reports a failure, like the local path", async () => {
    agentTrustDirMock.mockReturnValue({ ok: false, error: "no trust" } as ReturnType<
      typeof agentTrustDir
    >);
    launchCloudSessionMock.mockResolvedValue({
      sessionId: "session_abc",
      url: "https://claude.ai/code/session_abc",
    });

    await setupWorkspace(makeCloudConfig(), cloudOptions);

    expect(launchCloudSessionMock).toHaveBeenCalledTimes(1);
  });
});
