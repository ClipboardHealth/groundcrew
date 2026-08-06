/* eslint-disable no-template-curly-in-string -- ${branch}-style placeholders appear as literal strings in RepoRecipe create/remove command templates; they're NOT JS template literals */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import type * as nodeOs from "node:os";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";

import type { RunCommandOptions } from "./commandRunner.ts";
import type { ResolvedConfig } from "./config.ts";
import { setVerbose } from "./util.ts";
import { worktrees } from "./worktrees.ts";

const { remove } = worktrees;

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
  knownRepositories?: string[];
  repositories?: ResolvedConfig["workspace"]["repositories"];
}): ResolvedConfig {
  const knownRepositories = overrides.knownRepositories ?? ["repo-a"];
  return {
    sources: [],
    defaults: { hooks: {} },
    git: { remote: "origin", defaultBranch: "main" },
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
    logging: { file: "/tmp/groundcrew-test.log" },
  };
}

function makeUserInfo(username: string): ReturnType<typeof userInfo> {
  return { username, uid: 0, gid: 0, shell: null, homedir: "/tmp" };
}

function hasArguments(arguments_: readonly string[], ...needles: readonly string[]): boolean {
  return needles.every((needle) => arguments_.includes(needle));
}

function hasExcludePathspec(arguments_: readonly string[]): boolean {
  return arguments_.some((argument) => argument.startsWith(":(exclude"));
}

function isGitStatusCall(call: Parameters<RunCommandMock>): boolean {
  const [command, arguments_] = call;
  return command === "git" && arguments_.includes("status");
}

let projectDir: string;

function setupTempProjectDir(): void {
  beforeEach(() => {
    projectDir = mkdtempSync(path.join(tmpdir(), "groundcrew-worktrees-"));
    vi.stubEnv("XDG_STATE_HOME", path.join(projectDir, "state"));
    userInfoMock.mockReturnValue(makeUserInfo("dev"));
    runCommandMock.mockReturnValue("");
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    setVerbose(false);
    vi.clearAllMocks();
  });
}

