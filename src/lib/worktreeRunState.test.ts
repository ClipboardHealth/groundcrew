import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { RunCommandOptions } from "./commandRunner.ts";
import type { ResolvedConfig } from "./config.ts";
import { recordRunState, type RunState } from "./runState.ts";
import {
  effectiveBranchNameFromRunState as resolveBranch,
  isReferencedAsStackParent,
} from "./worktreeRunState.ts";

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

function makeStackedConfig(stateRoot: string): ResolvedConfig {
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
    agents: { default: "claude", definitions: { claude: { cmd: "claude", color: "#fff" } } },
    prompts: { initial: "x" },
    workspaceKind: "auto",
    local: {
      runner: "auto",
      networkEgress: "allowlisted",
      safehouse: { enable: [] },
      readOnlyDirs: [],
    },
    logging: { file: path.join(stateRoot, "groundcrew.log") },
  };
}

describe(isReferencedAsStackParent, () => {
  let stateRoot: string;
  let config: ResolvedConfig;

  beforeEach(() => {
    stateRoot = mkdtempSync(path.join(tmpdir(), "groundcrew-stack-parent-"));
    config = makeStackedConfig(stateRoot);
  });

  afterEach(() => {
    rmSync(stateRoot, { recursive: true, force: true });
  });

  it("is true when a child's run state names the task as parentTask with baseBranch set", () => {
    recordRunState({
      config,
      state: {
        task: "team-2",
        repository: "repo-a",
        agent: "claude",
        worktreeDir: "/work/repo-a-team-2",
        branchName: "dev-team-2",
        workspaceName: "team-2",
        state: "running",
        baseBranch: "dev-team-1",
        parentTask: "team-1",
      },
    });

    expect(isReferencedAsStackParent({ config, task: "team-1" })).toBe(true);
  });

  it("is false once the child has rebased and baseBranch was cleared", () => {
    recordRunState({
      config,
      state: {
        task: "team-2",
        repository: "repo-a",
        agent: "claude",
        worktreeDir: "/work/repo-a-team-2",
        branchName: "dev-team-2",
        workspaceName: "team-2",
        state: "running",
        parentTask: "team-1",
      },
    });

    expect(isReferencedAsStackParent({ config, task: "team-1" })).toBe(false);
  });

  it("is false when no run state names the task as parentTask", () => {
    recordRunState({
      config,
      state: {
        task: "team-2",
        repository: "repo-a",
        agent: "claude",
        worktreeDir: "/work/repo-a-team-2",
        branchName: "dev-team-2",
        workspaceName: "team-2",
        state: "running",
      },
    });

    expect(isReferencedAsStackParent({ config, task: "team-1" })).toBe(false);
  });

  it("is false when the runs directory does not exist", () => {
    expect(isReferencedAsStackParent({ config, task: "team-1" })).toBe(false);
  });
});
