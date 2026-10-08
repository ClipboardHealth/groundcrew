import type { RunCommandOptions } from "../lib/commandRunner.ts";
import { loadConfig, type ResolvedConfig } from "../lib/config.ts";
import { worktrees } from "../lib/worktrees.ts";
import { makeCmuxConfig } from "../testHelpers/cmuxConfig.ts";
import { makeLocalConfig } from "../testHelpers/localConfig.ts";
import {
  createPrStageSync,
  createPrStageSyncDeps,
  type PrStageSync,
  type PrStageSyncDeps,
} from "./prStageSync.ts";
import { stageCli } from "./stage.ts";

vi.mock(import("../lib/config.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, loadConfig: vi.fn<typeof loadConfig>() };
});
type RunCommandAsyncMock = (
  command: string,
  arguments_: readonly string[],
  options?: RunCommandOptions,
) => Promise<string>;

const runCommandMock = vi.hoisted(() => vi.fn<RunCommandAsyncMock>());

vi.mock(import("../lib/commandRunner.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    runCommandAsync: runCommandMock as unknown as typeof actual.runCommandAsync,
  };
});
vi.mock(import("../lib/worktrees.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    worktrees: { ...actual.worktrees, list: vi.fn<typeof actual.worktrees.list>() },
  };
});
vi.mock(import("./prStageSync.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createPrStageSync: vi.fn<typeof createPrStageSync>(),
    createPrStageSyncDeps: vi.fn<typeof createPrStageSyncDeps>(),
  };
});

const loadConfigMock = vi.mocked(loadConfig);
const worktreesListMock = vi.mocked(worktrees.list);
const createPrStageSyncMock = vi.mocked(createPrStageSync);
const createPrStageSyncDepsMock = vi.mocked(createPrStageSyncDeps);

function makeConfig(
  overrides: Partial<ResolvedConfig["cmux"]["prStages"]["labels"]> = {},
): ResolvedConfig {
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
      maximumInProgress: 2,
      pollIntervalMilliseconds: 1000,
      sessionLimitPercentage: 85,
    },
    agents: { default: "claude", definitions: { claude: { cmd: "claude", color: "#fff" } } },
    prompts: { initial: "x" },
    workspaceKind: "auto",
    local: makeLocalConfig(),
    cmux: makeCmuxConfig({
      enabled: true,
      labels: { selfReviewed: "self-reviewed", tested: "tested", ...overrides },
    }),
    logging: { file: "/tmp/groundcrew-test.log" },
  };
}

const PR_URL = "https://github.com/acme/repo-a/pull/42";

function stubGhLabelList(
  response: string,
): (command: string, arguments_: readonly string[]) => Promise<string> {
  return async (_command, arguments_) =>
    arguments_[0] === "label" && arguments_[1] === "list" ? response : "";
}

