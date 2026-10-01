import { type CmuxWorkspaceSummary, listCmuxWorkspaceSummaries } from "../lib/cmuxAdapter.ts";
import { type CmuxStatusWrite, readCmuxStatus, writeCmuxStatus } from "../lib/cmuxStatusFields.ts";
import type { ResolvedConfig } from "../lib/config.ts";
import { detectHostCapabilities, type HostCapabilities } from "../lib/host.ts";
import { fetchPullRequestDetails, type PullRequestDetail } from "../lib/pullRequestDetails.ts";
import { findPullRequestsForBranchOrThrow, type PullRequestSummary } from "../lib/pullRequests.ts";
import * as util from "../lib/util.ts";
import type { WorktreeEntry } from "../lib/worktrees.ts";
import { makeCmuxConfig } from "../testHelpers/cmuxConfig.ts";
import {
  deleteEnvironmentVariable,
  setEnvironmentVariable,
  snapshotEnvironmentVariables,
} from "../testHelpers/env.ts";
import { makeLocalConfig } from "../testHelpers/localConfig.ts";
import {
  createPrStageSync,
  createPrStageSyncDeps,
  isCmuxAdapterActive,
  type FetchPullRequestDetails,
  type FindPullRequests,
  type ListCmuxWorkspaces,
  type PrStageSyncDeps,
} from "./prStageSync.ts";

vi.mock(import("../lib/worktreeRunState.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    effectiveBranchName: vi.fn<typeof actual.effectiveBranchName>(
      async ({ entry }) => entry.branchName,
    ),
  };
});
vi.mock(import("../lib/host.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, detectHostCapabilities: vi.fn<typeof actual.detectHostCapabilities>() };
});
vi.mock(import("../lib/util.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, logEvent: vi.fn<typeof actual.logEvent>() };
});

const logEventMock = vi.mocked(util.logEvent);

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    sources: [],
    defaults: { hooks: {} },
    git: { remote: "origin", defaultBranch: "main", ...overrides.git },
    workspace: {
      projectDir: "/work",
      knownRepositories: ["repo-a"],
      repositories: [{ name: "repo-a" }],
      ...overrides.workspace,
    },
    orchestrator: {
      maximumInProgress: 2,
      pollIntervalMilliseconds: 1000,
      sessionLimitPercentage: 85,
      ...overrides.orchestrator,
    },
    agents: {
      default: "claude",
      definitions: { claude: { cmd: "claude", color: "#fff" } },
      ...overrides.agents,
    },
    prompts: { initial: "x", ...overrides.prompts },
    workspaceKind: overrides.workspaceKind ?? "auto",
    local: makeLocalConfig(),
    cmux: overrides.cmux ?? makeCmuxConfig({ enabled: true }),
    logging: { file: "/tmp/groundcrew-test.log", ...overrides.logging },
  };
}

function entryFor(task: string, overrides: Partial<WorktreeEntry> = {}): WorktreeEntry {
  return {
    repository: "repo-a",
    task,
    branchName: `dev-${task}`,
    dir: `/work/repo-a-${task}`,
    kind: "host",
    ...overrides,
  };
}

function workspaceFor(
  id: string,
  overrides: Partial<CmuxWorkspaceSummary> = {},
): CmuxWorkspaceSummary {
  return {
    id,
    taskId: id,
    title: `Work on ${id}`,
    currentDirectory: `/work/repo-a-${id}`,
    ...overrides,
  };
}

function pullRequestFor(overrides: Partial<PullRequestSummary> = {}): PullRequestSummary {
  return {
    url: "https://github.com/acme/repo-a/pull/1",
    number: 1,
    state: "open",
    title: "x",
    ...overrides,
  };
}

function detailFor(overrides: Partial<PullRequestDetail> = {}): PullRequestDetail {
  return {
    url: "https://github.com/acme/repo-a/pull/1",
    state: "OPEN",
    isDraft: false,
    labels: ["self-reviewed", "tested"],
    reviewDecision: "APPROVED",
    checks: null,
    ...overrides,
  };
}

interface Deps extends PrStageSyncDeps {
  findPullRequests: ReturnType<typeof vi.fn<FindPullRequests>>;
  fetchPullRequestDetails: ReturnType<typeof vi.fn<FetchPullRequestDetails>>;
  listCmuxWorkspaces: ReturnType<typeof vi.fn<ListCmuxWorkspaces>>;
  readCmuxStatus: ReturnType<typeof vi.fn<PrStageSyncDeps["readCmuxStatus"]>>;
  writeCmuxStatus: ReturnType<typeof vi.fn<PrStageSyncDeps["writeCmuxStatus"]>>;
  isCmuxAdapterActive: ReturnType<typeof vi.fn<PrStageSyncDeps["isCmuxAdapterActive"]>>;
}

