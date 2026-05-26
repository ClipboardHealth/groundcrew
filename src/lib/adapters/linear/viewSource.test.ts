import type { LinearClient } from "@linear/sdk";

import type { ResolvedConfig } from "../../config.ts";
import {
  canonicalStatusForStateType,
  createInProgressStateLookup,
  createLinearViewTicketSource,
  createViewBoardSource,
  fetchViewBoard,
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

const DEFAULT_PAGE_INFO: { hasNextPage: boolean; endCursor: string | null } = {
  hasNextPage: false,
  endCursor: null,
};

function viewIssuesResponse(
  nodes: unknown[],
  pageInfo: { hasNextPage: boolean; endCursor: string | null } = DEFAULT_PAGE_INFO,
) {
  return {
    data: {
      customView: { id: "vu", name: "v", issues: { nodes, pageInfo } },
    },
  };
}

describe(canonicalStatusForStateType, () => {
  it.each([
    ["unstarted", "todo"],
    ["started", "in-progress"],
    ["completed", "done"],
    ["canceled", "done"],
    ["backlog", "other"],
    ["triage", "other"],
    ["something-new", "other"],
  ])("maps %s → %s", (stateType, expected) => {
    expect(canonicalStatusForStateType(stateType)).toBe(expected);
  });
});

describe(verifyView, () => {
  it("resolves the view by slugId and returns its uuid", async () => {
    const client = mockClient({
      customView: { id: "uuid-1", name: "My View", slugId: "61e51e3730dd" },
    });
    const resolved = await verifyView({
      client: asClient(client),
      viewSlugId: "61e51e3730dd",
      viewSlug: "foo-61e51e3730dd",
    });
    expect(resolved).toStrictEqual({ id: "uuid-1", name: "My View" });
  });

  it("throws with the slugId when no view matches", async () => {
    const client = mockClient({ customView: null });
    await expect(
      verifyView({
        client: asClient(client),
        viewSlugId: "61e51e3730dd",
        viewSlug: "foo-61e51e3730dd",
      }),
    ).rejects.toThrow(/No Linear view found with slugId "61e51e3730dd"/);
  });
});

describe(createInProgressStateLookup, () => {
  it("returns the lowest-position `started`-type state for a team and caches it", async () => {
    let callCount = 0;
    const client = mockClient();
    client.client.rawRequest = async () => {
      callCount += 1;
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
    await expect(lookup.getStateId("team-1")).resolves.toBe("s1");
    await expect(lookup.getStateId("team-1")).resolves.toBe("s1");
    expect(callCount).toBe(1);
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
});

describe(fetchViewBoard, () => {
  it("filters labels, backlog/triage states, and emits parentSkip for unstarted parents", async () => {
    const nodes = [
      makeIssueNode({ identifier: "NO-LABEL", labels: { nodes: [{ name: "bug" }] } }),
      makeIssueNode({
        identifier: "ENG-B",
        state: { id: "x", name: "Backlog", type: "backlog" },
      }),
      makeIssueNode({
        identifier: "ENG-T",
        state: { id: "y", name: "Triage", type: "triage" },
      }),
      makeIssueNode({
        identifier: "ENG-PARENT",
        state: { id: "p", name: "Todo", type: "unstarted" },
        children: { nodes: [{ id: "c1" }, { id: "c2" }] },
      }),
      makeIssueNode({
        identifier: "ENG-PARENT-DOING",
        state: { id: "q", name: "Doing", type: "started" },
        children: { nodes: [{ id: "c3" }] },
      }),
      makeIssueNode({ identifier: "ENG-OK", state: { id: "z", name: "Todo", type: "unstarted" } }),
    ];
    const client = mockClient();
    client.client.rawRequest = async () => viewIssuesResponse(nodes);
    const result = await fetchViewBoard({
      client: asClient(client),
      config: makeConfig(),
      viewUuid: "v-uuid",
    });
    expect(result.issues.map((i) => i.id)).toStrictEqual(["eng-ok"]);
    expect(result.parentSkips).toStrictEqual([{ id: "eng-parent", title: "Title", childCount: 2 }]);
  });

  it("paginates via endCursor", async () => {
    const client = mockClient();
    const rawRequest = vi
      .fn<RawRequestFn>()
      .mockResolvedValueOnce(
        viewIssuesResponse([makeIssueNode({ identifier: "ENG-1" })], {
          hasNextPage: true,
          endCursor: "CUR1",
        }),
      )
      .mockResolvedValueOnce(viewIssuesResponse([makeIssueNode({ identifier: "ENG-2" })]));
    client.client.rawRequest = rawRequest;
    const result = await fetchViewBoard({
      client: asClient(client),
      config: makeConfig(),
      viewUuid: "v-uuid",
    });
    expect(rawRequest).toHaveBeenCalledTimes(2);
    expect(result.issues.map((i) => i.id)).toStrictEqual(["eng-1", "eng-2"]);
  });

  it("falls back to defaults when assignee, project, inverseRelations, and description are missing", async () => {
    const node: ViewIssueNodeShape = {
      id: "node-uuid",
      identifier: "ENG-9",
      title: "Title",
      description: null,
      updatedAt: "2026-01-01T00:00:00Z",
      state: { id: "a", name: "Todo", type: "unstarted" },
      team: { id: "team-1", key: "ENG" },
      assignee: null,
      project: null,
      children: { nodes: [] },
      labels: { nodes: [{ name: "agent-claude" }] },
    };
    const client = mockClient();
    client.client.rawRequest = async () => viewIssuesResponse([node]);
    const result = await fetchViewBoard({
      client: asClient(client),
      config: makeConfig(),
      viewUuid: "v-uuid",
    });
    expect(result.issues[0]).toMatchObject({
      assignee: "Unassigned",
      projectSlugId: "",
      hasMoreBlockers: false,
      blockers: [],
      repository: undefined,
    });
  });

  it("throws when customView is null mid-fetch", async () => {
    const client = mockClient();
    client.client.rawRequest = async () => ({ data: { customView: null } });
    await expect(
      fetchViewBoard({ client: asClient(client), config: makeConfig(), viewUuid: "v-uuid" }),
    ).rejects.toThrow(/disappeared mid-fetch/);
  });
});

const VIEW = { viewSlug: "foo-61e51e3730dd", slugId: "61e51e3730dd" };

function viewLookupResponses(nodes: unknown[]) {
  return [
    {
      match: "VerifyView",
      response: {
        data: { customView: { id: "vu", name: "v", slugId: "61e51e3730dd" } },
      },
    },
    { match: "ViewIssues", response: viewIssuesResponse(nodes) },
  ];
}

describe(createViewBoardSource, () => {
  it("caches the resolved uuid across verify() and fetch()", async () => {
    const client = mockClient();
    const rawRequest = vi.fn<RawRequestFn>(routedRawRequest(viewLookupResponses([])));
    client.client.rawRequest = rawRequest;
    const source = createViewBoardSource({
      client: asClient(client),
      config: makeConfig(),
      view: VIEW,
    });
    await source.verify();
    await source.fetch();
    expect(rawRequest.mock.calls.filter(([q]) => q.includes("VerifyView"))).toHaveLength(1);
  });
});

describe(createLinearViewTicketSource, () => {
  it("fetch() maps each state.type to its canonical status and view-mode blockers", async () => {
    const nodes = [
      makeIssueNode({
        identifier: "ENG-1",
        state: { id: "s0", name: "Doing", type: "unstarted" },
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
      }),
      makeIssueNode({
        identifier: "ENG-5",
        state: { id: "s1", name: "Doing", type: "started" },
      }),
      makeIssueNode({
        identifier: "ENG-6",
        state: { id: "s2", name: "Done", type: "completed" },
      }),
      makeIssueNode({
        identifier: "ENG-7",
        state: { id: "s3", name: "Cancel", type: "canceled" },
      }),
    ];
    const client = mockClient();
    client.client.rawRequest = routedRawRequest(viewLookupResponses(nodes));
    const source = createLinearViewTicketSource({
      client: asClient(client),
      config: makeConfig(),
      view: VIEW,
      sourceName: "linear",
    });
    await source.verify();
    const issues = await source.fetch();
    expect(issues.map((i) => i.status)).toStrictEqual(["todo", "in-progress", "done", "done"]);
    expect(issues[0]?.blockers.map((b) => b.status)).toStrictEqual(["done", "done", "todo"]);
    expect(issues[0]?.blockers.map((b) => b.id)).toStrictEqual([
      "linear:eng-2",
      "linear:eng-3",
      "linear:eng-4",
    ]);
  });

  it("resolveOne returns a canonical issue (projectSlugId='' when missing)", async () => {
    const client = mockClient();
    client.client.rawRequest = async () => ({
      data: {
        issue: {
          id: "uuid-r",
          title: "Resolve me",
          description: "repo: org/repo-a",
          team: { id: "team-r" },
          project: null,
          state: { name: "Todo" },
          children: { nodes: [] },
          labels: { nodes: [{ name: "agent-claude" }] },
          inverseRelations: { nodes: [], pageInfo: { hasNextPage: false } },
        },
      },
    });
    const source = createLinearViewTicketSource({
      client: asClient(client),
      config: makeConfig(),
      view: VIEW,
      sourceName: "linear",
    });
    const issue = await source.resolveOne("eng-1");
    expect(issue).toMatchObject({
      id: "linear:eng-1",
      title: "Resolve me",
      repository: "org/repo-a",
      sourceRef: { projectSlugId: "" },
    });
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
              states: { nodes: [{ id: "s1", name: "Doing", position: 1, type: "started" }] },
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
      view: VIEW,
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
