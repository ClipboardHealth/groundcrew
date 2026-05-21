import type { LinearClient } from "@linear/sdk";

import { captureConsoleLog, type ConsoleCapture } from "../testHelpers/consoleCapture.ts";
import {
  createBoardSource,
  fetchBlockersForTicket,
  fetchInProgressIssueCount,
  fetchRawLinearIssue,
  fetchResolvedIssue,
  isTerminalStatusForBlocker,
  isTerminalStatusForIssue,
  resolveModelFor,
  resolveRepositoryFor,
  UnknownProjectError,
  type Blocker,
  type Issue,
} from "./boardSource.ts";
import type { ResolvedConfig } from "./config.ts";

interface IssueNodeStub {
  id: string;
  identifier: string;
  title: string;
  description?: string | undefined;
  updatedAt: string;
  state?: { id: string; name: string } | null;
  team?: { id: string; key: string } | null;
  assignee?: { name: string } | null;
  project?: { slugId: string } | null;
  children?: { nodes: unknown[] };
  labels?: { nodes: { name: string }[] };
  inverseRelations?: {
    nodes: {
      type: string;
      issue?: {
        identifier: string;
        title: string;
        state?: { name: string } | null;
        project?: { slugId: string } | null;
      } | null;
    }[];
    pageInfo: { hasNextPage: boolean };
  };
}

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    linear: {
      projects: [
        {
          projectSlug: "ai-strategy-aaaaaaaaaaaa",
          slugId: "aaaaaaaaaaaa",
          statuses: {
            todo: "Todo",
            inProgress: "In Progress",
            done: "Done",
            terminal: ["Done"],
          },
        },
      ],
      ...overrides.linear,
    },
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
    state: overrides.state === undefined ? { id: "state-todo", name: "Todo" } : overrides.state,
    team: overrides.team === undefined ? { id: "team-default", key: "TEAM" } : overrides.team,
    assignee: overrides.assignee === undefined ? { name: "Alice" } : overrides.assignee,
    project: "project" in overrides ? overrides.project : { slugId: "aaaaaaaaaaaa" },
    children: overrides.children ?? { nodes: [] },
    labels: overrides.labels ?? { nodes: [] },
    ...(overrides.inverseRelations === undefined
      ? {}
      : { inverseRelations: overrides.inverseRelations }),
  };
}

function blockingRelation(
  identifier: string,
  status?: string,
): NonNullable<IssueNodeStub["inverseRelations"]>["nodes"][number] {
  return {
    type: "blocks",
    issue: {
      identifier,
      title: "Blocker",
      state: status === undefined ? null : { name: status },
    },
  };
}

type RawRequest = (query: string, variables?: Record<string, unknown>) => Promise<unknown>;

interface ClientStub {
  client: { rawRequest: ReturnType<typeof vi.fn<RawRequest>> };
}

