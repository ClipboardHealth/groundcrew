import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LinearClient } from "@linear/sdk";

import type * as configModule from "../lib/config.ts";
import { loadConfig, type ResolvedConfig } from "../lib/config.ts";
import { getUsageByModel } from "../lib/usage.ts";
import type * as utilModule from "../lib/util.ts";
import { getLinearClient, sleep } from "../lib/util.ts";
import { workspaces } from "../lib/workspaces.ts";
import { type WorktreeEntry, worktrees } from "../lib/worktrees.ts";
import { captureConsoleLog, type ConsoleCapture } from "../testHelpers/consoleCapture.ts";
import { emptyTeardownResult } from "../testHelpers/teardownResult.ts";
import { orchestrate } from "./orchestrator.ts";
import { setupWorkspace } from "./setupWorkspace.ts";

vi.mock(import("../lib/config.ts"), async (importOriginal) => {
  const actual = await importOriginal<typeof configModule>();
  return { ...actual, loadConfig: vi.fn<typeof loadConfig>() };
});
vi.mock(import("../lib/util.ts"), async (importOriginal) => {
  const actual = await importOriginal<typeof utilModule>();
  return {
    ...actual,
    getLinearClient: vi.fn<typeof getLinearClient>(),
    sleep: vi.fn<typeof sleep>(),
    // log() is forwarded to stdout so test assertions on render output
    // can also see status/info lines emitted via log().
    log: vi.fn<typeof actual.log>((message: string) => {
      actual.writeOutput(`[log] ${message}`);
    }),
  };
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
vi.mock(import("../lib/worktrees.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    worktrees: {
      ...actual.worktrees,
      list: vi.fn<typeof actual.worktrees.list>(),
      teardown: vi.fn<typeof actual.worktrees.teardown>(),
    },
  };
});
vi.mock(import("../lib/usage.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, getUsageByModel: vi.fn<typeof getUsageByModel>() };
});
vi.mock(import("./setupWorkspace.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, setupWorkspace: vi.fn<typeof setupWorkspace>() };
});

type RawRequestMock = ReturnType<
  typeof vi.fn<(query: string, variables?: Record<string, unknown>) => Promise<unknown>>
>;

const loadConfigMock = vi.mocked(loadConfig);
const linearClientMock = vi.mocked(getLinearClient);
const sleepMock = vi.mocked(sleep);
const listMock = vi.mocked(worktrees.list);
const teardownMock = vi.mocked(worktrees.teardown);

const usageMock = vi.mocked(getUsageByModel);
const setupMock = vi.mocked(setupWorkspace);
const workspacesProbeMock = vi.mocked(workspaces.probe);

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    sources: overrides.sources ?? [],
    git: { remote: "origin", defaultBranch: "main", ...overrides.git },
    workspace: {
      projectDir: "/work",
      knownRepositories: ["repo-a", "repo-b", "api", "api-admin"],
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
    local: { runner: "auto", ...overrides.local },
    logging: { file: "/tmp/groundcrew-test.log", ...overrides.logging },
  };
}

interface IssueNodeStub {
  id: string;
  identifier: string;
  title: string;
  description?: string | undefined;
  updatedAt: string;
  state?: { id: string; name: string; type: string } | null;
  team?: { id: string; key: string } | null;
  assignee?: { name: string } | null;
  children?: { nodes: unknown[] };
  labels?: { nodes: { name: string }[] };
  inverseRelations?: {
    nodes: {
      type: string;
      issue?: {
        identifier: string;
        title: string;
        state?: { name: string; type?: string } | null;
      } | null;
    }[];
    pageInfo: { hasNextPage: boolean };
  };
}

function issue(overrides: Partial<IssueNodeStub>): IssueNodeStub {
  return {
    id: overrides.id ?? "uuid-1",
    identifier: overrides.identifier ?? "TEAM-1",
    title: overrides.title ?? "Title",
    description: "description" in overrides ? overrides.description : "Touches repo-a.",
    updatedAt: overrides.updatedAt ?? "2025-01-01T00:00:00.000Z",
    state:
      overrides.state === undefined
        ? { id: "state-todo", name: "Todo", type: "unstarted" }
        : overrides.state,
    team: overrides.team === undefined ? { id: "team-default", key: "TEAM" } : overrides.team,
    assignee: overrides.assignee === undefined ? { name: "Alice" } : overrides.assignee,
    children: overrides.children ?? { nodes: [] },
    // Default to a groundcrew-eligible label. Tests that exercise unlabeled
    // tickets explicitly override with `labels: { nodes: [] }`.
    labels: overrides.labels ?? { nodes: [{ name: "agent-claude" }] },
    ...(overrides.inverseRelations === undefined
      ? {}
      : { inverseRelations: overrides.inverseRelations }),
  };
}

function blockerState(
  status: string | undefined,
  stateType: string | undefined,
): { name: string; type?: string } | null {
  if (status === undefined) {
    return null;
  }
  if (stateType === undefined) {
    return { name: status };
  }
  return { name: status, type: stateType };
}

function blockingRelation(
  identifier: string,
  status?: string,
  stateType?: string,
): NonNullable<IssueNodeStub["inverseRelations"]>["nodes"][number] {
  return {
    type: "blocks",
    issue: {
      identifier,
      title: "Blocker",
      state: blockerState(status, stateType),
    },
  };
}

interface ClientStub {
  client: { rawRequest: RawRequestMock };
  team: ReturnType<typeof vi.fn>;
  updateIssue: ReturnType<typeof vi.fn>;
}

