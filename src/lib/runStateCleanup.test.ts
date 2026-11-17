import { captureConsoleLog, type ConsoleCapture } from "../testHelpers/consoleCapture.ts";
import type { ResolvedConfig } from "./config.ts";
import type { RunCommandOptions } from "./commandRunner.ts";
import { listPullRequestsForBranch } from "./pullRequests.ts";
import { readRunState, removeRunState, type RunState } from "./runState.ts";
import { recordCleanedUpRuns } from "./runStateCleanup.ts";
import { reclaimStackParentBranch, type WorktreeEntry } from "./worktrees.ts";

vi.mock(import("./runState.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    readRunState: vi.fn<typeof readRunState>(),
    removeRunState: vi.fn<typeof removeRunState>(),
  };
});
const runCommandMock = vi.hoisted(() =>
  vi.fn<(command: string, arguments_: readonly string[]) => Promise<string>>(),
);

vi.mock(import("./commandRunner.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  async function runCommandAsync(
    command: string,
    arguments_: readonly string[],
    options: RunCommandOptions & { stdio: "inherit" },
  ): Promise<undefined>;
  async function runCommandAsync(
    command: string,
    arguments_: readonly string[],
    options?: RunCommandOptions & { stdio?: "captured" },
  ): Promise<string>;
  async function runCommandAsync(
    command: string,
    arguments_: readonly string[],
  ): Promise<string | undefined> {
    return await runCommandMock(command, arguments_);
  }
  return { ...actual, runCommandAsync };
});
vi.mock(import("./pullRequests.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, listPullRequestsForBranch: vi.fn<typeof listPullRequestsForBranch>() };
});
vi.mock(import("./worktrees.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, reclaimStackParentBranch: vi.fn<typeof reclaimStackParentBranch>() };
});

const readRunStateMock = vi.mocked(readRunState);
const removeRunStateMock = vi.mocked(removeRunState);
const reclaimMock = vi.mocked(reclaimStackParentBranch);
const listPullRequestsMock = vi.mocked(listPullRequestsForBranch);

const config: ResolvedConfig = Object.assign(Object.create(null), {});
const cloudConfig: ResolvedConfig = Object.assign(Object.create(null), {
  git: { remote: "origin", defaultBranch: "main" },
  workspace: { projectDir: "/work" },
});

function entryFor(task: string): WorktreeEntry {
  return {
    repository: "repo-a",
    task,
    branchName: `dev-${task}`,
    dir: `/work/repo-a-${task}`,
    kind: "host",
  };
}

function runStateWith(overrides: Partial<RunState>): RunState {
  return {
    task: "team-2",
    repository: "repo-a",
    agent: "claude",
    worktreeDir: "/work/repo-a-team-2",
    branchName: "dev-team-2",
    workspaceName: "team-2",
    state: "running",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    resumeCount: 0,
    ...overrides,
  };
}

