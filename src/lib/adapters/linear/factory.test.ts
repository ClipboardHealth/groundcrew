import type { LinearClient } from "@linear/sdk";

import type { AdapterContext } from "../../adapterDefinition.ts";
import * as boardSource from "../../boardSource.ts";
import type {
  BoardSource,
  Blocker as LinearBlocker,
  Issue as LinearIssue,
} from "../../boardSource.ts";
import type { ResolvedConfig, ResolvedProjectConfig } from "../../config.ts";
import * as linearIssueStatus from "../../linearIssueStatus.ts";
import * as util from "../../util.ts";
import {
  canonicalBlockerStatus,
  canonicalIssueStatus,
  createLinearTicketSource,
  toCanonicalIssue,
} from "./factory.ts";

function project(overrides: Partial<ResolvedProjectConfig> = {}): ResolvedProjectConfig {
  return {
    projectSlug: overrides.projectSlug ?? "ai-strategy-aaaaaaaaaaaa",
    slugId: overrides.slugId ?? "aaaaaaaaaaaa",
    statuses: overrides.statuses ?? {
      todo: "Todo",
      inProgress: "In Progress",
      done: "Done",
      terminal: ["Done"],
    },
  };
}

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    linear: { projects: [project()], ...overrides.linear },
    sources: [],
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

function linearIssue(overrides: Partial<LinearIssue> = {}): LinearIssue {
  return {
    id: overrides.id ?? "team-1",
    uuid: overrides.uuid ?? "uuid-1",
    title: overrides.title ?? "Title",
    status: overrides.status ?? "Todo",
    statusId: overrides.statusId ?? "state-todo",
    stateType: overrides.stateType ?? "unstarted",
    assignee: overrides.assignee ?? "Alice",
    updatedAt: overrides.updatedAt ?? "2026-01-01T00:00:00Z",
    repository: overrides.repository,
    model: overrides.model,
    teamId: overrides.teamId ?? "team-default",
    projectSlugId: overrides.projectSlugId ?? "aaaaaaaaaaaa",
    blockers: overrides.blockers ?? [],
    hasMoreBlockers: overrides.hasMoreBlockers ?? false,
  };
}

describe(canonicalIssueStatus, () => {
  it("maps the project's `todo` name to canonical 'todo'", () => {
    expect(canonicalIssueStatus(linearIssue({ status: "Todo" }), makeConfig())).toBe("todo");
  });
  it("maps `inProgress` to canonical 'in-progress'", () => {
    expect(canonicalIssueStatus(linearIssue({ status: "In Progress" }), makeConfig())).toBe(
      "in-progress",
    );
  });
  it("maps `done` to canonical 'done'", () => {
    expect(canonicalIssueStatus(linearIssue({ status: "Done" }), makeConfig())).toBe("done");
  });
  it("maps a status listed in the project's terminal array to 'done'", () => {
    const config = makeConfig({
      linear: {
        projects: [
          project({
            statuses: {
              todo: "Todo",
              inProgress: "In Progress",
              done: "Done",
              terminal: ["Done", "Cancelled"],
            },
          }),
        ],
      },
    });
    expect(canonicalIssueStatus(linearIssue({ status: "Cancelled" }), config)).toBe("done");
  });
  it("returns 'other' for any status name not in the project's mapping", () => {
    expect(canonicalIssueStatus(linearIssue({ status: "Triage" }), makeConfig())).toBe("other");
  });
  it("in view mode maps by stateType, not status name", () => {
    const viewConfig = makeConfig({
      linear: {
        projects: [],
        views: [{ viewSlug: "v-61e51e3730dd", slugId: "61e51e3730dd" }],
      },
    });
    expect(
      canonicalIssueStatus(linearIssue({ status: "Anything", stateType: "started" }), viewConfig),
    ).toBe("in-progress");
    expect(
      canonicalIssueStatus(linearIssue({ status: "Anything", stateType: "completed" }), viewConfig),
    ).toBe("done");
    expect(
      canonicalIssueStatus(linearIssue({ status: "Anything", stateType: "canceled" }), viewConfig),
    ).toBe("done");
    expect(
      canonicalIssueStatus(linearIssue({ status: "Anything", stateType: "unstarted" }), viewConfig),
    ).toBe("todo");
  });
  it("in view mode falls back to 'other' for unknown stateTypes (backlog/triage/...)", () => {
    const viewConfig = makeConfig({
      linear: {
        projects: [],
        views: [{ viewSlug: "v-61e51e3730dd", slugId: "61e51e3730dd" }],
      },
    });
    expect(
      canonicalIssueStatus(linearIssue({ status: "Backlog", stateType: "backlog" }), viewConfig),
    ).toBe("other");
  });
});