function makeDeps(config: ResolvedConfig, overrides: Partial<Deps> = {}): Deps {
  return {
    config,
    findPullRequests: vi.fn<FindPullRequests>().mockResolvedValue([]),
    fetchPullRequestDetails: vi.fn<FetchPullRequestDetails>().mockResolvedValue(new Map()),
    listCmuxWorkspaces: vi.fn<ListCmuxWorkspaces>().mockResolvedValue([]),
    readCmuxStatus: vi.fn<PrStageSyncDeps["readCmuxStatus"]>().mockResolvedValue(new Map()),
    writeCmuxStatus: vi.fn<PrStageSyncDeps["writeCmuxStatus"]>().mockResolvedValue(),
    isCmuxAdapterActive: vi.fn<PrStageSyncDeps["isCmuxAdapterActive"]>().mockResolvedValue(true),
    ...overrides,
  };
}

function writesFor(deps: Deps, key: string): CmuxStatusWrite[] {
  return deps.writeCmuxStatus.mock.calls
    .filter((call) => call[1].key === key)
    .map((call) => call[1]);
}

function rejectWritesFor(failingWorkspaceId: string): (workspaceId: string) => Promise<void> {
  const failing = new Set([failingWorkspaceId]);
  return async (workspaceId) => {
    if (failing.has(workspaceId)) {
      throw new Error("cmux set-status failed");
    }
  };
}

function rejectHeartbeatWrites(): (workspaceId: string, write: CmuxStatusWrite) => Promise<void> {
  const failingKeys = new Set(["crew_poller_heartbeat"]);
  return async (_workspaceId, write) => {
    if (failingKeys.has(write.key)) {
      throw new Error("heartbeat write failed");
    }
  };
}

const originalEnvironment = snapshotEnvironmentVariables();

afterEach(() => {
  const original = originalEnvironment["CMUX_WORKSPACE_ID"];
  if (original === undefined) {
    deleteEnvironmentVariable("CMUX_WORKSPACE_ID");
  } else {
    setEnvironmentVariable("CMUX_WORKSPACE_ID", original);
  }
});

beforeEach(() => {
  // The ambient shell this suite runs in may itself be a cmux workspace;
  // tests that don't exercise the heartbeat explicitly opt out of it so an
  // inherited CMUX_WORKSPACE_ID never sneaks in an extra write.
  deleteEnvironmentVariable("CMUX_WORKSPACE_ID");
});

