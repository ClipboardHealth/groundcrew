/* eslint-disable no-template-curly-in-string -- ${branch}-style placeholders appear as literal strings in RepoRecipe create/remove command templates; they're NOT JS template literals */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type * as nodeOs from "node:os";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";

import type { RunCommandOptions } from "./commandRunner.ts";
import type { ResolvedConfig } from "./config.ts";
import { setVerbose } from "./util.ts";
import { worktrees } from "./worktrees.ts";

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
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test mock intentionally shares one recorder across sync and async command APIs.
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
  worktreeDir?: string;
  git?: ResolvedConfig["git"];
  knownRepositories?: string[];
  repositoryDirs?: Record<string, string>;
  agents?: ResolvedConfig["agents"]["definitions"];
  repositories?: ResolvedConfig["workspace"]["repositories"];
}): ResolvedConfig {
  const knownRepositories = overrides.knownRepositories ?? ["repo-a"];
  const agents = overrides.agents ?? {
    claude: { cmd: "claude", color: "#fff" },
  };
  return {
    sources: [],
    defaults: { hooks: {} },
    git: overrides.git ?? { remote: "origin", defaultBranch: "main" },
    workspace: {
      projectDir: overrides.projectDir,
      ...(overrides.worktreeDir === undefined ? {} : { worktreeDir: overrides.worktreeDir }),
      knownRepositories,
      repositories: overrides.repositories ?? knownRepositories.map((name) => ({ name })),
      ...(overrides.repositoryDirs === undefined
        ? {}
        : { repositoryDirs: overrides.repositoryDirs }),
    },
    orchestrator: {
      maximumInProgress: 4,
      pollIntervalMilliseconds: 1000,
      sessionLimitPercentage: 85,
    },
    agents: { default: "claude", definitions: agents },
    prompts: { initial: "x" },
    workspaceKind: "auto",
    local: { runner: "auto", networkEgress: "allowlisted" },
    logging: { file: "/tmp/groundcrew-test.log" },
  };
}

function makeUserInfo(username: string): ReturnType<typeof userInfo> {
  return { username, uid: 0, gid: 0, shell: null, homedir: "/tmp" };
}

