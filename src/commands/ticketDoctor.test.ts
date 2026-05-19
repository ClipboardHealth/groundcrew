import type { RawLinearIssue } from "../lib/boardSource.ts";
import type { ResolvedConfig } from "../lib/config.ts";
import { ticketDoctor, type TicketDoctorDependencies } from "./ticketDoctor.ts";

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
