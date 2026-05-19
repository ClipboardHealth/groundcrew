import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type * as nodeOs from "node:os";
import { tmpdir, userInfo } from "node:os";
import { join, sep } from "node:path";

import { probeError } from "../testHelpers/workspaceProbe.ts";
import type { RunCommandOptions } from "./commandRunner.ts";
import type { ResolvedConfig } from "./config.ts";
import { workspaces } from "./workspaces.ts";
import { type WorktreeEntry, worktrees } from "./worktrees.ts";

const { create, findByTicket, list, remove, teardown } = worktrees;

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
vi.mock(import("./workspaces.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    workspaces: {
      open: vi.fn<typeof actual.workspaces.open>(),
      probe: vi.fn<typeof actual.workspaces.probe>(),
      close: vi.fn<typeof actual.workspaces.close>(),
      accessHint: vi.fn<typeof actual.workspaces.accessHint>(),
    },
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
  models?: ResolvedConfig["models"]["definitions"];
}): ResolvedConfig {
  const knownRepositories = overrides.knownRepositories ?? ["repo-a"];
  const models = overrides.models ?? {
    claude: { cmd: "claude", color: "#fff" },
  };
  return {
    linear: {
      projectSlug: "x-aaaaaaaaaaaa",
      slugId: "aaaaaaaaaaaa",
      statuses: {
        todo: "Todo",
        inProgress: "In Progress",
        done: "Done",
        terminal: ["Done"],
      },
    },
    git: overrides.git ?? { remote: "origin", defaultBranch: "main" },
    workspace: {
      projectDir: overrides.projectDir,
      knownRepositories,
    },
    orchestrator: {
      maximumInProgress: 4,
      pollIntervalMilliseconds: 1000,
      sessionLimitPercentage: 85,
    },
    models: { default: "claude", definitions: models },
    prompts: { initial: "x" },
    workspaceKind: "auto",
    local: { runner: "auto" },
    logging: { file: "/tmp/groundcrew-test.log" },
  };
}

function makeUserInfo(username: string): ReturnType<typeof userInfo> {
  return { username, uid: 0, gid: 0, shell: null, homedir: "/tmp" };
}

function hasArguments(arguments_: readonly string[], ...needles: readonly string[]): boolean {
  return needles.every((needle) => arguments_.includes(needle));
}

let projectDir: string;

function setupTempProjectDir(): void {
  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "groundcrew-worktrees-"));
    vi.stubEnv("XDG_STATE_HOME", join(projectDir, "state"));
    userInfoMock.mockReturnValue(makeUserInfo("rocky"));
    runCommandMock.mockReturnValue("");
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });
}