function makeClient(options: {
  projectFound?: boolean;
  pages?: IssueNodeStub[][];
  activePages?: number[];
}): ClientStub {
  const { projectFound = true, pages = [[]], activePages = [0] } = options;
  let boardCallIndex = 0;
  let activeCallIndex = 0;
  const rawRequest = vi.fn<RawRequest>(async (query: string) => {
    if (query.includes("VerifyProject")) {
      return {
        data: {
          projects: {
            nodes: projectFound ? [{ id: "p1", name: "AI Strategy", slugId: "aaaaaaaaaaaa" }] : [],
          },
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
              project: { slugId: "aaaaaaaaaaaa" },
              state: { name: "In Progress" },
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
            project: { slugId: "aaaaaaaaaaaa" },
            labels: { nodes: [] },
            state: { name: "Todo" },
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
    it("rejects when no project resolves from linear.projects", async () => {
      const { source } = makeBoardSource(makeClient({ projectFound: false }));
      await expect(source.verify()).rejects.toThrow(/No Linear projects resolved/);
    });

    it("logs a warning and continues when at least one slug resolves", async () => {
      const config = makeConfig({
        linear: {
          projects: [
            {
              projectSlug: "ai-strategy-aaaaaaaaaaaa",
              slugId: "aaaaaaaaaaaa",
              statuses: {
                todo: "Todo",
                inProgress: "In Progress",
                done: "Done",
                terminal: ["Done"],
              },
            },
            {
              projectSlug: "missing-cccccccccccc",
              slugId: "cccccccccccc",
              statuses: {
                todo: "Todo",
                inProgress: "In Progress",
                done: "Done",
                terminal: ["Done"],
              },
            },
          ],
        },
      });
      const { source } = makeBoardSource(makeClient({ projectFound: true }), config);
      await source.verify();
      const output = consoleLog.output();
      expect(output).toContain("Resolved Linear project: AI Strategy");
      expect(output).toMatch(
        /WARNING: no Linear project found with slugId "cccccccccccc".*"missing-cccccccccccc"/,
      );
    });

    it("logs the resolved project name on success", async () => {
      const { source } = makeBoardSource(makeClient({ projectFound: true }));
      await source.verify();
      expect(consoleLog.output()).toContain("Resolved Linear project: AI Strategy");
    });
  });

  describe("fetch", () => {
    it("returns an empty board when the project has no issues", async () => {
      const { source } = makeBoardSource(makeClient({ pages: [[]] }));
      const state = await source.fetch();
      expect(state.issues).toStrictEqual([]);
      expectTypeOf(state.timestamp).toBeString();
    });

    it("paginates across multiple pages", async () => {
      const { source } = makeBoardSource(
        makeClient({
          pages: [
            [issueNode({ identifier: "TEAM-1", id: "uuid-1" })],
            [issueNode({ identifier: "TEAM-2", id: "uuid-2" })],
          ],
        }),
      );
      const state = await source.fetch();
      expect(state.issues.map((index) => index.id)).toStrictEqual(["team-1", "team-2"]);
    });

    it("filters out parent issues that have children", async () => {
      const { source } = makeBoardSource(
        makeClient({
          pages: [
            [
              issueNode({ identifier: "TEAM-1", id: "uuid-1", children: { nodes: [{ id: "c" }] } }),
              issueNode({ identifier: "TEAM-2", id: "uuid-2" }),
            ],
          ],
        }),
      );
      const state = await source.fetch();
      expect(state.issues.map((index) => index.id)).toStrictEqual(["team-2"]);
    });

    it("drops issues whose project slugId isn't in linear.projects", async () => {
      // The GraphQL slugId filter normally scopes results to configured
      // projects; this guards against a degenerate Linear response that
      // returns an off-config issue. Dropping it here keeps projectFor's
      // throw a real bug signal instead of routine noise.
      const { source } = makeBoardSource(
        makeClient({
          pages: [[issueNode({ identifier: "TEAM-9", project: { slugId: "off-config" } })]],
        }),
      );
      const state = await source.fetch();
      expect(state.issues).toHaveLength(0);
    });

    it("drops issues whose project field is missing entirely", async () => {
      const { source } = makeBoardSource(
        makeClient({ pages: [[issueNode({ identifier: "TEAM-10", project: null })]] }),
      );
      const state = await source.fetch();
      expect(state.issues).toHaveLength(0);
    });

    it("lowercases Linear's uppercase identifier into Issue.id", async () => {
      const { source } = makeBoardSource(
        makeClient({ pages: [[issueNode({ identifier: "STAFF-508", id: "uuid-staff" })]] }),
      );
      const state = await source.fetch();
      expect(state.issues[0]?.id).toBe("staff-508");
    });

    it("infers the repository from a known repo name in the description", async () => {
      const { source } = makeBoardSource(
        makeClient({
          pages: [
            [
              issueNode({
                description: "Affects api-admin somewhere.",
                labels: { nodes: [{ name: "agent-claude" }] },
              }),
            ],
          ],
        }),
      );
      const state = await source.fetch();
      const [first] = state.issues;
      expect(first?.repository).toBe("api-admin");
    });

    it("resolves bare repo name to full owner/repo when org is omitted from description", async () => {
      const { source } = makeBoardSource(
        makeClient({
          pages: [
            [
              issueNode({
                description: "Affects security-alerts-agent somehow.",
                labels: { nodes: [{ name: "agent-claude" }] },
              }),
            ],
          ],
        }),
        makeConfig({
          workspace: {
            projectDir: "/work",
            knownRepositories: ["ClipboardHealth/security-alerts-agent"],
          },
        }),
      );
      const state = await source.fetch();
      const [first] = state.issues;
      expect(first?.repository).toBe("ClipboardHealth/security-alerts-agent");
    });

    it("rejects when a bare repo name is ambiguous across multiple orgs", async () => {
      const { source } = makeBoardSource(
        makeClient({
          pages: [
            [
              issueNode({
                description: "Touches shared-repo.",
                labels: { nodes: [{ name: "agent-claude" }] },
              }),
            ],
          ],
        }),
        makeConfig({
          workspace: {
            projectDir: "/work",
            knownRepositories: ["OrgA/shared-repo", "OrgB/shared-repo"],
          },
        }),
      );
      await expect(source.fetch()).rejects.toThrow(
        /No known repository found in ticket TEAM-1 description/,
      );
    });

    it("longer repository names beat shorter ones (api-admin vs api)", async () => {
      // Without the descending-length sort, `api` would match first.
      const { source } = makeBoardSource(
        makeClient({
          pages: [
            [
              issueNode({
                description: "ticket about api-admin only",
                labels: { nodes: [{ name: "agent-claude" }] },
              }),
            ],
          ],
        }),
      );
      const state = await source.fetch();
      const [first] = state.issues;
      expect(first?.repository).toBe("api-admin");
    });

    it("rejects when a labeled ticket has no known repo in its description", async () => {
      const { source } = makeBoardSource(
        makeClient({
          pages: [
            [
              issueNode({
                description: "no repo here",
                labels: { nodes: [{ name: "agent-claude" }] },
              }),
            ],
          ],
        }),
      );

      await expect(source.fetch()).rejects.toThrow(
        /No known repository found in ticket TEAM-1 description/,
      );
    });

    it("rejects when a labeled ticket has a missing description", async () => {
      const { source } = makeBoardSource(
        makeClient({
          pages: [
            [
              issueNode({
                description: undefined,
                labels: { nodes: [{ name: "agent-claude" }] },
              }),
            ],
          ],
        }),
      );

      await expect(source.fetch()).rejects.toThrow(
        /No known repository found in ticket TEAM-1 description/,
      );
    });

    it("does not reject when an unlabeled ticket has no parseable repo", async () => {
      // Regression guard: previously aborted the whole board load on any
      // human-owned ticket whose description happened not to mention one
      // of `workspace.knownRepositories`.
      const { source } = makeBoardSource(
        makeClient({ pages: [[issueNode({ description: "no repo here" })]] }),
      );
      const state = await source.fetch();
      const [first] = state.issues;
      expect(first?.repository).toBeUndefined();
      expect(first?.model).toBeUndefined();
    });

    it("does not reject when an unlabeled ticket has a missing description", async () => {
      const { source } = makeBoardSource(
        makeClient({ pages: [[issueNode({ description: undefined })]] }),
      );
      const state = await source.fetch();
      const [first] = state.issues;
      expect(first?.repository).toBeUndefined();
      expect(first?.model).toBeUndefined();
    });

    it("scopes the board query to the orchestrator's configured state names so off-board tickets are never returned", async () => {
      const { source, rawRequest } = makeBoardSource(makeClient({ pages: [[]] }));

      await source.fetch();

      const boardCall = rawRequest.mock.calls.find(([query]) => query.includes("BoardIssues"));
      expect(boardCall?.[0]).toMatch(/state:\s*\{\s*name:\s*\{\s*in:\s*\$stateNames\s*\}\s*\}/);
      expect(boardCall?.[1]).toMatchObject({
        stateNames: ["Todo", "In Progress", "Done"],
      });
    });

    it("filters the board query to tickets with an agent-* label so unlabeled tickets never leave Linear", async () => {
      const { source, rawRequest } = makeBoardSource(makeClient({ pages: [[]] }));

      await source.fetch();

      const boardCall = rawRequest.mock.calls.find(([query]) => query.includes("BoardIssues"));
      expect(boardCall?.[0]).toMatch(
        /labels:\s*\{\s*some:\s*\{\s*name:\s*\{\s*startsWith:\s*\$agentLabelPrefix\s*\}\s*\}\s*\}/,
      );
      expect(boardCall?.[1]).toMatchObject({
        agentLabelPrefix: "agent-",
      });
    });

    it("dedupes overlapping terminal state names in the query variables", async () => {
      const config = makeConfig({
        linear: {
          projects: [
            {
              projectSlug: "ai-strategy-aaaaaaaaaaaa",
              slugId: "aaaaaaaaaaaa",
              // Done appears in both `done` and `terminal`; "Won't Do" is a custom
              // terminal state. The query should carry each name exactly once.
              statuses: {
                todo: "Todo",
                inProgress: "In Progress",
                done: "Done",
                terminal: ["Done", "Won't Do"],
              },
            },
          ],
        },
      });
      const { source, rawRequest } = makeBoardSource(makeClient({ pages: [[]] }), config);

      await source.fetch();

      const boardCall = rawRequest.mock.calls.find(([query]) => query.includes("BoardIssues"));
      expect(boardCall?.[1]).toMatchObject({
        stateNames: ["Todo", "In Progress", "Done", "Won't Do"],
      });
    });

    it("resolves the model from an agent-* label", async () => {
      const { source } = makeBoardSource(
        makeClient({
          pages: [[issueNode({ labels: { nodes: [{ name: "agent-codex" }] } })]],
        }),
      );
      const state = await source.fetch();
      const [first] = state.issues;
      expect(first?.model).toBe("codex");
    });

    it("falls back to models.default with a warning when an agent-<model> label refers to a disabled shipped default", async () => {
      // Simulates the post-filter state of a config with codex disabled: codex
      // is absent from `definitions` but present in `disabledShippedDefaults`.
      // The ticket explicitly opted into codex, so silently rerouting it to
      // claude would be surprising — the warning gives observability without
      // blocking the ticket.
      const configWithCodexDisabled = makeConfig({
        models: {
          default: "claude",
          definitions: {
            claude: { cmd: "claude", color: "#fff" },
          },
        },
      });

      const { source } = makeBoardSource(
        makeClient({
          pages: [
            [issueNode({ identifier: "STAFF-1", labels: { nodes: [{ name: "agent-codex" }] } })],
          ],
        }),
        configWithCodexDisabled,
      );
      const state = await source.fetch();
      const [first] = state.issues;

      expect(first?.model).toBe("claude");
      expect(consoleLog.output()).toMatch(
        /staff-1: agent-codex label refers to a disabled model; falling back to models\.default \(claude\)/,
      );
    });

    it("falls back silently to models.default for an unknown (not disabled) agent label", async () => {
      // Unknown labels (e.g. typos, removed-but-not-disabled models) keep the
      // existing silent fallback — only explicitly-disabled labels warn, since
      // those are the cases where the user opted in to a model they themselves
      // disabled and would want to know about.
      const { source } = makeBoardSource(
        makeClient({
          // cspell:disable-next-line
          pages: [[issueNode({ labels: { nodes: [{ name: "agent-mystery" }] } })]],
        }),
      );
      const state = await source.fetch();
      const [first] = state.issues;

      expect(first?.model).toBe("claude");
      expect(consoleLog.output()).not.toMatch(/falling back to models\.default/);
    });

    it("preserves agent-any as the model name (resolution happens later)", async () => {
      const { source } = makeBoardSource(
        makeClient({
          pages: [[issueNode({ labels: { nodes: [{ name: "agent-any" }] } })]],
        }),
      );
      const state = await source.fetch();
      const [first] = state.issues;
      expect(first?.model).toBe("any");
    });

    it("falls back to the default model when an agent-* label names a prototype property", async () => {
      // Guard against `in`-operator prototype lookup: `agent-toString` must
      // not resolve to `toString`, it must fall back to models.default.
      const { source } = makeBoardSource(
        makeClient({
          pages: [
            [
              issueNode({
                description: "Touches repo-a.",
                labels: { nodes: [{ name: "agent-toString" }] },
              }),
            ],
          ],
        }),
      );
      const state = await source.fetch();
      const [first] = state.issues;
      expect(first?.model).toBe("claude");
    });

    it("falls back to the default model when the label names an unknown model", async () => {
      const { source } = makeBoardSource(
        makeClient({
          pages: [[issueNode({ labels: { nodes: [{ name: "agent-ghost" }] } })]],
        }),
      );
      const state = await source.fetch();
      const [first] = state.issues;
      expect(first?.model).toBe("claude");
    });

    it("uses the first recognized model when an unknown label appears first", async () => {
      const { source } = makeBoardSource(
        makeClient({
          pages: [
            [
              issueNode({
                labels: { nodes: [{ name: "agent-ghost" }, { name: "agent-codex" }] },
              }),
            ],
          ],
        }),
      );

      const state = await source.fetch();

      expect(state.issues[0]?.model).toBe("codex");
    });

    it("sets model and repository to undefined for tickets without an agent-* label", async () => {
      // Tickets without an `agent-*` label aren't groundcrew's concern. The
      // board snapshot still includes them (for dashboard counts and blocker
      // checks), but downstream dispatch skips them via isGroundcrewIssue.
      const { source } = makeBoardSource(
        makeClient({
          pages: [[issueNode({ labels: { nodes: [{ name: "feature" }] } })]],
        }),
      );
      const state = await source.fetch();
      const [first] = state.issues;
      expect(first?.model).toBeUndefined();
      expect(first?.repository).toBeUndefined();
    });

    it("falls back to defaults when team and assignee are missing", async () => {
      const { source } = makeBoardSource(
        makeClient({
          pages: [[issueNode({ team: null, assignee: null })]],
        }),
      );
      const state = await source.fetch();
      const [first] = state.issues;
      expect(first?.teamId).toBe("");
      expect(first?.assignee).toBe("Unassigned");
    });

    it("builds blockers only from `blocks` relations and ignores other relation types", async () => {
      const { source } = makeBoardSource(
        makeClient({
          pages: [
            [
              issueNode({
                inverseRelations: {
                  nodes: [
                    blockingRelation("TEAM-0", "In Progress"),
                    {
                      type: "relates",
                      issue: {
                        identifier: "TEAM-9",
                        title: "Related",
                        state: { name: "Done" },
                      },
                    },
                  ],
                  pageInfo: { hasNextPage: false },
                },
              }),
            ],
          ],
        }),
      );
      const state = await source.fetch();
      const [first] = state.issues;
      expect(first?.blockers).toStrictEqual([
        { id: "team-0", title: "Blocker", status: "In Progress", projectSlugId: undefined },
      ]);
      expect(first?.hasMoreBlockers).toBe(false);
    });

    it("represents missing blocker payloads as `unknown` with no status", async () => {
      const { source } = makeBoardSource(
        makeClient({
          pages: [
            [
              issueNode({
                inverseRelations: {
                  nodes: [{ type: "blocks", issue: null }],
                  pageInfo: { hasNextPage: false },
                },
              }),
            ],
          ],
        }),
      );
      const state = await source.fetch();
      const [first] = state.issues;
      expect(first?.blockers).toStrictEqual([
        { id: "unknown", title: "", status: undefined, projectSlugId: undefined },
      ]);
    });

    it("propagates hasMoreBlockers when the relation page is paginated", async () => {
      const { source } = makeBoardSource(
        makeClient({
          pages: [
            [
              issueNode({
                inverseRelations: {
                  nodes: [],
                  pageInfo: { hasNextPage: true },
                },
              }),
            ],
          ],
        }),
      );
      const state = await source.fetch();
      const [first] = state.issues;
      expect(first?.hasMoreBlockers).toBe(true);
    });
  });
});

describe(fetchResolvedIssue, () => {
  it("returns an empty team id when Linear omits the issue team", async () => {
    const client = makeClient({ pages: [[]] });
    client.client.rawRequest.mockResolvedValueOnce({
      data: {
        issue: {
          id: "uuid-1",
          title: "Title",
          description: "Touches repo-a.",
          team: null,
          project: { slugId: "aaaaaaaaaaaa" },
          labels: { nodes: [] },
        },
      },
    });

    const actual = await fetchResolvedIssue({
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- tests use the LinearClient surface consumed by boardSource
      client: client as unknown as LinearClient,
      config: makeConfig(),
      ticket: "team-1",
    });

    expect(actual.teamId).toBe("");
  });

  it("falls back to models.default when the label refers to a disabled shipped default", async () => {
    const configWithCodexDisabled = makeConfig({
      models: {
        default: "claude",
        definitions: {
          claude: { cmd: "claude", color: "#fff" },
        },
      },
    });
    const client = makeClient({ pages: [[]] });
    client.client.rawRequest.mockResolvedValueOnce({
      data: {
        issue: {
          id: "uuid-1",
          title: "Title",
          description: "Touches repo-a.",
          team: { id: "team-default" },
          project: { slugId: "aaaaaaaaaaaa" },
          labels: { nodes: [{ name: "agent-codex" }] },
        },
      },
    });

    const actual = await fetchResolvedIssue({
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- tests use the LinearClient surface consumed by boardSource
      client: client as unknown as LinearClient,
      config: configWithCodexDisabled,
      ticket: "team-1",
    });

    expect(actual.model).toBe("claude");
  });

  it("throws UnknownProjectError when the ticket's Linear project is not configured", async () => {
    const client = makeClient({ pages: [[]] });
    client.client.rawRequest.mockResolvedValueOnce({
      data: {
        issue: {
          id: "uuid-1",
          title: "Title",
          description: "Touches repo-a.",
          team: { id: "team-default" },
          project: { slugId: "off-config-cccccccccccc" },
          labels: { nodes: [] },
        },
      },
    });

    await expect(
      fetchResolvedIssue({
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- tests use the LinearClient surface consumed by boardSource
        client: client as unknown as LinearClient,
        config: makeConfig(),
        ticket: "team-1",
      }),
    ).rejects.toThrow(UnknownProjectError);
  });

  it("throws UnknownProjectError when the ticket has no Linear project", async () => {
    const client = makeClient({ pages: [[]] });
    client.client.rawRequest.mockResolvedValueOnce({
      data: {
        issue: {
          id: "uuid-1",
          title: "Title",
          description: "Touches repo-a.",
          team: { id: "team-default" },
          project: null,
          labels: { nodes: [] },
        },
      },
    });

    await expect(
      fetchResolvedIssue({
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- tests use the LinearClient surface consumed by boardSource
        client: client as unknown as LinearClient,
        config: makeConfig(),
        ticket: "team-1",
      }),
    ).rejects.toThrow(/has no associated Linear project/);
  });
});

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: overrides.id ?? "team-1",
    uuid: overrides.uuid ?? "uuid-1",
    title: overrides.title ?? "Title",
    status: overrides.status ?? "Done",
    statusId: overrides.statusId ?? "state-done",
    assignee: overrides.assignee ?? "Alice",
    updatedAt: overrides.updatedAt ?? "2025-01-01T00:00:00.000Z",
    repository: overrides.repository,
    model: overrides.model,
    teamId: overrides.teamId ?? "team-default",
    projectSlugId: overrides.projectSlugId ?? "aaaaaaaaaaaa",
    blockers: overrides.blockers ?? [],
    hasMoreBlockers: overrides.hasMoreBlockers ?? false,
  };
}

