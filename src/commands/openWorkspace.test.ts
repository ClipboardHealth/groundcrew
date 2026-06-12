import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type * as nodeFs from "node:fs";

import { ensureClearance } from "@clipboard-health/clearance";

import { loadConfig, type ResolvedConfig } from "../lib/config.ts";
import { detectHostCapabilities, type HostCapabilities } from "../lib/host.ts";
import { resolvePullRequest } from "../lib/pullRequests.ts";
import { resolvePrepareWorktreeCommand } from "../lib/repositoryHooks.ts";
import { readRunState, recordRunState } from "../lib/runState.ts";
import { workspaces } from "../lib/workspaces.ts";
import { type WorktreeEntry, worktrees } from "../lib/worktrees.ts";
import { openWorkspace, openWorkspaceCli, parseOpenWorkspaceArgs } from "./openWorkspace.ts";

interface NodeFsMock extends Omit<
  typeof nodeFs,
  "mkdtempSync" | "writeFileSync" | "existsSync" | "readFileSync"
> {
  mkdtempSync: ReturnType<typeof vi.fn<typeof mkdtempSync>>;
  writeFileSync: ReturnType<typeof vi.fn<typeof writeFileSync>>;
  existsSync: ReturnType<typeof vi.fn<typeof existsSync>>;
  readFileSync: ReturnType<typeof vi.fn<typeof readFileSync>>;
}

vi.mock("node:fs", async (importOriginal): Promise<NodeFsMock> => {
  const actual = await importOriginal<typeof nodeFs>();
  return {
    ...actual,
    mkdtempSync: vi.fn<typeof mkdtempSync>(),
    writeFileSync: vi.fn<typeof writeFileSync>(),
    existsSync: vi.fn<typeof existsSync>(),
    readFileSync: vi.fn<typeof readFileSync>(),
  };
});
vi.mock(import("@clipboard-health/clearance"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, ensureClearance: vi.fn<typeof ensureClearance>() };
});
vi.mock(import("../lib/config.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, loadConfig: vi.fn<typeof loadConfig>() };
});
vi.mock(import("../lib/host.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, detectHostCapabilities: vi.fn<typeof detectHostCapabilities>() };
});
vi.mock(import("../lib/pullRequests.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, resolvePullRequest: vi.fn<typeof resolvePullRequest>() };
});
vi.mock(import("../lib/repositoryHooks.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    resolvePrepareWorktreeCommand: vi.fn<typeof resolvePrepareWorktreeCommand>(),
  };
});
vi.mock(import("../lib/runState.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    readRunState: vi.fn<typeof readRunState>(),
    recordRunState: vi.fn<typeof recordRunState>(),
  };
});
vi.mock(import("../lib/workspaces.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    workspaces: {
      ...actual.workspaces,
      open: vi.fn<typeof actual.workspaces.open>(),
      probe: vi.fn<typeof actual.workspaces.probe>(),
    },
  };
});
vi.mock(import("../lib/worktrees.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    worktrees: {
      ...actual.worktrees,
      open: vi.fn<typeof actual.worktrees.open>(),
      findByTask: vi.fn<typeof actual.worktrees.findByTask>(),
      teardown: vi.fn<typeof actual.worktrees.teardown>(),
    },
  };
});
const runCommandMock = vi.hoisted(() =>
  vi.fn<(cmd: string, arguments_: readonly string[]) => string>(),
);
vi.mock(import("../lib/commandRunner.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, runCommand: runCommandMock };
});

// composeAgentLaunch resolves the safehouse git-common-dir via `git rev-parse`;
// the worktree dir here is a fixture path, so stub the probe to a path.
function stubRunCommand(): void {
  runCommandMock.mockImplementation((cmd: string, arguments_: readonly string[]) =>
    cmd === "git" && arguments_.includes("--git-common-dir") ? "/work/acme/widgets-pr-42/.git" : "",
  );
}

