import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { LinearClient } from "@linear/sdk";

import type { AdapterContext } from "../../adapterDefinition.ts";
import type { ResolvedConfig } from "../../config.ts";
import type {
  CreateTaskInput,
  Issue as CanonicalIssue,
  MarkInReviewResult,
  TaskSource,
} from "../../taskSource.ts";
import { readEnvironmentVariable } from "../../util.ts";
import { deleteEnvironmentVariable, setEnvironmentVariable } from "../../../testHelpers/env.ts";
import * as boardSource from "./fetch.ts";
import type { Issue as LinearIssue } from "./fetch.ts";
import * as linearIssueStatus from "./writeback.ts";
import * as client from "./client.ts";
import { createLinearTaskSource, toCanonicalIssue } from "./factory.ts";

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
      definitions: {
        claude: { cmd: "claude", color: "#fff" },
        codex: { cmd: "codex", color: "#000" },
      },
      ...overrides.agents,
    },
    prompts: { initial: "x", ...overrides.prompts },
    workspaceKind: overrides.workspaceKind ?? "auto",
    local: { runner: "auto" },
    logging: { file: "/tmp/groundcrew-test.log", ...overrides.logging },
  };
}

function linearIssue(overrides: Partial<LinearIssue> = {}): LinearIssue {
  return {
    id: overrides.id ?? "team-1",
    uuid: overrides.uuid ?? "uuid-1",
    title: overrides.title ?? "Title",
    description: overrides.description ?? "",
    status: overrides.status ?? "Todo",
    statusId: overrides.statusId ?? "state-todo",
    stateType: overrides.stateType ?? "unstarted",
    assignee: overrides.assignee ?? "Alice",
    updatedAt: overrides.updatedAt ?? "2026-01-01T00:00:00Z",
    repository: overrides.repository,
    agent: overrides.agent,
    teamId: overrides.teamId ?? "team-default",
    blockers: overrides.blockers ?? [],
    hasMoreBlockers: overrides.hasMoreBlockers ?? false,
    url: overrides.url ?? "https://linear.app/example/issue/TEAM-1",
    priority: overrides.priority ?? 0,
  };
}

function createInput(overrides: Partial<CreateTaskInput> = {}): CreateTaskInput {
  return {
    title: "Fix cancellation retry race",
    agent: "codex",
    repository: "ClipboardHealth/api",
    projects: [],
    contexts: [],
    dependencies: [],
    edit: false,
    ...overrides,
  };
}

function createInputWithoutRepository(): CreateTaskInput {
  return {
    title: "Fix cancellation retry race",
    agent: "codex",
    projects: [],
    contexts: [],
    dependencies: [],
    edit: false,
  };
}

function createConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return makeConfig({
    workspace: {
      projectDir: "/work",
      knownRepositories: ["ClipboardHealth/api", "ClipboardHealth/web"],
      repositories: [{ name: "ClipboardHealth/api" }, { name: "ClipboardHealth/web" }],
      ...overrides.workspace,
    },
    agents: {
      default: "claude",
      definitions: {
        claude: { cmd: "claude", color: "#fff" },
        codex: { cmd: "codex", color: "#000" },
      },
      ...overrides.agents,
    },
    ...overrides,
  });
}

function createContextResponse(
  overrides: {
    labels?: { id: string; name: string }[];
    states?: { id: string; name: string; type: string; position: number }[];
    teams?: {
      id: string;
      key: string;
      name: string;
      labels: { nodes: { id: string; name: string }[] };
      states: { nodes: { id: string; name: string; type: string; position: number }[] };
    }[];
    viewer?: { id: string; name: string } | null;
  } = {},
): { data: unknown } {
  const labels = overrides.labels ?? [{ id: "label-codex", name: "agent-codex" }];
  const states = overrides.states ?? [
    { id: "state-todo", name: "Todo", type: "unstarted", position: 1 },
    { id: "state-started", name: "In Progress", type: "started", position: 2 },
  ];
  return {
    data: {
      viewer: overrides.viewer === undefined ? { id: "user-1", name: "Alice" } : overrides.viewer,
      teams: {
        nodes: overrides.teams ?? [
          {
            id: "team-1",
            key: "ENG",
            name: "Engineering",
            labels: { nodes: labels },
            states: { nodes: states },
          },
        ],
      },
    },
  };
}

function createIssueResponse(identifier = "ENG-123"): { data: unknown } {
  return {
    data: {
      issueCreate: {
        success: true,
        issue: { identifier },
      },
    },
  };
}