function makeClient(options: {
  viewerFound?: boolean;
  pages?: IssueNodeStub[][];
  omitInProgressState?: boolean;
}): ClientStub {
  const { viewerFound = true, pages = [[]], omitInProgressState = false } = options;
  const inProgressStateId = omitInProgressState ? undefined : "state-in-progress";
  const rawRequest =
    vi.fn<(query: string, variables?: Record<string, unknown>) => Promise<unknown>>();
  rawRequest.mockImplementation(async (query: string) => {
    if (query.includes("VerifyViewer")) {
      return {
        data: {
          viewer: viewerFound
            ? { id: "viewer-1", name: "Alice", email: "alice@example.com" }
            : null,
        },
      };
    }
    if (query.includes("BoardIssues")) {
      const callsSoFar = rawRequest.mock.calls.filter(([q]) => q.includes("BoardIssues")).length;
      const index = callsSoFar - 1;
      const page = pages[index] ?? [];
      const hasNext = index < pages.length - 1;
      return {
        data: {
          issues: {
            nodes: page,
            pageInfo: { hasNextPage: hasNext, endCursor: hasNext ? `cursor-${index}` : "" },
          },
        },
      };
    }
    return { data: {} };
  });

  interface StateNode {
    id: string;
    name: string;
    type: string;
  }
  return {
    client: { rawRequest },
    team: vi
      .fn<() => Promise<{ states: () => Promise<{ nodes: StateNode[] }> }>>()
      .mockResolvedValue({
        states: vi.fn<() => Promise<{ nodes: StateNode[] }>>().mockResolvedValue({
          nodes:
            inProgressStateId === undefined
              ? [{ id: "state-other", name: "Other", type: "unstarted" }]
              : [
                  { id: inProgressStateId, name: "In Progress", type: "started" },
                  { id: "state-todo", name: "Todo", type: "unstarted" },
                ],
        }),
      }),
    updateIssue: vi.fn<() => Promise<Record<string, never>>>().mockResolvedValue({}),
  };
}

function mockLinearClient(client: ClientStub): void {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- tests use the LinearClient surface consumed by orchestrate
  linearClientMock.mockReturnValue(client as unknown as LinearClient);
}

function hostEntryFor(repository: string, ticket: string): WorktreeEntry {
  return {
    repository,
    ticket,
    branchName: `rocky-${ticket.toLowerCase()}`,
    dir: `/work/${repository}-${ticket}`,
    kind: "host",
  };
}

function verifyViewerResponse(): unknown {
  return {
    data: {
      viewer: { id: "viewer-1", name: "Alice", email: "alice@example.com" },
    },
  };
}

function boardIssuesResponse(nodes: IssueNodeStub[]): unknown {
  return {
    data: {
      issues: {
        nodes,
        pageInfo: { hasNextPage: false, endCursor: "" },
      },
    },
  };
}

function mockBoardFailuresThenEmpty(client: ClientStub, failures: number, message: string): void {
  let boardCalls = 0;
  client.client.rawRequest.mockImplementation(async (query: string) => {
    if (query.includes("VerifyViewer")) {
      return verifyViewerResponse();
    }
    boardCalls += 1;
    if (boardCalls <= failures) {
      throw new Error(message);
    }
    return boardIssuesResponse([]);
  });
}

function stopAfterMoreThanSleepCalls(count: number): void {
  let sleepCalls = 0;
  sleepMock.mockImplementation(async () => {
    sleepCalls += 1;
    if (sleepCalls > count) {
      throw new Error("__stop__");
    }
  });
}

async function flushMicrotasks(count = 10): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    // oxlint-disable-next-line no-await-in-loop -- deterministic test helper for promise chains
    await Promise.resolve();
  }
}

