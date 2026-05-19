import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RawLinearIssue } from "../lib/boardSource.ts";
import type { ResolvedConfig } from "../lib/config.ts";
import {
  renderTicketDoctorResult,
  ticketDoctor,
  ticketDoctorCli,
  type TicketDoctorDependencies,
  type TicketDoctorResult,
} from "./ticketDoctor.ts";

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    linear: {
      projectSlug: "ai-strategy-aaaaaaaaaaaa",
      slugId: "aaaaaaaaaaaa",
      statuses: { todo: "Todo", inProgress: "In Progress", done: "Done", terminal: ["Done"] },
      ...overrides.linear,
    },
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
      definitions: { claude: { cmd: "claude", color: "#fff" } },
      ...overrides.models,
    },
    prompts: { initial: "x", ...overrides.prompts },
    workspaceKind: overrides.workspaceKind ?? "auto",
    local: { runner: "auto", ...overrides.local },
    logging: { file: "/tmp/groundcrew-test.log", ...overrides.logging },
  };
}

function makeStubRawIssue(overrides: Partial<RawLinearIssue> = {}): RawLinearIssue {
  return {
    uuid: "uuid-1",
    title: "Stub",
    description: "",
    teamId: "team-1",
    labels: [],
    stateName: "Todo",
    blockers: [],
    hasMoreBlockers: false,
    ...overrides,
  };
}

function makeStubDependencies(
  overrides: Partial<TicketDoctorDependencies> = {},
): TicketDoctorDependencies {
  return {
    config: makeConfig(),
    ticket: "HRD-1",
    fetchRawIssue: vi
      .fn<TicketDoctorDependencies["fetchRawIssue"]>()
      .mockResolvedValue(makeStubRawIssue()),
    fetchBlockersFor: vi.fn<TicketDoctorDependencies["fetchBlockersFor"]>().mockResolvedValue([]),
    fetchUsage: vi.fn<TicketDoctorDependencies["fetchUsage"]>().mockResolvedValue({}),
    countInProgress: vi.fn<TicketDoctorDependencies["countInProgress"]>().mockResolvedValue(0),
    ...overrides,
  };
}

describe("ticketDoctor pure function", () => {
  it("normalizes the ticket id to upper case", async () => {
    const dependencies = makeStubDependencies({ ticket: "hrd-1" });
    const result = await ticketDoctor(dependencies);
    expect(result.ticket).toBe("HRD-1");
  });

  it("returns unresolvable when fetchRawIssue throws an Error", async () => {
    const dependencies = makeStubDependencies({
      fetchRawIssue: vi
        .fn<TicketDoctorDependencies["fetchRawIssue"]>()
        .mockRejectedValue(new Error("Ticket HRD-1 not found in Linear")),
    });
    const result = await ticketDoctor(dependencies);
    expect(result.verdict.kind).toBe("unresolvable");
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- kind already asserted above; narrowing union to access reason field
    const unresolvable = result.verdict as Extract<typeof result.verdict, { kind: "unresolvable" }>;
    expect(unresolvable.reason).toMatch(/not found/);
  });

  it("returns unresolvable when fetchRawIssue throws a non-Error value", async () => {
    const dependencies = makeStubDependencies({
      fetchRawIssue: vi
        .fn<TicketDoctorDependencies["fetchRawIssue"]>()
        .mockRejectedValue("string error"),
    });
    const result = await ticketDoctor(dependencies);
    expect(result.verdict.kind).toBe("unresolvable");
    expect(result.verdict).toMatchObject({ reason: "string error" });
  });

  it("records the resolved ticket title in the result", async () => {
    const dependencies = makeStubDependencies({
      fetchRawIssue: vi
        .fn<TicketDoctorDependencies["fetchRawIssue"]>()
        .mockResolvedValue(makeStubRawIssue({ title: "Some title" })),
    });
    const result = await ticketDoctor(dependencies);
    expect(result.title).toBe("Some title");
  });
});

