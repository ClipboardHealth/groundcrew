import type { RunCommandOptions } from "./commandRunner.ts";
import type { RunState } from "./runState.ts";
import { effectiveBranchNameFromRunState as resolveBranch } from "./worktreeRunState.ts";

type RunCommandAsyncMock = (
  command: string,
  arguments_: readonly string[],
  options?: RunCommandOptions,
) => Promise<string>;

const runCommandMock = vi.hoisted(() => vi.fn<RunCommandAsyncMock>());

vi.mock(import("./commandRunner.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- single recorder for the captured-stdio overload of runCommandAsync
    runCommandAsync: runCommandMock as unknown as typeof actual.runCommandAsync,
  };
});

const WORKTREE_DIR = "/work/repo/team-1";
const ENTRY_BRANCH = "dev-team-1";
const RUN_STATE_BRANCH = "feature/dev-team-1";
const GIT_BRANCH = "jdoe/dev-team-1";

interface EntryFixture {
  repository: string;
  branchName: string;
  dir: string;
}

function entry(overrides: Partial<EntryFixture> = {}): EntryFixture {
  return {
    repository: overrides.repository ?? "repo",
    branchName: overrides.branchName ?? ENTRY_BRANCH,
    dir: overrides.dir ?? WORKTREE_DIR,
  };
}

function runState(overrides: Partial<RunState> = {}): RunState {
  return {
    task: overrides.task ?? "team-1",
    repository: overrides.repository ?? "repo",
    agent: overrides.agent ?? "claude",
    worktreeDir: overrides.worktreeDir ?? WORKTREE_DIR,
    branchName: overrides.branchName ?? RUN_STATE_BRANCH,
    workspaceName: overrides.workspaceName ?? "ws",
    state: overrides.state ?? "running",
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-01-01T00:00:00.000Z",
    resumeCount: overrides.resumeCount ?? 0,
    ...(overrides.reason !== undefined && { reason: overrides.reason }),
    ...(overrides.detail !== undefined && { detail: overrides.detail }),
    ...(overrides.title !== undefined && { title: overrides.title }),
    ...(overrides.url !== undefined && { url: overrides.url }),
    ...(overrides.completionTaskId !== undefined && {
      completionTaskId: overrides.completionTaskId,
    }),
    ...(overrides.adoptedBranch !== undefined && { adoptedBranch: overrides.adoptedBranch }),
  };
}

function mockGitBranch(output: string): void {
  runCommandMock.mockImplementation(async (command, arguments_) => {
    if (command === "git" && arguments_[0] === "branch" && arguments_[1] === "--show-current") {
      return output;
    }
    throw new Error(`unexpected command: ${command} ${arguments_.join(" ")}`);
  });
}

function mockGitFailure(): void {
  runCommandMock.mockImplementation(async (command, arguments_) => {
    if (command === "git" && arguments_[0] === "branch" && arguments_[1] === "--show-current") {
      throw new Error("fatal: not a git repository");
    }
    throw new Error(`unexpected command: ${command} ${arguments_.join(" ")}`);
  });
}

describe(resolveBranch, () => {
  beforeEach(() => {
    runCommandMock.mockReset();
  });

  it("returns the git-resolved branch when git succeeds, even over a matching runState", async () => {
    mockGitBranch(GIT_BRANCH);

    const result = await resolveBranch({
      entry: entry(),
      runState: runState(),
    });

    expect(result).toBe(GIT_BRANCH);
    expect(runCommandMock).toHaveBeenCalledWith(
      "git",
      ["branch", "--show-current"],
      expect.objectContaining({ cwd: WORKTREE_DIR }),
    );
  });

  it("falls back to runState branchName when git returns empty (detached HEAD)", async () => {
    mockGitBranch("");

    const result = await resolveBranch({
      entry: entry(),
      runState: runState(),
    });

    expect(result).toBe(RUN_STATE_BRANCH);
  });

  it("falls back to entry branchName when git returns empty and runState is undefined", async () => {
    mockGitBranch("");

    const result = await resolveBranch({
      entry: entry(),
      runState: undefined,
    });

    expect(result).toBe(ENTRY_BRANCH);
  });

  it("falls back to entry branchName when git returns empty and runState does not match entry", async () => {
    mockGitBranch("");

    const result = await resolveBranch({
      entry: entry({ dir: "/work/repo/team-1" }),
      runState: runState({ worktreeDir: "/work/other-place" }),
    });

    expect(result).toBe(ENTRY_BRANCH);
  });

  it("falls back to runState branchName when git throws", async () => {
    mockGitFailure();

    const result = await resolveBranch({
      entry: entry(),
      runState: runState(),
    });

    expect(result).toBe(RUN_STATE_BRANCH);
  });

  it("falls back to entry branchName when git throws and runState is undefined", async () => {
    mockGitFailure();

    const result = await resolveBranch({
      entry: entry(),
      runState: undefined,
    });

    expect(result).toBe(ENTRY_BRANCH);
  });
});
