import type { ResolvedConfig } from "./config.ts";
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
vi.mock(import("./worktrees.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, reclaimStackParentBranch: vi.fn<typeof reclaimStackParentBranch>() };
});

const readRunStateMock = vi.mocked(readRunState);
const removeRunStateMock = vi.mocked(removeRunState);
const reclaimMock = vi.mocked(reclaimStackParentBranch);

const config: ResolvedConfig = Object.assign(Object.create(null), {});

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
});