describe(recordCleanedUpRuns, () => {
  beforeEach(() => {
    readRunStateMock.mockReset();
    removeRunStateMock.mockReset();
    reclaimMock.mockReset();
    runCommandMock.mockReset();
    listPullRequestsMock.mockReset();
  });

  it("reclaims the parent branch a removed stacked child was pinning", async () => {
    readRunStateMock.mockReturnValue(
      runStateWith({ baseBranch: "dev-team-1", parentTask: "team-1" }),
    );

    await recordCleanedUpRuns(config, [entryFor("team-2")]);

    expect(removeRunStateMock).toHaveBeenCalledWith(config, "team-2");
    expect(reclaimMock).toHaveBeenCalledWith(config, {
      repository: "repo-a",
      parentTask: "team-1",
      branchName: "dev-team-1",
    });
  });

  it("reclaims only after the child's run state is removed", async () => {
    readRunStateMock.mockReturnValue(
      runStateWith({ baseBranch: "dev-team-1", parentTask: "team-1" }),
    );
    removeRunStateMock.mockImplementation(() => {
      expect(reclaimMock).not.toHaveBeenCalled();
    });

    await recordCleanedUpRuns(config, [entryFor("team-2")]);

    expect(reclaimMock).toHaveBeenCalledOnce();
  });

  it("does not reclaim for a task that was not stacked", async () => {
    readRunStateMock.mockReturnValue(runStateWith({}));

    await recordCleanedUpRuns(config, [entryFor("team-2")]);

    expect(removeRunStateMock).toHaveBeenCalledWith(config, "team-2");
    expect(reclaimMock).not.toHaveBeenCalled();
  });

  it("does not reclaim when there is no run state", async () => {
    await recordCleanedUpRuns(config, [entryFor("team-2")]);

    expect(reclaimMock).not.toHaveBeenCalled();
  });

  it("swallows a failed reclaim and keeps cleaning the remaining entries", async () => {
    readRunStateMock.mockReturnValue(
      runStateWith({ baseBranch: "dev-team-1", parentTask: "team-1" }),
    );
    reclaimMock.mockRejectedValueOnce(new Error("git exploded"));

    await expect(
      recordCleanedUpRuns(config, [entryFor("team-2"), entryFor("team-3")]),
    ).resolves.toBeUndefined();

    expect(removeRunStateMock).toHaveBeenCalledTimes(2);
    expect(reclaimMock).toHaveBeenCalledTimes(2);
  });

  it("does not reclaim when removing the run state fails", async () => {
    readRunStateMock.mockReturnValue(
      runStateWith({ baseBranch: "dev-team-1", parentTask: "team-1" }),
    );
    removeRunStateMock.mockImplementation(() => {
      throw new Error("EACCES");
    });

    await recordCleanedUpRuns(config, [entryFor("team-2")]);

    expect(reclaimMock).not.toHaveBeenCalled();
  });
  describe("cloud runs", () => {
    const cloudRunState = runStateWith({
      execution: "cloud",
      cloudSessionId: "session_1",
      cloudSessionUrl: "https://claude.ai/code/session_1",
    });
    const remoteBranchDeleteArguments = [
      "-C",
      "/work/repo-a",
      "push",
      "--no-verify",
      "origin",
      "--delete",
      "dev-team-2",
    ];

    let consoleLog: ConsoleCapture;

    beforeEach(() => {
      consoleLog = captureConsoleLog();
      readRunStateMock.mockReturnValue(cloudRunState);
    });

    afterEach(() => {
      consoleLog.restore();
    });

    function fakeRemoteBranch(failing: readonly string[] = []): void {
      runCommandMock.mockImplementation(async (_command, arguments_) => {
        const failedStep = failing.find((step) => arguments_.includes(step));
        if (failedStep !== undefined) {
          throw new Error(`git ${failedStep} failed`);
        }
        return arguments_.includes("ls-remote") ? `${"c".repeat(40)}\trefs/heads/dev-team-2\n` : "";
      });
    }

    function deleteCalls(): readonly (readonly string[])[] {
      return runCommandMock.mock.calls
        .map(([, arguments_]) => arguments_)
        .filter((arguments_) => arguments_.includes("--delete"));
    }

    it("deletes the remote branch when a cloud run had no PR and the branch carries no work", async () => {
      fakeRemoteBranch();
      listPullRequestsMock.mockResolvedValue([]);

      await recordCleanedUpRuns(cloudConfig, [entryFor("team-2")]);

      expect(listPullRequestsMock).toHaveBeenCalledWith({
        cwd: "/work/repo-a",
        branchName: "dev-team-2",
      });
      expect(deleteCalls()).toStrictEqual([remoteBranchDeleteArguments]);
    });

    it("keeps the remote branch and logs when a cloud run had no PR but the branch carries commits", async () => {
      fakeRemoteBranch(["--is-ancestor"]);
      listPullRequestsMock.mockResolvedValue([]);

      await recordCleanedUpRuns(cloudConfig, [entryFor("team-2")]);

      expect(deleteCalls()).toStrictEqual([]);
      expect(consoleLog.output()).toContain("Kept remote branch dev-team-2");
    });

    it("keeps the remote branch when its tip is unknown locally", async () => {
      fakeRemoteBranch(["cat-file"]);
      listPullRequestsMock.mockResolvedValue([]);

      await recordCleanedUpRuns(cloudConfig, [entryFor("team-2")]);

      expect(deleteCalls()).toStrictEqual([]);
      expect(consoleLog.output()).toContain("Kept remote branch dev-team-2");
    });

    it("makes no delete call when the remote has no such branch", async () => {
      runCommandMock.mockResolvedValue("");
      listPullRequestsMock.mockResolvedValue([]);

      await recordCleanedUpRuns(cloudConfig, [entryFor("team-2")]);

      expect(deleteCalls()).toStrictEqual([]);
    });

    it("keeps the remote branch when a PR exists", async () => {
      listPullRequestsMock.mockResolvedValue([
        { url: "https://github.com/acme/repo-a/pull/1", number: 1, state: "open", title: "t" },
      ]);

      await recordCleanedUpRuns(cloudConfig, [entryFor("team-2")]);

      expect(runCommandMock).not.toHaveBeenCalled();
    });

    it("keeps the remote branch and logs when the PR lookup throws", async () => {
      listPullRequestsMock.mockRejectedValue(new Error("gh: not authenticated"));

      await recordCleanedUpRuns(cloudConfig, [entryFor("team-2")]);

      expect(runCommandMock).not.toHaveBeenCalled();
      expect(consoleLog.output()).toContain("Kept remote branch dev-team-2");
    });

    it("does nothing remote for local runs", async () => {
      readRunStateMock.mockReturnValue(runStateWith({}));

      await recordCleanedUpRuns(cloudConfig, [entryFor("team-2")]);

      expect(listPullRequestsMock).not.toHaveBeenCalled();
      expect(runCommandMock).not.toHaveBeenCalled();
    });

    describe("a cloud run resumed locally", () => {
      const resumedRunState = runStateWith({
        cloudSessionId: "session_1",
        cloudSessionUrl: "https://claude.ai/code/session_1",
      });

      beforeEach(() => {
        readRunStateMock.mockReturnValue(resumedRunState);
      });

      it("deletes the remote branch when it had no PR and the branch carries no work", async () => {
        fakeRemoteBranch();
        listPullRequestsMock.mockResolvedValue([]);

        await recordCleanedUpRuns(cloudConfig, [entryFor("team-2")]);

        expect(deleteCalls()).toStrictEqual([remoteBranchDeleteArguments]);
      });

      it("keeps the remote branch when a PR exists", async () => {
        listPullRequestsMock.mockResolvedValue([
          { url: "https://github.com/acme/repo-a/pull/1", number: 1, state: "open", title: "t" },
        ]);

        await recordCleanedUpRuns(cloudConfig, [entryFor("team-2")]);

        expect(runCommandMock).not.toHaveBeenCalled();
      });
    });

    it("does not throw when the remote delete fails", async () => {
      listPullRequestsMock.mockResolvedValue([]);
      runCommandMock.mockRejectedValue(new Error("remote rejected"));

      await expect(
        recordCleanedUpRuns(cloudConfig, [entryFor("team-2"), entryFor("team-3")]),
      ).resolves.toBeUndefined();

      expect(removeRunStateMock).toHaveBeenCalledTimes(2);
    });
  });
});
