import type { LinearClient } from "@linear/sdk";

import { captureConsoleLog, type ConsoleCapture } from "../testHelpers/consoleCapture.ts";
import {
  blockersFromRelations,
  createBoardSource,
  fetchBlockersForTicket,
  fetchInProgressIssueCount,
  fetchRawLinearIssue,
  fetchResolvedIssue,
  isIssueInProgress,
  isIssueTodo,
  isTerminalStatusForBlocker,
  isTerminalStatusForIssue,
  resolveModelFor,
  resolveRepositoryFor,
} from "./boardSource.ts";
import type { ResolvedConfig } from "./config.ts";

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

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    sources: [],
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
    local: { runner: "auto" },
    sandbox: { authRecipes: {}, gitDefaults: false },
    logging: { file: "/tmp/groundcrew-test.log", ...overrides.logging },
  };
}

function issueNode(overrides: Partial<IssueNodeStub>): IssueNodeStub {
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
    labels: overrides.labels ?? { nodes: [] },
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

type RawRequest = (query: string, variables?: Record<string, unknown>) => Promise<unknown>;

interface ClientStub {
  client: { rawRequest: ReturnType<typeof vi.fn<RawRequest>> };
}

function expectCallMatching(
  rawRequest: ReturnType<typeof vi.fn<RawRequest>>,
  queryPrefix: string,
): [string, Record<string, unknown>] {
  const call = rawRequest.mock.calls.find(([query]) => query.includes(queryPrefix));
  if (call === undefined) {
    throw new Error(`No call matched ${queryPrefix}`);
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- helper narrows the queue tuple shape after the find() guard above
  return call as [string, Record<string, unknown>];
}

interface ClientStubOptions {
  /** Whether `VerifyViewer` returns a viewer or null. Defaults to true. */
  viewerFound?: boolean;
  /** Pages returned for `BoardIssues`. Defaults to one empty page. */
  pages?: IssueNodeStub[][];
  /** Per-page counts for `InProgressIssues` paging. */
  activePages?: number[];
}

function makeClient(options: ClientStubOptions = {}): ClientStub {
  const { viewerFound = true, pages = [[]], activePages = [0] } = options;
  let boardCallIndex = 0;
  let activeCallIndex = 0;
  const rawRequest = vi.fn<RawRequest>(async (query: string) => {
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
      const index = boardCallIndex;
      boardCallIndex += 1;
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
    if (query.includes("InProgressIssues")) {
      const index = activeCallIndex;
      activeCallIndex += 1;
      const count = activePages[index] ?? 0;
      const hasNext = index < activePages.length - 1;
      return {
        data: {
          issues: {
            nodes: Array.from({ length: count }, (_value, nodeIndex) => ({
              id: `active-${index}-${nodeIndex}`,
              state: { type: "started" },
            })),
            pageInfo: { hasNextPage: hasNext, endCursor: hasNext ? `active-cursor-${index}` : "" },
          },
        },
      };
    }
    if (query.includes("ResolveIssue")) {
      return {
        data: {
          issue: {
            id: "uuid-1",
            title: "Title",
            description: "Touches repo-a.",
            team: { id: "team-default" },
            labels: { nodes: [] },
            state: { name: "Todo", type: "unstarted" },
          },
        },
      };
    }
    return { data: {} };
  });
  return { client: { rawRequest } };
}

function makeBoardSource(
  client: ClientStub,
  config: ResolvedConfig = makeConfig(),
): {
  source: ReturnType<typeof createBoardSource>;
  rawRequest: ClientStub["client"]["rawRequest"];
} {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- tests hit the LinearClient surface consumed by boardSource
  const source = createBoardSource({ config, client: client as unknown as LinearClient });
  return { source, rawRequest: client.client.rawRequest };
}

describe(createBoardSource, () => {
  let consoleLog: ConsoleCapture;

  beforeEach(() => {
    consoleLog = captureConsoleLog();
  });

  afterEach(() => {
    consoleLog.restore();
    vi.clearAllMocks();
  });

  describe("verify", () => {
    it("rejects when the API key does not resolve to a viewer", async () => {
      const { source } = makeBoardSource(makeClient({ viewerFound: false }));
      await expect(source.verify()).rejects.toThrow(/did not return a viewer/);
    });

    it("logs the resolved viewer on success", async () => {
      const { source } = makeBoardSource(makeClient({ viewerFound: true }));
      await source.verify();
      expect(consoleLog.output()).toContain("Resolved Linear viewer: Alice");
    });
  });

  describe("fetch", () => {
    it("returns an empty board when the viewer has no issues", async () => {
      const { source } = makeBoardSource(makeClient({ pages: [[]] }));
      const state = await source.fetch();
      expect(state.issues).toStrictEqual([]);
      expectTypeOf(state.timestamp).toBeString();
    });

    it("filters by assignee=isMe AND agent-* label AND actionable state types", async () => {
      const { source, rawRequest } = makeBoardSource(makeClient({ pages: [[]] }));
      await source.fetch();
      const [query, variables] = expectCallMatching(rawRequest, "BoardIssues");
      expect(query).toContain("assignee: { isMe: { eq: true } }");
      expect(query).toContain("labels: { some: { name: { startsWith: $agentLabelPrefix } } }");
      expect(query).toContain("state: { type: { in: $stateTypes } }");
      expect(variables).toMatchObject({
        agentLabelPrefix: "agent-",
        stateTypes: ["unstarted", "started", "completed", "canceled", "duplicate"],
      });
    });

    it("turns each issue node into an Issue carrying stateType", async () => {
      const node = issueNode({
        identifier: "TEAM-1",
        state: { id: "state-todo", name: "Todo", type: "unstarted" },
        labels: { nodes: [{ name: "agent-claude" }] },
      });
      const { source } = makeBoardSource(makeClient({ pages: [[node]] }));
      const state = await source.fetch();
      expect(state.issues).toHaveLength(1);
      const [issue] = state.issues;
      expect(issue?.id).toBe("team-1");
      expect(issue?.status).toBe("Todo");
      expect(issue?.stateType).toBe("unstarted");
      expect(issue?.repository).toBe("repo-a");
      expect(issue?.model).toBe("claude");
    });

    it("skips parent tickets with children and surfaces them as parentSkips when unstarted", async () => {
      const parent = issueNode({
        identifier: "TEAM-1",
        children: { nodes: [{ id: "child-1" }] },
        labels: { nodes: [{ name: "agent-claude" }] },
      });
      const { source } = makeBoardSource(makeClient({ pages: [[parent]] }));
      const state = await source.fetch();
      expect(state.issues).toStrictEqual([]);
      expect(state.parentSkips).toHaveLength(1);
      expect(state.parentSkips[0]).toMatchObject({ id: "team-1", childCount: 1 });
    });

    it("does not surface parent tickets in non-Todo states as parentSkips", async () => {
      const parent = issueNode({
        identifier: "TEAM-1",
        state: { id: "state-active", name: "In Progress", type: "started" },
        children: { nodes: [{ id: "child-1" }] },
        labels: { nodes: [{ name: "agent-claude" }] },
      });
      const { source } = makeBoardSource(makeClient({ pages: [[parent]] }));
      const state = await source.fetch();
      expect(state.parentSkips).toStrictEqual([]);
    });

    it("paginates until the API reports no more pages", async () => {
      const a = issueNode({ identifier: "TEAM-1", id: "uuid-1" });
      const b = issueNode({ identifier: "TEAM-2", id: "uuid-2" });
      const { source, rawRequest } = makeBoardSource(makeClient({ pages: [[a], [b]] }));
      const state = await source.fetch();
      expect(state.issues.map((i) => i.id)).toStrictEqual(["team-1", "team-2"]);
      const boardCalls = rawRequest.mock.calls.filter(([query]) => query.includes("BoardIssues"));
      expect(boardCalls).toHaveLength(2);
    });

    it("only resolves repository on Todo tickets with an agent-* label", async () => {
      const todo = issueNode({
        identifier: "TEAM-1",
        labels: { nodes: [{ name: "agent-claude" }] },
      });
      const inProgress = issueNode({
        identifier: "TEAM-2",
        id: "uuid-2",
        state: { id: "state-active", name: "In Progress", type: "started" },
        labels: { nodes: [{ name: "agent-claude" }] },
      });
      const { source } = makeBoardSource(makeClient({ pages: [[todo, inProgress]] }));
      const state = await source.fetch();
      const [first, second] = state.issues;
      expect(first?.repository).toBe("repo-a");
      expect(first?.model).toBe("claude");
      expect(second?.repository).toBeUndefined();
      expect(second?.model).toBeUndefined();
    });

    it("falls back to models.default when a Todo's agent-* label refers to a disabled shipped default", async () => {
      const config = makeConfig({
        models: {
          default: "claude",
          definitions: { claude: { cmd: "claude", color: "#fff" } },
          // codex is a shipped default but absent here = disabled
        },
      });
      const node = issueNode({
        identifier: "TEAM-1",
        labels: { nodes: [{ name: "agent-codex" }] },
      });
      const { source } = makeBoardSource(makeClient({ pages: [[node]] }), config);
      const state = await source.fetch();
      expect(state.issues[0]?.model).toBe("claude");
    });

    it("captures blockers from inverseRelations with stateType", async () => {
      const node = issueNode({
        identifier: "TEAM-1",
        labels: { nodes: [{ name: "agent-claude" }] },
        inverseRelations: {
          nodes: [blockingRelation("TEAM-9", "Done", "completed")],
          pageInfo: { hasNextPage: false },
        },
      });
      const { source } = makeBoardSource(makeClient({ pages: [[node]] }));
      const state = await source.fetch();
      const [issue] = state.issues;
      expect(issue?.blockers).toStrictEqual([
        { id: "team-9", title: "Blocker", status: "Done", stateType: "completed" },
      ]);
    });
  });
});

describe(fetchResolvedIssue, () => {
  let consoleLog: ConsoleCapture;
  beforeEach(() => {
    consoleLog = captureConsoleLog();
  });
  afterEach(() => {
    consoleLog.restore();
    vi.clearAllMocks();
  });

  it("returns the resolved repository and model from the issue description and labels", async () => {
    const client = makeClient();
    const resolved = await fetchResolvedIssue({
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- tests hit the LinearClient surface consumed by boardSource
      client: client as unknown as LinearClient,
      config: makeConfig(),
      ticket: "TEAM-1",
    });
    expect(resolved.repository).toBe("repo-a");
    expect(resolved.model).toBe("claude");
    expect(resolved.teamId).toBe("team-default");
  });

  it("falls back to models.default when the label refers to a disabled shipped default", async () => {
    const client = {
      client: {
        rawRequest: vi.fn<RawRequest>(async () => ({
          data: {
            issue: {
              id: "uuid-1",
              title: "Title",
              description: "Touches repo-a.",
              team: { id: "team-default" },
              labels: { nodes: [{ name: "agent-codex" }] },
              state: { name: "Todo", type: "unstarted" },
            },
          },
        })),
      },
    };
    const config = makeConfig({
      models: {
        default: "claude",
        definitions: {
          claude: { cmd: "claude", color: "#fff" },
          // codex disabled — exists in shipped defaults but not in resolved definitions
        },
      },
    });
    const resolved = await fetchResolvedIssue({
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- tests hit the LinearClient surface consumed by boardSource
      client: client as unknown as LinearClient,
      config,
      ticket: "TEAM-1",
    });
    expect(resolved.model).toBe("claude");
    expect(consoleLog.output()).toContain("agent-codex label refers to a disabled model");
  });

  it("throws RepositoryResolutionError when the description has no known repository", async () => {
    const client = {
      client: {
        rawRequest: vi.fn<RawRequest>(async () => ({
          data: {
            issue: {
              id: "uuid-1",
              title: "Title",
              description: "No matching repository.",
              team: { id: "team-default" },
              labels: { nodes: [{ name: "agent-claude" }] },
              state: { name: "Todo", type: "unstarted" },
            },
          },
        })),
      },
    };
    await expect(
      fetchResolvedIssue({
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- tests hit the LinearClient surface consumed by boardSource
        client: client as unknown as LinearClient,
        config: makeConfig(),
        ticket: "TEAM-1",
      }),
    ).rejects.toThrow(/No known repository/);
  });
});

describe(isIssueTodo, () => {
  it("is true only for stateType=unstarted", () => {
    expect(isIssueTodo({ stateType: "unstarted" })).toBe(true);
    expect(isIssueTodo({ stateType: "started" })).toBe(false);
    expect(isIssueTodo({ stateType: "completed" })).toBe(false);
    expect(isIssueTodo({ stateType: "duplicate" })).toBe(false);
  });
});

describe(isIssueInProgress, () => {
  it("is true only for stateType=started", () => {
    expect(isIssueInProgress({ stateType: "started" })).toBe(true);
    expect(isIssueInProgress({ stateType: "unstarted" })).toBe(false);
    expect(isIssueInProgress({ stateType: "completed" })).toBe(false);
    expect(isIssueInProgress({ stateType: "duplicate" })).toBe(false);
  });
});

describe(isTerminalStatusForIssue, () => {
  it("treats completed, canceled, and duplicate as terminal", () => {
    expect(isTerminalStatusForIssue({ stateType: "completed" })).toBe(true);
    expect(isTerminalStatusForIssue({ stateType: "canceled" })).toBe(true);
    expect(isTerminalStatusForIssue({ stateType: "duplicate" })).toBe(true);
  });

  it("treats unstarted/started as non-terminal", () => {
    expect(isTerminalStatusForIssue({ stateType: "unstarted" })).toBe(false);
    expect(isTerminalStatusForIssue({ stateType: "started" })).toBe(false);
  });
});

function blocker(overrides: { status?: string; stateType?: string } = {}) {
  return {
    id: "team-0",
    title: "Blocker",
    status: overrides.status,
    stateType: overrides.stateType,
  };
}

describe(isTerminalStatusForBlocker, () => {
  it("is false when stateType is undefined", () => {
    expect(isTerminalStatusForBlocker(blocker())).toBe(false);
  });

  it("treats completed, canceled, and duplicate blockers as terminal", () => {
    expect(isTerminalStatusForBlocker(blocker({ stateType: "completed" }))).toBe(true);
    expect(isTerminalStatusForBlocker(blocker({ stateType: "canceled" }))).toBe(true);
    expect(isTerminalStatusForBlocker(blocker({ stateType: "duplicate" }))).toBe(true);
  });

  it("treats unstarted/started blockers as non-terminal", () => {
    expect(isTerminalStatusForBlocker(blocker({ stateType: "unstarted" }))).toBe(false);
    expect(isTerminalStatusForBlocker(blocker({ stateType: "started" }))).toBe(false);
  });
});

describe(fetchRawLinearIssue, () => {
  it("returns the raw fields when the ticket exists", async () => {
    const client = makeClient();
    const raw = await fetchRawLinearIssue({
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- tests hit the LinearClient surface consumed by boardSource
      client: client as unknown as LinearClient,
      ticket: "team-1",
    });
    expect(raw.title).toBe("Title");
    expect(raw.stateName).toBe("Todo");
    expect(raw.stateType).toBe("unstarted");
    expect(raw.teamId).toBe("team-default");
    expect(raw.hasChildren).toBe(false);
  });

  it("coerces a null description to an empty string", async () => {
    const client = {
      client: {
        rawRequest: vi.fn<RawRequest>(async () => ({
          data: {
            issue: {
              id: "uuid-1",
              title: "Title",
              description: null,
              team: { id: "team-default" },
              labels: { nodes: [] },
              state: { name: "Todo", type: "unstarted" },
            },
          },
        })),
      },
    };
    const raw = await fetchRawLinearIssue({
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- tests hit the LinearClient surface consumed by boardSource
      client: client as unknown as LinearClient,
      ticket: "team-1",
    });
    expect(raw.description).toBe("");
  });

  it("throws a not-found error when the issue is null", async () => {
    const client = {
      client: {
        rawRequest: vi.fn<RawRequest>(async () => ({ data: { issue: null } })),
      },
    };
    await expect(
      fetchRawLinearIssue({
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- tests hit the LinearClient surface consumed by boardSource
        client: client as unknown as LinearClient,
        ticket: "team-9999",
      }),
    ).rejects.toThrow(/TEAM-9999 not found in Linear/);
  });
});

describe(fetchInProgressIssueCount, () => {
  it("counts matching in-progress tickets across all pages", async () => {
    const client = makeClient({ activePages: [2, 3] });
    const count = await fetchInProgressIssueCount({
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- tests hit the LinearClient surface consumed by boardSource
      client: client as unknown as LinearClient,
    });
    expect(count).toBe(5);
  });

  it("filters by assignee=isMe AND agent-* label AND state.type=started", async () => {
    const client = makeClient({ activePages: [0] });
    await fetchInProgressIssueCount({
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- tests hit the LinearClient surface consumed by boardSource
      client: client as unknown as LinearClient,
    });
    const [query, variables] = expectCallMatching(client.client.rawRequest, "InProgressIssues");
    expect(query).toContain("assignee: { isMe: { eq: true } }");
    expect(query).toContain('state: { type: { eq: "started" } }');
    expect(query).toContain("labels: { some: { name: { startsWith: $agentLabelPrefix } } }");
    expect(variables).toMatchObject({ agentLabelPrefix: "agent-" });
  });
});

describe(resolveRepositoryFor, () => {
  it("returns the repository when the description mentions a known one", () => {
    const result = resolveRepositoryFor({
      description: "Touches repo-a.",
      config: makeConfig(),
      ticket: "TEAM-1",
    });
    expect(result).toStrictEqual({ kind: "ok", repository: "repo-a" });
  });

  it("canonicalizes a bare repo mention to the full owner/repo entry from config", () => {
    const config = makeConfig({
      workspace: { projectDir: "/work", knownRepositories: ["acme/api"] },
    });
    expect(
      resolveRepositoryFor({ description: "api is sad", config, ticket: "TEAM-1" }),
    ).toStrictEqual({
      kind: "ok",
      repository: "acme/api",
    });
  });

  it("returns missing when a bare repo mention matches multiple configured repos", () => {
    const config = makeConfig({
      workspace: { projectDir: "/work", knownRepositories: ["acme/api", "beta/api"] },
    });
    expect(
      resolveRepositoryFor({ description: "api is sad", config, ticket: "TEAM-1" }),
    ).toStrictEqual({ kind: "missing" });
  });

  it("returns missing when no known repo is in the description", () => {
    expect(
      resolveRepositoryFor({
        description: "no matching repo here",
        config: makeConfig(),
        ticket: "TEAM-1",
      }),
    ).toStrictEqual({ kind: "missing" });
  });

  it("returns missing on empty description", () => {
    expect(
      resolveRepositoryFor({ description: "", config: makeConfig(), ticket: "TEAM-1" }),
    ).toStrictEqual({ kind: "missing" });
  });

  it("returns missing on undefined description", () => {
    expect(
      resolveRepositoryFor({ description: undefined, config: makeConfig(), ticket: "TEAM-1" }),
    ).toStrictEqual({ kind: "missing" });
  });
});

describe(resolveModelFor, () => {
  it("returns matched when label corresponds to a known model", () => {
    expect(
      resolveModelFor({ labels: [{ name: "agent-claude" }], config: makeConfig() }),
    ).toStrictEqual({ kind: "matched", model: "claude" });
  });

  it("returns no-label when no agent-* label is present", () => {
    expect(resolveModelFor({ labels: [{ name: "feature" }], config: makeConfig() })).toStrictEqual({
      kind: "no-label",
    });
  });

  it("returns no-label when the labels array is empty", () => {
    expect(resolveModelFor({ labels: [], config: makeConfig() })).toStrictEqual({
      kind: "no-label",
    });
  });

  it("returns agent-any when the label is agent-any", () => {
    expect(
      resolveModelFor({ labels: [{ name: "agent-any" }], config: makeConfig() }),
    ).toStrictEqual({ kind: "agent-any" });
  });

  it("returns disabled-fallback when the label matches a disabled shipped default", () => {
    const config = makeConfig({
      models: {
        default: "claude",
        definitions: {
          claude: { cmd: "claude", color: "#fff" },
          // codex is a shipped default but absent here = disabled
        },
      },
    });
    expect(resolveModelFor({ labels: [{ name: "agent-codex" }], config })).toStrictEqual({
      kind: "disabled-fallback",
      requestedModel: "codex",
      fallbackModel: "claude",
    });
  });
});

describe(fetchBlockersForTicket, () => {
  function makeBlockerClient(pages: { nodes: unknown[]; hasNextPage: boolean }[]): ClientStub {
    let callIndex = 0;
    return {
      client: {
        rawRequest: vi.fn<RawRequest>(async () => {
          const page = pages[callIndex] ?? { nodes: [], hasNextPage: false };
          callIndex += 1;
          return {
            data: {
              issue: {
                inverseRelations: {
                  nodes: page.nodes,
                  pageInfo: { hasNextPage: page.hasNextPage, endCursor: "cursor" },
                },
              },
            },
          };
        }),
      },
    };
  }

  it("returns blockers whose type is 'blocks'", async () => {
    const client = makeBlockerClient([
      {
        nodes: [
          blockingRelation("TEAM-9", "Done", "completed"),
          { type: "duplicates", issue: { identifier: "TEAM-10", title: "Other", state: null } },
        ],
        hasNextPage: false,
      },
    ]);
    const blockers = await fetchBlockersForTicket({
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- tests hit the LinearClient surface consumed by boardSource
      client: client as unknown as LinearClient,
      ticket: "TEAM-1",
      uuid: "uuid-1",
    });
    expect(blockers).toStrictEqual([
      { id: "team-9", title: "Blocker", status: "Done", stateType: "completed" },
    ]);
  });

  it("returns blockers from every relation page", async () => {
    const client = makeBlockerClient([
      { nodes: [blockingRelation("TEAM-9", "Todo", "unstarted")], hasNextPage: true },
      { nodes: [blockingRelation("TEAM-10", "Done", "completed")], hasNextPage: false },
    ]);
    const blockers = await fetchBlockersForTicket({
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- tests hit the LinearClient surface consumed by boardSource
      client: client as unknown as LinearClient,
      ticket: "TEAM-1",
      uuid: "uuid-1",
    });
    expect(blockers.map((b) => b.id)).toStrictEqual(["team-9", "team-10"]);
  });

  it("returns an empty array when the issue is null", async () => {
    const client = {
      client: {
        rawRequest: vi.fn<RawRequest>(async () => ({ data: { issue: null } })),
      },
    };
    const blockers = await fetchBlockersForTicket({
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- tests hit the LinearClient surface consumed by boardSource
      client: client as unknown as LinearClient,
      ticket: "TEAM-1",
      uuid: "uuid-1",
    });
    expect(blockers).toStrictEqual([]);
  });
});

describe(blockersFromRelations, () => {
  it("coerces a null issue state to undefined status and stateType", () => {
    const blockers = blockersFromRelations([
      {
        type: "blocks",
        issue: { identifier: "TEAM-9", title: "Blocker", state: null },
      },
    ]);
    expect(blockers).toStrictEqual([
      { id: "team-9", title: "Blocker", status: undefined, stateType: undefined },
    ]);
  });

  it("drops non-blocks relations", () => {
    const blockers = blockersFromRelations([
      {
        type: "duplicates",
        issue: { identifier: "TEAM-9", title: "Other", state: null },
      },
    ]);
    expect(blockers).toStrictEqual([]);
  });
});