describe(createPrStageSync, () => {
  describe("runOnce (gated on config)", () => {
    it("writes only crew_ticket, with no stage/label/heartbeat writes, when cmux.prStages.enabled is false", async () => {
      const config = makeConfig({ cmux: makeCmuxConfig({ enabled: false }) });
      const entry = entryFor("adhoc");
      const workspace = workspaceFor("ws-1", {
        currentDirectory: entry.dir,
        title: "TG-1 do a thing",
      });
      const deps = makeDeps(config, {
        listCmuxWorkspaces: vi.fn<ListCmuxWorkspaces>().mockResolvedValue([workspace]),
      });
      const prStageSync = createPrStageSync(deps);

      await prStageSync.runOnce({ worktreeEntries: [entry] });

      expect(deps.isCmuxAdapterActive).toHaveBeenCalledTimes(1);
      expect(deps.listCmuxWorkspaces).toHaveBeenCalledTimes(1);
      expect(deps.findPullRequests).not.toHaveBeenCalled();
      expect(writesFor(deps, "crew_ticket")).toStrictEqual([
        expect.objectContaining({ key: "crew_ticket", value: "TG-1" }),
      ]);
      expect(writesFor(deps, "crew_stage")).toStrictEqual([]);
      expect(writesFor(deps, "crew_labels")).toStrictEqual([]);
      expect(writesFor(deps, "crew_poller_heartbeat")).toStrictEqual([]);
    });

    it("tickets-only path no-ops when the resolved workspace backend isn't cmux", async () => {
      const config = makeConfig({ cmux: makeCmuxConfig({ enabled: false }) });
      const deps = makeDeps(config, {
        isCmuxAdapterActive: vi
          .fn<PrStageSyncDeps["isCmuxAdapterActive"]>()
          .mockResolvedValue(false),
      });
      const prStageSync = createPrStageSync(deps);

      await prStageSync.runOnce({ worktreeEntries: [entryFor("team-1")] });

      expect(deps.listCmuxWorkspaces).not.toHaveBeenCalled();
      expect(deps.writeCmuxStatus).not.toHaveBeenCalled();
    });

    it("logs a tickets-only error outcome and returns when listing workspaces fails", async () => {
      const config = makeConfig({ cmux: makeCmuxConfig({ enabled: false }) });
      const deps = makeDeps(config, {
        // oxlint-disable-next-line unicorn/no-useless-undefined -- undefined is the listing-failed signal here
        listCmuxWorkspaces: vi.fn<ListCmuxWorkspaces>().mockResolvedValue(undefined),
      });
      const prStageSync = createPrStageSync(deps);

      await prStageSync.runOnce({ worktreeEntries: [] });

      expect(deps.writeCmuxStatus).not.toHaveBeenCalled();
      expect(logEventMock).toHaveBeenCalledWith(
        "pr-stage-sync.tickets-only",
        expect.objectContaining({ outcome: "error", reason: "workspace_list_failed" }),
      );
    });

    it("catches an unexpected rejection from the tickets-only pass and logs it as an error outcome", async () => {
      const config = makeConfig({ cmux: makeCmuxConfig({ enabled: false }) });
      const deps = makeDeps(config, {
        listCmuxWorkspaces: vi
          .fn<ListCmuxWorkspaces>()
          .mockRejectedValue(new Error("unexpected cmux failure")),
      });
      const prStageSync = createPrStageSync(deps);

      await prStageSync.runOnce({ worktreeEntries: [entryFor("team-1")] });

      expect(logEventMock).toHaveBeenCalledWith(
        "pr-stage-sync.tickets-only",
        expect.objectContaining({ outcome: "error", reason: "unexpected cmux failure" }),
      );
    });

    it("logs a tickets-only status_write_failed outcome when a single workspace's write rejects", async () => {
      const config = makeConfig({ cmux: makeCmuxConfig({ enabled: false }) });
      const entry = entryFor("team-1");
      const failingWorkspace = workspaceFor("ws-fail", {
        currentDirectory: entry.dir,
        title: "TG-2 do a thing",
      });
      const deps = makeDeps(config, {
        listCmuxWorkspaces: vi.fn<ListCmuxWorkspaces>().mockResolvedValue([failingWorkspace]),
        writeCmuxStatus: vi
          .fn<PrStageSyncDeps["writeCmuxStatus"]>()
          .mockImplementation(rejectWritesFor(failingWorkspace.id)),
      });
      const prStageSync = createPrStageSync(deps);

      await prStageSync.runOnce({ worktreeEntries: [entry] });

      expect(logEventMock).toHaveBeenCalledWith(
        "pr-stage-sync.tickets-only",
        expect.objectContaining({ outcome: "error", reason: "status_write_failed" }),
      );
    });

    it("runs a sync pass when cmux.prStages.enabled is true", async () => {
      const config = makeConfig({ cmux: makeCmuxConfig({ enabled: true }) });
      const deps = makeDeps(config);
      const prStageSync = createPrStageSync(deps);

      await prStageSync.runOnce({ worktreeEntries: [] });

      expect(deps.isCmuxAdapterActive).toHaveBeenCalledTimes(1);
    });

    it("skips the pass and writes no cmux status when the orchestrator is in a dry run", async () => {
      const config = makeConfig({ cmux: makeCmuxConfig({ enabled: true }) });
      const deps = makeDeps(config);
      const prStageSync = createPrStageSync(deps);

      await prStageSync.runOnce({ worktreeEntries: [entryFor("adhoc")], dryRun: true });

      expect(deps.isCmuxAdapterActive).not.toHaveBeenCalled();
      expect(deps.listCmuxWorkspaces).not.toHaveBeenCalled();
      expect(deps.writeCmuxStatus).not.toHaveBeenCalled();
      expect(logEventMock).toHaveBeenCalledWith(
        "pr-stage-sync",
        expect.objectContaining({ outcome: "skipped", reason: "dry_run" }),
      );
    });

    it("still runs the pass when dryRun is explicitly false", async () => {
      const config = makeConfig({ cmux: makeCmuxConfig({ enabled: true }) });
      const deps = makeDeps(config);
      const prStageSync = createPrStageSync(deps);

      await prStageSync.runOnce({ worktreeEntries: [], dryRun: false });

      expect(deps.isCmuxAdapterActive).toHaveBeenCalledTimes(1);
    });
  });

  describe("syncOnce (ungated, still requires the cmux adapter)", () => {
    it("no-ops when the resolved workspace backend isn't cmux", async () => {
      const config = makeConfig();
      const deps = makeDeps(config, {
        isCmuxAdapterActive: vi
          .fn<PrStageSyncDeps["isCmuxAdapterActive"]>()
          .mockResolvedValue(false),
      });
      const prStageSync = createPrStageSync(deps);

      await prStageSync.syncOnce({ worktreeEntries: [entryFor("team-1")] });

      expect(deps.listCmuxWorkspaces).not.toHaveBeenCalled();
      expect(logEventMock).not.toHaveBeenCalled();
    });

    it("ignores dryRun — the label CLI's trailing sync and `crew stage refresh` always write", async () => {
      const config = makeConfig();
      const entry = entryFor("adhoc");
      const workspace = workspaceFor("ws-1", { currentDirectory: entry.dir, title: "no ticket" });
      const deps = makeDeps(config, {
        listCmuxWorkspaces: vi.fn<ListCmuxWorkspaces>().mockResolvedValue([workspace]),
        readCmuxStatus: vi
          .fn<PrStageSyncDeps["readCmuxStatus"]>()
          .mockResolvedValue(new Map([["crew_stage", "my_review"]])),
      });
      const prStageSync = createPrStageSync(deps);

      await prStageSync.syncOnce({ worktreeEntries: [entry], dryRun: true });

      expect(deps.listCmuxWorkspaces).toHaveBeenCalledTimes(1);
      expect(writesFor(deps, "crew_stage")).toStrictEqual([
        expect.objectContaining({ key: "crew_stage", value: "" }),
      ]);
    });

    it("logs an error outcome and returns when listing workspaces fails", async () => {
      const config = makeConfig();
      const deps = makeDeps(config, {
        // oxlint-disable-next-line unicorn/no-useless-undefined -- undefined is the listing-failed signal here
        listCmuxWorkspaces: vi.fn<ListCmuxWorkspaces>().mockResolvedValue(undefined),
      });
      const prStageSync = createPrStageSync(deps);

      await prStageSync.syncOnce({ worktreeEntries: [entryFor("team-1")] });

      expect(logEventMock).toHaveBeenCalledWith("pr-stage-sync", {
        outcome: "error",
        reason: "workspace_list_failed",
      });
      expect(deps.writeCmuxStatus).not.toHaveBeenCalled();
    });

    it("catches an unexpected rejection from the pass and logs it as an error outcome", async () => {
      const config = makeConfig();
      const deps = makeDeps(config, {
        listCmuxWorkspaces: vi
          .fn<ListCmuxWorkspaces>()
          .mockRejectedValue(new Error("unexpected cmux failure")),
      });
      const prStageSync = createPrStageSync(deps);

      await prStageSync.syncOnce({ worktreeEntries: [entryFor("team-1")] });

      expect(logEventMock).toHaveBeenCalledWith(
        "pr-stage-sync",
        expect.objectContaining({ outcome: "error", reason: "unexpected cmux failure" }),
      );
    });

    it("skips a cmux workspace that matches no groundcrew task", async () => {
      const config = makeConfig();
      const deps = makeDeps(config, {
        listCmuxWorkspaces: vi
          .fn<ListCmuxWorkspaces>()
          .mockResolvedValue([
            workspaceFor("other", { currentDirectory: "/elsewhere", taskId: "unmatched" }),
          ]),
      });
      const prStageSync = createPrStageSync(deps);

      await prStageSync.syncOnce({ worktreeEntries: [entryFor("team-1")] });

      expect(deps.findPullRequests).not.toHaveBeenCalled();
      expect(deps.writeCmuxStatus).not.toHaveBeenCalled();
      expect(logEventMock).toHaveBeenCalledWith(
        "pr-stage-sync",
        expect.objectContaining({ outcome: "updated", written: 0, cleared: 0, skipped: 0 }),
      );
    });

    it("matches a workspace by its reported current directory", async () => {
      const config = makeConfig();
      const entry = entryFor("team-1");
      const workspace = workspaceFor("ws-1", { currentDirectory: entry.dir, taskId: "unrelated" });
      const deps = makeDeps(config, {
        listCmuxWorkspaces: vi.fn<ListCmuxWorkspaces>().mockResolvedValue([workspace]),
      });
      const prStageSync = createPrStageSync(deps);

      await prStageSync.syncOnce({ worktreeEntries: [entry] });

      expect(deps.findPullRequests).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: entry.dir, branchName: entry.branchName }),
      );
    });

    it("falls back to matching a workspace by its taskId when the directory doesn't match", async () => {
      const config = makeConfig();
      const entry = entryFor("team-1");
      const workspace = workspaceFor("ws-1", { currentDirectory: undefined, taskId: entry.task });
      const deps = makeDeps(config, {
        listCmuxWorkspaces: vi.fn<ListCmuxWorkspaces>().mockResolvedValue([workspace]),
      });
      const prStageSync = createPrStageSync(deps);

      await prStageSync.syncOnce({ worktreeEntries: [entry] });

      expect(deps.findPullRequests).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: entry.dir, branchName: entry.branchName }),
      );
    });

    it("derives and writes the ticket from the workspace title even without a pull request", async () => {
      const config = makeConfig();
      // A non-ticket-shaped task id keeps the directory from also deriving a
      // ticket, so this test isolates the title-derivation path (the
      // directory form wins over the title form when both are present).
      const entry = entryFor("adhoc");
      const workspace = workspaceFor("ws-1", {
        currentDirectory: entry.dir,
        title: "TEAM-220 fix the thing",
      });
      const deps = makeDeps(config, {
        listCmuxWorkspaces: vi.fn<ListCmuxWorkspaces>().mockResolvedValue([workspace]),
        findPullRequests: vi.fn<FindPullRequests>().mockResolvedValue([]),
      });
      const prStageSync = createPrStageSync(deps);

      await prStageSync.syncOnce({ worktreeEntries: [entry] });

      expect(writesFor(deps, "crew_ticket")).toStrictEqual([
        { key: "crew_ticket", priority: -11, value: "TEAM-220" },
      ]);
    });

    it("clears stage and labels, but still writes the ticket, when the branch has no pull request", async () => {
      const config = makeConfig();
      const entry = entryFor("team-1");
      const workspace = workspaceFor("ws-1", {
        currentDirectory: entry.dir,
        title: "no ticket here",
      });
      const deps = makeDeps(config, {
        listCmuxWorkspaces: vi.fn<ListCmuxWorkspaces>().mockResolvedValue([workspace]),
        findPullRequests: vi.fn<FindPullRequests>().mockResolvedValue([]),
        readCmuxStatus: vi.fn<PrStageSyncDeps["readCmuxStatus"]>().mockResolvedValue(
          new Map([
            ["crew_stage", "ready_to_merge"],
            ["crew_labels", "tested"],
          ]),
        ),
      });
      const prStageSync = createPrStageSync(deps);

      await prStageSync.syncOnce({ worktreeEntries: [entry] });

      expect(writesFor(deps, "crew_stage")).toStrictEqual([
        { key: "crew_stage", priority: -10, value: "" },
      ]);
      expect(writesFor(deps, "crew_labels")).toStrictEqual([
        { key: "crew_labels", priority: -13, value: "" },
      ]);
      expect(writesFor(deps, "crew_ticket")).toStrictEqual([
        { key: "crew_ticket", priority: -11, value: "TEAM-1" },
      ]);
    });

    it("writes the derived stage and managed labels for a resolved pull request", async () => {
      const config = makeConfig();
      const entry = entryFor("team-1");
      const workspace = workspaceFor("ws-1", { currentDirectory: entry.dir, title: "no ticket" });
      const pullRequest = pullRequestFor();
      const detail = detailFor({ reviewDecision: "APPROVED" });
      const deps = makeDeps(config, {
        listCmuxWorkspaces: vi.fn<ListCmuxWorkspaces>().mockResolvedValue([workspace]),
        findPullRequests: vi.fn<FindPullRequests>().mockResolvedValue([pullRequest]),
        fetchPullRequestDetails: vi
          .fn<FetchPullRequestDetails>()
          .mockResolvedValue(new Map([[pullRequest.url, detail]])),
      });
      const prStageSync = createPrStageSync(deps);

      await prStageSync.syncOnce({ worktreeEntries: [entry] });

      expect(writesFor(deps, "crew_stage")).toStrictEqual([
        { key: "crew_stage", priority: -10, value: "ready_to_merge" },
      ]);
      expect(writesFor(deps, "crew_labels")).toStrictEqual([
        { key: "crew_labels", priority: -13, value: "self-reviewed,tested" },
      ]);
    });

    it("prefers an open pull request over merged/closed ones when several are returned", async () => {
      const config = makeConfig();
      const entry = entryFor("team-1");
      const workspace = workspaceFor("ws-1", { currentDirectory: entry.dir });
      const openPr = pullRequestFor({
        url: "https://github.com/acme/repo-a/pull/2",
        state: "open",
      });
      const mergedPr = pullRequestFor({
        url: "https://github.com/acme/repo-a/pull/1",
        state: "merged",
      });
      const deps = makeDeps(config, {
        listCmuxWorkspaces: vi.fn<ListCmuxWorkspaces>().mockResolvedValue([workspace]),
        findPullRequests: vi.fn<FindPullRequests>().mockResolvedValue([mergedPr, openPr]),
        fetchPullRequestDetails: vi
          .fn<FetchPullRequestDetails>()
          .mockResolvedValue(
            new Map([[openPr.url, detailFor({ url: openPr.url, state: "OPEN" })]]),
          ),
      });
      const prStageSync = createPrStageSync(deps);

      await prStageSync.syncOnce({ worktreeEntries: [entry] });

      expect(deps.fetchPullRequestDetails).toHaveBeenCalledWith(
        expect.objectContaining({ urls: [openPr.url] }),
      );
    });

    it("skips (never clears) stage and labels when a pull request exists but its detail is missing", async () => {
      const config = makeConfig();
      const entry = entryFor("team-1");
      const workspace = workspaceFor("ws-1", { currentDirectory: entry.dir, title: "no ticket" });
      const pullRequest = pullRequestFor();
      const deps = makeDeps(config, {
        listCmuxWorkspaces: vi.fn<ListCmuxWorkspaces>().mockResolvedValue([workspace]),
        findPullRequests: vi.fn<FindPullRequests>().mockResolvedValue([pullRequest]),
        fetchPullRequestDetails: vi.fn<FetchPullRequestDetails>().mockResolvedValue(new Map()),
        readCmuxStatus: vi
          .fn<PrStageSyncDeps["readCmuxStatus"]>()
          .mockResolvedValue(new Map([["crew_stage", "peer_review"]])),
      });
      const prStageSync = createPrStageSync(deps);

      await prStageSync.syncOnce({ worktreeEntries: [entry] });

      expect(writesFor(deps, "crew_stage")).toStrictEqual([]);
      expect(writesFor(deps, "crew_labels")).toStrictEqual([]);
    });

    it("leaves stage and labels untouched when the whole pull request detail batch fails, and logs an error", async () => {
      const config = makeConfig();
      const entry = entryFor("team-1");
      const workspace = workspaceFor("ws-1", { currentDirectory: entry.dir, title: "no ticket" });
      const pullRequest = pullRequestFor();
      const deps = makeDeps(config, {
        listCmuxWorkspaces: vi.fn<ListCmuxWorkspaces>().mockResolvedValue([workspace]),
        findPullRequests: vi.fn<FindPullRequests>().mockResolvedValue([pullRequest]),
        fetchPullRequestDetails: vi
          .fn<FetchPullRequestDetails>()
          .mockRejectedValue(new Error("gh api graphql failed")),
        readCmuxStatus: vi
          .fn<PrStageSyncDeps["readCmuxStatus"]>()
          .mockResolvedValue(new Map([["crew_stage", "peer_review"]])),
      });
      const prStageSync = createPrStageSync(deps);

      await prStageSync.syncOnce({ worktreeEntries: [entry] });

      expect(writesFor(deps, "crew_stage")).toStrictEqual([]);
      expect(logEventMock).toHaveBeenCalledWith(
        "pr-stage-sync",
        expect.objectContaining({ outcome: "error", reason: "pull_request_detail_lookup_failed" }),
      );
    });

    it("does not write a field whose desired value already matches the current cmux status", async () => {
      const config = makeConfig();
      const entry = entryFor("adhoc");
      const workspace = workspaceFor("ws-1", { currentDirectory: entry.dir, title: "no ticket" });
      const pullRequest = pullRequestFor();
      const detail = detailFor({ reviewDecision: "APPROVED" });
      const deps = makeDeps(config, {
        listCmuxWorkspaces: vi.fn<ListCmuxWorkspaces>().mockResolvedValue([workspace]),
        findPullRequests: vi.fn<FindPullRequests>().mockResolvedValue([pullRequest]),
        fetchPullRequestDetails: vi
          .fn<FetchPullRequestDetails>()
          .mockResolvedValue(new Map([[pullRequest.url, detail]])),
        readCmuxStatus: vi.fn<PrStageSyncDeps["readCmuxStatus"]>().mockResolvedValue(
          new Map([
            ["crew_stage", "ready_to_merge"],
            ["crew_labels", "self-reviewed,tested"],
          ]),
        ),
      });
      const prStageSync = createPrStageSync(deps);

      await prStageSync.syncOnce({ worktreeEntries: [entry] });

      expect(deps.writeCmuxStatus).toHaveBeenCalledTimes(1);
      expect(deps.writeCmuxStatus).toHaveBeenCalledWith(
        workspace.id,
        expect.objectContaining({ key: "crew_poller_heartbeat" }),
        undefined,
      );
      expect(logEventMock).toHaveBeenCalledWith(
        "pr-stage-sync",
        expect.objectContaining({ written: 0, cleared: 0 }),
      );
    });

    it("isolates one workspace's status-write failure from the rest and still logs an error outcome", async () => {
      const config = makeConfig();
      const failingEntry = entryFor("team-1");
      const okEntry = entryFor("team-2");
      const failingWorkspace = workspaceFor("ws-1", {
        currentDirectory: failingEntry.dir,
        title: "no ticket",
      });
      const okWorkspace = workspaceFor("ws-2", {
        currentDirectory: okEntry.dir,
        title: "no ticket",
      });
      const writeCmuxStatus = vi
        .fn<PrStageSyncDeps["writeCmuxStatus"]>()
        .mockImplementation(rejectWritesFor(failingWorkspace.id));
      const deps = makeDeps(config, {
        listCmuxWorkspaces: vi
          .fn<ListCmuxWorkspaces>()
          .mockResolvedValue([failingWorkspace, okWorkspace]),
        findPullRequests: vi.fn<FindPullRequests>().mockResolvedValue([]),
        writeCmuxStatus,
      });
      const prStageSync = createPrStageSync(deps);

      await prStageSync.syncOnce({ worktreeEntries: [failingEntry, okEntry] });

      expect(writeCmuxStatus).toHaveBeenCalledWith(
        okWorkspace.id,
        expect.objectContaining({ key: "crew_ticket" }),
        undefined,
      );
      expect(logEventMock).toHaveBeenCalledWith(
        "pr-stage-sync",
        expect.objectContaining({ outcome: "error", reason: "status_write_failed" }),
      );
    });

    it("preserves a workspace's saved stage and labels when PR discovery fails, without aborting the pass", async () => {
      const config = makeConfig();
      const entry = entryFor("team-1");
      const workspace = workspaceFor("ws-1", { currentDirectory: entry.dir, title: "no ticket" });
      const deps = makeDeps(config, {
        listCmuxWorkspaces: vi.fn<ListCmuxWorkspaces>().mockResolvedValue([workspace]),
        findPullRequests: vi
          .fn<FindPullRequests>()
          .mockRejectedValue(new Error("gh pr list failed")),
        readCmuxStatus: vi.fn<PrStageSyncDeps["readCmuxStatus"]>().mockResolvedValue(
          new Map([
            ["crew_stage", "ready_to_merge"],
            ["crew_labels", "self-reviewed,tested"],
          ]),
        ),
      });
      const prStageSync = createPrStageSync(deps);

      await prStageSync.syncOnce({ worktreeEntries: [entry] });

      expect(deps.fetchPullRequestDetails).not.toHaveBeenCalled();
      expect(writesFor(deps, "crew_stage")).toStrictEqual([]);
      expect(writesFor(deps, "crew_labels")).toStrictEqual([]);
      expect(logEventMock).toHaveBeenCalledWith(
        "pr-stage-sync",
        expect.objectContaining({ outcome: "error", reason: "pull_request_lookup_failed" }),
      );
    });

    it("writes the heartbeat on the watcher's own workspace when CMUX_WORKSPACE_ID is set", async () => {
      setEnvironmentVariable("CMUX_WORKSPACE_ID", "watcher-ws");
      const config = makeConfig();
      const deps = makeDeps(config);
      const prStageSync = createPrStageSync(deps);

      await prStageSync.syncOnce({ worktreeEntries: [] });

      expect(deps.writeCmuxStatus).toHaveBeenCalledWith(
        "watcher-ws",
        expect.objectContaining({ key: "crew_poller_heartbeat", priority: -12 }),
        undefined,
      );
    });

    it("skips the heartbeat write when CMUX_WORKSPACE_ID is unset and no task workspace matched either", async () => {
      deleteEnvironmentVariable("CMUX_WORKSPACE_ID");
      const config = makeConfig();
      const deps = makeDeps(config);
      const prStageSync = createPrStageSync(deps);

      await prStageSync.syncOnce({ worktreeEntries: [] });

      expect(deps.writeCmuxStatus).not.toHaveBeenCalled();
    });

    it("falls back to a matched task workspace's heartbeat when CMUX_WORKSPACE_ID is unset", async () => {
      deleteEnvironmentVariable("CMUX_WORKSPACE_ID");
      const config = makeConfig();
      const entry = entryFor("team-1");
      const workspace = workspaceFor("ws-1", { currentDirectory: entry.dir, title: "no ticket" });
      const deps = makeDeps(config, {
        listCmuxWorkspaces: vi.fn<ListCmuxWorkspaces>().mockResolvedValue([workspace]),
      });
      const prStageSync = createPrStageSync(deps);

      await prStageSync.syncOnce({ worktreeEntries: [entry] });

      expect(deps.writeCmuxStatus).toHaveBeenCalledWith(
        "ws-1",
        expect.objectContaining({ key: "crew_poller_heartbeat", priority: -12 }),
        undefined,
      );
    });

    it("reports heartbeat_write_failed when only the heartbeat write fails", async () => {
      const config = makeConfig();
      const entry = entryFor("adhoc");
      const workspace = workspaceFor("ws-1", { currentDirectory: entry.dir, title: "no ticket" });
      const writeCmuxStatus = vi
        .fn<PrStageSyncDeps["writeCmuxStatus"]>()
        .mockImplementation(rejectHeartbeatWrites());
      const deps = makeDeps(config, {
        listCmuxWorkspaces: vi.fn<ListCmuxWorkspaces>().mockResolvedValue([workspace]),
        findPullRequests: vi.fn<FindPullRequests>().mockResolvedValue([]),
        writeCmuxStatus,
      });
      const prStageSync = createPrStageSync(deps);

      await prStageSync.syncOnce({ worktreeEntries: [entry] });

      expect(writeCmuxStatus).toHaveBeenCalledTimes(1);
      expect(logEventMock).toHaveBeenCalledWith(
        "pr-stage-sync",
        expect.objectContaining({ outcome: "error", reason: "heartbeat_write_failed" }),
      );
    });

    it("forwards the abort signal through to the cmux and gh calls", async () => {
      const config = makeConfig();
      const entry = entryFor("team-1");
      const workspace = workspaceFor("ws-1", { currentDirectory: entry.dir, title: "no ticket" });
      const pullRequest = pullRequestFor();
      const deps = makeDeps(config, {
        listCmuxWorkspaces: vi.fn<ListCmuxWorkspaces>().mockResolvedValue([workspace]),
        findPullRequests: vi.fn<FindPullRequests>().mockResolvedValue([pullRequest]),
        fetchPullRequestDetails: vi
          .fn<FetchPullRequestDetails>()
          .mockResolvedValue(new Map([[pullRequest.url, detailFor()]])),
      });
      const prStageSync = createPrStageSync(deps);
      const { signal } = new AbortController();

      await prStageSync.syncOnce({ worktreeEntries: [entry], signal });

      expect(deps.listCmuxWorkspaces).toHaveBeenCalledWith(signal);
      expect(deps.readCmuxStatus).toHaveBeenCalledWith(workspace.id, signal);
      expect(deps.fetchPullRequestDetails).toHaveBeenCalledWith(
        expect.objectContaining({ urls: [pullRequest.url], signal }),
      );
    });

    it("logs a terminal event with written/cleared/skipped counts on success", async () => {
      const config = makeConfig();
      const entry = entryFor("adhoc");
      const workspace = workspaceFor("ws-1", { currentDirectory: entry.dir, title: "no ticket" });
      const pullRequest = pullRequestFor();
      const detail = detailFor({ reviewDecision: "APPROVED" });
      const deps = makeDeps(config, {
        listCmuxWorkspaces: vi.fn<ListCmuxWorkspaces>().mockResolvedValue([workspace]),
        findPullRequests: vi.fn<FindPullRequests>().mockResolvedValue([pullRequest]),
        fetchPullRequestDetails: vi
          .fn<FetchPullRequestDetails>()
          .mockResolvedValue(new Map([[pullRequest.url, detail]])),
      });
      const prStageSync = createPrStageSync(deps);

      await prStageSync.syncOnce({ worktreeEntries: [entry] });

      expect(logEventMock).toHaveBeenCalledWith("pr-stage-sync", {
        outcome: "updated",
        written: 2,
        cleared: 0,
        skipped: 1,
      });
    });
  });
});