describe(canonicalBlockerStatus, () => {
  it("returns 'other' when the blocker has no status", () => {
    const blocker: LinearBlocker = {
      id: "x-1",
      title: "x",
      status: undefined,
      stateType: undefined,
      projectSlugId: "aaaaaaaaaaaa",
    };
    expect(canonicalBlockerStatus(blocker, makeConfig())).toBe("other");
  });
  it("returns 'done' for a terminal status in the blocker's own project", () => {
    const blocker: LinearBlocker = {
      id: "x-1",
      title: "x",
      status: "Done",
      stateType: undefined,
      projectSlugId: "aaaaaaaaaaaa",
    };
    expect(canonicalBlockerStatus(blocker, makeConfig())).toBe("done");
  });
  it("returns 'done' via the union fallback for an off-config blocker whose status is terminal anywhere", () => {
    const config = makeConfig({
      linear: {
        projects: [
          project({
            statuses: { todo: "Todo", inProgress: "Doing", done: "Done", terminal: ["Cancelled"] },
          }),
        ],
      },
    });
    const blocker: LinearBlocker = {
      id: "off-1",
      title: "off-config",
      status: "Cancelled",
      stateType: undefined,
      projectSlugId: "ffffffffffff",
    };
    expect(canonicalBlockerStatus(blocker, config)).toBe("done");
  });
  it("uses the configured project's statuses to distinguish todo from in-progress", () => {
    const blocker: LinearBlocker = {
      id: "x-1",
      title: "x",
      status: "In Progress",
      stateType: undefined,
      projectSlugId: "aaaaaaaaaaaa",
    };
    expect(canonicalBlockerStatus(blocker, makeConfig())).toBe("in-progress");
  });
  it("collapses off-config non-terminal blockers to 'other'", () => {
    const blocker: LinearBlocker = {
      id: "off-1",
      title: "off-config",
      status: "Some Custom State",
      stateType: undefined,
      projectSlugId: "ffffffffffff",
    };
    expect(canonicalBlockerStatus(blocker, makeConfig())).toBe("other");
  });
  it("returns 'other' when the configured project's statuses don't match a non-terminal blocker status", () => {
    const blocker: LinearBlocker = {
      id: "x-1",
      title: "x",
      status: "Some Other Column",
      stateType: undefined,
      projectSlugId: "aaaaaaaaaaaa",
    };
    expect(canonicalBlockerStatus(blocker, makeConfig())).toBe("other");
  });
  it("in view mode maps blocker stateType to canonical status", () => {
    const viewConfig = makeConfig({
      linear: {
        projects: [],
        views: [{ viewSlug: "v-61e51e3730dd", slugId: "61e51e3730dd" }],
      },
    });
    expect(
      canonicalBlockerStatus(
        {
          id: "b",
          title: "b",
          status: undefined,
          stateType: "completed",
          projectSlugId: undefined,
        },
        viewConfig,
      ),
    ).toBe("done");
  });
  it("collapses to 'other' when the blocker has no projectSlugId at all", () => {
    const blocker: LinearBlocker = {
      id: "x-1",
      title: "x",
      status: "Random",
      stateType: undefined,
      projectSlugId: undefined,
    };
    expect(canonicalBlockerStatus(blocker, makeConfig())).toBe("other");
  });
});

describe(toCanonicalIssue, () => {
  it("prefixes the canonical id with the source name", () => {
    const result = toCanonicalIssue(linearIssue(), makeConfig(), "linear");
    expect(result.id).toBe("linear:team-1");
    expect(result.source).toBe("linear");
  });

  it("moves Linear-specific fields into sourceRef", () => {
    const result = toCanonicalIssue(
      linearIssue({
        uuid: "uuid-abc",
        statusId: "state-todo",
        teamId: "team-xyz",
        projectSlugId: "aaaaaaaaaaaa",
        status: "Todo",
      }),
      makeConfig(),
      "linear",
    );
    expect(result.sourceRef).toStrictEqual({
      uuid: "uuid-abc",
      statusId: "state-todo",
      teamId: "team-xyz",
      projectSlugId: "aaaaaaaaaaaa",
      nativeStatus: "Todo",
    });
  });

  it("canonicalizes the status using the issue's project", () => {
    const result = toCanonicalIssue(linearIssue({ status: "In Progress" }), makeConfig(), "linear");
    expect(result.status).toBe("in-progress");
  });

  it("leaves description empty (board snapshot doesn't fetch description)", () => {
    const result = toCanonicalIssue(linearIssue(), makeConfig(), "linear");
    expect(result.description).toBe("");
  });

  it("source-prefixes blocker ids and canonicalizes their statuses", () => {
    const issue = linearIssue({
      blockers: [
        {
          id: "team-2",
          title: "Block A",
          status: "Done",
          stateType: undefined,
          projectSlugId: "aaaaaaaaaaaa",
        },
        {
          id: "team-3",
          title: "Block B",
          status: "Todo",
          stateType: undefined,
          projectSlugId: "aaaaaaaaaaaa",
        },
      ],
    });
    const result = toCanonicalIssue(issue, makeConfig(), "linear");
    expect(result.blockers).toStrictEqual([
      { id: "linear:team-2", title: "Block A", status: "done" },
      { id: "linear:team-3", title: "Block B", status: "todo" },
    ]);
  });

  it("uses a custom source name when provided", () => {
    const result = toCanonicalIssue(linearIssue(), makeConfig(), "work-linear");
    expect(result.id).toBe("work-linear:team-1");
    expect(result.source).toBe("work-linear");
  });
});