describe("ticketDoctor resolution checks", () => {
  it("records status-mismatch as fail with current state in detail", async () => {
    const dependencies = makeStubDependencies({
      fetchRawIssue: vi.fn<TicketDoctorDependencies["fetchRawIssue"]>().mockResolvedValue(
        makeStubRawIssue({
          labels: [{ name: "agent-claude" }],
          stateName: "In Review",
          description: "see herds-social/herds",
        }),
      ),
      config: makeConfig({
        linear: {
          projectSlug: "ai-strategy-aaaaaaaaaaaa",
          slugId: "aaaaaaaaaaaa",
          statuses: { todo: "Todo", inProgress: "In Progress", done: "Done", terminal: ["Done"] },
        },
        workspace: { projectDir: "/work", knownRepositories: ["herds-social/herds"] },
        models: {
          default: "claude",
          definitions: { claude: { cmd: "claude", color: "#fff" } },
        },
      }),
    });
    const result = await ticketDoctor(dependencies);
    const statusCheck = result.resolution.find((check) => check.name === "Status is Todo");
    expect(statusCheck?.status).toBe("fail");
    expect(statusCheck?.detail).toMatch(/In Review/);
  });

  it("records missing agent-* label as fail and skips the model check", async () => {
    const dependencies = makeStubDependencies({
      fetchRawIssue: vi
        .fn<TicketDoctorDependencies["fetchRawIssue"]>()
        .mockResolvedValue(
          makeStubRawIssue({ labels: [], stateName: "Todo", description: "see repo-a" }),
        ),
    });
    const result = await ticketDoctor(dependencies);
    const labelCheck = result.resolution.find((check) => check.name === "Has agent-* label");
    const modelCheck = result.resolution.find(
      (check) => check.name === "Model resolves from agent-* label",
    );
    expect(labelCheck?.status).toBe("fail");
    expect(modelCheck?.status).toBe("skipped");
  });

  it("records agent-* label and matched model as ok", async () => {
    const dependencies = makeStubDependencies({
      fetchRawIssue: vi.fn<TicketDoctorDependencies["fetchRawIssue"]>().mockResolvedValue(
        makeStubRawIssue({
          labels: [{ name: "agent-claude" }],
          stateName: "Todo",
          description: "see repo-a",
        }),
      ),
    });
    const result = await ticketDoctor(dependencies);
    const labelCheck = result.resolution.find((check) => check.name === "Has agent-* label");
    const modelCheck = result.resolution.find(
      (check) => check.name === "Model resolves from agent-* label",
    );
    expect(labelCheck?.status).toBe("ok");
    expect(modelCheck?.status).toBe("ok");
    expect(modelCheck?.detail).toMatch(/claude/);
  });

  it("reports disabled-fallback model resolution with both names in detail", async () => {
    const dependencies = makeStubDependencies({
      fetchRawIssue: vi.fn<TicketDoctorDependencies["fetchRawIssue"]>().mockResolvedValue(
        makeStubRawIssue({
          labels: [{ name: "agent-codex" }],
          stateName: "Todo",
          description: "see repo-a",
        }),
      ),
      config: makeConfig({
        models: {
          default: "claude",
          definitions: {
            claude: { cmd: "claude", color: "#fff" },
            // codex intentionally absent — simulates `disabled: true` path
          },
        },
      }),
    });
    const result = await ticketDoctor(dependencies);
    const modelCheck = result.resolution.find(
      (check) => check.name === "Model resolves from agent-* label",
    );
    expect(modelCheck?.status).toBe("ok");
    expect(modelCheck?.detail).toMatch(/codex/);
    expect(modelCheck?.detail).toMatch(/claude/);
  });

  it("records repo recognition as ok when description matches a known repo", async () => {
    const dependencies = makeStubDependencies({
      fetchRawIssue: vi.fn<TicketDoctorDependencies["fetchRawIssue"]>().mockResolvedValue(
        makeStubRawIssue({
          labels: [{ name: "agent-claude" }],
          stateName: "Todo",
          description: "see herds-social/herds",
        }),
      ),
      config: makeConfig({
        workspace: { projectDir: "/work", knownRepositories: ["herds-social/herds"] },
      }),
    });
    const result = await ticketDoctor(dependencies);
    const repoCheck = result.resolution.find(
      (check) => check.name === "Description mentions known repo",
    );
    expect(repoCheck?.status).toBe("ok");
    expect(repoCheck?.detail).toMatch(/herds-social\/herds/);
  });

  it("records repo recognition as fail when description has no known repo", async () => {
    const dependencies = makeStubDependencies({
      fetchRawIssue: vi.fn<TicketDoctorDependencies["fetchRawIssue"]>().mockResolvedValue(
        makeStubRawIssue({
          labels: [{ name: "agent-claude" }],
          stateName: "Todo",
          description: "no relevant text",
        }),
      ),
    });
    const result = await ticketDoctor(dependencies);
    const repoCheck = result.resolution.find(
      (check) => check.name === "Description mentions known repo",
    );
    expect(repoCheck?.status).toBe("fail");
    expect(repoCheck?.detail).toMatch(/repo-a/);
  });

  it("records agent-any label as ok with would-resolve-to-default detail", async () => {
    const dependencies = makeStubDependencies({
      fetchRawIssue: vi.fn<TicketDoctorDependencies["fetchRawIssue"]>().mockResolvedValue(
        makeStubRawIssue({
          labels: [{ name: "agent-any" }],
          stateName: "Todo",
          description: "see repo-a",
        }),
      ),
    });
    const result = await ticketDoctor(dependencies);
    const labelCheck = result.resolution.find((check) => check.name === "Has agent-* label");
    const modelCheck = result.resolution.find(
      (check) => check.name === "Model resolves from agent-* label",
    );
    expect(labelCheck?.status).toBe("ok");
    expect(modelCheck?.status).toBe("ok");
    expect(modelCheck?.detail).toMatch(/claude/);
  });
});