describe(remove, () => {
  setupTempProjectDir();

  it("force-removes a native worktree whose only dirt is declared hook-generated", async () => {
    mkdirSync(path.join(projectDir, "repo-a"));
    mkdirSync(path.join(projectDir, "repo-a-team-1"));
    const config = makeConfig({
      projectDir,
      repositories: [
        {
          name: "repo-a",
          hookGeneratedPaths: [".rules/frontend/reactComponents.md", ".claude/settings.json"],
        },
      ],
    });

    runCommandMock.mockImplementation((_command, arguments_) => {
      // oxlint-disable-next-line vitest/no-conditional-in-test -- the unforced remove fails the way git does on a dirty tree; the forced retry succeeds.
      if (hasArguments(arguments_, "worktree", "remove") && !arguments_.includes("--force")) {
        throw new Error("Command failed: git worktree remove\nExit status: 128");
      }
      // oxlint-disable-next-line vitest/no-conditional-in-test -- the excluded probe reads clean; the unexcluded probe still reports the hook's output.
      if (hasArguments(arguments_, "status", "--porcelain") && hasExcludePathspec(arguments_)) {
        return "";
      }
      // oxlint-disable-next-line vitest/no-conditional-in-test -- as above
      if (hasArguments(arguments_, "status", "--porcelain")) {
        return " M .rules/frontend/reactComponents.md\n?? .claude/settings.json\n";
      }
      return "";
    });

    await remove(config, {
      repository: "repo-a",
      task: "team-1",
      branchName: "dev-team-1",
      dir: path.join(projectDir, "repo-a-team-1"),
      kind: "host",
    });

    expect(runCommandMock).toHaveBeenCalledWith(
      "git",
      expect.arrayContaining([
        "worktree",
        "remove",
        "--force",
        path.join(projectDir, "repo-a-team-1"),
      ]),
      expect.anything(),
    );
    expect(runCommandMock).toHaveBeenCalledWith("git", [
      "-C",
      path.join(projectDir, "repo-a"),
      "branch",
      "-D",
      "dev-team-1",
    ]);
  });

  it("passes the declared hook-generated paths to git as exclude pathspecs", async () => {
    mkdirSync(path.join(projectDir, "repo-a"));
    mkdirSync(path.join(projectDir, "repo-a-team-1"));
    const config = makeConfig({
      projectDir,
      repositories: [{ name: "repo-a", hookGeneratedPaths: [".claude/settings.json"] }],
    });

    runCommandMock.mockImplementation((_command, arguments_) => {
      // oxlint-disable-next-line vitest/no-conditional-in-test -- only the unforced remove fails, so the dirtiness probe runs.
      if (hasArguments(arguments_, "worktree", "remove") && !arguments_.includes("--force")) {
        throw new Error("Command failed: git worktree remove\nExit status: 128");
      }
      return "";
    });

    await remove(config, {
      repository: "repo-a",
      task: "team-1",
      branchName: "dev-team-1",
      dir: path.join(projectDir, "repo-a-team-1"),
      kind: "host",
    }).catch(() => null);

    expect(runCommandMock).toHaveBeenCalledWith(
      "git",
      expect.arrayContaining([
        "status",
        "--porcelain",
        "--",
        ".",
        ":(exclude,literal).claude/settings.json",
      ]),
      expect.anything(),
    );
  });

  it("still blocks teardown when the agent modified a tracked source file", async () => {
    mkdirSync(path.join(projectDir, "repo-a"));
    mkdirSync(path.join(projectDir, "repo-a-team-1"));
    const config = makeConfig({
      projectDir,
      repositories: [{ name: "repo-a", hookGeneratedPaths: [".claude/settings.json"] }],
    });

    runCommandMock.mockImplementation((_command, arguments_) => {
      // oxlint-disable-next-line vitest/no-conditional-in-test -- the unforced remove fails; the excluded probe still sees genuine agent work.
      if (hasArguments(arguments_, "worktree", "remove") && !arguments_.includes("--force")) {
        throw new Error("Command failed: git worktree remove\nExit status: 128");
      }
      // oxlint-disable-next-line vitest/no-conditional-in-test -- as above
      if (hasArguments(arguments_, "status", "--porcelain")) {
        return " M src/index.ts\n";
      }
      return "";
    });

    await expect(
      remove(config, {
        repository: "repo-a",
        task: "team-1",
        branchName: "dev-team-1",
        dir: path.join(projectDir, "repo-a-team-1"),
        kind: "host",
      }),
    ).rejects.toThrow(/1 modified file/);

    expect(runCommandMock).not.toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["worktree", "remove", "--force"]),
      expect.anything(),
    );
  });

  it("still blocks teardown when an undeclared untracked file survives the exclusions", async () => {
    mkdirSync(path.join(projectDir, "repo-a"));
    mkdirSync(path.join(projectDir, "repo-a-team-1"));
    const config = makeConfig({
      projectDir,
      repositories: [{ name: "repo-a", hookGeneratedPaths: [".agents/skills"] }],
    });

    runCommandMock.mockImplementation((_command, arguments_) => {
      // oxlint-disable-next-line vitest/no-conditional-in-test -- git collapses the untracked directory back into the excluded probe once an undeclared file lands under it.
      if (hasArguments(arguments_, "worktree", "remove") && !arguments_.includes("--force")) {
        throw new Error("Command failed: git worktree remove\nExit status: 128");
      }
      // oxlint-disable-next-line vitest/no-conditional-in-test -- as above
      if (hasArguments(arguments_, "status", "--porcelain")) {
        return "?? .agents/\n";
      }
      return "";
    });

    await expect(
      remove(config, {
        repository: "repo-a",
        task: "team-1",
        branchName: "dev-team-1",
        dir: path.join(projectDir, "repo-a-team-1"),
        kind: "host",
      }),
    ).rejects.toThrow(/crew cleanup --force team-1/);
  });

  it("leaves the git status command unchanged when no hook-generated paths are declared", async () => {
    mkdirSync(path.join(projectDir, "repo-a"));
    mkdirSync(path.join(projectDir, "repo-a-team-1"));
    const config = makeConfig({ projectDir });

    runCommandMock.mockImplementation((_command, arguments_) => {
      // oxlint-disable-next-line vitest/no-conditional-in-test -- the unforced remove fails so the probe runs; the tree really is dirty.
      if (hasArguments(arguments_, "worktree", "remove")) {
        throw new Error("Command failed: git worktree remove\nExit status: 128");
      }
      // oxlint-disable-next-line vitest/no-conditional-in-test -- as above
      if (hasArguments(arguments_, "status", "--porcelain")) {
        return " M src/index.ts\n";
      }
      return "";
    });

    await expect(
      remove(config, {
        repository: "repo-a",
        task: "team-1",
        branchName: "dev-team-1",
        dir: path.join(projectDir, "repo-a-team-1"),
        kind: "host",
      }),
    ).rejects.toThrow(/crew cleanup --force team-1/);

    const statusArguments = runCommandMock.mock.calls
      .filter(isGitStatusCall)
      .map(([, arguments_]) => arguments_);
    expect(statusArguments).toStrictEqual([
      ["-C", path.join(projectDir, "repo-a-team-1"), "status", "--porcelain"],
    ]);
  });

  it("rethrows the original git failure when the worktree is clean with and without exclusions", async () => {
    mkdirSync(path.join(projectDir, "repo-a"));
    mkdirSync(path.join(projectDir, "repo-a-team-1"));
    const config = makeConfig({
      projectDir,
      repositories: [{ name: "repo-a", hookGeneratedPaths: [".claude/settings.json"] }],
    });

    runCommandMock.mockImplementation((_command, arguments_) => {
      // oxlint-disable-next-line vitest/no-conditional-in-test -- removal fails for a reason git status cannot see (a locked worktree), so escalating to --force would be wrong.
      if (hasArguments(arguments_, "worktree", "remove")) {
        throw new Error("some unrelated failure");
      }
      return "";
    });

    await expect(
      remove(config, {
        repository: "repo-a",
        task: "team-1",
        branchName: "dev-team-1",
        dir: path.join(projectDir, "repo-a-team-1"),
        kind: "host",
      }),
    ).rejects.toThrow(/some unrelated failure/);

    expect(runCommandMock).not.toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["worktree", "remove", "--force"]),
      expect.anything(),
    );
  });

  it("runs the remove template for a scripted worktree whose only dirt is declared hook-generated", async () => {
    const worktreeDir = path.join(projectDir, "billing-team-220");
    mkdirSync(worktreeDir, { recursive: true });
    userInfoMock.mockReturnValue(makeUserInfo("paul"));
    const config = makeConfig({
      projectDir,
      knownRepositories: ["billing"],
      repositories: [
        {
          name: "billing",
          provision: { create: "graft new ${branch}", remove: "graft rm ${branch} -f" },
          hookGeneratedPaths: [".agents/skills"],
        },
      ],
    });

    // Clean excluded probe + successful remove template.
    runCommandMock.mockReturnValue("");

    await remove(config, {
      repository: "billing",
      task: "team-220",
      branchName: "paul-team-220",
      dir: worktreeDir,
      kind: "host",
    });

    expect(runCommandMock).toHaveBeenCalledWith(
      "sh",
      ["-c", "graft rm 'paul-team-220' -f"],
      expect.objectContaining({ cwd: projectDir, timeoutMs: 0 }),
    );
    expect(runCommandMock).toHaveBeenCalledWith(
      "git",
      expect.arrayContaining([
        "status",
        "--porcelain",
        "--",
        ".",
        ":(exclude,literal).agents/skills",
      ]),
      expect.anything(),
    );
  });

  it("still refuses a scripted worktree with dirt beyond the declared hook-generated paths", async () => {
    const worktreeDir = path.join(projectDir, "billing-team-220");
    mkdirSync(worktreeDir, { recursive: true });
    userInfoMock.mockReturnValue(makeUserInfo("paul"));
    const config = makeConfig({
      projectDir,
      knownRepositories: ["billing"],
      repositories: [
        {
          name: "billing",
          provision: { create: "graft new ${branch}", remove: "graft rm ${branch} -f" },
          hookGeneratedPaths: [".agents/skills"],
        },
      ],
    });

    runCommandMock.mockImplementation((command, arguments_) =>
      // oxlint-disable-next-line vitest/no-conditional-in-test -- the excluded probe still reports genuine agent work
      command === "git" && arguments_.includes("status") ? " M src/x.ts" : "",
    );

    await expect(
      remove(config, {
        repository: "billing",
        task: "team-220",
        branchName: "paul-team-220",
        dir: worktreeDir,
        kind: "host",
      }),
    ).rejects.toThrow(/crew cleanup --force team-220/);

    expect(runCommandMock).not.toHaveBeenCalledWith("sh", expect.anything(), expect.anything());
  });
});