describe(isTerminalStatusForIssue, () => {
  it("returns true when the issue's own project lists its status as terminal", () => {
    const config = makeConfig();
    expect(isTerminalStatusForIssue(makeIssue({ status: "Done" }), config)).toBe(true);
  });

  it("returns true for any status in the project's terminal list", () => {
    const config = makeConfig({
      linear: {
        projects: [
          {
            projectSlug: "x-aaaaaaaaaaaa",
            slugId: "aaaaaaaaaaaa",
            statuses: {
              todo: "Todo",
              inProgress: "In Progress",
              done: "Done",
              terminal: ["Done", "Released"],
            },
          },
        ],
      },
    });
    expect(isTerminalStatusForIssue(makeIssue({ status: "Released" }), config)).toBe(true);
  });

  it("returns false for non-terminal statuses", () => {
    const config = makeConfig();
    expect(isTerminalStatusForIssue(makeIssue({ status: "Todo" }), config)).toBe(false);
    expect(isTerminalStatusForIssue(makeIssue({ status: "In Progress" }), config)).toBe(false);
  });

  it("throws when the issue's slugId isn't in linear.projects", () => {
    // fetchBoard's slugId filter and issueStatusBelongsToOwnProject keep
    // production issues from reaching here with an unknown slugId. Direct
    // calls (or a degenerate Linear response) surface the bug loudly instead
    // of silently using the wrong project's terminals.
    const config = makeConfig();
    expect(() =>
      isTerminalStatusForIssue(
        makeIssue({ status: "Done", projectSlugId: "off-config-cccccccccccc" }),
        config,
      ),
    ).toThrow(/projectSlugId "off-config-cccccccccccc" which is not in linear\.projects/);
  });

  it("uses each project's own terminal list when projects diverge", () => {
    const config = makeConfig({
      linear: {
        projects: [
          {
            projectSlug: "alpha-aaaaaaaaaaaa",
            slugId: "aaaaaaaaaaaa",
            statuses: { todo: "Todo", inProgress: "In Progress", done: "Done", terminal: ["Done"] },
          },
          {
            projectSlug: "beta-bbbbbbbbbbbb",
            slugId: "bbbbbbbbbbbb",
            statuses: {
              todo: "Todo",
              inProgress: "In Progress",
              done: "Released",
              terminal: ["Released"],
            },
          },
        ],
      },
    });
    // Project alpha doesn't treat "Released" as terminal.
    expect(
      isTerminalStatusForIssue(
        makeIssue({ status: "Released", projectSlugId: "aaaaaaaaaaaa" }),
        config,
      ),
    ).toBe(false);
    // Project beta does.
    expect(
      isTerminalStatusForIssue(
        makeIssue({ status: "Released", projectSlugId: "bbbbbbbbbbbb" }),
        config,
      ),
    ).toBe(true);
  });
});