function createIssueFailureResponse(): { data: unknown } {
  return {
    data: {
      issueCreate: {
        success: false,
        issue: null,
      },
    },
  };
}

function createRelationResponse(success = true): { data: unknown } {
  return {
    data: {
      issueRelationCreate: { success },
    },
  };
}

function resolvedIssueResponse(
  overrides: {
    description?: string;
    labels?: { name: string }[];
    inverseRelations?: {
      nodes: boardSource.IssueRelationNode[];
      pageInfo: { hasNextPage: boolean };
    };
  } = {},
): { data: unknown } {
  return {
    data: {
      issue: {
        id: "uuid-created",
        title: "Fix cancellation retry race",
        description:
          overrides.description ??
          [
            "## Groundcrew",
            "",
            "Repository: ClipboardHealth/api",
            "",
            "## Task",
            "",
            "Investigate retry handling.",
          ].join("\n"),
        updatedAt: "2026-06-08T12:00:00.000Z",
        url: "https://linear.app/example/issue/ENG-123",
        priority: 2,
        team: { id: "team-1" },
        state: { id: "state-todo", name: "Todo", type: "unstarted" },
        assignee: { name: "Alice" },
        children: { nodes: [] },
        labels: { nodes: overrides.labels ?? [{ name: "agent-codex" }] },
        inverseRelations: overrides.inverseRelations ?? {
          nodes: [],
          pageInfo: { hasNextPage: false },
        },
      },
    },
  };
}

