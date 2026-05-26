import type { LinearClient } from "@linear/sdk";

import type { AdapterContext } from "../../adapterDefinition.ts";
import type { ResolvedConfig, ResolvedProjectConfig } from "../../config.ts";
import { canonicalLinearIssue } from "../../testing/canonicalFixtures.ts";
import type { LinearSourceRef } from "../../adapters/linear/index.ts";
import { readEnvironmentVariable } from "../../util.ts";
import { deleteEnvironmentVariable, setEnvironmentVariable } from "../../../testHelpers/env.ts";
import * as boardSource from "./fetch.ts";
import type { Issue as LinearIssue } from "./fetch.ts";
import * as linearIssueStatus from "./writeback.ts";
import * as client from "./client.ts";
import { createLinearTicketSource, toCanonicalIssue } from "./factory.ts";

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
    description: overrides.description ?? "",
    status: overrides.status ?? "Todo",
    statusId: overrides.statusId ?? "state-todo",
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

  it("copies description from the legacy Linear issue onto the canonical Issue", () => {
    const result = toCanonicalIssue(
      linearIssue({ description: "Body of the ticket." }),
      makeConfig(),
      "linear",
    );
    expect(result.description).toBe("Body of the ticket.");
  });

  it("source-prefixes blocker ids and canonicalizes their statuses", () => {
    const issue = linearIssue({
      blockers: [
        { id: "team-2", title: "Block A", status: "Done", projectSlugId: "aaaaaaaaaaaa" },
        { id: "team-3", title: "Block B", status: "Todo", projectSlugId: "aaaaaaaaaaaa" },
      ],
    });
    const result = toCanonicalIssue(issue, makeConfig(), "linear");
    expect(result.blockers).toStrictEqual([
      { id: "linear:team-2", title: "Block A", status: "done", nativeStatus: "Done" },
      { id: "linear:team-3", title: "Block B", status: "todo", nativeStatus: "Todo" },
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

  describe("optional methods", () => {
    it("refreshBlockers() calls fetchBlockersForTicket and returns canonical Blockers", async () => {
      vi.spyOn(boardSource, "fetchBlockersForTicket").mockResolvedValueOnce([
        { id: "eng-50", title: "Block", status: "Done", projectSlugId: "aaaaaaaaaaaa" },
      ]);
      const source = createLinearTicketSource({ kind: "linear" }, {
        globalConfig: makeConfig(),
      } satisfies AdapterContext);
      const ref: LinearSourceRef = {
        uuid: "u-1",
        statusId: "",
        teamId: "",
        projectSlugId: "aaaaaaaaaaaa",
        nativeStatus: "",
      };
      const issue = canonicalLinearIssue({
        naturalId: "eng-100",
        source: "linear",
        // sourceRef is typed as unknown in Issue; the adapter downcasts it internally
        sourceRef: ref as unknown,
      });

      expect(source).toHaveProperty("refreshBlockers");
      // oxlint-disable-next-line typescript/no-non-null-assertion -- Linear adapter always implements refreshBlockers; presence asserted above
      const blockers = await source.refreshBlockers!(issue);

      expect(blockers).toStrictEqual([
        { id: "linear:eng-50", title: "Block", status: "done", nativeStatus: "Done" },
      ]);
      expect(boardSource.fetchBlockersForTicket).toHaveBeenCalledWith(
        expect.objectContaining({ uuid: "u-1" }),
      );
    });

    it("countInProgress() calls fetchInProgressIssueCount and returns the number", async () => {
      vi.spyOn(boardSource, "fetchInProgressIssueCount").mockResolvedValueOnce(7);
      const source = createLinearTicketSource({ kind: "linear" }, {
        globalConfig: makeConfig(),
      } satisfies AdapterContext);

      expect(source).toHaveProperty("countInProgress");
      // oxlint-disable-next-line typescript/no-non-null-assertion -- Linear adapter always implements countInProgress; presence asserted above
      const count = await source.countInProgress!();

      expect(count).toBe(7);
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