const mkdtempMock = vi.mocked(mkdtempSync);
const writeFileMock = vi.mocked(writeFileSync);
const existsSyncMock = vi.mocked(existsSync);
const readFileMock = vi.mocked(readFileSync);
const ensureClearanceMock = vi.mocked(ensureClearance);
const loadConfigMock = vi.mocked(loadConfig);
const detectHostMock = vi.mocked(detectHostCapabilities);
const resolvePullRequestMock = vi.mocked(resolvePullRequest);
const resolvePrepareWorktreeCommandMock = vi.mocked(resolvePrepareWorktreeCommand);
const readRunStateMock = vi.mocked(readRunState);
const recordRunStateMock = vi.mocked(recordRunState);
// oxlint-disable-next-line typescript/unbound-method -- workspaces is mocked to plain vi.fn properties in this file.
const workspacesOpenMock = vi.mocked(workspaces.open);
const workspacesProbeMock = vi.mocked(workspaces.probe);
const worktreeOpenMock = vi.mocked(worktrees.open);
const teardownMock = vi.mocked(worktrees.teardown);
const findByTaskMock = vi.mocked(worktrees.findByTask);

type RecordedRunState = Parameters<typeof recordRunState>[0]["state"];

function lastRecordedRunState(): RecordedRunState {
  const input = recordRunStateMock.mock.calls.at(-1)?.[0];
  if (input === undefined) {
    throw new Error("recordRunState was not called");
  }
  return input.state;
}

function stagedLaunchScript(): string {
  const call = writeFileMock.mock.calls.find(
    (args) => typeof args[0] === "string" && args[0].endsWith("launch.sh"),
  );
  const content = call?.[1];
  if (typeof content !== "string") {
    throw new TypeError("launch.sh was not staged");
  }
  return content;
}

function host(overrides: Partial<HostCapabilities> = {}): HostCapabilities {
  return {
    hasSafehouse: true,
    hasSbx: false,
    hasCmux: true,
    hasTmux: false,
    hasZellij: false,
    hasBubblewrap: false,
    hasSocat: false,
    hasRipgrep: false,
    isMacOS: true,
    isLinux: false,
    isSafehouseSupported: true,
    isSrtSupported: true,
    isSdxSupported: true,
    ...overrides,
  };
}

function makeConfig(): ResolvedConfig {
  return {
    sources: [],
    defaults: { hooks: {} },
    git: { remote: "origin", defaultBranch: "main" },
    workspace: {
      projectDir: "/work",
      knownRepositories: ["acme/widgets"],
      repositories: [{ name: "acme/widgets" }],
    },
    orchestrator: {
      maximumInProgress: 4,
      pollIntervalMilliseconds: 1000,
      sessionLimitPercentage: 85,
    },
    agents: {
      default: "claude",
      definitions: { claude: { cmd: "claude", color: "#fff" } },
    },
    prompts: { initial: "x" },
    workspaceKind: "auto",
    local: { runner: "auto" },
    logging: { file: "/tmp/groundcrew-test.log" },
  };
}

function openedWorktree(): WorktreeEntry {
  return {
    repository: "acme/widgets",
    task: "pr-42",
    branchName: "jdoe/fix-thing",
    dir: "/work/acme/widgets-pr-42",
    kind: "host",
  };
}