describe("ticketDoctor — env checks", () => {
  it("records repo-dir-missing as fail when the resolved repo isn't cloned", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "td-"));
    try {
      const dependencies = makeStubDependencies({
        config: makeConfig({
          workspace: {
            knownRepositories: ["herds-social/herds"],
            projectDir,
          },
        }),
        fetchRawIssue: vi.fn<TicketDoctorDependencies["fetchRawIssue"]>().mockResolvedValue({
          uuid: "u",
          title: "X",
          description: "see herds-social/herds",
          teamId: "team-1",
          labels: [{ name: "agent-claude" }],
          stateName: "Todo",
          blockers: [],
          hasMoreBlockers: false,
        }),
      });
      const result = await ticketDoctor(dependencies);
      const repoDir = result.resolution.find(
        (check) => check.name === "Resolved repo is cloned locally",
      );
      expect(repoDir?.status).toBe("fail");
      expect(repoDir?.detail).toMatch(/herds-social\/herds/);
      expect(repoDir?.detail).toMatch(/crew setup repos/);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("records repo-dir as ok when the resolved repo exists on disk", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "td-"));
    mkdirSync(join(projectDir, "herds-social", "herds"), { recursive: true });
    try {
      const dependencies = makeStubDependencies({
        config: makeConfig({
          workspace: {
            knownRepositories: ["herds-social/herds"],
            projectDir,
          },
        }),
        fetchRawIssue: vi.fn<TicketDoctorDependencies["fetchRawIssue"]>().mockResolvedValue({
          uuid: "u",
          title: "X",
          description: "see herds-social/herds",
          teamId: "team-1",
          labels: [{ name: "agent-claude" }],
          stateName: "Todo",
          blockers: [],
          hasMoreBlockers: false,
        }),
      });
      const result = await ticketDoctor(dependencies);
      const repoDir = result.resolution.find(
        (check) => check.name === "Resolved repo is cloned locally",
      );
      expect(repoDir?.status).toBe("ok");
      expect(repoDir?.detail).toContain(projectDir);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("skips the repo-dir check when the repo couldn't be resolved", async () => {
    const dependencies = makeStubDependencies({
      config: makeConfig({
        workspace: { knownRepositories: ["herds-social/herds"], projectDir: "/tmp" },
      }),
      fetchRawIssue: vi.fn<TicketDoctorDependencies["fetchRawIssue"]>().mockResolvedValue({
        uuid: "u",
        title: "X",
        description: "no known repo mentioned here",
        teamId: "team-1",
        labels: [{ name: "agent-claude" }],
        stateName: "Todo",
        blockers: [],
        hasMoreBlockers: false,
      }),
    });
    const result = await ticketDoctor(dependencies);
    const repoDir = result.resolution.find(
      (check) => check.name === "Resolved repo is cloned locally",
    );
    expect(repoDir?.status).toBe("skipped");
  });
});

