import type { LinearClient } from "@linear/sdk";

import type { AdapterContext } from "../../adapterDefinition.ts";
import type { ResolvedConfig } from "../../config.ts";
import type { MarkInReviewResult } from "../../ticketSource.ts";
import { readEnvironmentVariable } from "../../util.ts";
import { deleteEnvironmentVariable, setEnvironmentVariable } from "../../../testHelpers/env.ts";
import * as boardSource from "./fetch.ts";
import type { Issue as LinearIssue } from "./fetch.ts";
import * as linearIssueStatus from "./writeback.ts";
import * as client from "./client.ts";
import { createLinearTicketSource, toCanonicalIssue } from "./factory.ts";

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    sources: [],
    defaults: { hooks: {} },
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
    description: overrides.description ?? "",
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
    url: overrides.url ?? "https://linear.app/example/issue/TEAM-1",
  };
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
    const result = toCanonicalIssue(linearIssue({ description: "Body of the ticket." }), "linear");
    expect(result.description).toBe("Body of the ticket.");
  });

  it("source-prefixes blocker ids and canonicalizes their statuses via stateType", () => {
    const issue = linearIssue({
      blockers: [
        { id: "team-2", title: "Block A", status: "Done", stateType: "completed" },
        { id: "team-3", title: "Block B", status: "Todo", stateType: "unstarted" },
      ],
    });
    const result = toCanonicalIssue(issue, "linear");
    expect(result.blockers).toStrictEqual([
      { id: "linear:team-2", title: "Block A", status: "done", nativeStatus: "Done" },
      { id: "linear:team-3", title: "Block B", status: "todo", nativeStatus: "Todo" },
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
    vi.spyOn(client, "getLinearClient").mockReturnValue(fakeClient);
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
      fetch: vi.fn<() => Promise<boardSource.BoardState>>(),
    });
    const source = createLinearTicketSource({ kind: "linear" }, {
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
    const source = createLinearTicketSource({ kind: "linear" }, {
      globalConfig: makeConfig(),
    } satisfies AdapterContext);
    const issues = await source.fetch();
    expect(issues.map((i) => i.id)).toStrictEqual(["linear:team-1", "linear:team-2"]);
    expect(issues[1]?.status).toBe("in-progress");
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
    const source = createLinearTicketSource({ kind: "linear", name: "work-linear" }, {
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
      model: "claude",
      teamId: "team-xyz",
      stateType: "unstarted",
      status: "Todo",
      statusId: "state-todo",
      url: "https://linear.app/example/issue/TEAM-1",
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
    expect(issue?.status).toBe("todo");
  });

  it("markInProgress() forwards uuid/teamId from sourceRef", async () => {
    const innerMarkInProgress = vi.fn<(...args: unknown[]) => Promise<void>>().mockResolvedValue();
    vi.spyOn(linearIssueStatus, "createLinearIssueStatusUpdater").mockReturnValue({
      markInProgress: innerMarkInProgress,
      markInReview: vi
        .fn<(...args: unknown[]) => Promise<MarkInReviewResult>>()
        .mockResolvedValue({ outcome: "unsupported", reason: "not implemented" }),
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
        stateType: "unstarted",
        nativeStatus: "Todo",
      },
    });
    expect(innerMarkInProgress).toHaveBeenCalledWith({
      id: "linear:team-1",
      uuid: "uuid-1",
      teamId: "team-default",
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
    const source = createLinearTicketSource({ kind: "linear" }, {
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
        model: "claude",
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
// source (multi-source Board fan-out, `crew doctor --ticket <shell-id>`)
// must not crash at adapter-construction time on a missing key. These
// tests deliberately do NOT stub `getLinearClient` — the point is to
// exercise the real key-resolution path.
// ─────────────────────────────────────────────────────────────────────────

describe("createLinearTicketSource — lazy client construction", () => {
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
      createLinearTicketSource({ kind: "linear" }, {
        globalConfig: makeConfig(),
      } satisfies AdapterContext),
    ).not.toThrow();
  });

  it("throws about the missing key only when verify() is invoked", async () => {
    const source = createLinearTicketSource({ kind: "linear" }, {
      globalConfig: makeConfig(),
    } satisfies AdapterContext);

    await expect(source.verify()).rejects.toThrow(/GROUNDCREW_LINEAR_API_KEY or LINEAR_API_KEY/);
  });

  it("throws about the missing key only when fetch() is invoked", async () => {
    const source = createLinearTicketSource({ kind: "linear" }, {
      globalConfig: makeConfig(),
    } satisfies AdapterContext);

    await expect(source.fetch()).rejects.toThrow(/GROUNDCREW_LINEAR_API_KEY or LINEAR_API_KEY/);
  });
});