describe(parseOpenWorkspaceArgs, () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("parses a PR number with an explicit repo", () => {
    expect(parseOpenWorkspaceArgs(["42", "--repo", "acme/widgets"])).toStrictEqual({
      input: { kind: "pr", pr: "42" },
      repository: "acme/widgets",
      dryRun: false,
    });
  });

  it("infers the repo from a PR URL", () => {
    expect(parseOpenWorkspaceArgs(["https://github.com/acme/widgets/pull/42"])).toStrictEqual({
      input: { kind: "pr", pr: "42" },
      repository: "acme/widgets",
      dryRun: false,
    });
  });

  it("lets an explicit --repo override the URL-inferred repo", () => {
    const actual = parseOpenWorkspaceArgs([
      "https://github.com/acme/widgets/pull/42",
      "--repo",
      "acme/other",
    ]);

    expect(actual.repository).toBe("acme/other");
  });

  it("parses a --branch with repo, agent, prompt, task, and dry-run", () => {
    expect(
      parseOpenWorkspaceArgs([
        "--branch",
        "jdoe/fix-thing",
        "--repo",
        "acme/widgets",
        "--agent",
        "codex",
        "--prompt",
        "address review",
        "--task",
        "custom-id",
        "--dry-run",
      ]),
    ).toStrictEqual({
      input: { kind: "branch", branch: "jdoe/fix-thing" },
      repository: "acme/widgets",
      agent: "codex",
      promptText: "address review",
      taskOverride: "custom-id",
      dryRun: true,
    });
  });

  it("rejects a PR number with no --repo", () => {
    expect(() => parseOpenWorkspaceArgs(["42"])).toThrow(/--repo .* is required/);
  });

  it("rejects --branch with no --repo", () => {
    expect(() => parseOpenWorkspaceArgs(["--branch", "x"])).toThrow(/--branch requires --repo/);
  });

  it("rejects passing both a PR and --branch", () => {
    expect(() => parseOpenWorkspaceArgs(["42", "--branch", "x", "--repo", "acme/widgets"])).toThrow(
      /either a PR or --branch, not both/,
    );
  });

  it("rejects no PR and no --branch", () => {
    expect(() => parseOpenWorkspaceArgs(["--repo", "acme/widgets"])).toThrow(
      /a PR .* or --branch is required/,
    );
  });

  it("rejects --prompt together with --prompt-file", () => {
    expect(() =>
      parseOpenWorkspaceArgs([
        "42",
        "--repo",
        "acme/widgets",
        "--prompt",
        "a",
        "--prompt-file",
        "b",
      ]),
    ).toThrow(/mutually exclusive/);
  });

  it("reads the prompt text from --prompt-file", () => {
    readFileMock.mockReturnValue("prompt from file");

    const actual = parseOpenWorkspaceArgs([
      "42",
      "--repo",
      "acme/widgets",
      "--prompt-file",
      "p.txt",
    ]);

    expect(readFileMock).toHaveBeenCalledWith("p.txt", "utf8");
    expect(actual.promptText).toBe("prompt from file");
  });

  it("throws when --prompt-file cannot be read", () => {
    readFileMock.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    expect(() =>
      parseOpenWorkspaceArgs(["42", "--repo", "acme/widgets", "--prompt-file", "missing.txt"]),
    ).toThrow(/could not read --prompt-file missing.txt/);
  });

  it("rejects a flag given without a value", () => {
    expect(() => parseOpenWorkspaceArgs(["42", "--repo"])).toThrow(/--repo requires a value/);
  });

  it("rejects unknown options", () => {
    expect(() => parseOpenWorkspaceArgs(["42", "--repo", "acme/widgets", "--nope"])).toThrow(
      /unknown option: --nope/,
    );
  });

  it("rejects extra positionals", () => {
    expect(() => parseOpenWorkspaceArgs(["42", "43", "--repo", "acme/widgets"])).toThrow(
      /unexpected extra argument: 43/,
    );
  });
});

