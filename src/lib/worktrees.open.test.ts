/* eslint-disable no-template-curly-in-string -- ${branch}-style placeholders appear as literal strings in RepoRecipe create/remove command templates; they're NOT JS template literals */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import type * as nodeOs from "node:os";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";

import type { RunCommandOptions } from "./commandRunner.ts";
import type { ResolvedConfig } from "./config.ts";
import { recordRunState } from "./runState.ts";
import { setVerbose } from "./util.ts";
import { worktrees } from "./worktrees.ts";

const { open, remove } = worktrees;

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
    local: { runner: "auto", networkEgress: "allowlisted", safehouse: { enable: [] } },
    logging: { file: "/tmp/groundcrew-test.log" },
  };
}

function hasArguments(arguments_: readonly string[], ...needles: readonly string[]): boolean {
  return needles.every((needle) => arguments_.includes(needle));
}

function expectNoForceDeleteBranchCommand(): void {
  const didForceDeleteBranch = runCommandMock.mock.calls.some(
    ([command, arguments_]) => command === "git" && hasArguments(arguments_, "branch", "-D"),
  );

  expect(didForceDeleteBranch).toBe(false);
}

let projectDir: string;

describe(open, () => {
  beforeEach(() => {
    projectDir = mkdtempSync(path.join(tmpdir(), "groundcrew-worktrees-open-"));
    userInfoMock.mockReturnValue({ username: "dev", uid: 0, gid: 0, shell: null, homedir: "/tmp" });
    runCommandMock.mockReturnValue("");
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    setVerbose(false);
    vi.clearAllMocks();
  });

  it("checks out an existing local branch without fetching", async () => {
    mkdirSync(path.join(projectDir, "repo-a"));
    const config = makeConfig({ projectDir });
    // show-ref succeeds (default mock returns ""), so the branch is local.

    const actual = await open(config, {
      repository: "repo-a",
      task: "pr-1234",
      branch: "feature/auth",
    });

    expect(runCommandMock).toHaveBeenCalledWith(
      "git",
      [
        "-C",
        path.join(projectDir, "repo-a"),
        "show-ref",
        "--verify",
        "--quiet",
        "refs/heads/feature/auth",
      ],
      {},
    );
    expect(runCommandMock).toHaveBeenCalledWith(
      "git",
      [
        "-C",
        path.join(projectDir, "repo-a"),
        "worktree",
        "add",
        path.join(projectDir, "repo-a-pr-1234"),
        "feature/auth",
      ],
      { stdio: "captured", timeoutMs: 0 },
    );
    expect(runCommandMock).not.toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["fetch"]),
      expect.anything(),
    );
    expect(actual).toMatchObject({
      repository: "repo-a",
      task: "pr-1234",
      branchName: "feature/auth",
      dir: path.join(projectDir, "repo-a-pr-1234"),
      kind: "host",
      adoptedBranch: true,
    });
  });

  it("never force-deletes the adopted branch when its worktree is removed", async () => {
    mkdirSync(path.join(projectDir, "repo-a"));
    const config = makeConfig({ projectDir });

    const entry = await open(config, {
      repository: "repo-a",
      task: "pr-1234",
      branch: "feature/auth",
    });
    mkdirSync(entry.dir);
    runCommandMock.mockClear();

    await remove(config, entry, { force: true });

    expect(runCommandMock).toHaveBeenCalledWith(
      "git",
      ["-C", path.join(projectDir, "repo-a"), "worktree", "remove", "--force", entry.dir],
      { stdio: "captured", timeoutMs: 0 },
    );
    expectNoForceDeleteBranchCommand();
  });

  it("never force-deletes a rediscovered adopted branch recorded in run state", async () => {
    mkdirSync(path.join(projectDir, "repo-a"));
    const worktreeDir = path.join(projectDir, "repo-a-pr-1234");
    mkdirSync(worktreeDir);
    const config = {
      ...makeConfig({ projectDir }),
      logging: { file: path.join(projectDir, "groundcrew.log") },
    };
    recordRunState({
      config,
      state: {
        task: "pr-1234",
        repository: "repo-a",
        agent: "claude",
        worktreeDir,
        branchName: "feature/auth",
        workspaceName: "pr-1234",
        state: "running",
        adoptedBranch: true,
      },
    });

    await remove(
      config,
      {
        repository: "repo-a",
        task: "pr-1234",
        branchName: "dev-pr-1234",
        dir: worktreeDir,
        kind: "host",
      },
      { force: true },
    );

    expect(runCommandMock).toHaveBeenCalledWith(
      "git",
      ["-C", path.join(projectDir, "repo-a"), "worktree", "remove", "--force", worktreeDir],
      { stdio: "captured", timeoutMs: 0 },
    );
    expectNoForceDeleteBranchCommand();
  });

  it("fetches the remote branch and creates a tracking branch when not local", async () => {
    mkdirSync(path.join(projectDir, "repo-a"));
    const config = makeConfig({ projectDir });
    runCommandMock.mockImplementation((_command, arguments_) => {
      // oxlint-disable-next-line vitest/no-conditional-in-test -- the show-ref probe exits non-zero when the branch is not local
      if (hasArguments(arguments_, "show-ref", "--verify")) {
        throw new Error("not a local branch");
      }
      return "";
    });

    const actual = await open(config, {
      repository: "repo-a",
      task: "pr-1234",
      branch: "feature/auth",
    });

    expect(runCommandMock).toHaveBeenCalledWith(
      "git",
      ["-C", path.join(projectDir, "repo-a"), "fetch", "origin", "feature/auth"],
      { stdio: "captured", timeoutMs: 0 },
    );
    expect(runCommandMock).toHaveBeenCalledWith(
      "git",
      [
        "-C",
        path.join(projectDir, "repo-a"),
        "worktree",
        "add",
        "--track",
        "-b",
        "feature/auth",
        path.join(projectDir, "repo-a-pr-1234"),
        "origin/feature/auth",
      ],
      { stdio: "captured", timeoutMs: 0 },
    );
    expect(actual.branchName).toBe("feature/auth");
  });

  it("rethrows the show-ref probe failure after the abort signal fires", async () => {
    mkdirSync(path.join(projectDir, "repo-a"));
    const config = makeConfig({ projectDir });
    const controller = new AbortController();
    controller.abort();
    runCommandMock.mockImplementation((_command, arguments_) => {
      // oxlint-disable-next-line vitest/no-conditional-in-test -- the show-ref probe throws while the signal is aborted
      if (hasArguments(arguments_, "show-ref", "--verify")) {
        throw new Error("aborted probe");
      }
      return "";
    });

    await expect(
      open(
        config,
        { repository: "repo-a", task: "pr-1234", branch: "feature/auth" },
        controller.signal,
      ),
    ).rejects.toThrow("aborted probe");
  });

  it("rejects when a worktree already exists for the task", async () => {
    mkdirSync(path.join(projectDir, "repo-a"));
    mkdirSync(path.join(projectDir, "repo-a-pr-1234"));
    const config = makeConfig({ projectDir });

    await expect(
      open(config, { repository: "repo-a", task: "pr-1234", branch: "feature/auth" }),
    ).rejects.toThrow(/already exists/);
  });

  it("rejects provision/sparse-checkout repositories", async () => {
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
      open(config, { repository: "billing", task: "pr-1234", branch: "feature/auth" }),
    ).rejects.toThrow(/does not support provision/);
  });
});