async function createTask(source: TaskSource, input: CreateTaskInput): Promise<CanonicalIssue> {
  if (source.createTask === undefined) {
    throw new Error("source.createTask is missing");
  }
  return await source.createTask(input);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function issueCreateInput(calls: readonly (readonly unknown[])[]): Record<string, unknown> {
  const [, call] = calls;
  if (call === undefined) {
    throw new Error("missing issueCreate call");
  }
  const [, variables] = call;
  if (!isRecord(variables)) {
    throw new Error("missing issueCreate variables");
  }
  const { input } = variables;
  if (!isRecord(input)) {
    throw new Error("missing issueCreate input");
  }
  return input;
}

describe(toCanonicalIssue, () => {
  it("prefixes the canonical id with the source name", () => {
    const result = toCanonicalIssue(linearIssue(), "linear");
    expect(result.id).toBe("linear:team-1");
    expect(result.source).toBe("linear");
  });

  it("moves Linear-specific fields into sourceRef", () => {
    const result = toCanonicalIssue(
      linearIssue({
        uuid: "uuid-abc",
        statusId: "state-todo",
        teamId: "team-xyz",
        stateType: "unstarted",
        status: "Todo",
      }),
      "linear",
    );
    expect(result.sourceRef).toStrictEqual({
      uuid: "uuid-abc",
      statusId: "state-todo",
      teamId: "team-xyz",
      stateType: "unstarted",
      nativeStatus: "Todo",
    });
  });

  it("canonicalizes status using the workflow state.type", () => {
    const result = toCanonicalIssue(
      linearIssue({ status: "In Progress", stateType: "started" }),
      "linear",
    );
    expect(result.status).toBe("in-progress");
  });

  it("canonicalizes default Linear In Review as in-review", () => {
    const result = toCanonicalIssue(
      linearIssue({ status: "In Review", stateType: "started" }),
      "linear",
    );
    expect(result.status).toBe("in-review");
  });

  it("does not let a review status name override a terminal state.type", () => {
    const result = toCanonicalIssue(
      linearIssue({ status: "In Review", stateType: "completed" }),
      "linear",
    );
    expect(result.status).toBe("done");
  });

  it("maps state.type 'completed' to canonical 'done'", () => {
    const result = toCanonicalIssue(
      linearIssue({ status: "Shipped", stateType: "completed" }),
      "linear",
    );
    expect(result.status).toBe("done");
  });

  it("maps state.type 'canceled' to canonical 'done'", () => {
    const result = toCanonicalIssue(
      linearIssue({ status: "Won't fix", stateType: "canceled" }),
      "linear",
    );
    expect(result.status).toBe("done");
  });

  it("maps state.type 'duplicate' to canonical 'done'", () => {
    const result = toCanonicalIssue(
      linearIssue({ status: "Duplicate", stateType: "duplicate" }),
      "linear",
    );
    expect(result.status).toBe("done");
  });

  it("maps unknown state.type to canonical 'other'", () => {
    const result = toCanonicalIssue(
      linearIssue({ status: "Backlog", stateType: "backlog" }),
      "linear",
    );
    expect(result.status).toBe("other");
  });

  it("copies description from the legacy Linear issue onto the canonical Issue", () => {
    const result = toCanonicalIssue(linearIssue({ description: "Body of the task." }), "linear");
    expect(result.description).toBe("Body of the task.");
  });

  it("source-prefixes blocker ids and canonicalizes their statuses via stateType", () => {
    const issue = linearIssue({
      blockers: [
        { id: "team-2", title: "Block A", status: "Done", stateType: "completed" },
        { id: "team-3", title: "Block B", status: "Todo", stateType: "unstarted" },
        { id: "team-4", title: "Block C", status: "In Review", stateType: "started" },
      ],
    });
    const result = toCanonicalIssue(issue, "linear");
    expect(result.blockers).toStrictEqual([
      { id: "linear:team-2", title: "Block A", status: "done", nativeStatus: "Done" },
      { id: "linear:team-3", title: "Block B", status: "todo", nativeStatus: "Todo" },
      {
        id: "linear:team-4",
        title: "Block C",
        status: "in-review",
        nativeStatus: "In Review",
      },
    ]);
  });

  it("flags a blocker with missing stateType as 'other'/missing", () => {
    const issue = linearIssue({
      blockers: [{ id: "team-2", title: "Block A", status: "Done", stateType: undefined }],
    });
    const result = toCanonicalIssue(issue, "linear");
    expect(result.blockers).toStrictEqual([
      {
        id: "linear:team-2",
        title: "Block A",
        status: "other",
        statusReason: "missing",
        nativeStatus: "Done",
      },
    ]);
  });

  it("falls back to state.type when a started blocker has no native status", () => {
    const issue = linearIssue({
      blockers: [{ id: "team-2", title: "Block A", status: undefined, stateType: "started" }],
    });

    const result = toCanonicalIssue(issue, "linear");

    expect(result.blockers).toStrictEqual([
      { id: "linear:team-2", title: "Block A", status: "in-progress" },
    ]);
  });

  it("flags a blocker with backlog/triage stateType as 'other'/unmapped", () => {
    // Blockers can carry `state.type` values outside the actionable set
    // (`backlog`, `triage`). They aren't terminal, but the orchestrator can't
    // act on them either, so surface as "other" with statusReason "unmapped".
    const issue = linearIssue({
      blockers: [{ id: "team-2", title: "Block A", status: "Backlog", stateType: "backlog" }],
    });
    const result = toCanonicalIssue(issue, "linear");
    expect(result.blockers).toStrictEqual([
      {
        id: "linear:team-2",
        title: "Block A",
        status: "other",
        statusReason: "unmapped",
        nativeStatus: "Backlog",
      },
    ]);
  });

  it("omits nativeStatus for an unmapped blocker that has no native status name", () => {
    const issue = linearIssue({
      blockers: [{ id: "team-2", title: "Block A", status: undefined, stateType: "backlog" }],
    });

    const result = toCanonicalIssue(issue, "linear");

    expect(result.blockers).toStrictEqual([
      {
        id: "linear:team-2",
        title: "Block A",
        status: "other",
        statusReason: "unmapped",
      },
    ]);
  });

  it("uses a custom source name when provided", () => {
    const result = toCanonicalIssue(linearIssue(), "work-linear");
    expect(result.id).toBe("work-linear:team-1");
    expect(result.source).toBe("work-linear");
  });
});

describe(createLinearTaskSource, () => {
  const rawRequest =
    vi.fn<(query: string, variables?: Record<string, unknown>) => Promise<{ data?: unknown }>>();
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- tests provide the subset of LinearClient used by the methods they exercise
  const fakeClient = { client: { rawRequest } } as unknown as LinearClient;
  beforeEach(() => {
    rawRequest.mockReset();
    vi.spyOn(client, "getLinearClient").mockReturnValue(fakeClient);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns a TaskSource whose name defaults to 'linear'", () => {
    const source = createLinearTaskSource({ kind: "linear" }, {
      globalConfig: makeConfig(),
    } satisfies AdapterContext);
    expect(source.name).toBe("linear");
  });

  it("respects an explicit name override", () => {
    const source = createLinearTaskSource({ kind: "linear", name: "work" }, {
      globalConfig: makeConfig(),
    } satisfies AdapterContext);
    expect(source.name).toBe("work");
  });

  it("verify() delegates to createBoardSource().verify()", async () => {
    const innerVerify = vi.fn<() => Promise<void>>().mockResolvedValue();
    vi.spyOn(boardSource, "createBoardSource").mockReturnValue({
      verify: innerVerify,
      fetch: vi.fn<() => Promise<boardSource.BoardState>>(),
    });
    const source = createLinearTaskSource({ kind: "linear" }, {
      globalConfig: makeConfig(),
    } satisfies AdapterContext);
    await source.verify();
    expect(innerVerify).toHaveBeenCalledTimes(1);
  });

  it("fetch() converts each LinearIssue into a canonical Issue", async () => {
    const innerFetch = vi.fn<() => Promise<boardSource.BoardState>>().mockResolvedValue({
      timestamp: "2026-01-01T00:00:00Z",
      issues: [
        linearIssue({ id: "team-1" }),
        linearIssue({ id: "team-2", status: "In Progress", stateType: "started" }),
      ],
      parentSkips: [],
    });
    vi.spyOn(boardSource, "createBoardSource").mockReturnValue({
      verify: vi.fn<() => Promise<void>>(),
      fetch: innerFetch,
    });
    const source = createLinearTaskSource({ kind: "linear" }, {
      globalConfig: makeConfig(),
    } satisfies AdapterContext);
    const issues = await source.fetch();
    expect(issues.map((i) => i.id)).toStrictEqual(["linear:team-1", "linear:team-2"]);
    expect(issues[1]?.status).toBe("in-progress");
  });

  it("listTasks() converts each LinearIssue into a canonical Issue", async () => {
    const innerFetch = vi.fn<() => Promise<boardSource.BoardState>>().mockResolvedValue({
      timestamp: "2026-01-01T00:00:00Z",
      issues: [linearIssue({ id: "team-1" })],
      parentSkips: [],
    });
    vi.spyOn(boardSource, "createBoardSource").mockReturnValue({
      verify: vi.fn<() => Promise<void>>(),
      fetch: innerFetch,
    });
    const source = createLinearTaskSource({ kind: "linear" }, {
      globalConfig: makeConfig(),
    } satisfies AdapterContext);

    const issues = await source.listTasks();

    expect(issues.map((issue) => issue.id)).toStrictEqual(["linear:team-1"]);
  });

  it("uses configured Linear status names before falling back to state.type", async () => {
    const innerFetch = vi.fn<() => Promise<boardSource.BoardState>>().mockResolvedValue({
      timestamp: "2026-01-01T00:00:00Z",
      issues: [
        linearIssue({ id: "team-1", status: "Doing", stateType: "started" }),
        linearIssue({ id: "team-2", status: "Code Review", stateType: "started" }),
        linearIssue({ id: "team-3", status: "Waiting", stateType: "started" }),
      ],
      parentSkips: [],
    });
    vi.spyOn(boardSource, "createBoardSource").mockReturnValue({
      verify: vi.fn<() => Promise<void>>(),
      fetch: innerFetch,
    });
    const source = createLinearTaskSource(
      {
        kind: "linear",
        statuses: {
          inProgress: ["Doing"],
          inReview: ["Code Review"],
        },
      },
      {
        globalConfig: makeConfig(),
      } satisfies AdapterContext,
    );

    const issues = await source.fetch();

    expect(issues.map((issue) => issue.status)).toStrictEqual([
      "in-progress",
      "in-review",
      "in-progress",
    ]);
  });

  it("fetchParentSkips() returns canonical (source-prefixed) ids", async () => {
    const innerFetch = vi.fn<() => Promise<boardSource.BoardState>>().mockResolvedValue({
      timestamp: "2026-01-01T00:00:00Z",
      issues: [],
      parentSkips: [
        { id: "team-9", title: "Umbrella epic", childCount: 3 },
        { id: "team-10", title: "Another epic", childCount: 1 },
      ],
    });
    vi.spyOn(boardSource, "createBoardSource").mockReturnValue({
      verify: vi.fn<() => Promise<void>>(),
      fetch: innerFetch,
    });
    const source = createLinearTaskSource({ kind: "linear", name: "work-linear" }, {
      globalConfig: makeConfig(),
    } satisfies AdapterContext);

    await source.fetch();
    const skips = await source.fetchParentSkips?.();

    expect(skips).toStrictEqual([
      { id: "work-linear:team-9", title: "Umbrella epic", childCount: 3 },
      { id: "work-linear:team-10", title: "Another epic", childCount: 1 },
    ]);
  });

  it("resolveOne() returns a canonical Issue with description populated from fetchResolvedIssue", async () => {
    vi.spyOn(boardSource, "fetchResolvedIssue").mockResolvedValue({
      uuid: "uuid-abc",
      title: "Resolved title",
      description: "Resolved description",
      repository: "repo-a",
      agent: "claude",
      teamId: "team-xyz",
      stateType: "unstarted",
      status: "Todo",
      statusId: "state-todo",
      assignee: "Alice",
      updatedAt: "2026-01-01T00:00:00Z",
      blockers: [],
      hasMoreBlockers: false,
      url: "https://linear.app/example/issue/TEAM-1",
      priority: 0,
    });
    const source = createLinearTaskSource({ kind: "linear" }, {
      globalConfig: makeConfig(),
    } satisfies AdapterContext);
    const issue = await source.resolveOne("team-1");
    expect(issue?.id).toBe("linear:team-1");
    expect(issue?.title).toBe("Resolved title");
    expect(issue?.description).toBe("Resolved description");
    expect(issue?.repository).toBe("repo-a");
    expect(issue?.agent).toBe("claude");
    expect(issue?.status).toBe("todo");
  });

  it("getTask() returns a canonical Issue with description populated from fetchResolvedIssue", async () => {
    vi.spyOn(boardSource, "fetchResolvedIssue").mockResolvedValue({
      uuid: "uuid-abc",
      title: "Resolved title",
      description: "Resolved description",
      repository: "repo-a",
      agent: "claude",
      teamId: "team-xyz",
      stateType: "unstarted",
      status: "Todo",
      statusId: "state-todo",
      assignee: "Alice",
      updatedAt: "2026-01-01T00:00:00Z",
      blockers: [{ id: "team-2", title: "Blocking task", status: "Todo", stateType: "unstarted" }],
      hasMoreBlockers: true,
      url: "https://linear.app/example/issue/TEAM-1",
      priority: 2,
    });
    const source = createLinearTaskSource({ kind: "linear" }, {
      globalConfig: makeConfig(),
    } satisfies AdapterContext);

    const issue = await source.getTask("team-1");

    expect(issue?.id).toBe("linear:team-1");
    expect(issue?.description).toBe("Resolved description");
    expect(issue?.assignee).toBe("Alice");
    expect(issue?.updatedAt).toBe("2026-01-01T00:00:00Z");
    expect(issue?.blockers).toStrictEqual([
      {
        id: "linear:team-2",
        title: "Blocking task",
        status: "todo",
        nativeStatus: "Todo",
      },
    ]);
    expect(issue?.hasMoreBlockers).toBe(true);
    expect(issue?.priority).toBe(2);
  });

  it("returns null for missing Linear tasks through getTask() and undefined through resolveOne()", async () => {
    vi.spyOn(boardSource, "fetchResolvedIssue")
      .mockRejectedValueOnce(new Error("Task TEAM-404 not found in Linear"))
      .mockRejectedValueOnce(new Error("Task TEAM-404 not found in Linear"));
    const source = createLinearTaskSource({ kind: "linear" }, {
      globalConfig: makeConfig(),
    } satisfies AdapterContext);

    await expect(source.getTask("team-404")).resolves.toBeNull();
    await expect(source.resolveOne("team-404")).resolves.toBeUndefined();
  });

  it("preserves non-missing Linear lookup failures", async () => {
    vi.spyOn(boardSource, "fetchResolvedIssue").mockRejectedValue(new Error("Linear API: timeout"));
    const source = createLinearTaskSource({ kind: "linear" }, {
      globalConfig: makeConfig(),
    } satisfies AdapterContext);

    await expect(source.getTask("team-1")).rejects.toThrow("Linear API: timeout");
  });

  it("does not treat every task-prefixed Linear lookup failure as missing", async () => {
    vi.spyOn(boardSource, "fetchResolvedIssue").mockRejectedValue(
      new Error("Task TEAM-1 lookup failed in Linear"),
    );
    const source = createLinearTaskSource({ kind: "linear" }, {
      globalConfig: makeConfig(),
    } satisfies AdapterContext);

    await expect(source.getTask("team-1")).rejects.toThrow("lookup failed");
  });

  it("preserves non-Error Linear lookup rejections", async () => {
    vi.spyOn(boardSource, "fetchResolvedIssue").mockRejectedValue("offline");
    const source = createLinearTaskSource({ kind: "linear" }, {
      globalConfig: makeConfig(),
    } satisfies AdapterContext);

    await expect(source.getTask("team-1")).rejects.toBe("offline");
  });

  it("createTask() creates a Groundcrew-eligible Linear issue and blocked-by relation", async () => {
    rawRequest
      .mockResolvedValueOnce(createContextResponse())
      .mockResolvedValueOnce(createIssueResponse("ENG-123"))
      .mockResolvedValueOnce(createRelationResponse())
      .mockResolvedValueOnce(
        resolvedIssueResponse({
          inverseRelations: {
            nodes: [
              {
                type: "blocks",
                issue: {
                  identifier: "ENG-99",
                  title: "Blocking task",
                  state: { name: "Todo", type: "unstarted" },
                },
              },
            ],
            pageInfo: { hasNextPage: false },
          },
        }),
      );
    const source = createLinearTaskSource({ kind: "linear", team: "DEFAULT" }, {
      globalConfig: createConfig(),
    } satisfies AdapterContext);

    const issue = await createTask(
      source,
      createInput({
        team: "ENG",
        description: "Investigate retry handling.",
        priority: "2",
        due: "2026-06-09",
        projects: ["marketplace"],
        contexts: ["backend"],
        dependencies: ["linear:ENG-99"],
      }),
    );

    expect(rawRequest.mock.calls[0]?.[1]).toStrictEqual({
      teamSelector: "ENG",
      teamSelectorId: "ENG",
      agentLabelName: "agent-codex",
    });
    expect(rawRequest.mock.calls[1]?.[1]).toMatchObject({
      input: {
        assigneeId: "user-1",
        dueDate: "2026-06-09",
        labelIds: ["label-codex"],
        priority: 2,
        stateId: "state-todo",
        teamId: "team-1",
        title: "Fix cancellation retry race",
      },
    });
    const createdInput = issueCreateInput(rawRequest.mock.calls);
    expect(createdInput["description"]).toContain("Repository: ClipboardHealth/api");
    expect(createdInput["description"]).toContain("Projects: marketplace\nContexts: backend");
    expect(rawRequest.mock.calls[2]?.[1]).toStrictEqual({
      input: {
        issueId: "ENG-99",
        relatedIssueId: "ENG-123",
        type: "blocks",
      },
    });
    expect(issue).toMatchObject({
      id: "linear:eng-123",
      source: "linear",
      status: "todo",
      repository: "ClipboardHealth/api",
      agent: "codex",
      priority: 2,
      blockers: [
        {
          id: "linear:eng-99",
          title: "Blocking task",
          status: "todo",
          nativeStatus: "Todo",
        },
      ],
    });
  });

  it("createTask() uses configured team, fallback prompt text, no optional issue fields, and the first unstarted state", async () => {
    rawRequest
      .mockResolvedValueOnce(
        createContextResponse({
          states: [
            { id: "state-later", name: "Queued", type: "unstarted", position: 5 },
            { id: "state-first", name: "Ready", type: "unstarted", position: 1 },
          ],
        }),
      )
      .mockResolvedValueOnce(createIssueResponse("ENG-123"))
      .mockResolvedValueOnce(resolvedIssueResponse());
    const source = createLinearTaskSource({ kind: "linear", team: "ENG" }, {
      globalConfig: createConfig(),
    } satisfies AdapterContext);

    await createTask(source, createInput());

    expect(rawRequest.mock.calls[0]?.[1]).toStrictEqual({
      teamSelector: "ENG",
      teamSelectorId: "ENG",
      agentLabelName: "agent-codex",
    });
    const createdInput = issueCreateInput(rawRequest.mock.calls);
    expect(createdInput["stateId"]).toBe("state-first");
    expect(createdInput["description"]).toContain("## Notes\n\nNone");
    expect(createdInput["dueDate"]).toBeUndefined();
    expect(createdInput["priority"]).toBeUndefined();
  });

  it("createTask() reads prompt body from --prompt-file", async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "groundcrew-linear-create-"));
    const promptFile = path.join(tempDir, "prompt.md");
    writeFileSync(promptFile, "Prompt from disk\n", "utf8");
    rawRequest
      .mockResolvedValueOnce(createContextResponse())
      .mockResolvedValueOnce(createIssueResponse("ENG-123"))
      .mockResolvedValueOnce(resolvedIssueResponse());
    const source = createLinearTaskSource({ kind: "linear", team: "ENG" }, {
      globalConfig: createConfig(),
    } satisfies AdapterContext);

    try {
      await createTask(source, createInput({ promptFile }));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }

    expect(issueCreateInput(rawRequest.mock.calls)["description"]).toContain("Prompt from disk");
  });

  it.each([
    {
      input: createInput({ id: "ENG-123" }),
      message: "--id is not supported",
    },
    {
      input: createInput({ recurrence: "+1w" }),
      message: "--rec is not supported",
    },
    {
      input: createInput({ edit: true }),
      message: "--edit is not supported",
    },
    {
      input: createInput({ title: "   " }),
      message: "title is required",
    },
    {
      input: createInput({ title: "Line one\nLine two" }),
      message: "title must be a single line",
    },
    {
      input: createInput({ agent: "   " }),
      message: "--agent must be a non-empty string",
    },
    {
      input: createInputWithoutRepository(),
      message: "--repo is required",
    },
    {
      input: createInput({ repository: "ClipboardHealth/missing" }),
      message: "workspace.knownRepositories",
    },
    {
      input: createInput({ team: "   " }),
      message: "team must be a non-empty string",
    },
    {
      input: createInput({ priority: "5" }),
      message: "--priority must be an integer from 0 to 4",
    },
    {
      input: createInput({ description: "Prompt", promptFile: "/tmp/prompt.md" }),
      message: "mutually exclusive",
    },
  ])("createTask() rejects invalid Linear create input: $message", async ({ input, message }) => {
    const source = createLinearTaskSource({ kind: "linear", team: "ENG" }, {
      globalConfig: createConfig(),
    } satisfies AdapterContext);

    await expect(createTask(source, input)).rejects.toThrow(message);
  });

  it("createTask() rejects missing Linear team configuration", async () => {
    const source = createLinearTaskSource({ kind: "linear" }, {
      globalConfig: createConfig(),
    } satisfies AdapterContext);

    await expect(createTask(source, createInput())).rejects.toThrow("team is required");
  });

  it.each([
    {
      response: createContextResponse({ viewer: null }),
      message: "did not return a viewer",
    },
    {
      response: createContextResponse({ teams: [] }),
      message: 'expected exactly one Linear team "ENG"',
    },
    {
      response: createContextResponse({ labels: [] }),
      message: 'expected exactly one Linear label "agent-codex"',
    },
    {
      response: createContextResponse({
        states: [{ id: "state-started", name: "In Progress", type: "started", position: 1 }],
      }),
      message: "could not find a Todo workflow state",
    },
  ])(
    "createTask() surfaces Linear create context errors: $message",
    async ({ response, message }) => {
      rawRequest.mockResolvedValueOnce(response);
      const source = createLinearTaskSource({ kind: "linear", team: "ENG" }, {
        globalConfig: createConfig(),
      } satisfies AdapterContext);

      await expect(createTask(source, createInput())).rejects.toThrow(message);
    },
  );

  it("createTask() rejects a failed Linear issueCreate mutation", async () => {
    rawRequest
      .mockResolvedValueOnce(createContextResponse())
      .mockResolvedValueOnce(createIssueFailureResponse());
    const source = createLinearTaskSource({ kind: "linear", team: "ENG" }, {
      globalConfig: createConfig(),
    } satisfies AdapterContext);

    await expect(createTask(source, createInput())).rejects.toThrow(
      "issueCreate did not return a created issue",
    );
  });

  it("createTask() rejects dependencies that target another source", async () => {
    rawRequest
      .mockResolvedValueOnce(createContextResponse())
      .mockResolvedValueOnce(createIssueResponse("ENG-123"));
    const source = createLinearTaskSource({ kind: "linear", team: "ENG" }, {
      globalConfig: createConfig(),
    } satisfies AdapterContext);

    await expect(createTask(source, createInput({ dependencies: ["todo:GC-1"] }))).rejects.toThrow(
      "is not a Linear task id",
    );
  });

  it("createTask() rejects failed blocked-by relation creation", async () => {
    rawRequest
      .mockResolvedValueOnce(createContextResponse())
      .mockResolvedValueOnce(createIssueResponse("ENG-123"))
      .mockResolvedValueOnce(createRelationResponse(false));
    const source = createLinearTaskSource({ kind: "linear", team: "ENG" }, {
      globalConfig: createConfig(),
    } satisfies AdapterContext);

    await expect(createTask(source, createInput({ dependencies: ["ENG-99"] }))).rejects.toThrow(
      "could not create blocked-by relation",
    );
  });

  it("markInProgress() forwards uuid/teamId from sourceRef", async () => {
    const innerMarkInProgress = vi.fn<(...args: unknown[]) => Promise<void>>().mockResolvedValue();
    vi.spyOn(linearIssueStatus, "createLinearIssueStatusUpdater").mockReturnValue({
      markInProgress: innerMarkInProgress,
      markInReview: vi
        .fn<(...args: unknown[]) => Promise<MarkInReviewResult>>()
        .mockResolvedValue({ outcome: "unsupported", reason: "not implemented" }),
    });
    const source = createLinearTaskSource({ kind: "linear" }, {
      globalConfig: makeConfig(),
    } satisfies AdapterContext);
    await source.markInProgress({
      id: "linear:team-1",
      source: "linear",
      title: "x",
      description: "",
      status: "todo",
      repository: "repo-a",
      agent: "claude",
      assignee: "Alice",
      updatedAt: "2026-01-01T00:00:00Z",
      blockers: [],
      hasMoreBlockers: false,
      sourceRef: {
        uuid: "uuid-1",
        statusId: "s",
        teamId: "team-default",
        stateType: "unstarted",
        nativeStatus: "Todo",
      },
    });
    expect(innerMarkInProgress).toHaveBeenCalledWith({
      id: "linear:team-1",
      uuid: "uuid-1",
      teamId: "team-default",
    });
    expect(linearIssueStatus.createLinearIssueStatusUpdater).toHaveBeenCalledWith({
      client: fakeClient,
      statusNames: { inProgress: ["In Progress"], inReview: ["In Review"] },
    });
  });

  it("markInReview() forwards uuid/teamId from sourceRef", async () => {
    const innerMarkInReview = vi
      .fn<(...args: unknown[]) => Promise<MarkInReviewResult>>()
      .mockResolvedValue({ outcome: "unsupported", reason: "not implemented" });
    vi.spyOn(linearIssueStatus, "createLinearIssueStatusUpdater").mockReturnValue({
      markInProgress: vi.fn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(),
      markInReview: innerMarkInReview,
    });
    const source = createLinearTaskSource({ kind: "linear" }, {
      globalConfig: makeConfig(),
    } satisfies AdapterContext);
    await expect(
      source.markInReview({
        id: "linear:team-1",
        source: "linear",
        title: "x",
        description: "",
        status: "in-progress",
        repository: "repo-a",
        agent: "claude",
        assignee: "Alice",
        updatedAt: "2026-01-01T00:00:00Z",
        blockers: [],
        hasMoreBlockers: false,
        sourceRef: {
          uuid: "uuid-1",
          statusId: "s",
          teamId: "team-default",
          stateType: "started",
          nativeStatus: "In Progress",
        },
      }),
    ).resolves.toStrictEqual({ outcome: "unsupported", reason: "not implemented" });
    expect(innerMarkInReview).toHaveBeenCalledWith({
      id: "linear:team-1",
      uuid: "uuid-1",
      teamId: "team-default",
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Lazy client construction — the Linear adapter must be constructible
// without a Linear API key in env. Callers that only touch a sibling
// source (multi-source Board fan-out, `crew doctor --task <shell-id>`)
// must not crash at adapter-construction time on a missing key. These
// tests deliberately do NOT stub `getLinearClient` — the point is to
// exercise the real key-resolution path.
// ─────────────────────────────────────────────────────────────────────────

describe("createLinearTaskSource — lazy client construction", () => {
  const originalGroundcrewKey = readEnvironmentVariable("GROUNDCREW_LINEAR_API_KEY");
  const originalLinearKey = readEnvironmentVariable("LINEAR_API_KEY");

  beforeEach(() => {
    deleteEnvironmentVariable("GROUNDCREW_LINEAR_API_KEY");
    deleteEnvironmentVariable("LINEAR_API_KEY");
  });

  afterEach(() => {
    if (originalGroundcrewKey === undefined) {
      deleteEnvironmentVariable("GROUNDCREW_LINEAR_API_KEY");
    } else {
      setEnvironmentVariable("GROUNDCREW_LINEAR_API_KEY", originalGroundcrewKey);
    }
    if (originalLinearKey === undefined) {
      deleteEnvironmentVariable("LINEAR_API_KEY");
    } else {
      setEnvironmentVariable("LINEAR_API_KEY", originalLinearKey);
    }
  });

  it("constructs the adapter without throwing when no Linear API key is set", () => {
    expect(() =>
      createLinearTaskSource({ kind: "linear" }, {
        globalConfig: makeConfig(),
      } satisfies AdapterContext),
    ).not.toThrow();
  });

  it("throws about the missing key only when verify() is invoked", async () => {
    const source = createLinearTaskSource({ kind: "linear" }, {
      globalConfig: makeConfig(),
    } satisfies AdapterContext);

    await expect(source.verify()).rejects.toThrow(/GROUNDCREW_LINEAR_API_KEY or LINEAR_API_KEY/);
  });

  it("throws about the missing key only when fetch() is invoked", async () => {
    const source = createLinearTaskSource({ kind: "linear" }, {
      globalConfig: makeConfig(),
    } satisfies AdapterContext);

    await expect(source.fetch()).rejects.toThrow(/GROUNDCREW_LINEAR_API_KEY or LINEAR_API_KEY/);
  });
});
