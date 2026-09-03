/* eslint-disable no-template-curly-in-string -- ${branch}-style placeholders appear as literal strings in RepoRecipe create/remove command templates; they're NOT JS template literals */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import type * as nodeOs from "node:os";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";

import type { RunCommandOptions } from "./commandRunner.ts";
import type { ResolvedConfig } from "./config.ts";
import { recordRunState } from "./runState.ts";
import { setVerbose } from "./util.ts";
import { StackedBaseBranchMismatchError, worktrees } from "./worktrees.ts";

const { create } = worktrees;

type NodeOsMock = Omit<typeof nodeOs, "userInfo"> & {
  userInfo: ReturnType<typeof vi.fn<typeof userInfo>>;
};

type RunCommandMock = (
  command: string,
  arguments_: readonly string[],
  options?: RunCommandOptions,
) => string;

const runCommandMock = vi.hoisted(() => vi.fn<RunCommandMock>());

vi.mock(import("./commandRunner.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    runCommand: runCommandMock,
    runCommandAsync: runCommandMock as unknown as typeof actual.runCommandAsync,
  };
});
vi.mock("node:os", async (importOriginal): Promise<NodeOsMock> => {
  const actual = await importOriginal<typeof nodeOs>();
  return {
    ...actual,
    userInfo: vi.fn<typeof actual.userInfo>(actual.userInfo),
  };
});

const userInfoMock = vi.mocked(userInfo);

