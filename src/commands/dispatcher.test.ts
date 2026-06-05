import type { ResolvedConfig } from "../lib/config.ts";
import { canonicalLinearIssue } from "../lib/testing/canonicalFixtures.ts";
import { makeBoard } from "../testHelpers/boardFixtures.ts";
import type { BoardState, Issue } from "../lib/ticketSource.ts";
import { EXHAUSTED_USAGE } from "../lib/usage.ts";
import { workspaces } from "../lib/workspaces.ts";
import type { WorktreeEntry } from "../lib/worktrees.ts";
import { setVerbose } from "../lib/util.ts";
import { captureConsoleLog, type ConsoleCapture } from "../testHelpers/consoleCapture.ts";
import { createDispatcher, formatActiveSlotList } from "./dispatcher.ts";
import { setupWorkspace } from "./setupWorkspace.ts";

vi.mock(import("./setupWorkspace.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, setupWorkspace: vi.fn<typeof setupWorkspace>() };
});
vi.mock(import("../lib/workspaces.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    workspaces: {
      open: vi.fn<typeof actual.workspaces.open>(),
      probe: vi.fn<typeof actual.workspaces.probe>(),
      close: vi.fn<typeof actual.workspaces.close>(),
      interrupt: vi.fn<typeof actual.workspaces.interrupt>(),
      accessHint: vi.fn<typeof actual.workspaces.accessHint>(),
    },
  };
});

const setupMock = vi.mocked(setupWorkspace);
const workspacesProbeMock = vi.mocked(workspaces.probe);

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    sources: [],
    defaults: { hooks: {} },
    git: { remote: "origin", defaultBranch: "main", ...overrides.git },
    workspace: {
      projectDir: "/work",
      knownRepositories: ["repo-a", "repo-b"],
      ...overrides.workspace,
    },
    orchestrator: {
      maximumInProgress: 2,
      pollIntervalMilliseconds: 1000,
      sessionLimitPercentage: 85,
      ...overrides.orchestrator,
    },
    models: {
      default: "claude",
      definitions: {
        claude: { cmd: "claude", color: "#fff" },
        codex: { cmd: "codex", color: "#000" },
      },
      ...overrides.models,
    },
    prompts: { initial: "x", ...overrides.prompts },
    workspaceKind: overrides.workspaceKind ?? "auto",
    local: { runner: "auto" },
    logging: { file: "/tmp/groundcrew-test.log", ...overrides.logging },
  };
}

function todoIssue(overrides: Partial<Issue> = {}): Issue {
  return canonicalLinearIssue({
    naturalId: "team-1",
    status: "todo",
    repository: "repo-a",
    model: "claude",
    title: "Title",
    description: "",
    ...overrides,
  });
}

function activeIssue(overrides: Partial<Issue> = {}): Issue {
  return todoIssue({ status: "in-progress", ...overrides });
}

function boardOf(
  issues: Issue[],
  { parentSkips = [] }: { parentSkips?: BoardState["parentSkips"] } = {},
): BoardState {
  return { timestamp: "2025-01-01T00:00:00.000Z", issues, parentSkips };
}

function hostEntryFor(repository: string, ticket: string): WorktreeEntry {
  return {
    repository,
    ticket,
    branchName: `dev-${ticket.toLowerCase()}`,
    dir: `/work/${repository}-${ticket}`,
    kind: "host",
  };
}