function makeBlocker(overrides: Partial<Blocker> = {}): Blocker {
  return {
    id: overrides.id ?? "team-99",
    title: overrides.title ?? "Blocker",
    status: overrides.status,
    projectSlugId: overrides.projectSlugId,
  };
}

describe(isTerminalStatusForBlocker, () => {
  it("returns false when the blocker has no status", () => {
    const config = makeConfig();
    expect(isTerminalStatusForBlocker(makeBlocker({ status: undefined }), config)).toBe(false);
  });

  it("uses the blocker's own project's terminals when in-config", () => {
    const config = makeConfig({
      linear: {
        projects: [
          {
            projectSlug: "alpha-aaaaaaaaaaaa",
            slugId: "aaaaaaaaaaaa",
            statuses: { todo: "Todo", inProgress: "In Progress", done: "Done", terminal: ["Done"] },
          },
          {
            projectSlug: "beta-bbbbbbbbbbbb",
            slugId: "bbbbbbbbbbbb",
            statuses: {
              todo: "Todo",
              inProgress: "In Progress",
              done: "Released",
              terminal: ["Released"],
            },
          },
        ],
      },
    });
    // "Released" is terminal in beta but not in alpha — beta wins for a beta blocker.
    expect(
      isTerminalStatusForBlocker(
        makeBlocker({ status: "Released", projectSlugId: "bbbbbbbbbbbb" }),
        config,
      ),
    ).toBe(true);
    expect(
      isTerminalStatusForBlocker(
        makeBlocker({ status: "Released", projectSlugId: "aaaaaaaaaaaa" }),
        config,
      ),
    ).toBe(false);
  });

  it("falls back to the union of terminals for blockers in unwatched projects", () => {
    const config = makeConfig({
      linear: {
        projects: [
          {
            projectSlug: "alpha-aaaaaaaaaaaa",
            slugId: "aaaaaaaaaaaa",
            statuses: { todo: "Todo", inProgress: "In Progress", done: "Done", terminal: ["Done"] },
          },
          {
            projectSlug: "beta-bbbbbbbbbbbb",
            slugId: "bbbbbbbbbbbb",
            statuses: {
              todo: "Todo",
              inProgress: "In Progress",
              done: "Released",
              terminal: ["Released"],
            },
          },
        ],
      },
    });
    // Off-config blocker: "Released" appears in the union (beta), so it counts as terminal.
    expect(
      isTerminalStatusForBlocker(
        makeBlocker({ status: "Released", projectSlugId: "off-config-cccccccccccc" }),
        config,
      ),
    ).toBe(true);
    // "Pending" isn't terminal under any configured project.
    expect(
      isTerminalStatusForBlocker(
        makeBlocker({ status: "Pending", projectSlugId: "off-config-cccccccccccc" }),
        config,
      ),
    ).toBe(false);
  });

  it("treats blockers with no project as off-config (union fallback)", () => {
    const config = makeConfig();
    expect(
      isTerminalStatusForBlocker(makeBlocker({ status: "Done", projectSlugId: undefined }), config),
    ).toBe(true);
    expect(
      isTerminalStatusForBlocker(
        makeBlocker({ status: "Pending", projectSlugId: undefined }),
        config,
      ),
    ).toBe(false);
  });
});