function capabilities(overrides: Partial<HostCapabilities> = {}): HostCapabilities {
  return {
    hasSafehouse: false,
    hasSbx: false,
    hasCmux: false,
    hasTmux: false,
    hasZellij: false,
    isMacOS: true,
    isLinux: false,
    isSafehouseSupported: true,
    isSdxSupported: true,
    ...overrides,
  };
}

describe(isCmuxAdapterActive, () => {
  const detectHostCapabilitiesMock = vi.mocked(detectHostCapabilities);

  it("is true when the resolved workspace backend is cmux", async () => {
    detectHostCapabilitiesMock.mockResolvedValue(capabilities({ hasCmux: true }));
    const config = makeConfig({ workspaceKind: "cmux" });

    await expect(isCmuxAdapterActive(config)).resolves.toBe(true);
  });

  it("is false when the resolved workspace backend is not cmux", async () => {
    detectHostCapabilitiesMock.mockResolvedValue(capabilities({ hasTmux: true }));
    const config = makeConfig({ workspaceKind: "tmux" });

    await expect(isCmuxAdapterActive(config)).resolves.toBe(false);
  });

  it("is false when workspace-kind resolution throws", async () => {
    detectHostCapabilitiesMock.mockResolvedValue(capabilities());
    const config = makeConfig({ workspaceKind: "cmux" });

    await expect(isCmuxAdapterActive(config)).resolves.toBe(false);
  });
});

