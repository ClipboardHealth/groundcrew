import type { RawLinearIssue } from "../lib/boardSource.ts";
import type { ResolvedConfig } from "../lib/config.ts";
import { ticketDoctor, type TicketDoctorDependencies } from "./ticketDoctor.ts";

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    linear: {
      projectSlug: "ai-strategy-aaaaaaaaaaaa",
      slugId: "aaaaaaaaaaaa",
      statuses: { todo: "Todo", inProgress: "In Progress", done: "Done", terminal: ["Done"] },
      teamIds: ["team-1"],
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
          teamId: "team-1",
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
          teamIds: ["team-1"],
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

  it("records team mismatch as fail", async () => {
    const dependencies = makeStubDependencies({
      fetchRawIssue: vi
        .fn<TicketDoctorDependencies["fetchRawIssue"]>()
        .mockResolvedValue(
          makeStubRawIssue({
            teamId: "team-OTHER",
            labels: [{ name: "agent-claude" }],
            stateName: "Todo",
            description: "see repo-a",
          }),
        ),
      config: makeConfig({
        linear: {
          projectSlug: "ai-strategy-aaaaaaaaaaaa",
          slugId: "aaaaaaaaaaaa",
          statuses: { todo: "Todo", inProgress: "In Progress", done: "Done", terminal: ["Done"] },
          teamIds: ["team-1"],
        },
      }),
    });
    const result = await ticketDoctor(dependencies);
    const teamCheck = result.resolution.find(
      (check) => check.name === "In configured Linear project",
    );
    expect(teamCheck?.status).toBe("fail");
    expect(teamCheck?.detail).toMatch(/team-OTHER/);
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
      fetchRawIssue: vi
        .fn<TicketDoctorDependencies["fetchRawIssue"]>()
        .mockResolvedValue(
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

  it("flags disabled-fallback model resolution as fail with both names in detail", async () => {
    const dependencies = makeStubDependencies({
      fetchRawIssue: vi
        .fn<TicketDoctorDependencies["fetchRawIssue"]>()
        .mockResolvedValue(
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
    expect(modelCheck?.status).toBe("fail");
    expect(modelCheck?.detail).toMatch(/codex/);
    expect(modelCheck?.detail).toMatch(/claude/);
  });

  it("records repo recognition as ok when description matches a known repo", async () => {
    const dependencies = makeStubDependencies({
      fetchRawIssue: vi
        .fn<TicketDoctorDependencies["fetchRawIssue"]>()
        .mockResolvedValue(
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
      fetchRawIssue: vi
        .fn<TicketDoctorDependencies["fetchRawIssue"]>()
        .mockResolvedValue(
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
      fetchRawIssue: vi
        .fn<TicketDoctorDependencies["fetchRawIssue"]>()
        .mockResolvedValue(
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
