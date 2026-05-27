import type { LinearClient } from "@linear/sdk";

import type { AdapterContext } from "../../adapterDefinition.ts";
import * as boardSource from "../../boardSource.ts";
import type {
  BoardSource,
  Blocker as LinearBlocker,
  Issue as LinearIssue,
} from "../../boardSource.ts";
import type { ResolvedConfig } from "../../config.ts";
import * as linearIssueStatus from "../../linearIssueStatus.ts";
import * as util from "../../util.ts";
import {
  canonicalStatusFromStateType,
  createLinearTicketSource,
  toCanonicalIssue,
} from "./factory.ts";

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
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
    blockers: overrides.blockers ?? [],
    hasMoreBlockers: overrides.hasMoreBlockers ?? false,
  };
}

describe(canonicalStatusFromStateType, () => {
  it("maps unstarted to canonical 'todo'", () => {
    expect(canonicalStatusFromStateType("unstarted")).toBe("todo");
  });
  it("maps started to canonical 'in-progress'", () => {
    expect(canonicalStatusFromStateType("started")).toBe("in-progress");
  });
  it("maps completed/canceled/duplicate to canonical 'done'", () => {
    expect(canonicalStatusFromStateType("completed")).toBe("done");
    expect(canonicalStatusFromStateType("canceled")).toBe("done");
    expect(canonicalStatusFromStateType("duplicate")).toBe("done");
  });
  it("maps anything else to 'other'", () => {
    expect(canonicalStatusFromStateType("backlog")).toBe("other");
    expect(canonicalStatusFromStateType("triage")).toBe("other");
    // oxlint-disable-next-line unicorn/no-useless-undefined -- the function's documented contract includes the undefined branch
    expect(canonicalStatusFromStateType(undefined)).toBe("other");
  });
});

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
        status: "Todo",
      }),
      "linear",
    );
    expect(result.sourceRef).toStrictEqual({
      uuid: "uuid-abc",
      statusId: "state-todo",
      teamId: "team-xyz",
      nativeStatus: "Todo",
    });
  });

  it("canonicalizes the status using the issue's stateType", () => {
    const result = toCanonicalIssue(
      linearIssue({ status: "Doing", stateType: "started" }),
      "linear",
    );
    expect(result.status).toBe("in-progress");
  });

  it("leaves description empty (board snapshot doesn't fetch description)", () => {
    const result = toCanonicalIssue(linearIssue(), "linear");
    expect(result.description).toBe("");
  });

  it("source-prefixes blocker ids and maps statuses from stateType", () => {
    const blockers: LinearBlocker[] = [
      { id: "team-2", title: "Block A", status: "Done", stateType: "completed" },
      { id: "team-3", title: "Block B", status: "Todo", stateType: "unstarted" },
    ];
    const issue = linearIssue({ blockers });
    const result = toCanonicalIssue(issue, "linear");
    expect(result.blockers).toStrictEqual([
      { id: "linear:team-2", title: "Block A", status: "done" },
      { id: "linear:team-3", title: "Block B", status: "todo" },
    ]);
  });

  it("uses a custom source name when provided", () => {
    const result = toCanonicalIssue(linearIssue(), "work-linear");
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

  it("markInProgress() forwards uuid/teamId from sourceRef", async () => {
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
        nativeStatus: "Todo",
      },
    });
    expect(innerMarkInProgress).toHaveBeenCalledWith({
      id: "linear:team-1",
      uuid: "uuid-1",
      teamId: "team-default",
    });
  });
});