describe(createLinearTicketSource, () => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- factory only uses the client when its methods are called; tests that exercise those methods stub the boardSource/linearIssueStatus calls so the client is never actually invoked
  const fakeClient = {} as LinearClient;
  beforeEach(() => {
    vi.spyOn(util, "getLinearClient").mockReturnValue(fakeClient);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns a TicketSource whose name defaults to 'linear'", () => {
    const source = createLinearTicketSource({ kind: "linear" }, {
      globalConfig: makeConfig(),
    } satisfies AdapterContext);
    expect(source.name).toBe("linear");
  });

  it("respects an explicit name override", () => {
    const source = createLinearTicketSource({ kind: "linear", name: "work" }, {
      globalConfig: makeConfig(),
    } satisfies AdapterContext);
    expect(source.name).toBe("work");
  });

  it("verify() delegates to createBoardSource().verify()", async () => {
    const innerVerify = vi.fn<() => Promise<void>>().mockResolvedValue();
    vi.spyOn(boardSource, "createBoardSource").mockReturnValue({
      verify: innerVerify,
      fetch: vi.fn<BoardSource["fetch"]>(),
    });
    const source = createLinearTicketSource({ kind: "linear" }, {
      globalConfig: makeConfig(),
    } satisfies AdapterContext);
    await source.verify();
    expect(innerVerify).toHaveBeenCalledTimes(1);
  });

  it("fetch() converts each LinearIssue into a canonical Issue", async () => {
    const innerFetch = vi.fn<BoardSource["fetch"]>().mockResolvedValue({
      timestamp: "2026-01-01T00:00:00Z",
      issues: [linearIssue({ id: "team-1" }), linearIssue({ id: "team-2", status: "In Progress" })],
      parentSkips: [],
    });
    vi.spyOn(boardSource, "createBoardSource").mockReturnValue({
      verify: vi.fn<() => Promise<void>>(),
      fetch: innerFetch,
    });
    const source = createLinearTicketSource({ kind: "linear" }, {
      globalConfig: makeConfig(),
    } satisfies AdapterContext);
    const issues = await source.fetch();
    expect(issues.map((i) => i.id)).toStrictEqual(["linear:team-1", "linear:team-2"]);
    expect(issues[1]?.status).toBe("in-progress");
  });

  it("resolveOne() returns a canonical Issue with description populated from fetchResolvedIssue", async () => {
    vi.spyOn(boardSource, "fetchResolvedIssue").mockResolvedValue({
      uuid: "uuid-abc",
      title: "Resolved title",
      description: "Resolved description",
      repository: "repo-a",
      model: "claude",
      teamId: "team-xyz",
      projectSlugId: "aaaaaaaaaaaa",
    });
    const source = createLinearTicketSource({ kind: "linear" }, {
      globalConfig: makeConfig(),
    } satisfies AdapterContext);
    const issue = await source.resolveOne("team-1");
    expect(issue?.id).toBe("linear:team-1");
    expect(issue?.title).toBe("Resolved title");
    expect(issue?.description).toBe("Resolved description");
    expect(issue?.repository).toBe("repo-a");
    expect(issue?.model).toBe("claude");
  });

  it("markInProgress() forwards uuid/teamId/projectSlugId from sourceRef", async () => {
    const innerMarkInProgress = vi.fn<(...args: unknown[]) => Promise<void>>().mockResolvedValue();
    vi.spyOn(linearIssueStatus, "createLinearIssueStatusUpdater").mockReturnValue({
      markInProgress: innerMarkInProgress,
      resetMissingInProgressCache: vi.fn<() => void>(),
    });
    const source = createLinearTicketSource({ kind: "linear" }, {
      globalConfig: makeConfig(),
    } satisfies AdapterContext);
    await source.markInProgress({
      id: "linear:team-1",
      source: "linear",
      title: "x",
      description: "",
      status: "todo",
      repository: "repo-a",
      model: "claude",
      assignee: "Alice",
      updatedAt: "2026-01-01T00:00:00Z",
      blockers: [],
      hasMoreBlockers: false,
      sourceRef: {
        uuid: "uuid-1",
        statusId: "s",
        teamId: "team-default",
        projectSlugId: "aaaaaaaaaaaa",
        nativeStatus: "Todo",
      },
    });
    expect(innerMarkInProgress).toHaveBeenCalledWith({
      id: "linear:team-1",
      uuid: "uuid-1",
      teamId: "team-default",
      projectSlugId: "aaaaaaaaaaaa",
    });
  });

  it("returns a view-mode source when globalConfig.linear.views is set", () => {
    const source = createLinearTicketSource({ kind: "linear" }, {
      globalConfig: makeConfig({
        linear: {
          projects: [],
          views: [{ viewSlug: "foo-61e51e3730dd", slugId: "61e51e3730dd" }],
        },
      }),
    } satisfies AdapterContext);
    expect(source.name).toBe("linear");
  });
});