describe(list, () => {
  setupTempProjectDir();

  it("returns an empty list when the project directory is empty", () => {
    const config = makeConfig({ projectDir });

    expect(list(config)).toStrictEqual([]);
  });

  it("returns an empty list when the project directory cannot be read", () => {
    const config = makeConfig({
      projectDir: join(projectDir, "does-not-exist"),
    });

    expect(list(config)).toStrictEqual([]);
  });

  it("ignores non-directory entries in the project root", () => {
    writeFileSync(join(projectDir, "stray-file"), "");
    mkdirSync(join(projectDir, "repo-a-team-1"));
    const config = makeConfig({ projectDir });

    const actual = list(config);

    expect(actual.map((entry) => entry.dir)).toStrictEqual([join(projectDir, "repo-a-team-1")]);
  });

  it("finds host sibling worktrees by their <repo>-<ticket> naming", () => {
    mkdirSync(join(projectDir, "repo-a"));
    mkdirSync(join(projectDir, "repo-a-team-1"));
    const config = makeConfig({ projectDir });

    expect(list(config)).toStrictEqual([
      {
        repository: "repo-a",
        ticket: "team-1",
        branchName: "rocky-team-1",
        dir: join(projectDir, "repo-a-team-1"),
        kind: "host",
      },
    ]);
  });

  it("ignores host directories whose <repo> segment is not configured", () => {
    mkdirSync(join(projectDir, "ghost-team-1"));
    const config = makeConfig({ projectDir });

    expect(list(config)).toStrictEqual([]);
  });

  it("finds nested host worktrees when knownRepositories contains <owner>/<repo>", () => {
    // `resolve(projectDir, "owner/repo-team-1")` produces a path one level
    // deeper than `projectDir`, so the worktree lives at
    // `projectDir/owner/repo-team-1`. list() has to scan the parent dir,
    // not the project root, to find it.
    mkdirSync(join(projectDir, "owner", "repo"), { recursive: true });
    mkdirSync(join(projectDir, "owner", "repo-team-1"));
    const config = makeConfig({
      projectDir,
      knownRepositories: ["owner/repo"],
    });

    expect(list(config)).toStrictEqual([
      {
        repository: "owner/repo",
        ticket: "team-1",
        branchName: "rocky-team-1",
        dir: join(projectDir, "owner", "repo-team-1"),
        kind: "host",
      },
    ]);
  });

  it("disambiguates same-basename repos across owners by parent dir", () => {
    // Two owners with a same-named repo. The worktree at
    // owner1/repo-team-1 must resolve to owner1/repo, not owner2/repo.
    mkdirSync(join(projectDir, "owner1", "repo-team-1"), { recursive: true });
    mkdirSync(join(projectDir, "owner2", "repo-team-2"), { recursive: true });
    const config = makeConfig({
      projectDir,
      knownRepositories: ["owner1/repo", "owner2/repo"],
    });

    expect(list(config).toSorted((a, b) => a.ticket.localeCompare(b.ticket))).toStrictEqual([
      {
        repository: "owner1/repo",
        ticket: "team-1",
        branchName: "rocky-team-1",
        dir: join(projectDir, "owner1", "repo-team-1"),
        kind: "host",
      },
      {
        repository: "owner2/repo",
        ticket: "team-2",
        branchName: "rocky-team-2",
        dir: join(projectDir, "owner2", "repo-team-2"),
        kind: "host",
      },
    ]);
  });

  it("ignores legacy .sbx worktree directories", () => {
    const repoDir = join(projectDir, "repo-a");
    const sandboxRoot = join(repoDir, ".sbx", "groundcrew-repo-a-claude-worktrees");
    mkdirSync(sandboxRoot, { recursive: true });
    mkdirSync(join(sandboxRoot, "rocky-team-1"));
    const config = makeConfig({ projectDir });

    expect(list(config)).toStrictEqual([]);
  });
});

describe(findByTicket, () => {
  setupTempProjectDir();

  it("returns every host entry matching the ticket regardless of repo", () => {
    mkdirSync(join(projectDir, "repo-a-team-1"));
    mkdirSync(join(projectDir, "repo-b-team-1"));
    const config = makeConfig({
      projectDir,
      knownRepositories: ["repo-a", "repo-b"],
    });

    const actual = findByTicket(config, "team-1");

    expect(actual).toHaveLength(2);
  });

  it("returns an empty array when the ticket has no worktree", () => {
    const config = makeConfig({ projectDir });

    expect(findByTicket(config, "team-99")).toStrictEqual([]);
  });
});