describe("ticketDoctor — eligibility phase", () => {
  /** Build a fully-passing stub set: all resolution checks pass and all
   *  eligibility checks pass by default. Individual tests override only the
   *  dimension under test.
   */
  function makeFullStub(
    overrides: Partial<TicketDoctorDependencies> = {},
  ): TicketDoctorDependencies {
    return {
      config: makeConfig({
        orchestrator: {
          maximumInProgress: 2,
          pollIntervalMilliseconds: 1000,
          sessionLimitPercentage: 85,
        },
        workspace: { projectDir: "/tmp", knownRepositories: ["herds-social/herds"] },
        models: {
          default: "claude",
          definitions: { claude: { cmd: "claude", color: "#fff" } },
        },
      }),
      ticket: "HRD-1",
      fetchRawIssue: vi.fn<TicketDoctorDependencies["fetchRawIssue"]>().mockResolvedValue({
        uuid: "uuid-1",
        title: "X",
        description: "see herds-social/herds",
        teamId: "team-1",
        labels: [{ name: "agent-claude" }],
        stateName: "Todo",
        blockers: [],
        hasMoreBlockers: false,
      }),
      fetchBlockersFor: vi.fn<TicketDoctorDependencies["fetchBlockersFor"]>().mockResolvedValue([]),
      // session: 0.23 = 23%, limit: 85% → under limit → ok
      fetchUsage: vi.fn<TicketDoctorDependencies["fetchUsage"]>().mockResolvedValue({
        claude: { session: 0.23, sessionEndDuration: null, weekly: null, weekEndDuration: null },
      }),
      countInProgress: vi.fn<TicketDoctorDependencies["countInProgress"]>().mockResolvedValue(0),
      ...overrides,
    };
  }

  it("returns would-dispatch when all resolution and eligibility checks pass", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "td-el-"));
    mkdirSync(join(projectDir, "herds-social", "herds"), { recursive: true });
    try {
      const dependencies = makeFullStub({
        config: makeConfig({
          orchestrator: {
            maximumInProgress: 2,
            pollIntervalMilliseconds: 1000,
            sessionLimitPercentage: 85,
          },
          workspace: {
            projectDir,
            knownRepositories: ["herds-social/herds"],
          },
          models: {
            default: "claude",
            definitions: { claude: { cmd: "claude", color: "#fff" } },
          },
        }),
      });
      const result = await ticketDoctor(dependencies);
      expect(result.verdict.kind).toBe("would-dispatch");
      expect(result.eligibility).toHaveLength(3);
      expect(result.eligibility.every((c) => c.status === "ok")).toBe(true);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("flags blocker check as fail when fetchBlockersFor returns a non-terminal blocker", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "td-el-"));
    mkdirSync(join(projectDir, "herds-social", "herds"), { recursive: true });
    try {
      const dependencies = makeFullStub({
        config: makeConfig({
          orchestrator: {
            maximumInProgress: 2,
            pollIntervalMilliseconds: 1000,
            sessionLimitPercentage: 85,
          },
          workspace: {
            projectDir,
            knownRepositories: ["herds-social/herds"],
          },
          models: {
            default: "claude",
            definitions: { claude: { cmd: "claude", color: "#fff" } },
          },
          linear: {
            projectSlug: "ai-strategy-aaaaaaaaaaaa",
            slugId: "aaaaaaaaaaaa",
            statuses: {
              todo: "Todo",
              inProgress: "In Progress",
              done: "Done",
              terminal: ["Done"],
            },
          },
        }),
        fetchBlockersFor: vi
          .fn<TicketDoctorDependencies["fetchBlockersFor"]>()
          .mockResolvedValue([{ id: "HRD-2", title: "Blocking ticket", status: "In Progress" }]),
      });
      const result = await ticketDoctor(dependencies);
      const check = result.eligibility.find((c) => c.name === "No active blockers");
      expect(check?.status).toBe("fail");
      expect(result.verdict).toMatchObject({
        kind: "ineligible",
        reason: "blocked by HRD-2:In Progress",
      });
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("flags model usage check as fail when session is over the limit", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "td-el-"));
    mkdirSync(join(projectDir, "herds-social", "herds"), { recursive: true });
    try {
      const dependencies = makeFullStub({
        config: makeConfig({
          orchestrator: {
            maximumInProgress: 2,
            pollIntervalMilliseconds: 1000,
            sessionLimitPercentage: 85,
          },
          workspace: {
            projectDir,
            knownRepositories: ["herds-social/herds"],
          },
          models: {
            default: "claude",
            definitions: { claude: { cmd: "claude", color: "#fff" } },
          },
        }),
        // session: 0.90 = 90% > 85% limit → fail
        fetchUsage: vi.fn<TicketDoctorDependencies["fetchUsage"]>().mockResolvedValue({
          claude: { session: 0.9, sessionEndDuration: null, weekly: null, weekEndDuration: null },
        }),
      });
      const result = await ticketDoctor(dependencies);
      const check = result.eligibility.find(
        (c) => c.name === 'Model "claude" usage under sessionLimitPercentage',
      );
      expect(check?.status).toBe("fail");
      expect(result.verdict).toMatchObject({
        kind: "ineligible",
        reason: "claude session usage 90% over 85% limit",
      });
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("flags in-progress cap check as fail when cap is already reached", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "td-el-"));
    mkdirSync(join(projectDir, "herds-social", "herds"), { recursive: true });
    try {
      const dependencies = makeFullStub({
        config: makeConfig({
          orchestrator: {
            maximumInProgress: 2,
            pollIntervalMilliseconds: 1000,
            sessionLimitPercentage: 85,
          },
          workspace: {
            projectDir,
            knownRepositories: ["herds-social/herds"],
          },
          models: {
            default: "claude",
            definitions: { claude: { cmd: "claude", color: "#fff" } },
          },
        }),
        // 2 in progress, cap is 2 → fail (inProgress < cap requires strictly less)
        countInProgress: vi.fn<TicketDoctorDependencies["countInProgress"]>().mockResolvedValue(2),
      });
      const result = await ticketDoctor(dependencies);
      const check = result.eligibility.find((c) => c.name === "In-progress cap not hit");
      expect(check?.status).toBe("fail");
      expect(result.verdict).toMatchObject({
        kind: "ineligible",
        reason: "in-progress cap is full (2/2 used)",
      });
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("uses the default model for usage check when the ticket has an agent-any label", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "td-el-"));
    mkdirSync(join(projectDir, "herds-social", "herds"), { recursive: true });
    try {
      const fetchUsage = vi.fn<TicketDoctorDependencies["fetchUsage"]>().mockResolvedValue({
        claude: { session: 0.1, sessionEndDuration: null, weekly: null, weekEndDuration: null },
      });
      const dependencies = makeFullStub({
        config: makeConfig({
          orchestrator: {
            maximumInProgress: 2,
            pollIntervalMilliseconds: 1000,
            sessionLimitPercentage: 85,
          },
          workspace: {
            projectDir,
            knownRepositories: ["herds-social/herds"],
          },
          models: {
            default: "claude",
            definitions: { claude: { cmd: "claude", color: "#fff" } },
          },
        }),
        fetchRawIssue: vi.fn<TicketDoctorDependencies["fetchRawIssue"]>().mockResolvedValue({
          uuid: "uuid-1",
          title: "X",
          description: "see herds-social/herds",
          teamId: "team-1",
          labels: [{ name: "agent-any" }],
          stateName: "Todo",
          blockers: [],
          hasMoreBlockers: false,
        }),
        fetchUsage,
      });
      const result = await ticketDoctor(dependencies);
      // agent-any falls back to default model "claude"; usage check should pass
      const usageCheck = result.eligibility.find(
        (c) => c.name === 'Model "claude" usage under sessionLimitPercentage',
      );
      expect(usageCheck?.status).toBe("ok");
      expect(result.verdict.kind).toBe("would-dispatch");
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("leaves eligibility empty and skips fetchBlockersFor when resolution failed", async () => {
    const fetchBlockersFor = vi
      .fn<TicketDoctorDependencies["fetchBlockersFor"]>()
      .mockResolvedValue([]);
    const dependencies = makeStubDependencies({
      fetchRawIssue: vi
        .fn<TicketDoctorDependencies["fetchRawIssue"]>()
        .mockResolvedValue(makeStubRawIssue({ stateName: "Done", labels: [], description: "" })),
      fetchBlockersFor,
    });
    const result = await ticketDoctor(dependencies);
    expect(result.eligibility).toHaveLength(0);
    expect(fetchBlockersFor).not.toHaveBeenCalled();
    expect(result.verdict.kind).toBe("ineligible");
  });
});