describe(UnknownProjectError, () => {
  it("names the ticket, the project slugId, and the configured set", () => {
    const error = new UnknownProjectError({
      ticket: "TEAM-1",
      projectSlugId: "off-config-cccccccccccc",
      configuredSlugIds: ["aaaaaaaaaaaa", "bbbbbbbbbbbb"],
    });
    expect(error.message).toContain("TEAM-1");
    expect(error.message).toContain("off-config-cccccccccccc");
    expect(error.message).toContain("aaaaaaaaaaaa");
    expect(error.message).toContain("bbbbbbbbbbbb");
    expect(error.message).toMatch(/linear\.projects/);
  });

  it("handles tickets with no associated project", () => {
    const error = new UnknownProjectError({
      ticket: "TEAM-2",
      projectSlugId: undefined,
      configuredSlugIds: ["aaaaaaaaaaaa"],
    });
    expect(error.message).toContain("has no associated Linear project");
  });
});

describe(fetchRawLinearIssue, () => {
  it("returns the raw fields when the ticket exists", async () => {
    const client = makeClient({ pages: [[]] });
    client.client.rawRequest.mockResolvedValueOnce({
      data: {
        issue: {
          id: "uuid-42",
          title: "Fix the thing",
          description: "Touches herds-social/herds.",
          team: { id: "team-hrd" },
          state: { name: "In Review" },
          labels: { nodes: [{ name: "agent-claude" }, { name: "feature" }] },
        },
      },
    });

    const result = await fetchRawLinearIssue({
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- tests use the LinearClient surface consumed by boardSource
      client: client as unknown as LinearClient,
      ticket: "hrd-1",
    });

    expect(result.uuid).toBe("uuid-42");
    expect(result.title).toBe("Fix the thing");
    expect(result.description).toBe("Touches herds-social/herds.");
    expect(result.teamId).toBe("team-hrd");
    expect(result.stateName).toBe("In Review");
    expect(result.labels).toStrictEqual([{ name: "agent-claude" }, { name: "feature" }]);
    expect(result.blockers).toStrictEqual([]);
    expect(result.hasMoreBlockers).toBe(false);
  });

  it("coerces a null description to an empty string", async () => {
    const client = makeClient({ pages: [[]] });
    client.client.rawRequest.mockResolvedValueOnce({
      data: {
        issue: {
          id: "uuid-43",
          title: "No description",
          description: null,
          team: { id: "team-hrd" },
          state: { name: "Todo" },
          labels: { nodes: [] },
        },
      },
    });

    const result = await fetchRawLinearIssue({
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- tests use the LinearClient surface consumed by boardSource
      client: client as unknown as LinearClient,
      ticket: "hrd-2",
    });

    expect(result.description).toBe("");
  });

  it("throws a not-found error when the issue is null", async () => {
    const client = makeClient({ pages: [[]] });
    client.client.rawRequest.mockResolvedValueOnce({
      data: { issue: null },
    });

    await expect(
      fetchRawLinearIssue({
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- tests use the LinearClient surface consumed by boardSource
        client: client as unknown as LinearClient,
        ticket: "hrd-1",
      }),
    ).rejects.toThrow(/HRD-1 not found in Linear/);
  });
});