describe(stageCli, () => {
  let syncOnceMock: ReturnType<typeof vi.fn<PrStageSync["syncOnce"]>>;

  beforeEach(() => {
    const config = makeConfig();
    loadConfigMock.mockResolvedValue(config);
    worktreesListMock.mockReturnValue([]);
    syncOnceMock = vi.fn<PrStageSync["syncOnce"]>().mockResolvedValue();
    createPrStageSyncDepsMock.mockReturnValue({
      config,
      listPullRequests: vi.fn<PrStageSyncDeps["listPullRequests"]>(),
      findPullRequestsForBranch: vi.fn<PrStageSyncDeps["findPullRequestsForBranch"]>(),
      fetchPullRequestDetails: vi.fn<PrStageSyncDeps["fetchPullRequestDetails"]>(),
      listCmuxWorkspaces: vi.fn<PrStageSyncDeps["listCmuxWorkspaces"]>(),
      readCmuxStatus: vi.fn<PrStageSyncDeps["readCmuxStatus"]>(),
      writeCmuxStatus: vi.fn<PrStageSyncDeps["writeCmuxStatus"]>(),
      isCmuxAdapterActive: vi.fn<PrStageSyncDeps["isCmuxAdapterActive"]>(),
    });
    createPrStageSyncMock.mockReturnValue({
      runOnce: vi.fn<PrStageSync["runOnce"]>(),
      syncOnce: syncOnceMock,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("label-add", () => {
    it("creates the label with its configured color on first use, adds it, then syncs", async () => {
      runCommandMock.mockImplementation(stubGhLabelList(JSON.stringify([])));

      await stageCli(["label-add", PR_URL, "self-reviewed"]);

      expect(runCommandMock).toHaveBeenCalledWith("gh", [
        "label",
        "create",
        "self-reviewed",
        "--repo",
        "acme/repo-a",
        "--color",
        "5319E7",
        "--force",
      ]);
      expect(runCommandMock).toHaveBeenCalledWith("gh", [
        "pr",
        "edit",
        PR_URL,
        "--add-label",
        "self-reviewed",
      ]);
      expect(syncOnceMock).toHaveBeenCalledTimes(1);
    });

    it("skips label creation when the label already exists in the repo", async () => {
      runCommandMock.mockImplementation(stubGhLabelList(JSON.stringify([{ name: "tested" }])));

      await stageCli(["label-add", PR_URL, "tested"]);

      expect(runCommandMock).not.toHaveBeenCalledWith(
        "gh",
        expect.arrayContaining(["label", "create"]),
      );
      expect(runCommandMock).toHaveBeenCalledWith("gh", [
        "pr",
        "edit",
        PR_URL,
        "--add-label",
        "tested",
      ]);
    });

    it("treats malformed gh label list output as 'label does not exist'", async () => {
      runCommandMock.mockImplementation(stubGhLabelList("not json"));

      await stageCli(["label-add", PR_URL, "tested"]);

      expect(runCommandMock).toHaveBeenCalledWith("gh", [
        "label",
        "create",
        "tested",
        "--repo",
        "acme/repo-a",
        "--color",
        "0E8A16",
        "--force",
      ]);
    });

    it("treats a non-array gh label list response as 'label does not exist'", async () => {
      runCommandMock.mockImplementation(stubGhLabelList(JSON.stringify({ not: "an array" })));

      await stageCli(["label-add", PR_URL, "tested"]);

      expect(runCommandMock).toHaveBeenCalledWith("gh", [
        "label",
        "create",
        "tested",
        "--repo",
        "acme/repo-a",
        "--color",
        "0E8A16",
        "--force",
      ]);
    });

    it("rejects a label that isn't one of the two configured gating labels", async () => {
      await expect(stageCli(["label-add", PR_URL, "not-configured"])).rejects.toThrow(
        /unknown label: not-configured/,
      );
      expect(runCommandMock).not.toHaveBeenCalled();
    });

    it("rejects a pull request URL that isn't a github.com PR link", async () => {
      await expect(
        stageCli(["label-add", "https://example.com/not-a-pr", "tested"]),
      ).rejects.toThrow(/invalid pull request URL/);
    });

    it("requires exactly a pr-url and a label", async () => {
      await expect(stageCli(["label-add", PR_URL])).rejects.toThrow(/Usage: crew stage label-add/);
      await expect(stageCli(["label-add", PR_URL, "tested", "extra"])).rejects.toThrow(
        /Usage: crew stage label-add/,
      );
    });
  });

  describe("label-remove", () => {
    it("removes the label without checking or creating it, then syncs", async () => {
      await stageCli(["label-remove", PR_URL, "self-reviewed"]);

      expect(runCommandMock).toHaveBeenCalledTimes(1);
      expect(runCommandMock).toHaveBeenCalledWith("gh", [
        "pr",
        "edit",
        PR_URL,
        "--remove-label",
        "self-reviewed",
      ]);
      expect(syncOnceMock).toHaveBeenCalledTimes(1);
    });

    it("rejects a label that isn't one of the two configured gating labels", async () => {
      await expect(stageCli(["label-remove", PR_URL, "not-configured"])).rejects.toThrow(
        /unknown label: not-configured/,
      );
    });

    it("rejects a pull request URL that isn't a github.com PR link", async () => {
      await expect(
        stageCli(["label-remove", "https://example.com/not-a-pr", "tested"]),
      ).rejects.toThrow(/invalid pull request URL/);
      expect(runCommandMock).not.toHaveBeenCalled();
    });
  });

  describe("refresh", () => {
    it("loads config and runs one sync pass", async () => {
      await stageCli(["refresh"]);

      expect(loadConfigMock).toHaveBeenCalledTimes(1);
      expect(syncOnceMock).toHaveBeenCalledWith({ worktreeEntries: [] });
    });

    it("rejects extra arguments", async () => {
      await expect(stageCli(["refresh", "extra"])).rejects.toThrow(/Usage: crew stage refresh/);
    });
  });

  it("rejects an unknown subcommand", async () => {
    await expect(stageCli(["bogus"])).rejects.toThrow(/Usage: crew stage <subcommand>/);
  });
});