describe(openWorkspace, () => {
  const config = makeConfig();

  beforeEach(() => {
    mkdtempMock.mockReturnValue("/tmp/groundcrew-open-pr-42-x");
    existsSyncMock.mockReturnValue(true);
    resolvePullRequestMock.mockResolvedValue({
      number: 42,
      branch: "jdoe/fix-thing",
      title: "Fix the thing",
      url: "https://github.com/acme/widgets/pull/42",
      state: "open",
      isCrossRepository: false,
    });
    findByTaskMock.mockReturnValue([]);
    worktreeOpenMock.mockResolvedValue(openedWorktree());
    teardownMock.mockResolvedValue({
      closed: [],
      removed: [],
      failures: [],
      workspaceProbe: { kind: "ok", names: new Set() },
    });
    workspacesProbeMock.mockResolvedValue({ kind: "ok", names: new Set<string>() });
    workspacesOpenMock.mockResolvedValue();
    stubRunCommand();
    detectHostMock.mockResolvedValue(host());
    ensureClearanceMock.mockResolvedValue({
      logPath: "/tmp/clearance/clearance.log",
      pidPath: "/tmp/clearance/clearance.pid",
      port: 19_999,
      status: "already-running",
    });
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it("opens the PR head branch in a new worktree and records run state", async () => {
    await openWorkspace(config, {
      input: { kind: "pr", pr: "42" },
      repository: "acme/widgets",
      promptText: "address the review comments",
    });

    expect(worktreeOpenMock).toHaveBeenCalledWith(config, {
      repository: "acme/widgets",
      task: "pr-42",
      branch: "jdoe/fix-thing",
    });
    expect(workspacesOpenMock).toHaveBeenCalledWith(
      config,
      expect.objectContaining({ name: "pr-42", cwd: "/work/acme/widgets-pr-42" }),
    );
    expect(resolvePrepareWorktreeCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeDir: "/work/acme/widgets-pr-42" }),
    );
    expect(lastRecordedRunState()).toMatchObject({
      task: "pr-42",
      repository: "acme/widgets",
      branchName: "jdoe/fix-thing",
      state: "running",
      title: "Fix the thing",
      url: "https://github.com/acme/widgets/pull/42",
    });
  });

  it("passes the prompt to the agent when one is given", async () => {
    await openWorkspace(config, {
      input: { kind: "pr", pr: "42" },
      repository: "acme/widgets",
      promptText: "address the review comments",
    });

    expect(writeFileMock).toHaveBeenCalledWith(
      "/tmp/groundcrew-open-pr-42-x/prompt.txt",
      "address the review comments",
    );
    expect(stagedLaunchScript()).toContain(`sh "$_p"`);
  });

  it("launches interactively with no prompt positional when no prompt is given", async () => {
    await openWorkspace(config, {
      input: { kind: "pr", pr: "42" },
      repository: "acme/widgets",
    });

    expect(stagedLaunchScript()).not.toContain(`sh "$_p"`);
  });

  it("stages the prepareWorktree hook into the launch when one is configured", async () => {
    resolvePrepareWorktreeCommandMock.mockReturnValue("npm ci");

    await openWorkspace(config, {
      input: { kind: "pr", pr: "42" },
      repository: "acme/widgets",
      promptText: "go",
    });

    expect(stagedLaunchScript()).toContain("npm ci");
  });

  it("rolls back the worktree when opening the workspace fails", async () => {
    workspacesOpenMock.mockRejectedValue(new Error("cmux down"));

    await expect(
      openWorkspace(config, {
        input: { kind: "pr", pr: "42" },
        repository: "acme/widgets",
        promptText: "go",
      }),
    ).rejects.toThrow("cmux down");
    expect(teardownMock).toHaveBeenCalledWith(
      config,
      [expect.objectContaining({ task: "pr-42" })],
      { force: true },
    );
    expect(recordRunStateMock).not.toHaveBeenCalled();
  });

  it("still surfaces the original failure when rollback teardown also fails", async () => {
    workspacesOpenMock.mockRejectedValue(new Error("cmux down"));
    teardownMock.mockRejectedValue(new Error("teardown blew up"));

    await expect(
      openWorkspace(config, {
        input: { kind: "pr", pr: "42" },
        repository: "acme/widgets",
        promptText: "go",
      }),
    ).rejects.toThrow("cmux down");
  });

  it("rejects a fork (cross-repository) PR", async () => {
    resolvePullRequestMock.mockResolvedValue({
      number: 9,
      branch: "patch",
      title: "fork pr",
      url: "https://github.com/acme/widgets/pull/9",
      state: "open",
      isCrossRepository: true,
    });

    await expect(
      openWorkspace(config, { input: { kind: "pr", pr: "9" }, repository: "acme/widgets" }),
    ).rejects.toThrow(/from a fork/);
    expect(worktreeOpenMock).not.toHaveBeenCalled();
  });

  it("short-circuits on --dry-run before provisioning anything", async () => {
    await openWorkspace(config, {
      input: { kind: "pr", pr: "42" },
      repository: "acme/widgets",
      dryRun: true,
    });

    expect(worktreeOpenMock).not.toHaveBeenCalled();
    expect(workspacesOpenMock).not.toHaveBeenCalled();
    expect(recordRunStateMock).not.toHaveBeenCalled();
  });

  it("fails when the workspace is already live", async () => {
    workspacesProbeMock.mockResolvedValue({ kind: "ok", names: new Set(["pr-42"]) });

    await expect(
      openWorkspace(config, { input: { kind: "pr", pr: "42" }, repository: "acme/widgets" }),
    ).rejects.toThrow(/already live/);
    expect(worktreeOpenMock).not.toHaveBeenCalled();
  });

  it("fails when the task already has a worktree", async () => {
    findByTaskMock.mockReturnValue([openedWorktree()]);

    await expect(
      openWorkspace(config, { input: { kind: "pr", pr: "42" }, repository: "acme/widgets" }),
    ).rejects.toThrow(/already has a worktree or run state/);
    expect(worktreeOpenMock).not.toHaveBeenCalled();
  });

  it("fails when run state already exists for the task", async () => {
    findByTaskMock.mockReturnValue([]);
    readRunStateMock.mockReturnValue({
      task: "pr-42",
      repository: "acme/widgets",
      agent: "claude",
      worktreeDir: "/work/acme/widgets-pr-42",
      branchName: "jdoe/fix-thing",
      workspaceName: "pr-42",
      state: "running",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      resumeCount: 0,
    });

    await expect(
      openWorkspace(config, { input: { kind: "pr", pr: "42" }, repository: "acme/widgets" }),
    ).rejects.toThrow(/already has a worktree or run state/);
    expect(worktreeOpenMock).not.toHaveBeenCalled();
  });

  it("fails for an unknown repository", async () => {
    await expect(
      openWorkspace(config, { input: { kind: "pr", pr: "42" }, repository: "ghost/repo" }),
    ).rejects.toThrow(/not in workspace.knownRepositories/);
  });

  it("fails when the clone directory is absent", async () => {
    existsSyncMock.mockReturnValue(false);

    await expect(
      openWorkspace(config, { input: { kind: "pr", pr: "42" }, repository: "acme/widgets" }),
    ).rejects.toThrow(/Repository not found/);
  });

  it("fails for an unknown agent", async () => {
    await expect(
      openWorkspace(config, {
        input: { kind: "pr", pr: "42" },
        repository: "acme/widgets",
        agent: "missing",
      }),
    ).rejects.toThrow(/Unknown agent: missing/);
  });

  it("opens a branch with a slugified task id when no PR is given", async () => {
    worktreeOpenMock.mockResolvedValue({
      repository: "acme/widgets",
      task: "jdoe-fix-thing",
      branchName: "jdoe/fix-thing",
      dir: "/work/acme/widgets-jdoe-fix-thing",
      kind: "host",
    });

    await openWorkspace(config, {
      input: { kind: "branch", branch: "jdoe/fix-thing" },
      repository: "acme/widgets",
    });

    expect(resolvePullRequestMock).not.toHaveBeenCalled();
    expect(worktreeOpenMock).toHaveBeenCalledWith(config, {
      repository: "acme/widgets",
      task: "jdoe-fix-thing",
      branch: "jdoe/fix-thing",
    });
    expect(lastRecordedRunState()).toMatchObject({
      task: "jdoe-fix-thing",
      branchName: "jdoe/fix-thing",
      title: "jdoe/fix-thing",
    });
  });
});