function makeConfig(overrides: {
  projectDir: string;
  git?: ResolvedConfig["git"];
  knownRepositories?: string[];
  repositories?: ResolvedConfig["workspace"]["repositories"];
}): ResolvedConfig {
  const knownRepositories = overrides.knownRepositories ?? ["repo-a"];
  return {
    sources: [],
    defaults: { hooks: {} },
    git: overrides.git ?? { remote: "origin", defaultBranch: "main" },
    workspace: {
      projectDir: overrides.projectDir,
      knownRepositories,
      repositories: overrides.repositories ?? knownRepositories.map((name) => ({ name })),
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
    logging: { file: path.join(overrides.projectDir, "state", "groundcrew.log") },
  };
}

function makeUserInfo(username: string): ReturnType<typeof userInfo> {
  return { username, uid: 0, gid: 0, shell: null, homedir: "/tmp" };
}

function hasArguments(arguments_: readonly string[], ...needles: readonly string[]): boolean {
  return needles.every((needle) => arguments_.includes(needle));
}

// `localBranchExists` probes `git show-ref --verify`; the default mock returns
// "" (success), which would report every branch as already local. Fresh-create
// tests call this so the probe exits non-zero and the `-b` create path runs.
function throwWhenProbingBranch(arguments_: readonly string[]): void {
  if (hasArguments(arguments_, "show-ref", "--verify")) {
    throw new Error("not a local branch");
  }
}

let projectDir: string;

function setupTempProjectDir(): void {
  beforeEach(() => {
    projectDir = mkdtempSync(path.join(tmpdir(), "groundcrew-worktrees-stacked-"));
    userInfoMock.mockReturnValue(makeUserInfo("dev"));
    runCommandMock.mockReturnValue("");
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    setVerbose(false);
    vi.clearAllMocks();
  });
}

describe(create, () => {
  setupTempProjectDir();

  it("fetches and worktree-adds the requested base branch instead of the default branch", async () => {
    mkdirSync(path.join(projectDir, "repo-a"));
    const config = makeConfig({ projectDir });
    runCommandMock.mockImplementation((_command, arguments_) => {
      throwWhenProbingBranch(arguments_);
      return "";
    });

    const actual = await create(config, {
      repository: "repo-a",
      task: "team-2",
      baseBranch: "dev-team-1",
    });

    expect(runCommandMock).toHaveBeenCalledWith(
      "git",
      ["-C", path.join(projectDir, "repo-a"), "fetch", "origin", "dev-team-1"],
      { stdio: "captured", timeoutMs: 0 },
    );
    expect(runCommandMock).toHaveBeenCalledWith(
      "git",
      [
        "-C",
        path.join(projectDir, "repo-a"),
        "worktree",
        "add",
        "-b",
        "dev-team-2",
        path.join(projectDir, "repo-a-team-2"),
        "origin/dev-team-1",
      ],
      { stdio: "captured", timeoutMs: 0 },
    );
    // No default-branch probe when a base branch is requested.
    expect(runCommandMock).not.toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["symbolic-ref"]),
      expect.anything(),
    );
    expect(actual.dir).toBe(path.join(projectDir, "repo-a-team-2"));
    expect(actual.branchName).toBe("dev-team-2");
  });

  it("leaves the unstacked (default-branch) create path byte-for-byte unchanged", async () => {
    mkdirSync(path.join(projectDir, "repo-a"));
    const config = makeConfig({ projectDir });
    runCommandMock.mockImplementation((_command, arguments_) => {
      throwWhenProbingBranch(arguments_);
      // oxlint-disable-next-line vitest/no-conditional-in-test -- discriminator picks out the symbolic-ref probe so it returns origin/<branch>
      if (hasArguments(arguments_, "symbolic-ref", "refs/remotes/origin/HEAD")) {
        return "origin/main\n";
      }
      return "";
    });

    const actual = await create(config, { repository: "repo-a", task: "team-1" });

    expect(runCommandMock).toHaveBeenCalledWith(
      "git",
      [
        "-C",
        path.join(projectDir, "repo-a"),
        "symbolic-ref",
        "--short",
        "refs/remotes/origin/HEAD",
      ],
      {},
    );
    expect(runCommandMock).toHaveBeenCalledWith(
      "git",
      ["-C", path.join(projectDir, "repo-a"), "fetch", "origin", "main"],
      { stdio: "captured", timeoutMs: 0 },
    );
    expect(runCommandMock).toHaveBeenCalledWith(
      "git",
      [
        "-C",
        path.join(projectDir, "repo-a"),
        "worktree",
        "add",
        "-b",
        "dev-team-1",
        path.join(projectDir, "repo-a-team-1"),
        "origin/main",
      ],
      { stdio: "captured", timeoutMs: 0 },
    );
    expect(actual.dir).toBe(path.join(projectDir, "repo-a-team-1"));
  });

  it("refuses to reattach a surviving local branch when run state names a different baseBranch", async () => {
    mkdirSync(path.join(projectDir, "repo-a"));
    const config = makeConfig({ projectDir });
    recordRunState({
      config,
      state: {
        task: "team-2",
        repository: "repo-a",
        agent: "claude",
        worktreeDir: path.join(projectDir, "repo-a-team-2"),
        branchName: "dev-team-2",
        workspaceName: "team-2",
        state: "running",
        baseBranch: "dev-team-0",
      },
    });
    // show-ref succeeds (default mock returns ""), so dev-team-2 is already local.

    const error = await create(config, {
      repository: "repo-a",
      task: "team-2",
      baseBranch: "dev-team-1",
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(StackedBaseBranchMismatchError);
    expect((error as Error).message).toContain("crew cleanup team-2");
    expect(runCommandMock).not.toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["worktree", "add"]),
      expect.anything(),
    );
  });

  it("refuses to reattach a surviving local branch when run state records no baseBranch at all", async () => {
    mkdirSync(path.join(projectDir, "repo-a"));
    const config = makeConfig({ projectDir });
    recordRunState({
      config,
      state: {
        task: "team-2",
        repository: "repo-a",
        agent: "claude",
        worktreeDir: path.join(projectDir, "repo-a-team-2"),
        branchName: "dev-team-2",
        workspaceName: "team-2",
        state: "running",
      },
    });

    await expect(
      create(config, { repository: "repo-a", task: "team-2", baseBranch: "dev-team-1" }),
    ).rejects.toThrow(StackedBaseBranchMismatchError);
  });

  it("reattaches without complaint when the recorded baseBranch matches the requested one", async () => {
    mkdirSync(path.join(projectDir, "repo-a"));
    const config = makeConfig({ projectDir });
    recordRunState({
      config,
      state: {
        task: "team-2",
        repository: "repo-a",
        agent: "claude",
        worktreeDir: path.join(projectDir, "repo-a-team-2"),
        branchName: "dev-team-2",
        workspaceName: "team-2",
        state: "running",
        baseBranch: "dev-team-1",
      },
    });

    const actual = await create(config, {
      repository: "repo-a",
      task: "team-2",
      baseBranch: "dev-team-1",
    });

    expect(runCommandMock).toHaveBeenCalledWith(
      "git",
      [
        "-C",
        path.join(projectDir, "repo-a"),
        "worktree",
        "add",
        path.join(projectDir, "repo-a-team-2"),
        "dev-team-2",
      ],
      { stdio: "captured", timeoutMs: 0 },
    );
    expect(actual.branchName).toBe("dev-team-2");
  });

  it("refuses to stack a worktree for a scripted-provisioner repository", async () => {
    const config = makeConfig({
      projectDir,
      knownRepositories: ["billing"],
      repositories: [
        {
          name: "billing",
          provision: { create: "graft new ${branch}", remove: "graft rm ${branch} -f" },
        },
      ],
    });

    await expect(
      create(config, { repository: "billing", task: "team-220", baseBranch: "dev-team-1" }),
    ).rejects.toThrow(/Stacked worktrees are not supported for provision\/sparse-checkout/);
    expect(runCommandMock).not.toHaveBeenCalledWith("sh", expect.anything(), expect.anything());
  });
});