describe(fetchInProgressIssueCount, () => {
  it("counts matching in-progress tickets", async () => {
    const config = makeConfig();
    const client = makeClient({ pages: [[]], activePages: [2] });

    const result = await fetchInProgressIssueCount({
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- tests use the LinearClient surface consumed by boardSource
      client: client as unknown as LinearClient,
      config,
    });

    expect(result).toBe(2);
  });

  it("paginates across in-progress tickets", async () => {
    const config = makeConfig();
    const client = makeClient({ pages: [[]], activePages: [2, 3] });

    const result = await fetchInProgressIssueCount({
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- tests use the LinearClient surface consumed by boardSource
      client: client as unknown as LinearClient,
      config,
    });

    expect(result).toBe(5);
  });

  it("drops issues whose state matches the union but not their own project's inProgress", async () => {
    // Cross-project leakage scenario: project A treats "Doing" as inProgress;
    // project B includes "Doing" as a non-inProgress state. The union filter
    // would let B's "Doing" issue through, but it should not count toward
    // the shared maximumInProgress budget.
    const config = makeConfig({
      linear: {
        projects: [
          {
            projectSlug: "alpha-aaaaaaaaaaaa",
            slugId: "aaaaaaaaaaaa",
            statuses: { todo: "Todo", inProgress: "Doing", done: "Done", terminal: ["Done"] },
          },
          {
            projectSlug: "beta-bbbbbbbbbbbb",
            slugId: "bbbbbbbbbbbb",
            statuses: {
              todo: "Todo",
              inProgress: "In Progress",
              done: "Released",
              terminal: ["Released"],
            },
          },
        ],
      },
    });
    const rawRequest =
      vi.fn<(query: string, variables?: Record<string, unknown>) => Promise<unknown>>();
    rawRequest.mockResolvedValue({
      data: {
        issues: {
          nodes: [
            { id: "alpha-1", project: { slugId: "aaaaaaaaaaaa" }, state: { name: "Doing" } },
            // Cross-project leakage: beta issue in "Doing" state (not beta's inProgress).
            { id: "beta-1", project: { slugId: "bbbbbbbbbbbb" }, state: { name: "Doing" } },
            { id: "beta-2", project: { slugId: "bbbbbbbbbbbb" }, state: { name: "In Progress" } },
          ],
          pageInfo: { hasNextPage: false, endCursor: "" },
        },
      },
    });
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- tests use the LinearClient surface consumed by boardSource
    const client = { client: { rawRequest } } as unknown as LinearClient;

    const result = await fetchInProgressIssueCount({ client, config });

    expect(result).toBe(2);
  });
});

