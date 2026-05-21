import type { LinearClient } from "@linear/sdk";

import type { BoardState, Issue } from "../lib/boardSource.ts";
import type { RunCommandOptions } from "../lib/commandRunner.ts";
import type { ResolvedConfig } from "../lib/config.ts";
import { FOLLOWUP_MARKER } from "../lib/linearComments.ts";
import type { WorktreeEntry } from "../lib/worktrees.ts";
import { captureConsoleLog, type ConsoleCapture } from "../testHelpers/consoleCapture.ts";
import { createReporter } from "./reporter.ts";

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
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test mock shares one recorder across runCommandAsync overloads.
    runCommandAsync: runCommandMock as unknown as typeof actual.runCommandAsync,
  };
});

interface ClientStub {
  comments: ReturnType<typeof vi.fn>;
  createComment: ReturnType<typeof vi.fn>;
}

function makeClient(overrides: Partial<ClientStub> = {}): ClientStub {
  return {
    comments:
      overrides.comments ??
      vi.fn<() => Promise<{ nodes: { body: string }[] }>>().mockResolvedValue({ nodes: [] }),
    createComment:
      overrides.createComment ??
      vi.fn<() => Promise<{ success: true }>>().mockResolvedValue({ success: true }),
  };
}

function asLinearClient(stub: ClientStub): LinearClient {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- tests only touch the LinearClient surface used by Reporter
  return stub as unknown as LinearClient;
}

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    linear: {
      projectSlug: "ai-strategy-aaaaaaaaaaaa",
      slugId: "aaaaaaaaaaaa",
      statuses: {
        todo: "Todo",
        inProgress: "In Progress",
        done: "Done",
        terminal: ["Done"],
      },
      ...overrides.linear,
    },
    git: { remote: "origin", defaultBranch: "main", ...overrides.git },
    workspace: {
      projectDir: "/work",
      knownRepositories: ["repo-a"],
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
      definitions: { claude: { cmd: "claude", color: "#fff" } },
      ...overrides.models,
    },
    prompts: { initial: "x", ...overrides.prompts },
    workspaceKind: overrides.workspaceKind ?? "auto",
    local: { runner: "auto", ...overrides.local },
    logging: { file: "/tmp/groundcrew-test.log", ...overrides.logging },
  };
}

function doneIssue(id: string, overrides: Partial<Issue> = {}): Issue {
  return {
    id,
    uuid: `uuid-${id}`,
    title: "Title",
    status: "Done",
    statusId: "state-done",
    assignee: "Alice",
    updatedAt: "2025-01-01T00:00:00.000Z",
    repository: "repo-a",
    model: "claude",
    teamId: "team-1",
    blockers: [],
    hasMoreBlockers: false,
    ...overrides,
  };
}

function todoIssue(id: string, overrides: Partial<Issue> = {}): Issue {
  return doneIssue(id, {
    status: "Todo",
    statusId: "state-todo",
    ...overrides,
  });
}

function boardOf(issues: Issue[]): BoardState {
  return { timestamp: "2025-01-01T00:00:00.000Z", issues };
}

function hostEntryFor(repository: string, ticket: string): WorktreeEntry {
  return {
    repository,
    ticket,
    branchName: `rocky-${ticket}`,
    dir: `/work/${repository}-${ticket}`,
    kind: "host",
  };
}

function stubGitAndGh(options: {
  commitLines?: number;
  shortStat?: string;
  prUrl?: string;
  noPr?: boolean;
}): void {
  const commitOutput =
    options.commitLines === undefined || options.commitLines === 0
      ? ""
      : Array.from({ length: options.commitLines }, (_, index) => `sha${index} msg ${index}`).join(
          "\n",
        );
  const shortStat = options.shortStat ?? "5 files changed, 142 insertions(+), 28 deletions(-)";

  runCommandMock.mockImplementation(async (command, args) => {
    if (command === "git" && args[0] === "log") {
      return commitOutput;
    }
    if (command === "git" && args[0] === "diff") {
      return shortStat;
    }
    if (command === "gh") {
      if (options.noPr === true || options.prUrl === undefined) {
        throw new Error("no PR open");
      }
      return options.prUrl;
    }
    throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
  });
}