describe(createPrStageSyncDeps, () => {
  const detectHostCapabilitiesMock = vi.mocked(detectHostCapabilities);

  it("wires the real cmux/gh-backed implementations", () => {
    const config = makeConfig();

    const deps = createPrStageSyncDeps(config);

    expect(deps.config).toBe(config);
    expect(deps.findPullRequests).toBe(findPullRequestsForBranchOrThrow);
    expect(deps.fetchPullRequestDetails).toBe(fetchPullRequestDetails);
    expect(deps.listCmuxWorkspaces).toBe(listCmuxWorkspaceSummaries);
    expect(deps.readCmuxStatus).toBe(readCmuxStatus);
    expect(deps.writeCmuxStatus).toBe(writeCmuxStatus);
  });

  it("binds isCmuxAdapterActive to the same config it was built from", async () => {
    detectHostCapabilitiesMock.mockResolvedValue({
      hasSafehouse: false,
      hasSbx: false,
      hasCmux: true,
      hasTmux: false,
      hasZellij: false,
      isMacOS: true,
      isLinux: false,
      isSafehouseSupported: true,
      isSdxSupported: true,
    });
    const config = makeConfig({ workspaceKind: "cmux" });

    const deps = createPrStageSyncDeps(config);

    await expect(deps.isCmuxAdapterActive()).resolves.toBe(true);
  });
});