describe(createDispatcher, () => {
  let consoleLog: ConsoleCapture;

  beforeEach(() => {
    consoleLog = captureConsoleLog();
    setupMock.mockResolvedValue();
    workspacesProbeMock.mockResolvedValue({ kind: "ok", names: new Set<string>() });
    // Dispatch telemetry (event= lines) is diagnostic, so it only reaches the
    // console under verbose — many cases assert that wording.
    setVerbose(true);
  });

  afterEach(() => {
    consoleLog.restore();
    setVerbose(false);
    vi.clearAllMocks();
  });

  describe("slot math", () => {
    it("starts a Todo ticket and marks it In Progress", async () => {
      const board = makeBoard();
      const dispatcher = createDispatcher({ config: makeConfig(), board });

      await dispatcher.runOnce({
        state: boardOf([todoIssue()]),
        worktreeEntries: [],
        usage: async () => ({}),
        dryRun: false,
      });

      expect(setupMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          ticket: "team-1",
          repository: "repo-a",
          model: "claude",
          details: { title: "Title", description: "" },
        }),
      );
      // oxlint-disable-next-line typescript/unbound-method -- board is a plain vi.fn stub; markInProgress has no `this` binding
      expect(board.markInProgress).toHaveBeenCalledWith(
        expect.objectContaining({ id: "linear:team-1" }),
      );
    });

    it("forwards the ticket url through setupWorkspace details when the source provides one", async () => {
      const board = makeBoard();
      const dispatcher = createDispatcher({ config: makeConfig(), board });

      await dispatcher.runOnce({
        state: boardOf([todoIssue({ url: "https://linear.app/example/issue/TEAM-1" })]),
        worktreeEntries: [],
        usage: async () => ({}),
        dryRun: false,
      });

      const setupCall = setupMock.mock.calls.at(-1);
      expect(setupCall?.[1]?.details.url).toBe("https://linear.app/example/issue/TEAM-1");
    });

    it("logs `At capacity` when no slots remain", async () => {
      const config = makeConfig({
        orchestrator: {
          maximumInProgress: 1,
          pollIntervalMilliseconds: 1,
          sessionLimitPercentage: 85,
        },
      });
      const board = makeBoard();
      const dispatcher = createDispatcher({ config, board });

      await dispatcher.runOnce({
        state: boardOf([activeIssue({ id: "linear:team-a" }), todoIssue({ id: "linear:team-b" })]),
        worktreeEntries: [],
        usage: async () => ({}),
        dryRun: false,
      });

      expect(setupMock).not.toHaveBeenCalled();
      expect(consoleLog.output()).toContain(
        "At capacity (1/1) [team-a(claude)], no new work to start",
      );
    });

    it("enumerates all in-progress tickets in the `At capacity` line, sorted by id", async () => {
      const config = makeConfig({
        orchestrator: {
          maximumInProgress: 2,
          pollIntervalMilliseconds: 1,
          sessionLimitPercentage: 85,
        },
      });
      const board = makeBoard();
      const dispatcher = createDispatcher({ config, board });

      await dispatcher.runOnce({
        // Deliberately reverse-ordered to prove the dispatcher sorts.
        state: boardOf([
          activeIssue({ id: "linear:team-b", model: "codex" }),
          activeIssue({ id: "linear:team-a", model: "claude" }),
        ]),
        worktreeEntries: [],
        usage: async () => ({}),
        dryRun: false,
      });

      expect(consoleLog.output()).toContain(
        "At capacity (2/2) [team-a(claude), team-b(codex)], no new work to start",
      );
    });

    it("logs `Slots 0/N used` on the happy path when no slots are occupied", async () => {
      const board = makeBoard();
      const dispatcher = createDispatcher({ config: makeConfig(), board });

      await dispatcher.runOnce({
        state: boardOf([todoIssue()]),
        worktreeEntries: [],
        usage: async () => ({}),
        dryRun: true,
      });

      expect(consoleLog.output()).toContain("Slots 0/2 used, starting 1 ticket(s): team-1(claude)");
    });

    it("enumerates already-running tickets when some slots are occupied", async () => {
      const config = makeConfig({
        orchestrator: {
          maximumInProgress: 3,
          pollIntervalMilliseconds: 1,
          sessionLimitPercentage: 85,
        },
      });
      const board = makeBoard();
      const dispatcher = createDispatcher({ config, board });

      await dispatcher.runOnce({
        state: boardOf([
          activeIssue({ id: "linear:team-running-b", model: "codex" }),
          activeIssue({ id: "linear:team-running-a", model: "claude" }),
          todoIssue({ id: "linear:team-new" }),
        ]),
        worktreeEntries: [],
        usage: async () => ({}),
        dryRun: true,
      });

      expect(consoleLog.output()).toContain(
        "Slots 2/3 used [team-running-a(claude), team-running-b(codex)], starting 1 ticket(s): team-new(claude)",
      );
    });

    it("includes in-progress issues with undefined model in the slot list as `id(?)`", async () => {
      const config = makeConfig({
        orchestrator: {
          maximumInProgress: 2,
          pollIntervalMilliseconds: 1,
          sessionLimitPercentage: 85,
        },
      });
      const board = makeBoard();
      const dispatcher = createDispatcher({ config, board });

      await dispatcher.runOnce({
        state: boardOf([
          // Defensive fallback for a source that cannot resolve model metadata.
          activeIssue({ id: "linear:team-stale", model: undefined }),
          todoIssue({ id: "linear:team-new" }),
        ]),
        worktreeEntries: [],
        usage: async () => ({}),
        dryRun: true,
      });

      expect(consoleLog.output()).toContain(
        "Slots 1/2 used [team-stale(?)], starting 1 ticket(s): team-new(claude)",
      );
    });

    it("logs `No Todo tickets` when nothing is queued", async () => {
      const board = makeBoard();
      const dispatcher = createDispatcher({ config: makeConfig(), board });

      await dispatcher.runOnce({
        state: boardOf([activeIssue()]),
        worktreeEntries: [],
        usage: async () => ({}),
        dryRun: false,
      });

      expect(consoleLog.output()).toContain("No Todo tickets");
    });

    it("ignores Todo tickets without an agent-* label (model: undefined)", async () => {
      // Unlabeled Todo tickets reach the dispatcher in the board snapshot
      // but should be filtered out via isGroundcrewIssue before eligibility.
      const board = makeBoard();
      const dispatcher = createDispatcher({ config: makeConfig(), board });

      await dispatcher.runOnce({
        state: boardOf([todoIssue({ model: undefined, repository: undefined })]),
        worktreeEntries: [],
        usage: async () => ({}),
        dryRun: false,
      });

      expect(setupMock).not.toHaveBeenCalled();
      // oxlint-disable-next-line typescript/unbound-method -- board is a plain vi.fn stub; markInProgress has no `this` binding
      expect(board.markInProgress).not.toHaveBeenCalled();
      expect(consoleLog.output()).toContain("No Todo tickets");
    });

    it("stops scanning Todo issues once eligible count reaches the slot cap", async () => {
      const config = makeConfig({
        orchestrator: {
          maximumInProgress: 1,
          pollIntervalMilliseconds: 1,
          sessionLimitPercentage: 85,
        },
      });
      const board = makeBoard();
      const dispatcher = createDispatcher({ config, board });

      await dispatcher.runOnce({
        state: boardOf([todoIssue({ id: "linear:team-1" }), todoIssue({ id: "linear:team-2" })]),
        worktreeEntries: [],
        usage: async () => ({}),
        dryRun: false,
      });

      expect(setupMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("priority ordering", () => {
    let board: ReturnType<typeof makeBoard>;
    let dispatcher: ReturnType<typeof createDispatcher>;

    beforeEach(() => {
      board = makeBoard();
      dispatcher = createDispatcher({
        config: makeConfig({
          orchestrator: {
            maximumInProgress: 1,
            pollIntervalMilliseconds: 1,
            sessionLimitPercentage: 85,
          },
        }),
        board,
      });
    });

    it("starts the highest-priority ticket first when slots are limited", async () => {
      const urgent = todoIssue({ id: "linear:team-urgent", priority: 1 });
      const medium = todoIssue({ id: "linear:team-medium", priority: 3 });
      const noPriority = todoIssue({ id: "linear:team-none" });

      await dispatcher.runOnce({
        state: boardOf([noPriority, medium, urgent]),
        worktreeEntries: [],
        usage: async () => ({}),
        dryRun: false,
      });

      expect(setupMock).toHaveBeenCalledTimes(1);
      expect(setupMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ ticket: "team-urgent" }),
      );
    });

    it("treats undefined priority (no priority) as lower than priority=4 (Low)", async () => {
      const low = todoIssue({ id: "linear:team-low", priority: 4 });
      const noPriority = todoIssue({ id: "linear:team-none" });

      await dispatcher.runOnce({
        state: boardOf([noPriority, low]),
        worktreeEntries: [],
        usage: async () => ({}),
        dryRun: false,
      });

      expect(setupMock).toHaveBeenCalledTimes(1);
      expect(setupMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ ticket: "team-low" }),
      );
    });
  });

  describe("blocker classification", () => {
    it("skips a ticket whose blocker is not in a terminal state", async () => {
      const board = makeBoard();
      const dispatcher = createDispatcher({ config: makeConfig(), board });

      await dispatcher.runOnce({
        state: boardOf([
          todoIssue({
            blockers: [
              {
                id: "linear:team-0",
                title: "Blocker",
                status: "in-progress",
              },
            ],
          }),
        ]),
        worktreeEntries: [],
        usage: async () => ({}),
        dryRun: false,
      });

      expect(setupMock).not.toHaveBeenCalled();
      expect(consoleLog.output()).toContain(
        "event=dispatch outcome=skipped reason=blocked ticket=team-1",
      );
    });

    it("dispatches a ticket whose blocker is terminal", async () => {
      const board = makeBoard();
      const dispatcher = createDispatcher({ config: makeConfig(), board });

      await dispatcher.runOnce({
        state: boardOf([
          todoIssue({
            blockers: [{ id: "linear:team-0", title: "Blocker", status: "done" }],
          }),
        ]),
        worktreeEntries: [],
        usage: async () => ({}),
        dryRun: false,
      });

      expect(setupMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ ticket: "team-1" }),
      );
    });

    it("conservatively skips a ticket when blocker pagination overflowed", async () => {
      const board = makeBoard();
      const dispatcher = createDispatcher({ config: makeConfig(), board });

      await dispatcher.runOnce({
        state: boardOf([todoIssue({ hasMoreBlockers: true })]),
        worktreeEntries: [],
        usage: async () => ({}),
        dryRun: false,
      });

      expect(consoleLog.output()).toContain(
        "event=dispatch outcome=skipped reason=blockers_paginated",
      );
    });

    it("conservatively skips a ticket when a blocker state is missing", async () => {
      const board = makeBoard();
      const dispatcher = createDispatcher({ config: makeConfig(), board });

      await dispatcher.runOnce({
        state: boardOf([
          todoIssue({
            blockers: [{ id: "linear:team-0", title: "Blocker", status: "other" }],
          }),
        ]),
        worktreeEntries: [],
        usage: async () => ({}),
        dryRun: false,
      });

      expect(setupMock).not.toHaveBeenCalled();
      expect(consoleLog.output()).toContain("blockers=linear:team-0:other");
    });

    // Regression: the lazy `usage` callback exists so all-blocked ticks don't
    // burn a codexbar HTTP call and a cmux/tmux shell-out for nothing.
    it("does not probe usage or workspaces when every Todo is blocked", async () => {
      const usageProbe = vi.fn<() => Promise<Record<string, never>>>().mockResolvedValue({});
      const board = makeBoard();
      const dispatcher = createDispatcher({ config: makeConfig(), board });

      await dispatcher.runOnce({
        state: boardOf([
          todoIssue({
            id: "linear:team-1",
            blockers: [
              {
                id: "linear:team-0",
                title: "Blocker",
                status: "in-progress",
              },
            ],
          }),
          todoIssue({
            id: "linear:team-2",
            blockers: [
              {
                id: "linear:team-0",
                title: "Blocker",
                status: "in-progress",
              },
            ],
          }),
        ]),
        worktreeEntries: [],
        usage: usageProbe,
        dryRun: false,
      });

      expect(usageProbe).not.toHaveBeenCalled();
      expect(workspacesProbeMock).not.toHaveBeenCalled();
      expect(consoleLog.output()).toContain("No eligible Todo tickets after blocker filtering");
    });
  });

  describe("agent-any resolution", () => {
    it("picks the model with the lowest session-used percent", async () => {
      const board = makeBoard();
      const dispatcher = createDispatcher({ config: makeConfig(), board });

      await dispatcher.runOnce({
        state: boardOf([todoIssue({ model: "any" })]),
        worktreeEntries: [],
        usage: async () => ({
          claude: { session: 0.6, sessionEndDuration: 30, weekly: null, weekEndDuration: null },
          codex: { session: 0.2, sessionEndDuration: 30, weekly: null, weekEndDuration: null },
        }),
        dryRun: false,
      });

      expect(setupMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ model: "codex" }),
      );
      expect(consoleLog.output()).toContain("Resolved agent-any for team-1 → codex");
    });

    it("skips agent-any when every model is exhausted", async () => {
      const board = makeBoard();
      const dispatcher = createDispatcher({ config: makeConfig(), board });

      await dispatcher.runOnce({
        state: boardOf([todoIssue({ model: "any" })]),
        worktreeEntries: [],
        usage: async () => ({
          claude: { session: 0.95, sessionEndDuration: 30, weekly: null, weekEndDuration: null },
          codex: { session: 0.95, sessionEndDuration: 30, weekly: null, weekEndDuration: null },
        }),
        dryRun: false,
      });

      expect(setupMock).not.toHaveBeenCalled();
      expect(consoleLog.output()).toContain("no model has available capacity");
    });
  });

  describe("eligibility", () => {
    it("resumes when worktree exists and a matching live workspace is present", async () => {
      workspacesProbeMock.mockResolvedValue({ kind: "ok", names: new Set(["team-1"]) });
      const board = makeBoard();
      const dispatcher = createDispatcher({ config: makeConfig(), board });

      await dispatcher.runOnce({
        state: boardOf([todoIssue()]),
        worktreeEntries: [hostEntryFor("repo-a", "team-1")],
        usage: async () => ({}),
        dryRun: false,
      });

      expect(setupMock).not.toHaveBeenCalled();
      // oxlint-disable-next-line typescript/unbound-method -- board is a plain vi.fn stub; markInProgress has no `this` binding
      expect(board.markInProgress).toHaveBeenCalledWith(
        expect.objectContaining({ id: "linear:team-1" }),
      );
      expect(consoleLog.output()).toContain("resuming with markInProgress");
    });

    it("skips when worktree exists but no live workspace matches", async () => {
      workspacesProbeMock.mockResolvedValue({ kind: "ok", names: new Set<string>() });
      const board = makeBoard();
      const dispatcher = createDispatcher({ config: makeConfig(), board });

      await dispatcher.runOnce({
        state: boardOf([todoIssue()]),
        worktreeEntries: [hostEntryFor("repo-a", "team-1")],
        usage: async () => ({}),
        dryRun: false,
      });

      expect(setupMock).not.toHaveBeenCalled();
      // oxlint-disable-next-line typescript/unbound-method -- board is a plain vi.fn stub; markInProgress has no `this` binding
      expect(board.markInProgress).not.toHaveBeenCalled();
      expect(consoleLog.output()).toContain("Run `crew cleanup");
    });

    it("retries next iteration when the workspace list is unavailable", async () => {
      workspacesProbeMock.mockResolvedValue({ kind: "unavailable" });
      const board = makeBoard();
      const dispatcher = createDispatcher({ config: makeConfig(), board });

      await dispatcher.runOnce({
        state: boardOf([todoIssue()]),
        worktreeEntries: [hostEntryFor("repo-a", "team-1")],
        usage: async () => ({}),
        dryRun: false,
      });

      expect(setupMock).not.toHaveBeenCalled();
      expect(consoleLog.output()).toContain("will retry next tick");
    });

    it("dry-run logs `Would start` without invoking setupWorkspace", async () => {
      const board = makeBoard();
      const dispatcher = createDispatcher({ config: makeConfig(), board });

      await dispatcher.runOnce({
        state: boardOf([todoIssue()]),
        worktreeEntries: [],
        usage: async () => ({}),
        dryRun: true,
      });

      expect(setupMock).not.toHaveBeenCalled();
      expect(consoleLog.output()).toContain("[dry-run] Would start team-1");
      expect(consoleLog.output()).toContain("(claude)");
    });

    it("rethrows workspace probe failures after attaching a usage rejection handler", async () => {
      const board = makeBoard();
      const dispatcher = createDispatcher({ config: makeConfig(), board });
      const usageProbe = vi
        .fn<() => Promise<Record<string, never>>>()
        .mockRejectedValue(new Error("usage failed"));
      workspacesProbeMock.mockRejectedValue(new Error("probe failed"));

      await expect(
        dispatcher.runOnce({
          state: boardOf([todoIssue()]),
          worktreeEntries: [hostEntryFor("repo-a", "team-1")],
          usage: usageProbe,
          dryRun: false,
        }),
      ).rejects.toThrow("probe failed");
    });
  });

  describe("session limits", () => {
    it("skips a Todo ticket whose model is over the session limit", async () => {
      const board = makeBoard();
      const dispatcher = createDispatcher({ config: makeConfig(), board });

      await dispatcher.runOnce({
        state: boardOf([todoIssue()]),
        worktreeEntries: [],
        usage: async () => ({
          claude: { session: 0.95, sessionEndDuration: 30, weekly: null, weekEndDuration: null },
        }),
        dryRun: false,
      });

      expect(setupMock).not.toHaveBeenCalled();
      expect(consoleLog.output()).toContain("session at 95%");
    });

    it("treats EXHAUSTED_USAGE as exhausted at sessionLimitPercentage=100", async () => {
      const board = makeBoard();
      const dispatcher = createDispatcher({
        config: makeConfig({
          orchestrator: {
            maximumInProgress: 2,
            pollIntervalMilliseconds: 1000,
            sessionLimitPercentage: 100,
          },
        }),
        board,
      });

      await dispatcher.runOnce({
        state: boardOf([todoIssue()]),
        worktreeEntries: [],
        usage: async () => ({ claude: EXHAUSTED_USAGE }),
        dryRun: false,
      });

      expect(setupMock).not.toHaveBeenCalled();
      expect(consoleLog.output()).toContain("(> 100%)");
    });
  });

  describe("weekly paced budget", () => {
    // Week = 7 days = 10080 minutes. weekEndDuration is "minutes until
    // the weekly window resets" — codexbar's signal for how much of the
    // week is left.
    const MINUTES_PER_DAY = 24 * 60;
    const MINUTES_PER_WEEK = 7 * MINUTES_PER_DAY;
    const dayEnd = (n: number): number => MINUTES_PER_WEEK - n * MINUTES_PER_DAY;

    it("does not gate when weekly usage is below the current day budget", async () => {
      // End of day 3 → 3/7 = 42.86% allowed. Used 30% — well under the line.
      const board = makeBoard();
      const dispatcher = createDispatcher({ config: makeConfig(), board });

      await dispatcher.runOnce({
        state: boardOf([todoIssue()]),
        worktreeEntries: [],
        usage: async () => ({
          claude: {
            session: 0.1,
            sessionEndDuration: 30,
            weekly: 0.3,
            weekEndDuration: dayEnd(3),
          },
        }),
        dryRun: false,
      });

      expect(setupMock).toHaveBeenCalledTimes(1);
    });

    it("allows the first-day budget immediately after weekly rollover", async () => {
      // 19 minutes after rollover is still day 1, so 1/7 = 14.29% is allowed.
      const board = makeBoard();
      const dispatcher = createDispatcher({ config: makeConfig(), board });

      await dispatcher.runOnce({
        state: boardOf([todoIssue({ model: "codex" })]),
        worktreeEntries: [],
        usage: async () => ({
          codex: {
            session: 0.1,
            sessionEndDuration: 30,
            weekly: 0.01,
            weekEndDuration: MINUTES_PER_WEEK - 19,
          },
        }),
        dryRun: false,
      });

      expect(setupMock).toHaveBeenCalledTimes(1);
      expect(consoleLog.output()).not.toContain("paced budget");
    });

    it("gates when weekly usage exceeds the current day budget", async () => {
      // End of day 1 → 1/7 = 14.29% allowed. Used 20% — over the line.
      const board = makeBoard();
      const dispatcher = createDispatcher({ config: makeConfig(), board });

      await dispatcher.runOnce({
        state: boardOf([todoIssue()]),
        worktreeEntries: [],
        usage: async () => ({
          claude: {
            session: 0.1,
            sessionEndDuration: 30,
            weekly: 0.2,
            weekEndDuration: dayEnd(1),
          },
        }),
        dryRun: false,
      });

      expect(setupMock).not.toHaveBeenCalled();
      expect(consoleLog.output()).toContain("claude weekly at 20.0% (> 14.3% paced budget)");
      expect(consoleLog.output()).toContain(`resets in ${dayEnd(1)}m`);
      expect(consoleLog.output()).toContain(
        "event=dispatch outcome=skipped reason=model_exhausted",
      );
    });

    // The contract is strict `>`. Pin the equality case so a future
    // refactor to `>=` can't silently start benching models early.
    it("does not gate when weekly usage exactly equals the current day budget", async () => {
      // Mid-week (3.5 days in) is day 4's bucket, and used exactly 4/7.
      const board = makeBoard();
      const dispatcher = createDispatcher({ config: makeConfig(), board });

      await dispatcher.runOnce({
        state: boardOf([todoIssue()]),
        worktreeEntries: [],
        usage: async () => ({
          claude: {
            session: 0.1,
            sessionEndDuration: 30,
            weekly: 4 / 7,
            weekEndDuration: MINUTES_PER_WEEK / 2,
          },
        }),
        dryRun: false,
      });

      expect(setupMock).toHaveBeenCalledTimes(1);
      expect(consoleLog.output()).not.toContain("paced budget");
    });

    // From the user's example: day 2 of the week with 0% interactive
    // usage gives nightly agents the full 2/7 = 28.57% budget — i.e.,
    // catch-up usage is permitted when behind the pace.
    it("permits catch-up usage when behind the pace", async () => {
      const board = makeBoard();
      const dispatcher = createDispatcher({ config: makeConfig(), board });

      await dispatcher.runOnce({
        state: boardOf([todoIssue()]),
        worktreeEntries: [],
        usage: async () => ({
          // 25% used at end of day 2 → allowed 28.57%, still under the line.
          claude: {
            session: 0.1,
            sessionEndDuration: 30,
            weekly: 0.25,
            weekEndDuration: dayEnd(2),
          },
        }),
        dryRun: false,
      });

      expect(setupMock).toHaveBeenCalledTimes(1);
    });

    it("ignores a null weekly value (no codexbar secondary window)", async () => {
      const board = makeBoard();
      const dispatcher = createDispatcher({ config: makeConfig(), board });

      await dispatcher.runOnce({
        state: boardOf([todoIssue()]),
        worktreeEntries: [],
        usage: async () => ({
          claude: { session: 0.1, sessionEndDuration: 30, weekly: null, weekEndDuration: null },
        }),
        dryRun: false,
      });

      expect(setupMock).toHaveBeenCalledTimes(1);
    });

    it("ignores a null weekEndDuration (can't compute pace this tick)", async () => {
      const board = makeBoard();
      const dispatcher = createDispatcher({ config: makeConfig(), board });

      await dispatcher.runOnce({
        state: boardOf([todoIssue()]),
        worktreeEntries: [],
        usage: async () => ({
          // Without weekEndDuration the dispatcher can't locate us in the
          // week, so the gate stays open even though 99% is over any
          // reasonable line.
          claude: {
            session: 0.1,
            sessionEndDuration: 30,
            weekly: 0.99,
            weekEndDuration: null,
          },
        }),
        dryRun: false,
      });

      expect(setupMock).toHaveBeenCalledTimes(1);
      expect(consoleLog.output()).not.toContain("paced budget");
    });

    it("clamps elapsed day to the valid week when codexbar reports an out-of-range duration", async () => {
      // Anomalous weekEndDuration > MINUTES_PER_WEEK (e.g., codexbar
      // returned a value from before the window started). Elapsed should
      // clamp to the first day bucket, so usage over 1/7 trips the gate.
      const board = makeBoard();
      const dispatcher = createDispatcher({ config: makeConfig(), board });

      await dispatcher.runOnce({
        state: boardOf([todoIssue()]),
        worktreeEntries: [],
        usage: async () => ({
          claude: {
            session: 0.1,
            sessionEndDuration: 30,
            weekly: 0.2,
            weekEndDuration: MINUTES_PER_WEEK + 5000,
          },
        }),
        dryRun: false,
      });

      expect(setupMock).not.toHaveBeenCalled();
      expect(consoleLog.output()).toContain("claude weekly at 20.0% (> 14.3% paced budget)");
    });

    it("does not double-gate when weekly is Infinity (session gate handles EXHAUSTED_USAGE)", async () => {
      const board = makeBoard();
      const dispatcher = createDispatcher({ config: makeConfig(), board });

      await dispatcher.runOnce({
        state: boardOf([todoIssue()]),
        worktreeEntries: [],
        usage: async () => ({ claude: EXHAUSTED_USAGE }),
        dryRun: false,
      });

      expect(setupMock).not.toHaveBeenCalled();
      // Session gate's log fires; weekly gate's "paced budget" log doesn't.
      const output = consoleLog.output();
      expect(output).toContain("session at Infinity%");
      expect(output).not.toContain("paced budget");
    });
  });

  describe("setup failures", () => {
    it("logs setupWorkspace failures without crashing the loop", async () => {
      setupMock.mockRejectedValue(new Error("boom"));
      const board = makeBoard();
      const dispatcher = createDispatcher({ config: makeConfig(), board });

      await dispatcher.runOnce({
        state: boardOf([todoIssue()]),
        worktreeEntries: [],
        usage: async () => ({}),
        dryRun: false,
      });

      expect(consoleLog.output()).toContain("Failed to start team-1: boom");
    });
  });

  describe("repository validation", () => {
    it("WARN-skips an issue whose repository is not in knownRepositories", async () => {
      const board = makeBoard();
      const dispatcher = createDispatcher({ config: makeConfig(), board });

      await dispatcher.runOnce({
        state: boardOf([todoIssue({ repository: "unknown-repo" })]),
        worktreeEntries: [],
        usage: async () => ({}),
        dryRun: false,
      });

      expect(setupMock).not.toHaveBeenCalled();
      // oxlint-disable-next-line typescript/unbound-method -- board is a plain vi.fn stub; markInProgress has no `this` binding
      expect(board.markInProgress).not.toHaveBeenCalled();
      expect(consoleLog.output()).toContain("references unknown repository unknown-repo");
    });

    it("short-circuits BEFORE usage() and workspaces.probe when every candidate has an unknown repo", async () => {
      // Pins the ordering invariant: repository validation runs ahead of the
      // expensive probes, so an all-unknown-repo tick doesn't pay the HTTP +
      // shell-out cost just to drop every candidate afterward.
      const board = makeBoard();
      const dispatcher = createDispatcher({ config: makeConfig(), board });
      const usageMock = vi.fn<() => Promise<Record<string, never>>>().mockResolvedValue({});

      await dispatcher.runOnce({
        state: boardOf([todoIssue({ repository: "unknown-repo" })]),
        worktreeEntries: [],
        usage: usageMock,
        dryRun: false,
      });

      expect(usageMock).not.toHaveBeenCalled();
      expect(workspacesProbeMock).not.toHaveBeenCalled();
      expect(consoleLog.output()).toContain("No eligible Todo tickets after repository validation");
    });

    it("dispatches issues whose repository is in knownRepositories", async () => {
      const board = makeBoard();
      const dispatcher = createDispatcher({ config: makeConfig(), board });

      await dispatcher.runOnce({
        state: boardOf([todoIssue({ repository: "repo-b" })]),
        worktreeEntries: [],
        usage: async () => ({}),
        dryRun: false,
      });

      expect(setupMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ repository: "repo-b" }),
      );
      // oxlint-disable-next-line typescript/unbound-method -- board is a plain vi.fn stub; markInProgress has no `this` binding
      expect(board.markInProgress).toHaveBeenCalledWith(
        expect.objectContaining({ id: "linear:team-1" }),
      );
    });
  });

  // Parent tickets are silently dropped by board.fetch (children filter).
  // Surfacing each parent skip makes the silent filter visible so operators
  // see WHY a Todo ticket isn't being picked up (PR #80 behavior).
  describe("parent ticket logging", () => {
    it("emits a dispatch skip event for every parent ticket in state.parentSkips", async () => {
      const board = makeBoard();
      const dispatcher = createDispatcher({ config: makeConfig(), board });

      // ParentSkip.id is canonical (source-prefixed) per the contract in
      // ticketSource.ts. The dispatcher strips the prefix before logging so
      // operator output is uniform with the rest of the dispatcher's log lines.
      await dispatcher.runOnce({
        state: boardOf([], {
          parentSkips: [
            { id: "linear:team-9", title: "Umbrella epic", childCount: 3 },
            { id: "linear:team-10", title: "Another epic", childCount: 1 },
          ],
        }),
        worktreeEntries: [],
        usage: async () => ({}),
        dryRun: false,
      });

      const output = consoleLog.output();
      expect(output).toContain(
        "event=dispatch outcome=skipped reason=parent_with_children ticket=team-9",
      );
      expect(output).toContain(
        "event=dispatch outcome=skipped reason=parent_with_children ticket=team-10",
      );
      expect(output).toMatch(/Skipping team-9: parent ticket with 3 sub-issue/);
      expect(output).not.toContain("linear:team-9");
      expect(output).not.toContain("linear:team-10");
    });

    it("does not log parent skips when state.parentSkips is empty", async () => {
      const board = makeBoard();
      const dispatcher = createDispatcher({ config: makeConfig(), board });

      await dispatcher.runOnce({
        state: boardOf([]),
        worktreeEntries: [],
        usage: async () => ({}),
        dryRun: false,
      });

      expect(consoleLog.output()).not.toContain("reason=parent_with_children");
    });
  });
});

describe(formatActiveSlotList, () => {
  it("returns an empty string when no slots are used", () => {
    expect(formatActiveSlotList([])).toBe("");
  });

  it("formats a single in-progress ticket as ` [id(model)]`", () => {
    const issue = activeIssue({ id: "linear:hrd-1", model: "claude" });
    expect(formatActiveSlotList([issue])).toBe(" [hrd-1(claude)]");
  });

  it("joins multiple tickets with `, ` and preserves caller-supplied order", () => {
    const a = activeIssue({ id: "linear:hrd-1", model: "claude" });
    const b = activeIssue({ id: "linear:hrd-2", model: "codex" });
    expect(formatActiveSlotList([a, b])).toBe(" [hrd-1(claude), hrd-2(codex)]");
  });

  it("renders an undefined model as `?`", () => {
    const issue = activeIssue({ id: "linear:hrd-9", model: undefined });
    expect(formatActiveSlotList([issue])).toBe(" [hrd-9(?)]");
  });
});