describe(createReporter, () => {
  let consoleLog: ConsoleCapture;

  beforeEach(() => {
    consoleLog = captureConsoleLog();
  });

  afterEach(() => {
    consoleLog.restore();
    vi.clearAllMocks();
  });

  it("posts a followup with branch, PR, and diff stats when terminal+worktree+not-posted", async () => {
    const stub = makeClient();
    const reporter = createReporter({
      config: makeConfig(),
      client: asLinearClient(stub),
    });
    stubGitAndGh({
      commitLines: 5,
      shortStat: "7 files changed, 142 insertions(+), 28 deletions(-)",
      prUrl: "https://github.com/org/repo/pull/482",
    });

    await reporter.runOnce({
      state: boardOf([doneIssue("team-1")]),
      worktreeEntries: [hostEntryFor("repo-a", "team-1")],
      dryRun: false,
    });

    expect(stub.createComment).toHaveBeenCalledTimes(1);
    expect(stub.createComment).toHaveBeenCalledWith({
      issueId: "uuid-team-1",
      body: [
        "groundcrew finished TEAM-1.",
        "",
        "Branch: rocky-team-1 (5 commits)",
        "PR: https://github.com/org/repo/pull/482",
        "Files changed: 7 (+142 / -28)",
        "",
        FOLLOWUP_MARKER,
      ].join("\n"),
    });
    expect(consoleLog.output()).toContain("event=reporter outcome=posted ticket=team-1");
  });

  it("skips silently when the issue already has a followup comment", async () => {
    const stub = makeClient({
      comments: vi.fn<() => Promise<{ nodes: { body: string }[] }>>().mockResolvedValue({
        nodes: [{ body: `prior followup\n\n${FOLLOWUP_MARKER}` }],
      }),
    });
    const reporter = createReporter({
      config: makeConfig(),
      client: asLinearClient(stub),
    });

    await reporter.runOnce({
      state: boardOf([doneIssue("team-1")]),
      worktreeEntries: [hostEntryFor("repo-a", "team-1")],
      dryRun: false,
    });

    expect(stub.createComment).not.toHaveBeenCalled();
    expect(runCommandMock).not.toHaveBeenCalled();
    expect(consoleLog.output()).toContain(
      "event=reporter outcome=skipped reason=already_posted ticket=team-1",
    );
  });

  it("does nothing when the terminal ticket has no matching worktree (already cleaned up)", async () => {
    const stub = makeClient();
    const reporter = createReporter({
      config: makeConfig(),
      client: asLinearClient(stub),
    });

    await reporter.runOnce({
      state: boardOf([doneIssue("team-1")]),
      worktreeEntries: [],
      dryRun: false,
    });

    expect(stub.comments).not.toHaveBeenCalled();
    expect(stub.createComment).not.toHaveBeenCalled();
    expect(runCommandMock).not.toHaveBeenCalled();
  });

  it("does nothing when the only issues are non-terminal", async () => {
    const stub = makeClient();
    const reporter = createReporter({
      config: makeConfig(),
      client: asLinearClient(stub),
    });

    await reporter.runOnce({
      state: boardOf([todoIssue("team-1")]),
      worktreeEntries: [hostEntryFor("repo-a", "team-1")],
      dryRun: false,
    });

    expect(stub.comments).not.toHaveBeenCalled();
    expect(stub.createComment).not.toHaveBeenCalled();
  });

  it("writes nothing to Linear when dryRun is true", async () => {
    const stub = makeClient();
    const reporter = createReporter({
      config: makeConfig(),
      client: asLinearClient(stub),
    });

    await reporter.runOnce({
      state: boardOf([doneIssue("team-1")]),
      worktreeEntries: [hostEntryFor("repo-a", "team-1")],
      dryRun: true,
    });

    expect(stub.comments).not.toHaveBeenCalled();
    expect(stub.createComment).not.toHaveBeenCalled();
    expect(runCommandMock).not.toHaveBeenCalled();
    const output = consoleLog.output();
    expect(output).toContain("[dry-run]");
    expect(output).toContain("event=reporter outcome=skipped reason=dry_run ticket=team-1");
  });

  it("renders 'no PR found' when gh exits non-zero and still posts the comment", async () => {
    const stub = makeClient();
    const reporter = createReporter({
      config: makeConfig(),
      client: asLinearClient(stub),
    });
    stubGitAndGh({ commitLines: 3, noPr: true });

    await reporter.runOnce({
      state: boardOf([doneIssue("team-1")]),
      worktreeEntries: [hostEntryFor("repo-a", "team-1")],
      dryRun: false,
    });

    expect(stub.createComment).toHaveBeenCalledWith({
      issueId: "uuid-team-1",
      body: [
        "groundcrew finished TEAM-1.",
        "",
        "Branch: rocky-team-1 (3 commits)",
        "PR: no PR found",
        "Files changed: 5 (+142 / -28)",
        "",
        FOLLOWUP_MARKER,
      ].join("\n"),
    });
  });

  it("continues processing other tickets when one ticket's post fails", async () => {
    const failingCreate = vi.fn<() => Promise<{ success: true }>>();
    failingCreate.mockRejectedValueOnce(new Error("Linear API exploded"));
    failingCreate.mockResolvedValueOnce({ success: true });
    const stub = makeClient({ createComment: failingCreate });
    const reporter = createReporter({
      config: makeConfig(),
      client: asLinearClient(stub),
    });
    stubGitAndGh({
      commitLines: 1,
      prUrl: "https://github.com/org/repo/pull/1",
    });

    await reporter.runOnce({
      state: boardOf([doneIssue("team-1"), doneIssue("team-2", { uuid: "uuid-team-2" })]),
      worktreeEntries: [hostEntryFor("repo-a", "team-1"), hostEntryFor("repo-a", "team-2")],
      dryRun: false,
    });

    expect(failingCreate).toHaveBeenCalledTimes(2);
    const output = consoleLog.output();
    expect(output).toContain("event=reporter outcome=failed");
    expect(output).toContain("ticket=team-1");
    expect(output).toContain("event=reporter outcome=posted ticket=team-2");
  });

  it("uses git.defaultBranch from config when computing commit and diff ranges", async () => {
    const stub = makeClient();
    const reporter = createReporter({
      config: makeConfig({ git: { remote: "origin", defaultBranch: "trunk" } }),
      client: asLinearClient(stub),
    });
    stubGitAndGh({
      commitLines: 2,
      prUrl: "https://github.com/org/repo/pull/9",
    });

    await reporter.runOnce({
      state: boardOf([doneIssue("team-1")]),
      worktreeEntries: [hostEntryFor("repo-a", "team-1")],
      dryRun: false,
    });

    expect(runCommandMock).toHaveBeenCalledWith(
      "git",
      ["log", "--oneline", "trunk..HEAD"],
      expect.objectContaining({ cwd: "/work/repo-a-team-1" }),
    );
    expect(runCommandMock).toHaveBeenCalledWith(
      "git",
      ["diff", "--shortstat", "trunk...HEAD"],
      expect.objectContaining({ cwd: "/work/repo-a-team-1" }),
    );
  });

  it("respects custom terminal statuses", async () => {
    const stub = makeClient();
    const reporter = createReporter({
      config: makeConfig({
        linear: {
          projectSlug: "x-aaaaaaaaaaaa",
          slugId: "aaaaaaaaaaaa",
          statuses: {
            todo: "Todo",
            inProgress: "In Progress",
            done: "Done",
            terminal: ["Done", "Released"],
          },
        },
      }),
      client: asLinearClient(stub),
    });
    stubGitAndGh({
      commitLines: 1,
      prUrl: "https://github.com/org/repo/pull/1",
    });

    await reporter.runOnce({
      state: boardOf([doneIssue("team-1", { status: "Released", statusId: "state-released" })]),
      worktreeEntries: [hostEntryFor("repo-a", "team-1")],
      dryRun: false,
    });

    expect(stub.createComment).toHaveBeenCalledTimes(1);
  });

  it("passes the shutdown signal through to git/gh shell-outs", async () => {
    const { signal } = new AbortController();
    const stub = makeClient();
    const reporter = createReporter({
      config: makeConfig(),
      client: asLinearClient(stub),
    });
    stubGitAndGh({
      commitLines: 1,
      prUrl: "https://github.com/org/repo/pull/1",
    });

    await reporter.runOnce({
      state: boardOf([doneIssue("team-1")]),
      worktreeEntries: [hostEntryFor("repo-a", "team-1")],
      dryRun: false,
      signal,
    });

    for (const call of runCommandMock.mock.calls) {
      expect(call[2]?.signal).toBe(signal);
    }
  });

  it("reports zero commits when no commits separate the worktree from the base branch", async () => {
    const stub = makeClient();
    const reporter = createReporter({
      config: makeConfig(),
      client: asLinearClient(stub),
    });
    stubGitAndGh({
      commitLines: 0,
      shortStat: "",
      prUrl: "https://github.com/org/repo/pull/1",
    });

    await reporter.runOnce({
      state: boardOf([doneIssue("team-1")]),
      worktreeEntries: [hostEntryFor("repo-a", "team-1")],
      dryRun: false,
    });

    expect(stub.createComment).toHaveBeenCalledWith({
      issueId: "uuid-team-1",
      body: [
        "groundcrew finished TEAM-1.",
        "",
        "Branch: rocky-team-1 (0 commits)",
        "PR: https://github.com/org/repo/pull/1",
        "Files changed: 0 (+0 / -0)",
        "",
        FOLLOWUP_MARKER,
      ].join("\n"),
    });
  });
});