describe(openWorkspaceCli, () => {
  const config = makeConfig();

  beforeEach(() => {
    loadConfigMock.mockResolvedValue(config);
    mkdtempMock.mockReturnValue("/tmp/groundcrew-open-pr-42-x");
    existsSyncMock.mockReturnValue(true);
    resolvePullRequestMock.mockResolvedValue({
      number: 42,
      branch: "jdoe/fix-thing",
      title: "Fix the thing",
      url: "https://github.com/acme/widgets/pull/42",
      state: "open",
      isCrossRepository: false,
    });
    findByTaskMock.mockReturnValue([]);
    worktreeOpenMock.mockResolvedValue(openedWorktree());
    teardownMock.mockResolvedValue({
      closed: [],
      removed: [],
      failures: [],
      workspaceProbe: { kind: "ok", names: new Set() },
    });
    workspacesProbeMock.mockResolvedValue({ kind: "ok", names: new Set<string>() });
    stubRunCommand();
    detectHostMock.mockResolvedValue(host());
    ensureClearanceMock.mockResolvedValue({
      logPath: "/tmp/clearance/clearance.log",
      pidPath: "/tmp/clearance/clearance.pid",
      port: 19_999,
      status: "already-running",
    });
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it("loads config and opens the PR", async () => {
    await openWorkspaceCli(["42", "--repo", "acme/widgets"]);

    expect(loadConfigMock).toHaveBeenCalledTimes(1);
    expect(worktreeOpenMock).toHaveBeenCalledWith(config, {
      repository: "acme/widgets",
      task: "pr-42",
      branch: "jdoe/fix-thing",
    });
  });
});