describe(create, () => {
  setupTempProjectDir();

  it("fetches origin/main then runs git worktree add for the host strategy", async () => {
    mkdirSync(join(projectDir, "repo-a"));
    const config = makeConfig({ projectDir });

    const actual = await create(config, {
      repository: "repo-a",
      ticket: "team-1",
    });

    expect(runCommandMock).toHaveBeenCalledWith(
      "git",
      ["-C", join(projectDir, "repo-a"), "fetch", "origin", "main"],
      { stdio: "inherit", timeoutMs: 0 },
    );
    expect(runCommandMock).toHaveBeenCalledWith(
      "git",
      [
        "-C",
        join(projectDir, "repo-a"),
        "worktree",
        "add",
        "-b",
        "rocky-team-1",
        join(projectDir, "repo-a-team-1"),
        "origin/main",
      ],
      { stdio: "inherit", timeoutMs: 0 },
    );
    expect(actual.kind).toBe("host");
    expect(actual.dir).toBe(join(projectDir, "repo-a-team-1"));
  });

  it("rejects when a host worktree already exists for the same ticket", async () => {
    mkdirSync(join(projectDir, "repo-a"));
    mkdirSync(join(projectDir, "repo-a-team-1"));
    const config = makeConfig({ projectDir });

    await expect(
      create(config, {
        repository: "repo-a",
        ticket: "team-1",
      }),
    ).rejects.toThrow(/already exists/);
  });

  it("rejects unknown repositories", async () => {
    const config = makeConfig({ projectDir });

    await expect(
      create(config, {
        repository: "ghost",
        ticket: "team-1",
      }),
    ).rejects.toThrow(/not in workspace.knownRepositories/);
  });

  it("throws when the repository directory does not exist", async () => {
    const config = makeConfig({ projectDir });

    await expect(
      create(config, {
        repository: "repo-a",
        ticket: "team-1",
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
    ["traversal segment", `..${sep}evil`],
    ["wrong shape — no digits", "team-abc"],
    ["wrong shape — uppercase", "TEAM-123"],
    ["wrong shape — trailing whitespace", "team-123 "],
    ["wrong shape — plain word", "foo"],
  ])("rejects invalid ticket %s", async (_label, ticket) => {
    mkdirSync(join(projectDir, "repo-a"));
    const config = makeConfig({ projectDir });

    await expect(
      create(config, {
        repository: "repo-a",
        ticket,
      }),
    ).rejects.toThrow(/must be a plain ticket id/);
  });

  it("throws when the OS username is empty", async () => {
    mkdirSync(join(projectDir, "repo-a"));
    userInfoMock.mockReturnValue(makeUserInfo(""));
    const config = makeConfig({ projectDir });

    await expect(
      create(config, {
        repository: "repo-a",
        ticket: "team-1",
      }),
    ).rejects.toThrow(/Could not determine OS username/);
  });
});

describe(remove, () => {
  setupTempProjectDir();

  it("runs git worktree remove for a host entry whose dir exists", async () => {
    mkdirSync(join(projectDir, "repo-a"));
    mkdirSync(join(projectDir, "repo-a-team-1"));
    const config = makeConfig({ projectDir });

    await remove(config, {
      repository: "repo-a",
      ticket: "team-1",
      branchName: "rocky-team-1",
      dir: join(projectDir, "repo-a-team-1"),
      kind: "host",
    });

    expect(runCommandMock).toHaveBeenCalledWith(
      "git",
      ["-C", join(projectDir, "repo-a"), "worktree", "remove", join(projectDir, "repo-a-team-1")],
      { stdio: "inherit", timeoutMs: 0 },
    );
    expect(runCommandMock).toHaveBeenCalledWith("git", [
      "-C",
      join(projectDir, "repo-a"),
      "branch",
      "-D",
      "rocky-team-1",
    ]);
  });

  it("passes --force when force is set on a host entry", async () => {
    mkdirSync(join(projectDir, "repo-a"));
    mkdirSync(join(projectDir, "repo-a-team-1"));
    const config = makeConfig({ projectDir });

    await remove(
      config,
      {
        repository: "repo-a",
        ticket: "team-1",
        branchName: "rocky-team-1",
        dir: join(projectDir, "repo-a-team-1"),
        kind: "host",
      },
      { force: true },
    );

    expect(runCommandMock).toHaveBeenCalledWith(
      "git",
      [
        "-C",
        join(projectDir, "repo-a"),
        "worktree",
        "remove",
        "--force",
        join(projectDir, "repo-a-team-1"),
      ],
      { stdio: "inherit", timeoutMs: 0 },
    );
  });

  it("prunes when a host entry's directory is missing", async () => {
    mkdirSync(join(projectDir, "repo-a"));
    const config = makeConfig({ projectDir });

    await remove(config, {
      repository: "repo-a",
      ticket: "team-1",
      branchName: "rocky-team-1",
      dir: join(projectDir, "repo-a-team-1"),
      kind: "host",
    });

    expect(runCommandMock).toHaveBeenCalledWith(
      "git",
      ["-C", join(projectDir, "repo-a"), "worktree", "prune"],
      { stdio: "inherit", timeoutMs: 0 },
    );
    expect(runCommandMock).not.toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["worktree", "remove"]),
      expect.anything(),
    );
  });

  it("does not throw when host branch deletion fails", async () => {
    mkdirSync(join(projectDir, "repo-a"));
    mkdirSync(join(projectDir, "repo-a-team-1"));
    const config = makeConfig({ projectDir });
    runCommandMock.mockImplementation((_cmd, arguments_) => {
      // oxlint-disable-next-line jest/no-conditional-in-test -- discriminator selects the branch-D call to fail; mirrors the real branch-D failure shape
      const includesBranchDelete = Array.isArray(arguments_) && arguments_.includes("-D");
      // oxlint-disable-next-line jest/no-conditional-in-test -- as above
      if (includesBranchDelete) {
        throw new Error("branch missing");
      }
      return "";
    });

    const callRemove = async (): Promise<void> => {
      await remove(config, {
        repository: "repo-a",
        ticket: "team-1",
        branchName: "rocky-team-1",
        dir: join(projectDir, "repo-a-team-1"),
        kind: "host",
      });
    };

    await expect(callRemove()).resolves.toBeUndefined();
  });

  it("wraps the error with a dirtiness explanation and --force hint when the worktree has modifications", async () => {
    mkdirSync(join(projectDir, "repo-a"));
    mkdirSync(join(projectDir, "repo-a-team-1"));
    const config = makeConfig({ projectDir });

    runCommandMock.mockImplementation((_command, arguments_) => {
      // oxlint-disable-next-line vitest/no-conditional-in-test -- discriminator selects the worktree-remove call to fail; status --porcelain reports a dirty tree.
      if (hasArguments(arguments_, "worktree", "remove")) {
        throw new Error("Command failed: git worktree remove\nExit status: 128");
      }
      // oxlint-disable-next-line vitest/no-conditional-in-test -- as above
      if (hasArguments(arguments_, "status", "--porcelain")) {
        return " M src/foo.ts\nM  src/bar.ts\n?? src/new.ts\n?? src/other.ts\n";
      }
      return "";
    });

    const callRemove = async (): Promise<void> => {
      await remove(config, {
        repository: "repo-a",
        ticket: "team-1",
        branchName: "rocky-team-1",
        dir: join(projectDir, "repo-a-team-1"),
        kind: "host",
      });
    };

    await expect(callRemove()).rejects.toThrow(/2 modified files and 2 untracked files/);
    await expect(callRemove()).rejects.toThrow(/crew cleanup --force team-1/);
    await expect(callRemove()).rejects.toThrow(
      new RegExp(
        `commit/stash in ${join(projectDir, "repo-a-team-1").replaceAll("/", String.raw`\/`)}`,
      ),
    );
  });

  it("uses singular wording when exactly one modified file is dirty", async () => {
    mkdirSync(join(projectDir, "repo-a"));
    mkdirSync(join(projectDir, "repo-a-team-1"));
    const config = makeConfig({ projectDir });

    runCommandMock.mockImplementation((_command, arguments_) => {
      // oxlint-disable-next-line vitest/no-conditional-in-test -- single modified file produces singular "modified file"/"it" wording.
      if (hasArguments(arguments_, "worktree", "remove")) {
        throw new Error("remove failed");
      }
      // oxlint-disable-next-line vitest/no-conditional-in-test -- as above
      if (hasArguments(arguments_, "status", "--porcelain")) {
        return " M src/foo.ts\n";
      }
      return "";
    });

    const callRemove = async (): Promise<void> => {
      await remove(config, {
        repository: "repo-a",
        ticket: "team-1",
        branchName: "rocky-team-1",
        dir: join(projectDir, "repo-a-team-1"),
        kind: "host",
      });
    };

    await expect(callRemove()).rejects.toThrow(/worktree has 1 modified file\./);
    await expect(callRemove()).rejects.toThrow(/to discard it/);
    await expect(callRemove()).rejects.not.toThrow(/untracked/);
  });

  it("uses singular wording when exactly one untracked file is dirty", async () => {
    mkdirSync(join(projectDir, "repo-a"));
    mkdirSync(join(projectDir, "repo-a-team-1"));
    const config = makeConfig({ projectDir });

    runCommandMock.mockImplementation((_command, arguments_) => {
      // oxlint-disable-next-line vitest/no-conditional-in-test -- single untracked file produces singular "untracked file"/"it" wording.
      if (hasArguments(arguments_, "worktree", "remove")) {
        throw new Error("remove failed");
      }
      // oxlint-disable-next-line vitest/no-conditional-in-test -- as above
      if (hasArguments(arguments_, "status", "--porcelain")) {
        return "?? src/new.ts\n";
      }
      return "";
    });

    const callRemove = async (): Promise<void> => {
      await remove(config, {
        repository: "repo-a",
        ticket: "team-1",
        branchName: "rocky-team-1",
        dir: join(projectDir, "repo-a-team-1"),
        kind: "host",
      });
    };

    await expect(callRemove()).rejects.toThrow(/worktree has 1 untracked file\./);
    await expect(callRemove()).rejects.toThrow(/to discard it/);
    await expect(callRemove()).rejects.not.toThrow(/modified/);
  });

  it("rethrows the original error when the dirtiness probe itself fails", async () => {
    mkdirSync(join(projectDir, "repo-a"));
    mkdirSync(join(projectDir, "repo-a-team-1"));
    const config = makeConfig({ projectDir });

    runCommandMock.mockImplementation((_command, arguments_) => {
      // oxlint-disable-next-line vitest/no-conditional-in-test -- both the remove and the follow-up status probe fail; no dirtiness info available.
      if (hasArguments(arguments_, "worktree", "remove")) {
        throw new Error("original remove failure");
      }
      // oxlint-disable-next-line vitest/no-conditional-in-test -- as above
      if (hasArguments(arguments_, "status", "--porcelain")) {
        throw new Error("status probe blew up");
      }
      return "";
    });

    await expect(
      remove(config, {
        repository: "repo-a",
        ticket: "team-1",
        branchName: "rocky-team-1",
        dir: join(projectDir, "repo-a-team-1"),
        kind: "host",
      }),
    ).rejects.toThrow("original remove failure");
  });

  it("rethrows the original error when removal fails but the worktree is clean", async () => {
    mkdirSync(join(projectDir, "repo-a"));
    mkdirSync(join(projectDir, "repo-a-team-1"));
    const config = makeConfig({ projectDir });

    runCommandMock.mockImplementation((_command, arguments_) => {
      // oxlint-disable-next-line vitest/no-conditional-in-test -- discriminator selects the worktree-remove call to fail; status --porcelain returns clean.
      if (hasArguments(arguments_, "worktree", "remove")) {
        throw new Error("git worktree remove failed for some other reason");
      }
      return "";
    });

    await expect(
      remove(config, {
        repository: "repo-a",
        ticket: "team-1",
        branchName: "rocky-team-1",
        dir: join(projectDir, "repo-a-team-1"),
        kind: "host",
      }),
    ).rejects.toThrow("git worktree remove failed for some other reason");
  });

  it("skips the dirtiness probe and rethrows when --force is already set", async () => {
    mkdirSync(join(projectDir, "repo-a"));
    mkdirSync(join(projectDir, "repo-a-team-1"));
    const config = makeConfig({ projectDir });

    runCommandMock.mockImplementation((_command, arguments_) => {
      // oxlint-disable-next-line vitest/no-conditional-in-test -- discriminator fails the worktree-remove call even with --force.
      if (hasArguments(arguments_, "worktree", "remove")) {
        throw new Error("forced remove still failed");
      }
      return "";
    });

    await expect(
      remove(
        config,
        {
          repository: "repo-a",
          ticket: "team-1",
          branchName: "rocky-team-1",
          dir: join(projectDir, "repo-a-team-1"),
          kind: "host",
        },
        { force: true },
      ),
    ).rejects.toThrow("forced remove still failed");

    const statusCalls = runCommandMock.mock.calls.filter(([, arguments_]) =>
      hasArguments(arguments_, "status", "--porcelain"),
    );
    expect(statusCalls).toHaveLength(0);
  });

  it("rethrows branch deletion failures after the shutdown signal fires", async () => {
    mkdirSync(join(projectDir, "repo-a"));
    mkdirSync(join(projectDir, "repo-a-team-1"));
    const controller = new AbortController();
    controller.abort();
    const config = makeConfig({ projectDir });
    runCommandMock.mockImplementation((_cmd, arguments_) => {
      // oxlint-disable-next-line jest/no-conditional-in-test -- this selects the best-effort branch cleanup command.
      if (Array.isArray(arguments_) && arguments_.includes("-D")) {
        throw new Error("interrupted branch delete");
      }
      return "";
    });

    await expect(
      remove(
        config,
        {
          repository: "repo-a",
          ticket: "team-1",
          branchName: "rocky-team-1",
          dir: join(projectDir, "repo-a-team-1"),
          kind: "host",
        },
        { signal: controller.signal },
      ),
    ).rejects.toThrow("interrupted branch delete");
  });
});

describe(teardown, () => {
  setupTempProjectDir();
  const workspacesProbeMock = vi.mocked(workspaces.probe);
  // oxlint-disable-next-line typescript/unbound-method -- vi.mocked needs the function reference
  const workspacesCloseMock = vi.mocked(workspaces.close);

  function hostEntry(ticket: string): WorktreeEntry {
    mkdirSync(join(projectDir, `repo-a-${ticket}`), { recursive: true });
    mkdirSync(join(projectDir, "repo-a"), { recursive: true });
    return {
      repository: "repo-a",
      ticket,
      branchName: `rocky-${ticket}`,
      dir: join(projectDir, `repo-a-${ticket}`),
      kind: "host",
    };
  }

  it("short-circuits with an empty result when entries is empty (no workspaces.probe shell-out)", async () => {
    const config = makeConfig({ projectDir });

    const result = await teardown(config, []);

    expect(result).toStrictEqual({
      closed: [],
      removed: [],
      failures: [],
      workspaceProbe: { kind: "ok", names: new Set<string>() },
    });
    expect(workspacesProbeMock).not.toHaveBeenCalled();
  });

  it("closes the matching workspace before removing the worktree", async () => {
    workspacesProbeMock.mockResolvedValue({
      kind: "ok",
      names: new Set(["team-1"]),
    });
    const config = makeConfig({ projectDir });
    const entry = hostEntry("team-1");

    await teardown(config, [entry]);

    expect(workspacesCloseMock).toHaveBeenCalledWith(expect.anything(), "team-1", undefined);
    expect(Number(workspacesCloseMock.mock.invocationCallOrder[0])).toBeLessThan(
      Number(runCommandMock.mock.invocationCallOrder[0]),
    );
  });

  it("dedupes the workspace close across duplicate host entries for one ticket", async () => {
    workspacesProbeMock.mockResolvedValue({
      kind: "ok",
      names: new Set(["team-1"]),
    });
    const config = makeConfig({
      projectDir,
      knownRepositories: ["repo-a", "repo-b"],
    });
    mkdirSync(join(projectDir, "repo-b-team-1"), { recursive: true });
    mkdirSync(join(projectDir, "repo-b"), { recursive: true });
    const entries = [
      hostEntry("team-1"),
      {
        repository: "repo-b",
        ticket: "team-1",
        branchName: "rocky-team-1",
        dir: join(projectDir, "repo-b-team-1"),
        kind: "host" as const,
      },
    ];

    const result = await teardown(config, entries);

    expect(workspacesCloseMock).toHaveBeenCalledTimes(1);
    expect(result.closed).toStrictEqual(["team-1"]);
    expect(result.removed).toHaveLength(2);
  });

  it("skips workspace close when the ticket is not in the live name set", async () => {
    workspacesProbeMock.mockResolvedValue({
      kind: "ok",
      names: new Set<string>(),
    });
    const config = makeConfig({ projectDir });

    const result = await teardown(config, [hostEntry("team-1")]);

    expect(workspacesCloseMock).not.toHaveBeenCalled();
    expect(result.closed).toStrictEqual([]);
    expect(result.removed).toHaveLength(1);
    expect(result.workspaceProbe.kind).toBe("ok");
  });

  it("surfaces workspaceProbe.kind=unavailable with no error when the probe reported no info", async () => {
    workspacesProbeMock.mockResolvedValue({ kind: "unavailable" });
    const config = makeConfig({ projectDir });

    const result = await teardown(config, [hostEntry("team-1")]);

    expect(workspacesCloseMock).toHaveBeenCalledWith(config, "team-1", undefined);
    expect(result.workspaceProbe).toStrictEqual({ kind: "unavailable" });
    expect(result.closed).toStrictEqual(["team-1"]);
    expect(result.removed).toHaveLength(1);
  });

  // Regression: a flaky cmux/tmux throwing from probe must not abort the
  // batch; otherwise every on-disk worktree gets stranded.
  it("captures the error on workspaceProbe, best-effort closes, and still removes every worktree", async () => {
    workspacesProbeMock.mockResolvedValue({
      kind: "unavailable",
      error: new Error("cmux exploded"),
    });
    const config = makeConfig({ projectDir });
    const entries = [hostEntry("team-1"), hostEntry("team-2")];

    const result = await teardown(config, entries);

    expect(result.workspaceProbe.kind).toBe("unavailable");
    expect(probeError(result.workspaceProbe)).toBeInstanceOf(Error);
    expect(workspacesCloseMock).toHaveBeenCalledTimes(2);
    expect(workspacesCloseMock).toHaveBeenCalledWith(config, "team-1", undefined);
    expect(workspacesCloseMock).toHaveBeenCalledWith(config, "team-2", undefined);
    expect(result.closed).toStrictEqual(["team-1", "team-2"]);
    expect(result.removed).toHaveLength(2);
  });

  it("only best-effort closes a ticket once when duplicate entries exist and probe is unavailable", async () => {
    workspacesProbeMock.mockResolvedValue({ kind: "unavailable" });
    const config = makeConfig({
      projectDir,
      knownRepositories: ["repo-a", "repo-b"],
    });
    mkdirSync(join(projectDir, "repo-b-team-1"), { recursive: true });
    mkdirSync(join(projectDir, "repo-b"), { recursive: true });
    const entries = [
      hostEntry("team-1"),
      {
        repository: "repo-b",
        ticket: "team-1",
        branchName: "rocky-team-1",
        dir: join(projectDir, "repo-b-team-1"),
        kind: "host" as const,
      },
    ];

    const result = await teardown(config, entries);

    expect(workspacesCloseMock).toHaveBeenCalledTimes(1);
    expect(workspacesCloseMock).toHaveBeenCalledWith(config, "team-1", undefined);
    expect(result.closed).toStrictEqual(["team-1"]);
    expect(result.removed).toHaveLength(2);
  });

  it("records workspace_close failures and continues to remove the worktree", async () => {
    workspacesProbeMock.mockResolvedValue({
      kind: "ok",
      names: new Set(["team-1"]),
    });
    workspacesCloseMock.mockImplementation(() => {
      throw new Error("close down");
    });
    const config = makeConfig({ projectDir });
    const entry = hostEntry("team-1");

    const result = await teardown(config, [entry]);

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.entry).toBe(entry);
    expect(result.failures[0]?.step).toBe("workspace_close");
    expect(result.removed).toStrictEqual([entry]);
  });

  it("rethrows workspace_close failures after the shutdown signal fires", async () => {
    const controller = new AbortController();
    controller.abort();
    workspacesProbeMock.mockResolvedValue({
      kind: "ok",
      names: new Set(["team-1"]),
    });
    workspacesCloseMock.mockRejectedValue(new Error("close interrupted"));
    const config = makeConfig({ projectDir });

    await expect(
      teardown(config, [hostEntry("team-1")], { signal: controller.signal }),
    ).rejects.toThrow("close interrupted");
  });

  it("records worktree_remove failures and continues to the next entry", async () => {
    workspacesProbeMock.mockResolvedValue({
      kind: "ok",
      names: new Set<string>(),
    });
    // The first runCommand fired by teardown is the `worktree remove` for
    // entry 1; subsequent calls (entry 1 branch -D, entry 2 remove + -D)
    // fall back to the beforeEach mockReturnValue.
    runCommandMock.mockImplementationOnce(() => {
      throw new Error("remove failed");
    });
    const config = makeConfig({ projectDir });
    const entries = [hostEntry("team-1"), hostEntry("team-2")];

    const result = await teardown(config, entries);

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.step).toBe("worktree_remove");
    expect(result.removed).toStrictEqual([entries[1]]);
  });

  it("rethrows worktree_remove failures after the shutdown signal fires", async () => {
    const controller = new AbortController();
    controller.abort();
    workspacesProbeMock.mockResolvedValue({
      kind: "ok",
      names: new Set<string>(),
    });
    runCommandMock.mockImplementationOnce(() => {
      throw new Error("remove interrupted");
    });
    const config = makeConfig({ projectDir });

    await expect(
      teardown(config, [hostEntry("team-1")], { signal: controller.signal }),
    ).rejects.toThrow("remove interrupted");
  });

  it("passes force through to the underlying remove", async () => {
    workspacesProbeMock.mockResolvedValue({
      kind: "ok",
      names: new Set<string>(),
    });
    const config = makeConfig({ projectDir });

    await teardown(config, [hostEntry("team-1")], { force: true });

    const allArguments = runCommandMock.mock.calls.flatMap(([, arguments_]) => arguments_);
    expect(allArguments).toContain("--force");
  });
});