describe(orchestrate, () => {
  let consoleLog: ConsoleCapture;

  beforeEach(() => {
    consoleLog = captureConsoleLog();
    loadConfigMock.mockResolvedValue(makeConfig());
    listMock.mockReturnValue([]);
    teardownMock.mockResolvedValue(emptyTeardownResult());
    sleepMock.mockResolvedValue();
    usageMock.mockResolvedValue({});
    setupMock.mockResolvedValue();
    workspacesProbeMock.mockResolvedValue({ kind: "ok", names: new Set<string>() });
  });

  afterEach(() => {
    vi.useRealTimers();
    consoleLog.restore();
    vi.clearAllMocks();
  });

  it("rejects when the Linear API key resolves to no viewer", async () => {
    const client = makeClient({ viewerFound: false });
    mockLinearClient(client);

    await expect(orchestrate({ watch: false, dryRun: false })).rejects.toThrow(
      /did not return a viewer/,
    );
  });

  it("logs the resolved viewer on successful verify", async () => {
    const client = makeClient({ pages: [[]] });
    mockLinearClient(client);

    await orchestrate({ watch: false, dryRun: false });

    expect(consoleLog.output()).toContain("Resolved Linear viewer: Alice");
  });

  it("emits the no-todo log line when the board is empty", async () => {
    const client = makeClient({ pages: [[]] });
    mockLinearClient(client);

    await orchestrate({ watch: false, dryRun: false });

    const out = consoleLog.output();
    expect(out).toContain("No Todo tickets to pick up");
  });

  it("starts a Todo ticket and marks it In Progress", async () => {
    const client = makeClient({
      pages: [
        [
          issue({
            identifier: "TEAM-1",
            state: { id: "state-todo", name: "Todo", type: "unstarted" },
          }),
        ],
      ],
    });
    mockLinearClient(client);

    await orchestrate({ watch: false, dryRun: false });

    expect(setupMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ ticket: "team-1", repository: "repo-a", model: "claude" }),
    );
    expect(client.updateIssue).toHaveBeenCalledWith("uuid-1", { stateId: "state-in-progress" });
  });

  it("infers the repository from a known repository name in the description", async () => {
    const client = makeClient({
      pages: [
        [
          issue({
            identifier: "TEAM-2",
            id: "uuid-2",
            description: "Some context. Affects api-admin somewhere.",
            state: { id: "state-todo", name: "Todo", type: "unstarted" },
          }),
        ],
      ],
    });
    mockLinearClient(client);

    await orchestrate({ watch: false, dryRun: false });

    expect(setupMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ repository: "api-admin" }),
    );
  });

  it("warns and skips dispatch when the description has no known repo", async () => {
    const client = makeClient({
      pages: [
        [
          issue({
            identifier: "TEAM-3",
            id: "uuid-3",
            description: "no repo here",
            state: { id: "state-todo", name: "Todo", type: "unstarted" },
          }),
        ],
      ],
    });
    mockLinearClient(client);

    await orchestrate({ watch: false, dryRun: false });

    expect(setupMock).not.toHaveBeenCalled();
    expect(consoleLog.output()).toMatch(
      /TEAM-3 has an agent-\* label but no known repository in its description/,
    );
  });

  it("resolves the model from an agent-* label", async () => {
    const client = makeClient({
      pages: [
        [
          issue({
            identifier: "TEAM-4",
            id: "uuid-4",
            state: { id: "state-todo", name: "Todo", type: "unstarted" },
            labels: { nodes: [{ name: "agent-codex" }] },
          }),
        ],
      ],
    });
    mockLinearClient(client);

    await orchestrate({ watch: false, dryRun: false });

    expect(setupMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ model: "codex" }),
    );
  });

  it("resolves agent-any to the model with the lowest session-used percent", async () => {
    usageMock.mockResolvedValue({
      claude: { session: 0.6, sessionEndDuration: 30, weekly: null, weekEndDuration: null },
      codex: { session: 0.2, sessionEndDuration: 30, weekly: null, weekEndDuration: null },
    });
    const client = makeClient({
      pages: [
        [
          issue({
            identifier: "TEAM-1",
            state: { id: "state-todo", name: "Todo", type: "unstarted" },
            labels: { nodes: [{ name: "agent-any" }] },
          }),
        ],
      ],
    });
    mockLinearClient(client);

    await orchestrate({ watch: false, dryRun: false });

    expect(setupMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ model: "codex" }),
    );
    const out = consoleLog.output();
    expect(out).toContain("Resolved agent-any for team-1 → codex");
  });

  it("resolves agent-any to the default model when no usage data is available", async () => {
    usageMock.mockResolvedValue({});
    const client = makeClient({
      pages: [
        [
          issue({
            identifier: "TEAM-1",
            state: { id: "state-todo", name: "Todo", type: "unstarted" },
            labels: { nodes: [{ name: "agent-any" }] },
          }),
        ],
      ],
    });
    mockLinearClient(client);

    await orchestrate({ watch: false, dryRun: false });

    expect(setupMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ model: "claude" }),
    );
  });

  it("agent-any excludes an exhausted model and picks the available one", async () => {
    usageMock.mockResolvedValue({
      claude: { session: 0.95, sessionEndDuration: 30, weekly: null, weekEndDuration: null },
      codex: { session: 0.5, sessionEndDuration: 30, weekly: null, weekEndDuration: null },
    });
    const client = makeClient({
      pages: [
        [
          issue({
            identifier: "TEAM-1",
            state: { id: "state-todo", name: "Todo", type: "unstarted" },
            labels: { nodes: [{ name: "agent-any" }] },
          }),
        ],
      ],
    });
    mockLinearClient(client);

    await orchestrate({ watch: false, dryRun: false });

    expect(setupMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ model: "codex" }),
    );
  });

  it("agent-any prefers the default model on a score tie even when iterated last", async () => {
    // claude is iterated first by Object.keys, but the user has set the
    // default to codex. With no usage data both score 0; the tiebreak
    // should hand the slot to codex (the default), not claude.
    loadConfigMock.mockResolvedValue(
      makeConfig({
        models: {
          default: "codex",
          definitions: {
            claude: { cmd: "claude", color: "#fff" },
            codex: { cmd: "codex", color: "#000" },
          },
        },
      }),
    );
    const client = makeClient({
      pages: [
        [
          issue({
            identifier: "TEAM-1",
            state: { id: "state-todo", name: "Todo", type: "unstarted" },
            labels: { nodes: [{ name: "agent-any" }] },
          }),
        ],
      ],
    });
    mockLinearClient(client);

    await orchestrate({ watch: false, dryRun: false });

    expect(setupMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ model: "codex" }),
    );
  });

  it("agent-any treats a null session reading as fully available", async () => {
    usageMock.mockResolvedValue({
      claude: { session: null, sessionEndDuration: null, weekly: null, weekEndDuration: null },
      codex: { session: 0.4, sessionEndDuration: 30, weekly: null, weekEndDuration: null },
    });
    const client = makeClient({
      pages: [
        [
          issue({
            identifier: "TEAM-1",
            state: { id: "state-todo", name: "Todo", type: "unstarted" },
            labels: { nodes: [{ name: "agent-any" }] },
          }),
        ],
      ],
    });
    mockLinearClient(client);

    await orchestrate({ watch: false, dryRun: false });

    expect(setupMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ model: "claude" }),
    );
  });

  it("skips agent-any tickets when every model is exhausted", async () => {
    usageMock.mockResolvedValue({
      claude: { session: 0.95, sessionEndDuration: 30, weekly: null, weekEndDuration: null },
      codex: { session: 0.95, sessionEndDuration: 30, weekly: null, weekEndDuration: null },
    });
    const client = makeClient({
      pages: [
        [
          issue({
            identifier: "TEAM-1",
            state: { id: "state-todo", name: "Todo", type: "unstarted" },
            labels: { nodes: [{ name: "agent-any" }] },
          }),
        ],
      ],
    });
    mockLinearClient(client);

    await orchestrate({ watch: false, dryRun: false });

    expect(setupMock).not.toHaveBeenCalled();
    const out = consoleLog.output();
    expect(out).toContain("no model has available capacity");
  });

  it("falls back to the default model when the agent-* label names an unknown model", async () => {
    const client = makeClient({
      pages: [
        [
          issue({
            identifier: "TEAM-5",
            id: "uuid-5",
            state: { id: "state-todo", name: "Todo", type: "unstarted" },
            labels: { nodes: [{ name: "agent-ghost" }] },
          }),
        ],
      ],
    });
    mockLinearClient(client);

    await orchestrate({ watch: false, dryRun: false });

    expect(setupMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ model: "claude" }),
    );
  });

  it("paginates issues across multiple pages and dispatches each", async () => {
    const client = makeClient({
      pages: [
        [issue({ identifier: "TEAM-1", id: "uuid-1" })],
        [issue({ identifier: "TEAM-2", id: "uuid-2" })],
      ],
    });
    mockLinearClient(client);

    await orchestrate({ watch: false, dryRun: false });

    const boardCalls = client.client.rawRequest.mock.calls.filter(([q]) =>
      q.includes("BoardIssues"),
    );
    expect(boardCalls).toHaveLength(2);
    expect(setupMock).toHaveBeenCalledTimes(2);
  });

  it("filters out parent issues that have children", async () => {
    const client = makeClient({
      pages: [
        [
          issue({
            identifier: "TEAM-1",
            id: "uuid-1",
            children: { nodes: [{ id: "child-1" }] },
          }),
          issue({ identifier: "TEAM-2", id: "uuid-2" }),
        ],
      ],
    });
    mockLinearClient(client);

    await orchestrate({ watch: false, dryRun: false });

    expect(setupMock).toHaveBeenCalledTimes(1);
    expect(setupMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ ticket: "team-2" }),
    );
  });

  it("dry-run logs would-start without invoking setupWorkspace", async () => {
    const client = makeClient({
      pages: [
        [
          issue({
            identifier: "TEAM-1",
            state: { id: "state-todo", name: "Todo", type: "unstarted" },
          }),
        ],
      ],
    });
    mockLinearClient(client);

    await orchestrate({ watch: false, dryRun: true });

    expect(setupMock).not.toHaveBeenCalled();
    const out = consoleLog.output();
    expect(out).toContain("[dry-run] Would start team-1");
  });

  it("respects maximumInProgress and reports capacity", async () => {
    loadConfigMock.mockResolvedValue(
      makeConfig({
        orchestrator: {
          maximumInProgress: 1,
          pollIntervalMilliseconds: 1,
          sessionLimitPercentage: 85,
        },
      }),
    );
    const client = makeClient({
      pages: [
        [
          issue({
            identifier: "TEAM-a",
            id: "uuid-a",
            state: { id: "state-active", name: "In Progress", type: "started" },
          }),
          issue({
            identifier: "TEAM-b",
            id: "uuid-b",
            state: { id: "state-todo", name: "Todo", type: "unstarted" },
          }),
        ],
      ],
    });
    mockLinearClient(client);

    await orchestrate({ watch: false, dryRun: false });

    expect(setupMock).not.toHaveBeenCalled();
    // Locks the lazy-usage contract: dispatcher must early-return on
    // at-capacity ticks without firing the codexbar shell-out.
    expect(usageMock).not.toHaveBeenCalled();
    const out = consoleLog.output();
    expect(out).toContain("At capacity");
  });

  it("logs `no Todo tickets` when nothing is queued", async () => {
    const client = makeClient({
      pages: [
        [
          issue({
            identifier: "TEAM-1",
            state: { id: "state-active", name: "In Progress", type: "started" },
          }),
        ],
      ],
    });
    mockLinearClient(client);

    await orchestrate({ watch: false, dryRun: false });

    const out = consoleLog.output();
    expect(out).toContain("No Todo tickets");
  });

  it("skips Todo tickets whose model is over the session limit", async () => {
    usageMock.mockResolvedValue({
      claude: { session: 0.95, sessionEndDuration: 30, weekly: null, weekEndDuration: null },
    });
    const client = makeClient({
      pages: [
        [
          issue({
            identifier: "TEAM-1",
            state: { id: "state-todo", name: "Todo", type: "unstarted" },
          }),
        ],
      ],
    });
    mockLinearClient(client);

    await orchestrate({ watch: false, dryRun: false });

    expect(setupMock).not.toHaveBeenCalled();
    const out = consoleLog.output();
    expect(out).toContain("session at 95%");
  });

  it("skips Todo tickets with non-terminal blockers before usage or agent-any resolution", async () => {
    const client = makeClient({
      pages: [
        [
          issue({
            identifier: "TEAM-1",
            state: { id: "state-todo", name: "Todo", type: "unstarted" },
            labels: { nodes: [{ name: "agent-any" }] },
            inverseRelations: {
              nodes: [blockingRelation("TEAM-0", "In Progress")],
              pageInfo: { hasNextPage: false },
            },
          }),
        ],
      ],
    });
    mockLinearClient(client);

    await orchestrate({ watch: false, dryRun: false });

    expect(setupMock).not.toHaveBeenCalled();
    const out = consoleLog.output();
    expect(out).toContain("event=dispatch outcome=skipped reason=blocked ticket=team-1");
    expect(out).toContain('blockers="team-0:In Progress"');
  });

  it("dispatches Todo tickets whose blockers are terminal", async () => {
    const client = makeClient({
      pages: [
        [
          issue({
            identifier: "TEAM-1",
            state: { id: "state-todo", name: "Todo", type: "unstarted" },
            inverseRelations: {
              nodes: [blockingRelation("TEAM-0", "Done", "completed")],
              pageInfo: { hasNextPage: false },
            },
          }),
        ],
      ],
    });
    mockLinearClient(client);

    await orchestrate({ watch: false, dryRun: false });

    expect(setupMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ ticket: "team-1" }),
    );
  });

  it("treats canceled blockers as terminal regardless of status name", async () => {
    const client = makeClient({
      pages: [
        [
          issue({
            identifier: "TEAM-1",
            inverseRelations: {
              nodes: [blockingRelation("TEAM-0", "Won't fix", "canceled")],
              pageInfo: { hasNextPage: false },
            },
          }),
        ],
      ],
    });
    mockLinearClient(client);

    await orchestrate({ watch: false, dryRun: false });

    expect(setupMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ ticket: "team-1" }),
    );
  });

  it("conservatively skips Todo tickets when a blocker state is missing", async () => {
    const client = makeClient({
      pages: [
        [
          issue({
            identifier: "TEAM-1",
            state: { id: "state-todo", name: "Todo", type: "unstarted" },
            inverseRelations: {
              nodes: [blockingRelation("TEAM-0")],
              pageInfo: { hasNextPage: false },
            },
          }),
        ],
      ],
    });
    mockLinearClient(client);

    await orchestrate({ watch: false, dryRun: false });

    expect(setupMock).not.toHaveBeenCalled();
    expect(consoleLog.output()).toContain("blockers=team-0:missing");
  });

  it("ignores non-blocking relations and skips malformed blockers", async () => {
    const client = makeClient({
      pages: [
        [
          issue({
            identifier: "TEAM-1",
            state: { id: "state-todo", name: "Todo", type: "unstarted" },
            inverseRelations: {
              nodes: [
                {
                  type: "relates",
                  issue: {
                    identifier: "TEAM-0",
                    title: "Related",
                    state: { name: "In Progress", type: "started" },
                  },
                },
                { type: "blocks", issue: null },
              ],
              pageInfo: { hasNextPage: false },
            },
          }),
        ],
      ],
    });
    mockLinearClient(client);

    await orchestrate({ watch: false, dryRun: false });

    expect(setupMock).not.toHaveBeenCalled();
    expect(consoleLog.output()).toContain("blockers=unknown:missing");
  });

  it("conservatively skips Todo tickets when blocker relations are paginated", async () => {
    const client = makeClient({
      pages: [
        [
          issue({
            identifier: "TEAM-1",
            state: { id: "state-todo", name: "Todo", type: "unstarted" },
            inverseRelations: {
              nodes: [],
              pageInfo: { hasNextPage: true },
            },
          }),
        ],
      ],
    });
    mockLinearClient(client);

    await orchestrate({ watch: false, dryRun: false });

    expect(setupMock).not.toHaveBeenCalled();
    const out = consoleLog.output();
    expect(out).toContain("blockers exceeded the v1 relation page size");
    expect(out).toContain("event=dispatch outcome=skipped reason=blockers_paginated");
  });

  it("does not let blocked Todo tickets consume available slots", async () => {
    loadConfigMock.mockResolvedValue(
      makeConfig({
        orchestrator: {
          maximumInProgress: 1,
          pollIntervalMilliseconds: 1,
          sessionLimitPercentage: 85,
        },
      }),
    );
    const client = makeClient({
      pages: [
        [
          issue({
            identifier: "TEAM-1",
            id: "uuid-1",
            state: { id: "state-todo", name: "Todo", type: "unstarted" },
            inverseRelations: {
              nodes: [blockingRelation("TEAM-0", "In Progress")],
              pageInfo: { hasNextPage: false },
            },
          }),
          issue({
            identifier: "TEAM-2",
            id: "uuid-2",
            state: { id: "state-todo", name: "Todo", type: "unstarted" },
          }),
        ],
      ],
    });
    mockLinearClient(client);

    await orchestrate({ watch: false, dryRun: false });

    expect(setupMock).toHaveBeenCalledTimes(1);
    expect(setupMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ ticket: "team-2" }),
    );
  });

  it("ignores usage failures and keeps starting tickets", async () => {
    usageMock.mockRejectedValue(new Error("codexbar offline"));
    const client = makeClient({
      pages: [
        [
          issue({
            identifier: "TEAM-1",
            state: { id: "state-todo", name: "Todo", type: "unstarted" },
          }),
        ],
      ],
    });
    mockLinearClient(client);

    await orchestrate({ watch: false, dryRun: false });

    expect(setupMock).toHaveBeenCalledWith(expect.anything(), expect.anything());
    expect(consoleLog.output()).toContain("Usage check failed, proceeding without limits");
  });

  it("does not swallow usage failures after a shutdown signal", async () => {
    const client = makeClient({
      pages: [
        [
          issue({
            identifier: "TEAM-1",
            state: { id: "state-todo", name: "Todo", type: "unstarted" },
          }),
        ],
      ],
    });
    mockLinearClient(client);
    usageMock.mockImplementation(async (_config, signal) => {
      process.listeners("SIGINT").at(-1)?.("SIGINT");
      expect(signal?.aborted).toBe(true);
      throw new Error("Command failed: codexbar usage\nSignal: SIGINT");
    });

    await orchestrate({ watch: true, dryRun: false });

    expect(setupMock).not.toHaveBeenCalled();
    expect(consoleLog.output()).toContain("Shutdown requested");
  });

  it("resumes a ticket whose worktree and workspace already exist", async () => {
    listMock.mockReturnValue([hostEntryFor("repo-a", "team-1")]);
    workspacesProbeMock.mockResolvedValue({ kind: "ok", names: new Set(["team-1"]) });
    const client = makeClient({
      pages: [
        [
          issue({
            identifier: "TEAM-1",
            state: { id: "state-todo", name: "Todo", type: "unstarted" },
          }),
        ],
      ],
    });
    mockLinearClient(client);

    await orchestrate({ watch: false, dryRun: false });

    expect(setupMock).not.toHaveBeenCalled();
    expect(client.updateIssue).toHaveBeenCalledWith("uuid-1", { stateId: "state-in-progress" });
  });

  it("skips a ticket whose worktree exists but workspace is missing", async () => {
    listMock.mockReturnValue([hostEntryFor("repo-a", "team-1")]);
    workspacesProbeMock.mockResolvedValue({ kind: "ok", names: new Set<string>() });
    const client = makeClient({
      pages: [
        [
          issue({
            identifier: "TEAM-1",
            state: { id: "state-todo", name: "Todo", type: "unstarted" },
          }),
        ],
      ],
    });
    mockLinearClient(client);

    await orchestrate({ watch: false, dryRun: false });

    expect(setupMock).not.toHaveBeenCalled();
    expect(client.updateIssue).not.toHaveBeenCalled();
    const out = consoleLog.output();
    expect(out).toContain("Run `crew cleanup");
  });

  it("skips a ticket when the workspace list is unavailable", async () => {
    listMock.mockReturnValue([hostEntryFor("repo-a", "team-1")]);
    workspacesProbeMock.mockResolvedValue({ kind: "unavailable" });
    const client = makeClient({
      pages: [
        [
          issue({
            identifier: "TEAM-1",
            state: { id: "state-todo", name: "Todo", type: "unstarted" },
          }),
        ],
      ],
    });
    mockLinearClient(client);

    await orchestrate({ watch: false, dryRun: false });

    expect(setupMock).not.toHaveBeenCalled();
    const out = consoleLog.output();
    expect(out).toContain("will retry next tick");
  });

  it("logs that no eligible tickets remain after filtering", async () => {
    listMock.mockReturnValue([hostEntryFor("repo-a", "team-1")]);
    workspacesProbeMock.mockResolvedValue({ kind: "ok", names: new Set<string>() });
    const client = makeClient({
      pages: [
        [
          issue({
            identifier: "TEAM-1",
            state: { id: "state-todo", name: "Todo", type: "unstarted" },
          }),
        ],
      ],
    });
    mockLinearClient(client);

    await orchestrate({ watch: false, dryRun: false });

    const out = consoleLog.output();
    expect(out).toContain("No eligible Todo tickets after");
  });

  it("logs setup failures without crashing the loop", async () => {
    setupMock.mockRejectedValue(new Error("boom"));
    const client = makeClient({
      pages: [
        [
          issue({
            identifier: "TEAM-1",
            state: { id: "state-todo", name: "Todo", type: "unstarted" },
          }),
        ],
      ],
    });
    mockLinearClient(client);

    await orchestrate({ watch: false, dryRun: false });

    const out = consoleLog.output();
    expect(out).toContain("Failed to start team-1");
  });

  it("throws when the team has no In Progress state", async () => {
    const teamWithoutInProgress = { id: "team-no-inprogress", key: "TEAM" };
    const client = makeClient({
      pages: [
        [
          issue({
            identifier: "TEAM-1",
            state: { id: "state-todo", name: "Todo", type: "unstarted" },
            team: teamWithoutInProgress,
          }),
        ],
      ],
      omitInProgressState: true,
    });
    mockLinearClient(client);

    await orchestrate({ watch: false, dryRun: false });

    const out = consoleLog.output();
    expect(out).toContain('Could not find a workflow state with type "started"');
  });

  it("formats the missing-team error with `?` when the issue has no team", async () => {
    const client = makeClient({
      pages: [
        [
          issue({
            identifier: "TEAM-1",
            state: { id: "state-todo", name: "Todo", type: "unstarted" },
            team: null,
          }),
        ],
      ],
    });
    mockLinearClient(client);

    await orchestrate({ watch: false, dryRun: false });

    const out = consoleLog.output();
    expect(out).toContain("team ?");
  });

  it("caches the in-progress state ID across tickets in the same team", async () => {
    const sharedTeam = { id: "team-shared", key: "TEAM" };
    const client = makeClient({
      pages: [
        [
          issue({
            identifier: "TEAM-1",
            id: "uuid-1",
            team: sharedTeam,
            state: { id: "state-todo", name: "Todo", type: "unstarted" },
          }),
          issue({
            identifier: "TEAM-2",
            id: "uuid-2",
            team: sharedTeam,
            state: { id: "state-todo", name: "Todo", type: "unstarted" },
          }),
        ],
      ],
    });
    mockLinearClient(client);

    await orchestrate({ watch: false, dryRun: false });

    expect(client.team).toHaveBeenCalledTimes(1);
  });

  it("hands a Done worktree to teardown", async () => {
    const entry = hostEntryFor("repo-a", "team-1");
    listMock.mockReturnValue([
      entry,
      hostEntryFor("repo-a", "OTHER-9"), // unrelated terminal-looking ticket: should be left alone
    ]);
    teardownMock.mockResolvedValue(emptyTeardownResult({ removed: [entry] }));
    const client = makeClient({
      pages: [
        [
          issue({
            identifier: "TEAM-1",
            id: "uuid-1",
            state: { id: "state-done", name: "Done", type: "completed" },
          }),
        ],
      ],
    });
    mockLinearClient(client);

    await orchestrate({ watch: false, dryRun: false });

    expect(teardownMock).toHaveBeenCalledWith(expect.anything(), [entry]);
  });

  it("cleans up worktrees for canceled tickets regardless of status name", async () => {
    const entry = hostEntryFor("repo-a", "team-1");
    listMock.mockReturnValue([entry]);
    teardownMock.mockResolvedValue(emptyTeardownResult({ removed: [entry] }));
    const client = makeClient({
      pages: [
        [
          issue({
            identifier: "TEAM-1",
            id: "uuid-1",
            state: { id: "state-released", name: "Released", type: "canceled" },
          }),
        ],
      ],
    });
    mockLinearClient(client);

    await orchestrate({ watch: false, dryRun: false });

    expect(teardownMock).toHaveBeenCalledWith(expect.anything(), [entry]);
  });

  it("logs Cleanup failed when teardown reports a worktree_remove failure", async () => {
    const entry = hostEntryFor("repo-a", "team-1");
    listMock.mockReturnValue([entry]);
    teardownMock.mockResolvedValue(
      emptyTeardownResult({
        failures: [{ entry, step: "worktree_remove", error: new Error("cleanup boom") }],
      }),
    );
    const client = makeClient({
      pages: [
        [
          issue({
            identifier: "TEAM-1",
            id: "uuid-1",
            state: { id: "state-done", name: "Done", type: "completed" },
          }),
        ],
      ],
    });
    mockLinearClient(client);

    await orchestrate({ watch: false, dryRun: false });

    const out = consoleLog.output();
    expect(out).toContain("Cleanup failed for team-1");
  });

  it("logs workspace_list_failed when teardown reports the adapter unavailable", async () => {
    listMock.mockReturnValue([hostEntryFor("repo-a", "team-1")]);
    teardownMock.mockResolvedValue(
      emptyTeardownResult({ workspaceProbe: { kind: "unavailable" } }),
    );
    const client = makeClient({
      pages: [
        [
          issue({
            identifier: "TEAM-1",
            id: "uuid-1",
            state: { id: "state-done", name: "Done", type: "completed" },
          }),
        ],
      ],
    });
    mockLinearClient(client);

    await orchestrate({ watch: false, dryRun: false });

    expect(teardownMock).toHaveBeenCalledWith(expect.anything(), [
      expect.objectContaining({ ticket: "team-1" }),
    ]);
    const out = consoleLog.output();
    expect(out).toContain("event=cleanup outcome=failed reason=workspace_list_failed");
  });

  it("logs workspace close failures from teardown", async () => {
    const entry = hostEntryFor("repo-a", "team-1");
    listMock.mockReturnValue([entry]);
    teardownMock.mockResolvedValue(
      emptyTeardownResult({
        failures: [{ entry, step: "workspace_close", error: new Error("close down") }],
      }),
    );
    const client = makeClient({
      pages: [
        [
          issue({
            identifier: "TEAM-1",
            id: "uuid-1",
            state: { id: "state-done", name: "Done", type: "completed" },
          }),
        ],
      ],
    });
    mockLinearClient(client);

    await orchestrate({ watch: false, dryRun: false });

    const out = consoleLog.output();
    expect(out).toContain("workspace close failed for team-1: close down");
    expect(out).toContain("event=cleanup outcome=failed reason=workspace_close_failed");
  });

  it("emits a dry-run cleanup notice without invoking teardown", async () => {
    listMock.mockReturnValue([hostEntryFor("repo-a", "team-1")]);
    const client = makeClient({
      pages: [
        [
          issue({
            identifier: "TEAM-1",
            id: "uuid-1",
            state: { id: "state-done", name: "Done", type: "completed" },
          }),
        ],
      ],
    });
    mockLinearClient(client);

    await orchestrate({ watch: false, dryRun: true });

    expect(teardownMock).not.toHaveBeenCalled();
    const out = consoleLog.output();
    expect(out).toContain("[dry-run]");
    expect(out).toContain("worktree(s) due for cleanup");
  });

  it("skips cleanup when there are no Done tickets", async () => {
    listMock.mockReturnValue([hostEntryFor("repo-a", "team-1")]);
    const client = makeClient({
      pages: [
        [
          issue({
            identifier: "TEAM-1",
            id: "uuid-1",
            state: { id: "state-todo", name: "Todo", type: "unstarted" },
          }),
        ],
      ],
    });
    mockLinearClient(client);

    await orchestrate({ watch: false, dryRun: false });

    expect(teardownMock).not.toHaveBeenCalled();
  });

  it("skips cleanup when the matching ticket isn't in the project", async () => {
    listMock.mockReturnValue([hostEntryFor("repo-a", "OTHER-1")]);
    const client = makeClient({
      pages: [
        [
          issue({
            identifier: "TEAM-1",
            id: "uuid-1",
            state: { id: "state-done", name: "Done", type: "completed" },
          }),
        ],
      ],
    });
    mockLinearClient(client);

    await orchestrate({ watch: false, dryRun: false });

    expect(teardownMock).not.toHaveBeenCalled();
  });

  it("logs and keeps polling when a tick throws in watch mode", async () => {
    const client = makeClient({});
    mockBoardFailuresThenEmpty(client, 4, "network down");
    mockLinearClient(client);

    stopAfterMoreThanSleepCalls(5);

    await expect(orchestrate({ watch: true, dryRun: false })).rejects.toThrow("__stop__");

    const out = consoleLog.output();
    expect(out).toContain("Error: network down");
  });

  it("keeps polling when a labeled ticket has no parseable repository in watch mode", async () => {
    // A single broken ticket previously aborted the entire watch loop. Now
    // the orchestrator warns and continues to the next tick so the rest of
    // the board still gets serviced.
    const client = makeClient({
      pages: [
        [
          issue({
            identifier: "TEAM-3",
            id: "uuid-3",
            description: "no repo here",
            state: { id: "state-todo", name: "Todo", type: "unstarted" },
          }),
        ],
      ],
    });
    mockLinearClient(client);
    stopAfterMoreThanSleepCalls(1);

    await expect(orchestrate({ watch: true, dryRun: false })).rejects.toThrow("__stop__");

    expect(setupMock).not.toHaveBeenCalled();
    expect(consoleLog.output()).toMatch(
      /TEAM-3 has an agent-\* label but no known repository in its description/,
    );
  });

  it("ignores models whose session window is null", async () => {
    usageMock.mockResolvedValue({
      claude: { session: null, sessionEndDuration: null, weekly: null, weekEndDuration: null },
    });
    const client = makeClient({
      pages: [
        [
          issue({
            identifier: "TEAM-1",
            state: { id: "state-todo", name: "Todo", type: "unstarted" },
          }),
        ],
      ],
    });
    mockLinearClient(client);

    await orchestrate({ watch: false, dryRun: false });

    expect(setupMock).toHaveBeenCalledWith(expect.anything(), expect.anything());
  });

  it("ignores models below the session limit threshold", async () => {
    usageMock.mockResolvedValue({
      claude: { session: 0.5, sessionEndDuration: 30, weekly: null, weekEndDuration: null },
    });
    const client = makeClient({
      pages: [
        [
          issue({
            identifier: "TEAM-1",
            state: { id: "state-todo", name: "Todo", type: "unstarted" },
          }),
        ],
      ],
    });
    mockLinearClient(client);

    await orchestrate({ watch: false, dryRun: false });

    expect(setupMock).toHaveBeenCalledWith(expect.anything(), expect.anything());
  });

  it("uses a `?` placeholder when sessionEndDuration is null on an exhausted model", async () => {
    usageMock.mockResolvedValue({
      claude: { session: 0.95, sessionEndDuration: null, weekly: null, weekEndDuration: null },
    });
    const client = makeClient({
      pages: [
        [
          issue({
            identifier: "TEAM-1",
            state: { id: "state-todo", name: "Todo", type: "unstarted" },
          }),
        ],
      ],
    });
    mockLinearClient(client);

    await orchestrate({ watch: false, dryRun: false });

    const out = consoleLog.output();
    expect(out).toContain("resets in ?m");
  });

  it("stops scanning Todo issues once eligible count reaches the slot cap", async () => {
    loadConfigMock.mockResolvedValue(
      makeConfig({
        orchestrator: {
          maximumInProgress: 1,
          pollIntervalMilliseconds: 1,
          sessionLimitPercentage: 85,
        },
      }),
    );
    const client = makeClient({
      pages: [
        [
          issue({ identifier: "TEAM-1", id: "uuid-1" }),
          issue({ identifier: "TEAM-2", id: "uuid-2" }),
        ],
      ],
    });
    mockLinearClient(client);

    await orchestrate({ watch: false, dryRun: false });

    expect(setupMock).toHaveBeenCalledTimes(1);
  });

  it("retries a fetchBoard rate-limit and succeeds", async () => {
    const client = makeClient({});
    mockBoardFailuresThenEmpty(client, 1, "Rate limit exceeded");
    mockLinearClient(client);

    await orchestrate({ watch: false, dryRun: false });

    const out = consoleLog.output();
    expect(out).toContain("Retrying in");
  });

  it("exits the watch loop when SIGINT arrives during retry backoff", async () => {
    const client = makeClient({});
    mockBoardFailuresThenEmpty(client, 1, "Rate limit exceeded");
    mockLinearClient(client);
    sleepMock.mockImplementation(async (_delay, signal) => {
      expect(signal).toBeInstanceOf(AbortSignal);
      process.listeners("SIGINT").at(-1)?.("SIGINT");
    });

    await orchestrate({ watch: true, dryRun: false });

    const boardCalls = client.client.rawRequest.mock.calls.filter(([query]) =>
      query.includes("BoardIssues"),
    );
    expect(boardCalls).toHaveLength(1);
    expect(consoleLog.output()).toContain("Shutdown requested");
  });

  it("exits the watch loop on SIGINT and removes its signal handlers", async () => {
    const client = makeClient({ pages: [[]] });
    mockLinearClient(client);

    const sigintBefore = process.listenerCount("SIGINT");
    const sigtermBefore = process.listenerCount("SIGTERM");

    // Fire SIGINT during the post-tick sleep by invoking the handler the
    // orchestrator installed. emit("SIGINT") would also poke vitest's own
    // SIGINT listener and could shut the worker down — calling our handler
    // directly keeps the blast radius inside the function under test.
    sleepMock.mockImplementation(async () => {
      const installed = process.listeners("SIGINT").at(-1);
      installed?.("SIGINT");
    });

    await orchestrate({ watch: true, dryRun: false });

    expect(process.listenerCount("SIGINT")).toBe(sigintBefore);
    expect(process.listenerCount("SIGTERM")).toBe(sigtermBefore);
    expect(consoleLog.output()).toContain("Shutdown requested");
  });

  it("exits the watch loop on SIGTERM", async () => {
    const client = makeClient({ pages: [[]] });
    mockLinearClient(client);

    sleepMock.mockImplementation(async () => {
      process.listeners("SIGTERM").at(-1)?.("SIGTERM");
    });

    await orchestrate({ watch: true, dryRun: false });

    expect(consoleLog.output()).toContain("Shutdown requested (SIGTERM)");
  });

  it("skips the post-tick sleep when SIGINT arrives mid-tick", async () => {
    const client = makeClient({ pages: [[]] });
    mockLinearClient(client);

    // Fire SIGINT inside the tick (via worktrees.list, which tick() calls
    // synchronously). After tick returns, the post-tick abort check should
    // short-circuit before we reach sleep.
    listMock.mockImplementation(() => {
      process.listeners("SIGINT").at(-1)?.("SIGINT");
      return [];
    });

    await orchestrate({ watch: true, dryRun: false });

    expect(sleepMock).not.toHaveBeenCalled();
  });

  it("passes the watch shutdown signal into workspace setup", async () => {
    const client = makeClient({
      pages: [[issue({ identifier: "TEAM-1", description: "Touches repo-a." })]],
    });
    mockLinearClient(client);
    let setupSignal: AbortSignal | undefined;

    setupMock.mockImplementation(async (_config, _options, runOptions) => {
      setupSignal = runOptions?.signal;
      process.listeners("SIGINT").at(-1)?.("SIGINT");
    });

    await orchestrate({ watch: true, dryRun: false });

    expect(setupSignal).toBeInstanceOf(AbortSignal);
    expect(setupSignal?.aborted).toBe(true);
    expect(sleepMock).not.toHaveBeenCalled();
  });

  it("exits the watch loop when a synchronous command reports SIGINT", async () => {
    const client = makeClient({ pages: [[]] });
    mockLinearClient(client);
    const cause = Object.assign(new Error("spawnSync git ENOENT"), { signal: "SIGINT" });

    listMock.mockImplementation(() => {
      throw new Error("Command failed: git worktree list\nSignal: SIGINT", { cause });
    });
    sleepMock.mockRejectedValue(new Error("__stop__"));

    await orchestrate({ watch: true, dryRun: false });

    expect(sleepMock).not.toHaveBeenCalled();
    expect(consoleLog.output()).toContain("Shutdown requested");
  });

  it("does not force-exit when a command reports SIGINT after the handler ran", async () => {
    const client = makeClient({ pages: [[]] });
    mockLinearClient(client);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((): never => {
      throw new Error("__exit__");
    });

    listMock.mockImplementation(() => {
      process.listeners("SIGINT").at(-1)?.("SIGINT");
      throw new Error("Command failed: git worktree list\nSignal: SIGINT");
    });

    await orchestrate({ watch: true, dryRun: false });

    expect(exitSpy).not.toHaveBeenCalled();
    expect(consoleLog.output()).not.toContain("forcing exit");
    exitSpy.mockRestore();
  });

  it("force-exits when SIGINT is pressed a second time during shutdown", async () => {
    const client = makeClient({ pages: [[]] });
    mockLinearClient(client);

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((): never => {
      throw new Error("__exit__");
    });

    sleepMock.mockImplementation(async () => {
      const installed = process.listeners("SIGINT").at(-1);
      installed?.("SIGINT");
      installed?.("SIGINT");
    });

    await expect(orchestrate({ watch: true, dryRun: false })).rejects.toThrow("__exit__");

    expect(exitSpy).toHaveBeenCalledWith(130);
    expect(consoleLog.output()).toContain("forcing exit");
    exitSpy.mockRestore();
  });

  it("force-exits when the shutdown grace period expires", async () => {
    vi.useFakeTimers();
    const client = makeClient({
      pages: [
        [
          issue({
            identifier: "TEAM-1",
            state: { id: "state-todo", name: "Todo", type: "unstarted" },
          }),
        ],
      ],
    });
    mockLinearClient(client);

    let releaseSetup: (() => void) | undefined;
    setupMock.mockImplementation(async () => {
      process.listeners("SIGINT").at(-1)?.("SIGINT");
      await new Promise<void>((resolve) => {
        releaseSetup = resolve;
      });
    });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((): never => {
      throw new Error("__exit__");
    });

    const promise = orchestrate({ watch: true, dryRun: false });
    await flushMicrotasks(50);
    expect(releaseSetup).toBeDefined();

    await expect(vi.advanceTimersByTimeAsync(10_000)).rejects.toThrow("__exit__");
    expect(exitSpy).toHaveBeenCalledWith(130);
    expect(consoleLog.output()).toContain("shutdown did not finish; forcing exit");

    releaseSetup?.();
    await expect(promise).resolves.toBeUndefined();
    exitSpy.mockRestore();
    vi.useRealTimers();
  });

  it("verifies pluggable sources at startup (shell adapter verify runs)", async () => {
    // Real subprocess: write a small bash script and point a shell source at
    // it. The script touches a marker file to confirm verify() invoked it;
    // failure-path tests live in invoke.test.ts and factory.test.ts.
    const dir = mkdtempSync(join(tmpdir(), "orchestrate-shell-verify-"));
    try {
      const verifyMarker = join(dir, "verify-ran");
      const verifyScript = join(dir, "verify.sh");
      writeFileSync(verifyScript, `#!/usr/bin/env bash\ntouch "${verifyMarker}"\n`);
      chmodSync(verifyScript, 0o755);

      loadConfigMock.mockResolvedValue(
        makeConfig({
          sources: [
            {
              kind: "shell",
              name: "test-source",
              commands: { verify: verifyScript, fetch: "echo '[]'" },
            },
          ],
        }),
      );
      const client = makeClient({ pages: [[]] });
      mockLinearClient(client);

      await orchestrate({ watch: false, dryRun: false });

      expect(existsSync(verifyMarker)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