describe(resolveRepositoryFor, () => {
  it("returns the repository when the description mentions a known one", () => {
    const config = makeConfig({
      workspace: { projectDir: "/work", knownRepositories: ["herds-social/herds"] },
    });
    const result = resolveRepositoryFor({
      description: "fix the herds-social/herds bug",
      config,
      ticket: "HRD-1",
    });
    expect(result).toStrictEqual({ kind: "ok", repository: "herds-social/herds" });
  });

  it("returns missing when no known repo is in the description", () => {
    const config = makeConfig({
      workspace: { projectDir: "/work", knownRepositories: ["herds-social/herds"] },
    });
    expect(
      resolveRepositoryFor({ description: "nothing here", config, ticket: "HRD-1" }).kind,
    ).toBe("missing");
  });

  it("returns missing on empty description", () => {
    const config = makeConfig({
      workspace: { projectDir: "/work", knownRepositories: ["herds-social/herds"] },
    });
    expect(resolveRepositoryFor({ description: "", config, ticket: "HRD-1" }).kind).toBe("missing");
  });

  it("returns missing on undefined description", () => {
    const config = makeConfig({
      workspace: { projectDir: "/work", knownRepositories: ["herds-social/herds"] },
    });
    expect(resolveRepositoryFor({ description: undefined, config, ticket: "HRD-1" }).kind).toBe(
      "missing",
    );
  });
});