function makeWouldDispatchResult(): TicketDoctorResult {
  return {
    ticket: "HRD-446",
    title: "Multi-event",
    resolution: [
      { name: "Ticket exists in Linear", status: "ok", detail: '"Multi-event"' },
      { name: "Status is Todo", status: "ok" },
      { name: "Has agent-* label", status: "ok", detail: "agent-claude" },
      { name: "Model resolves from agent-* label", status: "ok", detail: 'model "claude"' },
      {
        name: "Description mentions known repo",
        status: "ok",
        detail: "herds-social/herds",
      },
      {
        name: "Resolved repo is cloned locally",
        status: "ok",
        detail: "/work/herds-social/herds",
      },
    ],
    eligibility: [
      { name: "No active blockers", status: "ok" },
      {
        name: 'Model "claude" usage under sessionLimitPercentage',
        status: "ok",
        detail: "23% (limit 85%)",
      },
      { name: "In-progress cap not hit", status: "ok", detail: "1/4 used" },
    ],
    verdict: { kind: "would-dispatch" },
  };
}

describe("ticket doctor renderer", () => {
  it("green-path: contains [ok] lines, ticket id, and would-dispatch line", () => {
    const result = makeWouldDispatchResult();
    const lines = renderTicketDoctorResult(result);

    expect(lines.some((l) => l.includes("HRD-446"))).toBe(true);
    expect(lines.some((l) => l.includes("Multi-event"))).toBe(true);
    expect(lines.filter((l) => l.includes("[ok]")).length).toBeGreaterThan(0);
    expect(lines.some((l) => l.includes("would be dispatched on next tick"))).toBe(true);
    expect(lines.some((l) => l.includes("Resolution"))).toBe(true);
    expect(lines.some((l) => l.includes("Eligibility"))).toBe(true);
  });

  it("failed resolution check: renders [--] with detail and ineligible verdict line", () => {
    const result: TicketDoctorResult = {
      ticket: "HRD-1",
      title: "My Ticket",
      resolution: [
        { name: "Ticket exists in Linear", status: "ok", detail: '"My Ticket"' },
        { name: "Status is Todo", status: "ok" },
        { name: "Has agent-* label", status: "ok", detail: "agent-claude" },
        { name: "Model resolves from agent-* label", status: "ok", detail: 'model "claude"' },
        {
          name: "Description mentions known repo",
          status: "fail",
          detail: "no entry from workspace.knownRepositories (repo-a) appears in description",
        },
        { name: "Resolved repo is cloned locally", status: "skipped" },
      ],
      eligibility: [],
      verdict: { kind: "ineligible", reason: "description does not mention a known repo" },
    };

    const lines = renderTicketDoctorResult(result);

    const failLine = lines.find((l) => l.includes("Description mentions known repo"));
    expect(failLine).toBeDefined();
    expect(failLine).toMatch(/\[--\]/);
    expect(failLine).toMatch(/no entry/);

    expect(
      lines.some((l) => l.includes("→ ineligible: description does not mention a known repo")),
    ).toBe(true);
  });

  it("empty eligibility with ineligible verdict: prints resolution-checks-failed skip message", () => {
    const result: TicketDoctorResult = {
      ticket: "HRD-2",
      title: "Bad Ticket",
      resolution: [
        { name: "Ticket exists in Linear", status: "ok", detail: '"Bad Ticket"' },
        { name: "Status is Todo", status: "fail", detail: "current: Done" },
      ],
      eligibility: [],
      verdict: { kind: "ineligible", reason: "status is Done (need Todo)" },
    };

    const lines = renderTicketDoctorResult(result);

    expect(lines.some((l) => l.includes("(skipped — resolution checks failed)"))).toBe(true);
    expect(lines.some((l) => l.includes("(skipped — ticket unresolved)"))).toBe(false);
  });

  it("unresolvable verdict: prints ticket-unresolved skip message in eligibility", () => {
    const result: TicketDoctorResult = {
      ticket: "HRD-404",
      resolution: [
        {
          name: "Ticket exists in Linear",
          status: "fail",
          detail: "Ticket HRD-404 not found in Linear",
        },
      ],
      eligibility: [],
      verdict: { kind: "unresolvable", reason: "Ticket HRD-404 not found in Linear" },
    };

    const lines = renderTicketDoctorResult(result);

    expect(lines.some((l) => l.includes("(skipped — ticket unresolved)"))).toBe(true);
    expect(
      lines.some((l) => l.includes("→ unresolvable: Ticket HRD-404 not found in Linear")),
    ).toBe(true);
  });

  it("skipped resolution check renders with [? ] tag, distinct from [--]", () => {
    const result: TicketDoctorResult = {
      ticket: "HRD-3",
      title: "Cascade",
      resolution: [
        { name: "Ticket exists in Linear", status: "ok", detail: '"Cascade"' },
        { name: "Status is Todo", status: "ok" },
        {
          name: "Has agent-* label",
          status: "fail",
          detail: "no agent-* label on this ticket",
          failureSummary: "ticket has no agent-* label",
        },
        { name: "Model resolves from agent-* label", status: "skipped" },
      ],
      eligibility: [],
      verdict: { kind: "ineligible", reason: "ticket has no agent-* label" },
    };

    const lines = renderTicketDoctorResult(result);

    const labelLine = lines.find((l) => l.includes("Has agent-* label"));
    const modelLine = lines.find((l) => l.includes("Model resolves from agent-* label"));
    expect(labelLine).toMatch(/\[--\]/);
    expect(modelLine).toMatch(/\[\? \]/);
    expect(modelLine).not.toMatch(/\[--\]/);
  });
});

describe("ticketDoctorCli argument validation", () => {
  it("throws a usage error when no ticket is provided", async () => {
    await expect(ticketDoctorCli([])).rejects.toThrow(/Usage: crew doctor --ticket <ticket>/);
  });

  it("throws a usage error when the argument looks like a flag", async () => {
    await expect(ticketDoctorCli(["--help"])).rejects.toThrow(
      /Usage: crew doctor --ticket <ticket>/,
    );
  });

  it("throws on extra arguments beyond the ticket id", async () => {
    await expect(ticketDoctorCli(["HRD-1", "extra"])).rejects.toThrow(
      /crew doctor --ticket: unexpected arguments: extra/,
    );
  });
});