function makeBillingWorkdirConfig(projectDir: string): ResolvedConfig {
  return makeConfig({
    projectDir,
    knownRepositories: ["billing"],
    repositories: [
      {
        name: "billing",
        provision: { create: "create ${dir}", remove: "remove ${dir}" },
        workdir: "services/api",
      },
    ],
  });
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

describe(create, () => {
  setupTempProjectDir();

  it("probes origin/HEAD, then fetches and worktree-adds the auto-detected default branch", async () => {
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

    const actual = await create(config, {
      repository: "repo-a",
      task: "team-1",
    });

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
    expect(actual.kind).toBe("host");
    expect(actual.dir).toBe(path.join(projectDir, "repo-a-team-1"));
  });

  it("reuses an existing branch by attaching it to a new worktree instead of recreating it", async () => {
    mkdirSync(path.join(projectDir, "repo-a"));
    const config = makeConfig({ projectDir });
    // show-ref succeeds (default mock returns ""), so dev-team-1 is already a
    // local branch — left behind by a prior run whose worktree dir was removed.

    const actual = await create(config, {
      repository: "repo-a",
      task: "team-1",
    });

    expect(runCommandMock).toHaveBeenCalledWith(
      "git",
      [
        "-C",
        path.join(projectDir, "repo-a"),
        "show-ref",
        "--verify",
        "--quiet",
        "refs/heads/dev-team-1",
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
        path.join(projectDir, "repo-a-team-1"),
        "dev-team-1",
      ],
      { stdio: "captured", timeoutMs: 0 },
    );
    // The lingering branch already carries the prior work, so reuse must skip the
    // fresh-branch seeding (default-branch probe + fetch) and never pass -b.
    expect(runCommandMock).not.toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["fetch"]),
      expect.anything(),
    );
    expect(runCommandMock).not.toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["symbolic-ref"]),
      expect.anything(),
    );
    expect(actual).toMatchObject({
      repository: "repo-a",
      task: "team-1",
      branchName: "dev-team-1",
      dir: path.join(projectDir, "repo-a-team-1"),
      kind: "host",
    });
    // The reused branch is still groundcrew's own <prefix>-<task> branch, so it
    // is not adopted — teardown may delete it as usual.
    expect(actual.adoptedBranch).toBeUndefined();
  });

  it("creates worktrees for multi-segment source task ids", async () => {
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

    const actual = await create(config, {
      repository: "repo-a",
      task: "gc-20260608-001",
    });

    expect(runCommandMock).toHaveBeenCalledWith(
      "git",
      [
        "-C",
        path.join(projectDir, "repo-a"),
        "worktree",
        "add",
        "-b",
        "dev-gc-20260608-001",
        path.join(projectDir, "repo-a-gc-20260608-001"),
        "origin/main",
      ],
      { stdio: "captured", timeoutMs: 0 },
    );
    expect(actual).toMatchObject({
      repository: "repo-a",
      task: "gc-20260608-001",
      branchName: "dev-gc-20260608-001",
      dir: path.join(projectDir, "repo-a-gc-20260608-001"),
      kind: "host",
    });
  });

  it("creates worktrees for single-segment todo-txt task ids", async () => {
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

    const actual = await create(config, {
      repository: "repo-a",
      task: "rrr",
    });

    expect(runCommandMock).toHaveBeenCalledWith(
      "git",
      [
        "-C",
        path.join(projectDir, "repo-a"),
        "worktree",
        "add",
        "-b",
        "dev-rrr",
        path.join(projectDir, "repo-a-rrr"),
        "origin/main",
      ],
      { stdio: "captured", timeoutMs: 0 },
    );
    expect(actual).toMatchObject({
      repository: "repo-a",
      task: "rrr",
      branchName: "dev-rrr",
      dir: path.join(projectDir, "repo-a-rrr"),
      kind: "host",
    });
  });

  it("streams git output (stdio inherit) under verbose", async () => {
    mkdirSync(path.join(projectDir, "repo-a"));
    const config = makeConfig({ projectDir });
    runCommandMock.mockImplementation((_command, arguments_) => {
      throwWhenProbingBranch(arguments_);
      // oxlint-disable-next-line vitest/no-conditional-in-test -- discriminator reports an origin/main-backed repo
      if (hasArguments(arguments_, "symbolic-ref", "refs/remotes/origin/HEAD")) {
        return "origin/main\n";
      }
      return "";
    });
    setVerbose(true);

    await create(config, { repository: "repo-a", task: "team-1" });

    expect(runCommandMock).toHaveBeenCalledWith(
      "git",
      ["-C", path.join(projectDir, "repo-a"), "fetch", "origin", "main"],
      { stdio: "inherit", timeoutMs: 0 },
    );
  });

  it("uses the per-repo default branch reported by origin/HEAD (e.g. master)", async () => {
    mkdirSync(path.join(projectDir, "repo-a"));
    const config = makeConfig({ projectDir });
    runCommandMock.mockImplementation((_command, arguments_) => {
      throwWhenProbingBranch(arguments_);
      // oxlint-disable-next-line vitest/no-conditional-in-test -- discriminator picks out the symbolic-ref probe so it reports a master-backed repo
      if (hasArguments(arguments_, "symbolic-ref", "refs/remotes/origin/HEAD")) {
        return "origin/master\n";
      }
      return "";
    });

    await create(config, {
      repository: "repo-a",
      task: "team-1",
    });

    expect(runCommandMock).toHaveBeenCalledWith(
      "git",
      ["-C", path.join(projectDir, "repo-a"), "fetch", "origin", "master"],
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
        "origin/master",
      ],
      { stdio: "captured", timeoutMs: 0 },
    );
  });

  it("falls back to config.git.defaultBranch when origin/HEAD is not set", async () => {
    mkdirSync(path.join(projectDir, "repo-a"));
    const config = makeConfig({
      projectDir,
      git: { remote: "origin", defaultBranch: "trunk" },
    });
    runCommandMock.mockImplementation((_command, arguments_) => {
      throwWhenProbingBranch(arguments_);
      // oxlint-disable-next-line vitest/no-conditional-in-test -- mirrors `git symbolic-ref` exit status 1 when refs/remotes/origin/HEAD is unset
      if (hasArguments(arguments_, "symbolic-ref", "refs/remotes/origin/HEAD")) {
        throw new Error(
          "Command failed: git symbolic-ref --short refs/remotes/origin/HEAD\nExit status: 1",
        );
      }
      return "";
    });

    await create(config, {
      repository: "repo-a",
      task: "team-1",
    });

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
      ["-C", path.join(projectDir, "repo-a"), "fetch", "origin", "trunk"],
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
        "origin/trunk",
      ],
      { stdio: "captured", timeoutMs: 0 },
    );
  });

  it("rejects when a host worktree already exists for the same task", async () => {
    mkdirSync(path.join(projectDir, "repo-a"));
    mkdirSync(path.join(projectDir, "repo-a-team-1"));
    const config = makeConfig({ projectDir });

    await expect(
      create(config, {
        repository: "repo-a",
        task: "team-1",
      }),
    ).rejects.toThrow(/already exists/);
  });

  it("rejects unknown repositories", async () => {
    const config = makeConfig({ projectDir });

    await expect(
      create(config, {
        repository: "ghost",
        task: "team-1",
      }),
    ).rejects.toThrow(/not in workspace.knownRepositories/);
  });

  it("throws when the repository directory does not exist", async () => {
    const config = makeConfig({ projectDir });

    await expect(
      create(config, {
        repository: "repo-a",
        task: "team-1",
      }),
    ).rejects.toThrow(/Repository not found/);
  });

  it.each([
    ["empty string", ""],
    ["bare dot", "."],
    ["double dot", ".."],
    ["forward slash", "team/123"],
    ["backslash", String.raw`team\123`],
    ["embedded ..", "team-..-123"],
    ["traversal segment", `..${path.sep}evil`],
    ["wrong shape — uppercase", "TEAM-123"],
    ["wrong shape — trailing whitespace", "team-123 "],
    ["wrong shape — leading hyphen", "-rrr"],
    ["wrong shape — trailing hyphen", "rrr-"],
  ])("rejects invalid task %s", async (_label, task) => {
    mkdirSync(path.join(projectDir, "repo-a"));
    const config = makeConfig({ projectDir });

    await expect(
      create(config, {
        repository: "repo-a",
        task,
      }),
    ).rejects.toThrow(/must be a plain task id/);
  });

  it("throws when the OS username is empty", async () => {
    mkdirSync(path.join(projectDir, "repo-a"));
    userInfoMock.mockReturnValue(makeUserInfo(""));
    const config = makeConfig({ projectDir });

    await expect(
      create(config, {
        repository: "repo-a",
        task: "team-1",
      }),
    ).rejects.toThrow(/Could not determine OS username/);
  });

  it("create runs the create template via sh and skips git fetch/worktree add", async () => {
    userInfoMock.mockReturnValue(makeUserInfo("paul"));
    runCommandMock.mockReturnValue("");

    const config = makeConfig({
      projectDir,
      knownRepositories: ["billing"],
      repositories: [
        {
          name: "billing",
          provision: {
            create: "graft new ${branch} billing --from ${baseRef} --dir ${dir}",
            remove: "graft rm ${branch} -f",
          },
        },
      ],
    });
    const controller = new AbortController();

    const entry = await create(
      config,
      { repository: "billing", task: "team-220" },
      controller.signal,
    );

    expect(entry.dir).toBe(path.join(projectDir, "billing-team-220"));
    expect(entry.branchName).toBe("paul-team-220");

    // No git fetch / worktree add — only the sh -c template, with the abort
    // signal forwarded.
    const commands = runCommandMock.mock.calls.map((call) => call[0]);
    expect(commands).not.toContain("git");
    expect(runCommandMock).toHaveBeenCalledWith(
      "sh",
      [
        "-c",
        `graft new 'paul-team-220' billing --from 'origin/main' --dir '${path.join(projectDir, "billing-team-220")}'`,
      ],
      expect.objectContaining({ cwd: projectDir, timeoutMs: 0, signal: controller.signal }),
    );
  });

  it("streams create template output (stdio inherit) under verbose", async () => {
    userInfoMock.mockReturnValue(makeUserInfo("paul"));
    runCommandMock.mockReturnValue("");
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
    setVerbose(true);

    await create(config, { repository: "billing", task: "team-220" });

    expect(runCommandMock).toHaveBeenCalledWith(
      "sh",
      ["-c", "graft new 'paul-team-220'"],
      expect.objectContaining({ cwd: projectDir, stdio: "inherit", timeoutMs: 0 }),
    );
  });

  it("removes the worktree when the configured workdir is missing after create", async () => {
    runCommandMock.mockReturnValue("");
    const worktreeDir = path.join(projectDir, "billing-team-220");
    const config = makeBillingWorkdirConfig(projectDir);

    await expect(create(config, { repository: "billing", task: "team-220" })).rejects.toThrow(
      /workdir "services\/api" not found/,
    );
    expect(runCommandMock.mock.calls.map((call) => call[1][1])).toContain(
      `remove '${worktreeDir}'`,
    );
  });

  it("returns the entry when the configured workdir exists after create", async () => {
    const config = makeConfig({
      projectDir,
      knownRepositories: ["billing"],
      repositories: [
        { name: "billing", provision: { create: "true", remove: "true" }, workdir: "services/api" },
      ],
    });
    // The create template materializes the subproject as it runs (after the
    // worktree-already-exists scan, before the workdir-present assertion).
    runCommandMock.mockImplementation(() => {
      mkdirSync(path.join(projectDir, "billing-team-220", "services", "api"), { recursive: true });
      return "";
    });

    const entry = await create(config, { repository: "billing", task: "team-220" });

    expect(entry.dir).toBe(path.join(projectDir, "billing-team-220"));
  });

  it("removes the worktree when the configured workdir is a file after create", async () => {
    const worktreeDir = path.join(projectDir, "billing-team-220");
    const config = makeBillingWorkdirConfig(projectDir);
    runCommandMock
      .mockImplementationOnce(() => {
        mkdirSync(path.join(worktreeDir, "services"), { recursive: true });
        writeFileSync(path.join(worktreeDir, "services", "api"), "");
        return "";
      })
      .mockReturnValue("");

    await expect(create(config, { repository: "billing", task: "team-220" })).rejects.toThrow(
      /workdir "services\/api" not found/,
    );
    expect(runCommandMock.mock.calls.map((call) => call[1][1])).toContain(
      `remove '${worktreeDir}'`,
    );
  });
});