describe(resolveModelFor, () => {
  it("returns matched when label corresponds to a known model", () => {
    const config = makeConfig();
    const result = resolveModelFor({ labels: [{ name: "agent-claude" }], config });
    expect(result).toStrictEqual({ kind: "matched", model: "claude" });
  });

  it("returns no-label when no agent-* label is present", () => {
    const config = makeConfig();
    const result = resolveModelFor({ labels: [{ name: "feature" }], config });
    expect(result.kind).toBe("no-label");
  });

  it("returns no-label when the labels array is empty", () => {
    const config = makeConfig();
    const result = resolveModelFor({ labels: [], config });
    expect(result.kind).toBe("no-label");
  });

  it("returns agent-any when the label is agent-any", () => {
    const config = makeConfig();
    const result = resolveModelFor({ labels: [{ name: "agent-any" }], config });
    expect(result.kind).toBe("agent-any");
  });

  it("returns disabled-fallback when the label matches a disabled shipped default", () => {
    // codex is absent from definitions (simulating `disabled: true`) but IS a
    // shipped default, so isShippedDefaultDisabled returns true for it.
    const configWithCodexDisabled = makeConfig({
      models: {
        default: "claude",
        definitions: {
          claude: { cmd: "claude", color: "#fff" },
        },
      },
    });
    const result = resolveModelFor({
      labels: [{ name: "agent-codex" }],
      config: configWithCodexDisabled,
    });
    expect(result).toStrictEqual({
      kind: "disabled-fallback",
      requestedModel: "codex",
      fallbackModel: "claude",
    });
  });
});

describe(fetchBlockersForTicket, () => {
  it("returns blockers whose type is 'blocks'", async () => {
    const client = makeClient({ pages: [[]] });
    client.client.rawRequest.mockResolvedValueOnce({
      data: {
        issue: {
          inverseRelations: {
            nodes: [
              {
                type: "blocks",
                issue: { identifier: "HRD-10", title: "Blocker A", state: { name: "In Progress" } },
              },
              {
                type: "blocked-by",
                issue: {
                  identifier: "HRD-11",
                  title: "Not a blocker",
                  state: { name: "In Progress" },
                },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: "" },
          },
        },
      },
    });

    const result = await fetchBlockersForTicket({
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- tests use the LinearClient surface consumed by boardSource
      client: client as unknown as LinearClient,
      ticket: "HRD-1",
      uuid: "uuid-1",
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toStrictEqual({
      id: "hrd-10",
      title: "Blocker A",
      status: "In Progress",
      projectSlugId: undefined,
    });
  });

  it("returns blockers from every relation page", async () => {
    const client = makeClient({ pages: [[]] });
    client.client.rawRequest
      .mockResolvedValueOnce({
        data: {
          issue: {
            inverseRelations: {
              nodes: [
                {
                  type: "blocks",
                  issue: {
                    identifier: "HRD-10",
                    title: "Blocker A",
                    state: { name: "In Progress" },
                  },
                },
              ],
              pageInfo: { hasNextPage: true, endCursor: "blockers-cursor-1" },
            },
          },
        },
      })
      .mockResolvedValueOnce({
        data: {
          issue: {
            inverseRelations: {
              nodes: [
                {
                  type: "blocks",
                  issue: { identifier: "HRD-20", title: "Blocker B", state: { name: "Todo" } },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: "" },
            },
          },
        },
      });

    const result = await fetchBlockersForTicket({
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- tests use the LinearClient surface consumed by boardSource
      client: client as unknown as LinearClient,
      ticket: "HRD-1",
      uuid: "uuid-1",
    });

    expect(result).toStrictEqual([
      { id: "hrd-10", title: "Blocker A", status: "In Progress", projectSlugId: undefined },
      { id: "hrd-20", title: "Blocker B", status: "Todo", projectSlugId: undefined },
    ]);
    expect(client.client.rawRequest).toHaveBeenNthCalledWith(1, expect.any(String), {
      after: null,
      id: "uuid-1",
    });
    expect(client.client.rawRequest).toHaveBeenNthCalledWith(2, expect.any(String), {
      after: "blockers-cursor-1",
      id: "uuid-1",
    });
  });

  it("returns an empty array when the issue is null", async () => {
    const client = makeClient({ pages: [[]] });
    client.client.rawRequest.mockResolvedValueOnce({
      data: { issue: null },
    });

    const result = await fetchBlockersForTicket({
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- tests use the LinearClient surface consumed by boardSource
      client: client as unknown as LinearClient,
      ticket: "HRD-1",
      uuid: "uuid-missing",
    });

    expect(result).toStrictEqual([]);
  });

  it("returns an empty array when there are no blocking relations", async () => {
    const client = makeClient({ pages: [[]] });
    client.client.rawRequest.mockResolvedValueOnce({
      data: {
        issue: {
          inverseRelations: { nodes: [], pageInfo: { hasNextPage: false, endCursor: "" } },
        },
      },
    });

    const result = await fetchBlockersForTicket({
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- tests use the LinearClient surface consumed by boardSource
      client: client as unknown as LinearClient,
      ticket: "HRD-2",
      uuid: "uuid-2",
    });

    expect(result).toStrictEqual([]);
  });

  it("coerces a null issue state to undefined status", async () => {
    const client = makeClient({ pages: [[]] });
    client.client.rawRequest.mockResolvedValueOnce({
      data: {
        issue: {
          inverseRelations: {
            nodes: [
              {
                type: "blocks",
                issue: { identifier: "HRD-20", title: "No state", state: null },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: "" },
          },
        },
      },
    });

    const result = await fetchBlockersForTicket({
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- tests use the LinearClient surface consumed by boardSource
      client: client as unknown as LinearClient,
      ticket: "HRD-3",
      uuid: "uuid-3",
    });

    expect(result[0]?.status).toBeUndefined();
  });
});
