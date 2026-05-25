import type { LinearClient } from "@linear/sdk";

import type { ResolvedConfig } from "../../config.ts";
import {
  canonicalStatusForStateType,
  createInProgressStateLookup,
  createLinearViewBoardSource,
  createLinearViewTicketSource,
  fetchViewBoard,
  resolveOneByIdentifier,
  verifyView,
} from "./viewSource.ts";

type RawRequestFn = (query: string, variables?: unknown) => Promise<{ data?: unknown }>;

interface MockedLinearClient {
  client: { rawRequest: RawRequestFn };
  updateIssue: (uuid: string, args: { stateId: string }) => Promise<void>;
}

function mockClient(rawResponse?: unknown): MockedLinearClient {
  return {
    client: {
      rawRequest: async () => ({ data: rawResponse }),
    },
    updateIssue: async () => {
      /* no-op */
    },
  };
}

interface QueryRouterEntry {
  match: string;
  response: { data: unknown };
}

function routedRawRequest(entries: QueryRouterEntry[]): RawRequestFn {
  return async (query) => {
    const match = entries.find((entry) => query.includes(entry.match));
    if (match === undefined) {
      throw new Error(`unexpected query in test: ${query.slice(0, 80)}`);
    }
    return match.response;
  };
}

function asClient(client: MockedLinearClient): LinearClient {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- mocked surface narrows the full LinearClient via the helper
  return client as unknown as LinearClient;
}

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    linear: { projects: [], ...overrides.linear },
    sources: [],
    git: { remote: "origin", defaultBranch: "main", ...overrides.git },
    workspace: {
      projectDir: "/work",
      knownRepositories: ["org/repo-a"],
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

interface ViewIssueNodeShape {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  updatedAt: string;
  state: { id: string; name: string; type: string };
  team: { id: string; key: string };
  assignee?: { name: string } | null;
  project?: { slugId: string } | null;
  children: { nodes: { id: string }[] };
  labels: { nodes: { name: string }[] };
  inverseRelations?: { nodes: unknown[]; pageInfo: { hasNextPage: boolean } };
}

function makeIssueNode(overrides: Partial<ViewIssueNodeShape> = {}): ViewIssueNodeShape {
  return {
    id: overrides.id ?? "node-uuid",
    identifier: overrides.identifier ?? "ENG-1",
    title: overrides.title ?? "Title",
    description: overrides.description ?? "",
    updatedAt: overrides.updatedAt ?? "2026-01-01T00:00:00Z",
    state: overrides.state ?? { id: "s", name: "Todo", type: "unstarted" },
    team: overrides.team ?? { id: "team-1", key: "ENG" },
    assignee: overrides.assignee ?? { name: "Alice" },
    project: overrides.project ?? { slugId: "aaaaaaaaaaaa" },
    children: overrides.children ?? { nodes: [] },
    labels: overrides.labels ?? { nodes: [{ name: "agent-claude" }] },
    inverseRelations: overrides.inverseRelations ?? {
      nodes: [],
      pageInfo: { hasNextPage: false },
    },
  };
}

describe(canonicalStatusForStateType, () => {
  it("maps unstarted → todo", () => {
    expect(canonicalStatusForStateType("unstarted")).toBe("todo");
  });
  it("maps started → in-progress", () => {
    expect(canonicalStatusForStateType("started")).toBe("in-progress");
  });
  it("maps completed → done", () => {
    expect(canonicalStatusForStateType("completed")).toBe("done");
  });
  it("maps canceled → done (terminal)", () => {
    expect(canonicalStatusForStateType("canceled")).toBe("done");
  });
  it("maps backlog → other (out of canonical mapping)", () => {
    expect(canonicalStatusForStateType("backlog")).toBe("other");
  });
  it("maps triage → other", () => {
    expect(canonicalStatusForStateType("triage")).toBe("other");
  });
  it("maps unknown types → other", () => {
    expect(canonicalStatusForStateType("something-new")).toBe("other");
  });
});

describe(verifyView, () => {
  it("resolves the view by slugId and returns its uuid", async () => {
    const client = mockClient({
      customViews: {
        nodes: [{ id: "uuid-1", name: "My View", slugId: "61e51e3730dd" }],
      },
    });
    const resolved = await verifyView({
      client: asClient(client),
      viewSlugId: "61e51e3730dd",
      viewUrl: "https://linear.app/cbh/view/foo-61e51e3730dd",
    });
    expect(resolved).toStrictEqual({ id: "uuid-1", name: "My View" });
  });

  it("throws with the slugId and url when no view matches", async () => {
    const client = mockClient({ customViews: { nodes: [] } });
    await expect(
      verifyView({
        client: asClient(client),
        viewSlugId: "61e51e3730dd",
        viewUrl: "https://linear.app/cbh/view/foo-61e51e3730dd",
      }),
    ).rejects.toThrow(/No Linear view found with slugId "61e51e3730dd"/);
  });
});

describe(createInProgressStateLookup, () => {
  it("returns the lowest-position `started`-type state for a team", async () => {
    const calls: { teamId: string }[] = [];
    const client = mockClient();
    client.client.rawRequest = async (_query: string, variables?: unknown) => {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- mocked rawRequest matches the production GraphQL contract for InProgressState
      const { teamId } = variables as { teamId: string };
      calls.push({ teamId });
      return {
        data: {
          team: {
            states: {
              nodes: [
                { id: "s2", name: "In Review", position: 200, type: "started" },
                { id: "s1", name: "In Progress", position: 100, type: "started" },
              ],
            },
          },
        },
      };
    };
    const lookup = createInProgressStateLookup({ client: asClient(client) });
    const id = await lookup.getStateId("team-1");
    expect(id).toBe("s1");
    expect(calls).toStrictEqual([{ teamId: "team-1" }]);
  });

  it("throws when a team has zero `started`-type states", async () => {
    const client = mockClient();
    client.client.rawRequest = async () => ({
      data: { team: { states: { nodes: [] } } },
    });
    const lookup = createInProgressStateLookup({ client: asClient(client) });
    await expect(lookup.getStateId("team-1")).rejects.toThrow(
      /team "team-1" has no workflow state with type=started/,
    );
  });

  it("caches the per-team result across calls", async () => {
    const client = mockClient();
    let callCount = 0;
    client.client.rawRequest = async () => {
      callCount += 1;
      return {
        data: {
          team: {
            states: {
              nodes: [{ id: "s1", name: "In Progress", position: 100, type: "started" }],
            },
          },
        },
      };
    };
    const lookup = createInProgressStateLookup({ client: asClient(client) });
    await lookup.getStateId("team-1");
    await lookup.getStateId("team-1");
    expect(callCount).toBe(1);
  });
});

describe(fetchViewBoard, () => {
  it("returns empty issues + empty parentSkips for an empty view", async () => {
    const client = mockClient();
    client.client.rawRequest = async () => ({
      data: {
        customView: {
          id: "v-uuid",
          name: "v",
          issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
        },
      },
    });
    const result = await fetchViewBoard({
      client: asClient(client),
      config: makeConfig(),
      viewUuid: "v-uuid",
    });
    expect(result.issues).toStrictEqual([]);
    expect(result.parentSkips).toStrictEqual([]);
  });

  it("drops issues whose state.type is backlog or triage", async () => {
    const issueNodes = [
      makeIssueNode({
        identifier: "ENG-1",
        state: { id: "x", name: "Backlog", type: "backlog" },
      }),
      makeIssueNode({
        identifier: "ENG-2",
        state: { id: "y", name: "Triage", type: "triage" },
      }),
      makeIssueNode({
        identifier: "ENG-3",
        state: { id: "z", name: "Todo", type: "unstarted" },
      }),
    ];
    const client = mockClient();
    client.client.rawRequest = async () => ({
      data: {
        customView: {
          id: "v-uuid",
          name: "v",
          issues: { nodes: issueNodes, pageInfo: { hasNextPage: false, endCursor: null } },
        },
      },
    });
    const result = await fetchViewBoard({
      client: asClient(client),
      config: makeConfig(),
      viewUuid: "v-uuid",
    });
    expect(result.issues.map((i) => i.id)).toStrictEqual(["eng-3"]);
  });

  it("paginates via endCursor when hasNextPage is true", async () => {
    const client = mockClient();
    const rawRequest = vi
      .fn<RawRequestFn>()
      .mockResolvedValueOnce({
        data: {
          customView: {
            id: "v-uuid",
            name: "v",
            issues: {
              nodes: [
                makeIssueNode({
                  identifier: "ENG-1",
                  state: { id: "a", name: "Todo", type: "unstarted" },
                }),
              ],
              pageInfo: { hasNextPage: true, endCursor: "CUR1" },
            },
          },
        },
      })
      .mockResolvedValueOnce({
        data: {
          customView: {
            id: "v-uuid",
            name: "v",
            issues: {
              nodes: [
                makeIssueNode({
                  identifier: "ENG-2",
                  state: { id: "b", name: "Doing", type: "started" },
                }),
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      });
    client.client.rawRequest = rawRequest;
    const result = await fetchViewBoard({
      client: asClient(client),
      config: makeConfig(),
      viewUuid: "v-uuid",
    });
    expect(rawRequest).toHaveBeenCalledTimes(2);
    expect(result.issues.map((i) => i.id)).toStrictEqual(["eng-1", "eng-2"]);
  });

  it("drops non-unstarted issues with children without emitting a parentSkip", async () => {
    const node = makeIssueNode({
      identifier: "ENG-5",
      state: { id: "a", name: "Doing", type: "started" },
      children: { nodes: [{ id: "child-1" }] },
    });
    const client = mockClient();
    client.client.rawRequest = async () => ({
      data: {
        customView: {
          id: "v-uuid",
          name: "v",
          issues: { nodes: [node], pageInfo: { hasNextPage: false, endCursor: null } },
        },
      },
    });
    const result = await fetchViewBoard({
      client: asClient(client),
      config: makeConfig(),
      viewUuid: "v-uuid",
    });
    expect(result.issues).toStrictEqual([]);
    expect(result.parentSkips).toStrictEqual([]);
  });

  it("treats a null description as missing when looking up a known repo", async () => {
    const node: ViewIssueNodeShape = {
      id: "node-uuid",
      identifier: "ENG-6",
      title: "Title",
      description: null,
      updatedAt: "2026-01-01T00:00:00Z",
      state: { id: "a", name: "Todo", type: "unstarted" },
      team: { id: "team-1", key: "ENG" },
      assignee: { name: "Alice" },
      project: { slugId: "aaaaaaaaaaaa" },
      children: { nodes: [] },
      labels: { nodes: [{ name: "agent-claude" }] },
    };
    const client = mockClient();
    client.client.rawRequest = async () => ({
      data: {
        customView: {
          id: "v-uuid",
          name: "v",
          issues: { nodes: [node], pageInfo: { hasNextPage: false, endCursor: null } },
        },
      },
    });
    const result = await fetchViewBoard({
      client: asClient(client),
      config: makeConfig({
        workspace: { projectDir: "/w", knownRepositories: ["org/repo-a"] },
      }),
      viewUuid: "v-uuid",
    });
    expect(result.issues[0]?.repository).toBeUndefined();
  });

  it("emits parentSkip for issues with children", async () => {
    const node = makeIssueNode({
      identifier: "ENG-1",
      state: { id: "a", name: "Todo", type: "unstarted" },
      children: { nodes: [{ id: "child-1" }, { id: "child-2" }] },
    });
    const client = mockClient();
    client.client.rawRequest = async () => ({
      data: {
        customView: {
          id: "v-uuid",
          name: "v",
          issues: { nodes: [node], pageInfo: { hasNextPage: false, endCursor: null } },
        },
      },
    });
    const result = await fetchViewBoard({
      client: asClient(client),
      config: makeConfig(),
      viewUuid: "v-uuid",
    });
    expect(result.issues).toStrictEqual([]);
    expect(result.parentSkips).toStrictEqual([{ id: "eng-1", title: node.title, childCount: 2 }]);
  });

  it("falls back to defaults when assignee, project, and inverseRelations are missing", async () => {
    const node: ViewIssueNodeShape = {
      id: "node-uuid",
      identifier: "ENG-9",
      title: "Title",
      description: "",
      updatedAt: "2026-01-01T00:00:00Z",
      state: { id: "a", name: "Todo", type: "unstarted" },
      team: { id: "team-1", key: "ENG" },
      assignee: null,
      project: null,
      children: { nodes: [] },
      labels: { nodes: [{ name: "agent-claude" }] },
    };
    const client = mockClient();
    client.client.rawRequest = async () => ({
      data: {
        customView: {
          id: "v-uuid",
          name: "v",
          issues: { nodes: [node], pageInfo: { hasNextPage: false, endCursor: null } },
        },
      },
    });
    const result = await fetchViewBoard({
      client: asClient(client),
      config: makeConfig(),
      viewUuid: "v-uuid",
    });
    expect(result.issues[0]?.assignee).toBe("Unassigned");
    expect(result.issues[0]?.projectSlugId).toBe("");
    expect(result.issues[0]?.hasMoreBlockers).toBe(false);
    expect(result.issues[0]?.blockers).toStrictEqual([]);
  });

  it("populates repository and model when description names a known repo and label is agent-*", async () => {
    const node = makeIssueNode({
      identifier: "ENG-1",
      description: "repo: org/repo-a",
      state: { id: "a", name: "Todo", type: "unstarted" },
      labels: { nodes: [{ name: "agent-claude" }] },
    });
    const client = mockClient();
    client.client.rawRequest = async () => ({
      data: {
        customView: {
          id: "v-uuid",
          name: "v",
          issues: { nodes: [node], pageInfo: { hasNextPage: false, endCursor: null } },
        },
      },
    });
    const result = await fetchViewBoard({
      client: asClient(client),
      config: makeConfig({
        workspace: { projectDir: "/w", knownRepositories: ["org/repo-a"] },
      }),
      viewUuid: "v-uuid",
    });
    expect(result.issues[0]?.repository).toBe("org/repo-a");
    expect(result.issues[0]?.model).toBe("claude");
  });

  it("drops issues without an agent-* label", async () => {
    const node = makeIssueNode({
      identifier: "ENG-1",
      state: { id: "a", name: "Todo", type: "unstarted" },
      labels: { nodes: [{ name: "bug" }] },
    });
    const client = mockClient();
    client.client.rawRequest = async () => ({
      data: {
        customView: {
          id: "v-uuid",
          name: "v",
          issues: { nodes: [node], pageInfo: { hasNextPage: false, endCursor: null } },
        },
      },
    });
    const result = await fetchViewBoard({
      client: asClient(client),
      config: makeConfig(),
      viewUuid: "v-uuid",
    });
    expect(result.issues).toStrictEqual([]);
  });

  it("throws when customView is null mid-fetch", async () => {
    const client = mockClient();
    client.client.rawRequest = async () => ({
      data: { customView: null },
    });
    await expect(
      fetchViewBoard({ client: asClient(client), config: makeConfig(), viewUuid: "v-uuid" }),
    ).rejects.toThrow(/disappeared mid-fetch/);
  });
});

describe(resolveOneByIdentifier, () => {
  it("returns a canonical issue using description-derived repo + label-derived model", async () => {
    const client = mockClient();
    client.client.rawRequest = async () => ({
      data: {
        issue: {
          id: "uuid-1",
          title: "Fix it",
          description: "repo: org/repo-a",
          team: { id: "team-1" },
          project: { slugId: "aaaaaaaaaaaa" },
          state: { name: "In Progress" },
          children: { nodes: [] },
          labels: { nodes: [{ name: "agent-claude" }] },
          inverseRelations: { nodes: [], pageInfo: { hasNextPage: false } },
        },
      },
    });
    const result = await resolveOneByIdentifier({
      client: asClient(client),
      identifier: "eng-1",
      config: makeConfig({
        workspace: { projectDir: "/w", knownRepositories: ["org/repo-a"] },
      }),
    });
    expect(result).toMatchObject({
      title: "Fix it",
      description: "repo: org/repo-a",
      repository: "org/repo-a",
      model: "claude",
      teamId: "team-1",
    });
  });

  it("returns projectSlugId='' when the resolved issue has no project", async () => {
    const client = mockClient();
    client.client.rawRequest = async () => ({
      data: {
        issue: {
          id: "uuid-1",
          title: "no-project",
          description: "repo: org/repo-a",
          team: { id: "team-1" },
          project: null,
          state: { name: "Todo" },
          children: { nodes: [] },
          labels: { nodes: [{ name: "agent-claude" }] },
          inverseRelations: { nodes: [], pageInfo: { hasNextPage: false } },
        },
      },
    });
    const result = await resolveOneByIdentifier({
      client: asClient(client),
      identifier: "eng-1",
      config: makeConfig({
        workspace: { projectDir: "/w", knownRepositories: ["org/repo-a"] },
      }),
    });
    expect(result.projectSlugId).toBe("");
  });

  it("uses models.default when there's no agent label on the resolved ticket", async () => {
    const client = mockClient();
    client.client.rawRequest = async () => ({
      data: {
        issue: {
          id: "uuid-1",
          title: "no-label",
          description: "repo: org/repo-a",
          team: { id: "team-1" },
          project: { slugId: "aaaaaaaaaaaa" },
          state: { name: "Todo" },
          children: { nodes: [] },
          labels: { nodes: [] },
          inverseRelations: { nodes: [], pageInfo: { hasNextPage: false } },
        },
      },
    });
    const result = await resolveOneByIdentifier({
      client: asClient(client),
      identifier: "eng-1",
      config: makeConfig({
        workspace: { projectDir: "/w", knownRepositories: ["org/repo-a"] },
      }),
    });
    expect(result.model).toBe("claude");
  });

  it("falls back to models.default when the agent label points to a disabled shipped model", async () => {
    const client = mockClient();
    client.client.rawRequest = async () => ({
      data: {
        issue: {
          id: "uuid-1",
          title: "Fix it",
          description: "repo: org/repo-a",
          team: { id: "team-1" },
          project: { slugId: "aaaaaaaaaaaa" },
          state: { name: "Todo" },
          children: { nodes: [] },
          labels: { nodes: [{ name: "agent-claude" }] },
          inverseRelations: { nodes: [], pageInfo: { hasNextPage: false } },
        },
      },
    });
    const result = await resolveOneByIdentifier({
      client: asClient(client),
      identifier: "eng-1",
      config: makeConfig({
        workspace: { projectDir: "/w", knownRepositories: ["org/repo-a"] },
        models: {
          default: "codex",
          definitions: { codex: { cmd: "codex", color: "#000" } },
        },
      }),
    });
    expect(result.model).toBe("codex");
  });

  it("throws when description does not name a known repository", async () => {
    const client = mockClient();
    client.client.rawRequest = async () => ({
      data: {
        issue: {
          id: "uuid-1",
          title: "Fix it",
          description: "no repo mention here",
          team: { id: "team-1" },
          project: { slugId: "aaaaaaaaaaaa" },
          state: { name: "Todo" },
          children: { nodes: [] },
          labels: { nodes: [] },
          inverseRelations: { nodes: [], pageInfo: { hasNextPage: false } },
        },
      },
    });
    await expect(
      resolveOneByIdentifier({
        client: asClient(client),
        identifier: "eng-1",
        config: makeConfig({
          workspace: { projectDir: "/w", knownRepositories: ["org/repo-a"] },
        }),
      }),
    ).rejects.toThrow(/No known repository found/);
  });
});

describe(createLinearViewTicketSource, () => {
  it("verify() calls verifyView and caches the resolved uuid for fetch()", async () => {
    const client = mockClient();
    const rawRequest = vi.fn<RawRequestFn>(
      routedRawRequest([
        {
          match: "customViews",
          response: {
            data: {
              customViews: {
                nodes: [{ id: "view-uuid", name: "v", slugId: "61e51e3730dd" }],
              },
            },
          },
        },
        {
          match: "customView",
          response: {
            data: {
              customView: {
                id: "view-uuid",
                name: "v",
                issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
              },
            },
          },
        },
      ]),
    );
    client.client.rawRequest = rawRequest;

    const source = createLinearViewTicketSource({
      client: asClient(client),
      config: makeConfig(),
      viewUrl: "https://linear.app/cbh/view/foo-61e51e3730dd",
      viewSlugId: "61e51e3730dd",
      sourceName: "linear",
    });
    await source.verify();
    await source.fetch();
    const fetchCallCount = rawRequest.mock.calls.filter(([query]) =>
      query.includes("ViewIssues"),
    ).length;
    expect(fetchCallCount).toBe(1);
  });

  it("markInProgress() resolves the team's started state and writes it", async () => {
    const writes: { uuid: string; stateId: string }[] = [];
    const client = mockClient();
    client.client.rawRequest = routedRawRequest([
      {
        match: "InProgressState",
        response: {
          data: {
            team: {
              states: {
                nodes: [{ id: "s1", name: "Doing", position: 1, type: "started" }],
              },
            },
          },
        },
      },
    ]);
    client.updateIssue = async (uuid, arguments_) => {
      writes.push({ uuid, stateId: arguments_.stateId });
    };

    const source = createLinearViewTicketSource({
      client: asClient(client),
      config: makeConfig(),
      viewUrl: "https://linear.app/cbh/view/foo-61e51e3730dd",
      viewSlugId: "61e51e3730dd",
      sourceName: "linear",
    });

    await source.markInProgress({
      id: "linear:eng-1",
      source: "linear",
      title: "t",
      description: "",
      status: "todo",
      repository: undefined,
      model: undefined,
      assignee: "Alice",
      updatedAt: "2026-01-01T00:00:00Z",
      blockers: [],
      hasMoreBlockers: false,
      sourceRef: {
        uuid: "issue-uuid",
        statusId: "state-todo",
        teamId: "team-1",
        projectSlugId: "",
        nativeStatus: "Todo",
      },
    });

    expect(writes).toStrictEqual([{ uuid: "issue-uuid", stateId: "s1" }]);
  });
});

describe("createLinearViewTicketSource resolveOne + fetch state-type derivation", () => {
  it("resolveOne returns a canonical issue from resolveOneByIdentifier", async () => {
    const client = mockClient();
    client.client.rawRequest = async () => ({
      data: {
        issue: {
          id: "uuid-r",
          title: "Resolve me",
          description: "repo: org/repo-a",
          team: { id: "team-r" },
          project: { slugId: "aaaaaaaaaaaa" },
          state: { name: "Todo" },
          children: { nodes: [] },
          labels: { nodes: [{ name: "agent-claude" }] },
          inverseRelations: { nodes: [], pageInfo: { hasNextPage: false } },
        },
      },
    });
    const source = createLinearViewTicketSource({
      client: asClient(client),
      config: makeConfig({
        workspace: { projectDir: "/w", knownRepositories: ["org/repo-a"] },
      }),
      viewUrl: "https://linear.app/cbh/view/foo-61e51e3730dd",
      viewSlugId: "61e51e3730dd",
      sourceName: "linear",
    });
    const issue = await source.resolveOne("eng-1");
    expect(issue?.id).toBe("linear:eng-1");
    expect(issue?.title).toBe("Resolve me");
    expect(issue?.description).toBe("repo: org/repo-a");
    expect(issue?.repository).toBe("org/repo-a");
    expect(issue?.model).toBe("claude");
    expect(issue?.status).toBe("other");
  });

  it("fetch() maps each state.type to its canonical status", async () => {
    // Backlog and triage are dropped upstream by fetchViewBoard; only
    // pick-up-able types reach toCanonicalIssue.
    const cases: { stateType: string; expected: string }[] = [
      { stateType: "unstarted", expected: "todo" },
      { stateType: "started", expected: "in-progress" },
      { stateType: "completed", expected: "done" },
      { stateType: "canceled", expected: "done" },
    ];
    const nodes = cases.map((entry, index) =>
      makeIssueNode({
        identifier: `ENG-${index + 1}`,
        state: { id: `s${index}`, name: "Doing", type: entry.stateType },
        team: { id: `team-${index}`, key: "ENG" },
      }),
    );
    const client = mockClient();
    client.client.rawRequest = routedRawRequest([
      {
        match: "customViews",
        response: {
          data: {
            customViews: { nodes: [{ id: "vu", name: "v", slugId: "61e51e3730dd" }] },
          },
        },
      },
      {
        match: "customView",
        response: {
          data: {
            customView: {
              id: "vu",
              name: "v",
              issues: { nodes, pageInfo: { hasNextPage: false, endCursor: null } },
            },
          },
        },
      },
    ]);
    const source = createLinearViewTicketSource({
      client: asClient(client),
      config: makeConfig(),
      viewUrl: "https://linear.app/cbh/view/foo-61e51e3730dd",
      viewSlugId: "61e51e3730dd",
      sourceName: "linear",
    });
    const issues = await source.fetch();
    const statuses = issues.map((issue) => issue.status);
    expect(statuses).toStrictEqual(cases.map((entry) => entry.expected));
  });

  it("toCanonicalBlocker maps completed/canceled to done and others to other", async () => {
    const node = makeIssueNode({
      identifier: "ENG-1",
      state: { id: "s1", name: "Todo", type: "unstarted" },
      inverseRelations: {
        nodes: [
          {
            type: "blocks",
            issue: {
              identifier: "ENG-2",
              title: "blocker-done",
              state: { name: "completed", type: "completed" },
              project: { slugId: "p" },
            },
          },
          {
            type: "blocks",
            issue: {
              identifier: "ENG-3",
              title: "blocker-cancel",
              state: { name: "canceled", type: "canceled" },
              project: { slugId: "p" },
            },
          },
          {
            type: "blocks",
            issue: {
              identifier: "ENG-4",
              title: "blocker-todo",
              state: { name: "Todo", type: "unstarted" },
              project: { slugId: "p" },
            },
          },
        ],
        pageInfo: { hasNextPage: false },
      },
    });
    const client = mockClient();
    client.client.rawRequest = routedRawRequest([
      {
        match: "customViews",
        response: {
          data: { customViews: { nodes: [{ id: "vu", name: "v", slugId: "61e51e3730dd" }] } },
        },
      },
      {
        match: "customView",
        response: {
          data: {
            customView: {
              id: "vu",
              name: "v",
              issues: { nodes: [node], pageInfo: { hasNextPage: false, endCursor: null } },
            },
          },
        },
      },
    ]);
    const source = createLinearViewTicketSource({
      client: asClient(client),
      config: makeConfig(),
      viewUrl: "https://linear.app/cbh/view/foo-61e51e3730dd",
      viewSlugId: "61e51e3730dd",
      sourceName: "linear",
    });
    const issues = await source.fetch();
    const [first] = issues;
    expect(first?.blockers.map((b) => b.status)).toStrictEqual(["done", "done", "other"]);
    expect(first?.blockers.map((b) => b.id)).toStrictEqual([
      "linear:eng-2",
      "linear:eng-3",
      "linear:eng-4",
    ]);
  });
});

describe(createLinearViewBoardSource, () => {
  it("verify() resolves the view; fetch() returns a BoardState", async () => {
    const client = mockClient();
    client.client.rawRequest = routedRawRequest([
      {
        match: "customViews",
        response: {
          data: {
            customViews: {
              nodes: [{ id: "vu", name: "v", slugId: "61e51e3730dd" }],
            },
          },
        },
      },
      {
        match: "customView",
        response: {
          data: {
            customView: {
              id: "vu",
              name: "v",
              issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
            },
          },
        },
      },
    ]);
    const source = createLinearViewBoardSource({
      client: asClient(client),
      config: makeConfig(),
      viewUrl: "https://linear.app/cbh/view/foo-61e51e3730dd",
      viewSlugId: "61e51e3730dd",
    });
    await source.verify();
    const state = await source.fetch();
    expect(state.issues).toStrictEqual([]);
    expect(state.parentSkips).toStrictEqual([]);
  });

  it("fetch() lazily verifies the view when called before verify()", async () => {
    const client = mockClient();
    const rawRequest = vi.fn<RawRequestFn>(
      routedRawRequest([
        {
          match: "customViews",
          response: {
            data: {
              customViews: {
                nodes: [{ id: "vu", name: "v", slugId: "61e51e3730dd" }],
              },
            },
          },
        },
        {
          match: "customView",
          response: {
            data: {
              customView: {
                id: "vu",
                name: "v",
                issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
              },
            },
          },
        },
      ]),
    );
    client.client.rawRequest = rawRequest;
    const source = createLinearViewBoardSource({
      client: asClient(client),
      config: makeConfig(),
      viewUrl: "https://linear.app/cbh/view/foo-61e51e3730dd",
      viewSlugId: "61e51e3730dd",
    });
    await source.fetch();
    const customViewsCalls = rawRequest.mock.calls.filter(([query]) =>
      query.includes("customViews"),
    ).length;
    expect(customViewsCalls).toBe(1);
  });
});
