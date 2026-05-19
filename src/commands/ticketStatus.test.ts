import type { RawLinearIssue } from "../lib/boardSource.ts";
import type { ResolvedConfig } from "../lib/config.ts";
import {
  decideVerdict,
  ticketStatus,
  type DecideVerdictInput,
  type LinearStatusProbe,
  type LocalBranchProbe,
  type PullRequestProbe,
  type RemoteBranchProbe,
  type StatusVerdict,
  type TicketStatusDependencies,
  type TicketStatusResult,
  type WorktreeProbe,
} from "./ticketStatus.ts";

// Type-only smoke test — keeps `knip` happy while later tasks wire these types
// into the orchestrator and probes.
type _ProbeUnion =
  | LinearStatusProbe
  | LocalBranchProbe
  | PullRequestProbe
  | RemoteBranchProbe
  | StatusVerdict
  | WorktreeProbe;
const _typeSmokeTest: readonly _ProbeUnion[] = [];
void _typeSmokeTest;

function makeInput(overrides: Partial<DecideVerdictInput> = {}): DecideVerdictInput {
  return {
    linear: { kind: "terminal", stateName: "Done" },
    worktree: { kind: "absent" },
    localBranch: { kind: "absent" },
    remoteBranch: { kind: "absent" },
    pullRequest: { kind: "absent" },
    branch: "paul-hrd-1",
    worktreeDir: undefined,
    workspaceName: undefined,
    ...overrides,
  };
}

function assertRecoverable(
  verdict: StatusVerdict,
): asserts verdict is Extract<StatusVerdict, { kind: "recoverable" }> {
  expect(verdict.kind).toBe("recoverable");
}

function assertInFlight(
  verdict: StatusVerdict,
): asserts verdict is Extract<StatusVerdict, { kind: "in-flight" }> {
  expect(verdict.kind).toBe("in-flight");
}

describe("decideVerdict pure verdict logic", () => {
  it("row 1 — terminal + nothing local + no PR → lost", () => {
    const actual = decideVerdict(makeInput());

    expect(actual.kind).toBe("lost");
  });

  it("row 2 — terminal + remote branch only + no PR → recoverable (gh pr create)", () => {
    const actual = decideVerdict(makeInput({ remoteBranch: { kind: "present" } }));

    assertRecoverable(actual);
    expect(actual.nextStep).toMatch(/gh pr create --head paul-hrd-1/);
  });

  it("row 3 — terminal + remote branch + open PR → pr-open", () => {
    const actual = decideVerdict(
      makeInput({
        remoteBranch: { kind: "present" },
        pullRequest: { kind: "open", number: 42, url: "https://github.com/x/y/pull/42" },
      }),
    );

    expect(actual).toMatchObject({ kind: "pr-open", number: 42 });
  });

  it("row 4 — terminal + remote branch + merged PR → pr-merged", () => {
    const actual = decideVerdict(
      makeInput({
        remoteBranch: { kind: "present" },
        pullRequest: { kind: "merged", number: 42, url: "https://github.com/x/y/pull/42" },
      }),
    );

    expect(actual.kind).toBe("pr-merged");
  });

  it("row 5 — terminal + clean worktree + local branch only → recoverable (push + pr create)", () => {
    const actual = decideVerdict(
      makeInput({
        worktree: { kind: "present-clean" },
        localBranch: { kind: "present", ahead: 3, behind: 0 },
        worktreeDir: "/work/repo-hrd-1",
      }),
    );

    assertRecoverable(actual);
    expect(actual.nextStep).toMatch(/git push -u origin paul-hrd-1.*gh pr create/);
  });

  it("row 6 — terminal + dirty worktree → recoverable (commit first)", () => {
    const actual = decideVerdict(
      makeInput({
        worktree: { kind: "present-dirty", modified: 2, untracked: 1 },
        localBranch: { kind: "present", ahead: 0, behind: 0 },
      }),
    );

    assertRecoverable(actual);
    expect(actual.reason).toMatch(/dirty|uncommitted/);
  });

  it("row 7 — non-terminal + present worktree → in-flight", () => {
    const actual = decideVerdict(
      makeInput({
        linear: { kind: "non-terminal", stateName: "In Progress" },
        worktree: { kind: "present-clean" },
        localBranch: { kind: "present", ahead: 0, behind: 0 },
        workspaceName: "hrd-1",
      }),
    );

    assertInFlight(actual);
    expect(actual.reason).toMatch(/hrd-1/);
  });

  it("row 7 — non-terminal + dirty worktree → in-flight (dirty disjunct)", () => {
    const actual = decideVerdict(
      makeInput({
        linear: { kind: "non-terminal", stateName: "In Progress" },
        worktree: { kind: "present-dirty", modified: 1, untracked: 0 },
        localBranch: { kind: "present", ahead: 0, behind: 0 },
        workspaceName: "hrd-1",
      }),
    );

    assertInFlight(actual);
    expect(actual.reason).toMatch(/hrd-1/);
  });

  it("row 7 — non-terminal + unknown-dirtiness worktree → in-flight (unknown disjunct)", () => {
    const actual = decideVerdict(
      makeInput({
        linear: { kind: "non-terminal", stateName: "In Progress" },
        worktree: { kind: "present-unknown-dirtiness", reason: "git status failed" },
        localBranch: { kind: "present", ahead: 0, behind: 0 },
        workspaceName: "hrd-1",
      }),
    );

    assertInFlight(actual);
    expect(actual.reason).toMatch(/hrd-1/);
  });

  it("row 7 fallthrough — non-terminal + absent worktree → falls through to stranded local", () => {
    const actual = decideVerdict(
      makeInput({
        linear: { kind: "non-terminal", stateName: "In Progress" },
        worktree: { kind: "absent" },
        localBranch: { kind: "present", ahead: 0, behind: 0 },
      }),
    );

    assertRecoverable(actual);
    expect(actual.reason).toMatch(/stranded local branch/);
  });

  it("row 8 — absent worktree but local branch exists → recoverable (stranded branch)", () => {
    const actual = decideVerdict(
      makeInput({
        worktree: { kind: "absent" },
        localBranch: { kind: "present", ahead: 0, behind: 0 },
      }),
    );

    assertRecoverable(actual);
    expect(actual.reason).toMatch(/stranded local branch/);
  });

  it("row 9 — any state + open PR with no local trace → pr-open with note", () => {
    const actual = decideVerdict(
      makeInput({
        linear: { kind: "non-terminal", stateName: "In Progress" },
        pullRequest: { kind: "open", number: 7, url: "https://github.com/x/y/pull/7" },
      }),
    );

    expect(actual.kind).toBe("pr-open");
  });

  describe("decideVerdict — non-terminal Linear state still produces actionable verdicts", () => {
    it("non-terminal + absent worktree + remote branch only → recoverable (gh pr create)", () => {
      const actual = decideVerdict(
        makeInput({
          linear: { kind: "non-terminal", stateName: "In Progress" },
          remoteBranch: { kind: "present" },
        }),
      );

      assertRecoverable(actual);
      expect(actual.nextStep).toMatch(/gh pr create --head paul-hrd-1/);
    });

    it("non-terminal + clean worktree + local branch + no remote → recoverable (push + create)", () => {
      const actual = decideVerdict(
        makeInput({
          linear: { kind: "non-terminal", stateName: "In Progress" },
          worktree: { kind: "present-clean" },
          localBranch: { kind: "present", ahead: 0, behind: 0 },
          worktreeDir: "/work/repo-hrd-1",
        }),
      );

      // Row 7 (in-flight) actually wins here because worktree is present.
      // This test pins down that ordering.
      assertInFlight(actual);
      expect(actual.reason).toMatch(/mid-flight/);
    });

    it("non-terminal + dirty worktree → in-flight (Row 7 wins over Row 6)", () => {
      const actual = decideVerdict(
        makeInput({
          linear: { kind: "non-terminal", stateName: "In Progress" },
          worktree: { kind: "present-dirty", modified: 1, untracked: 0 },
          localBranch: { kind: "present", ahead: 0, behind: 0 },
          workspaceName: "hrd-1",
        }),
      );

      assertInFlight(actual);
      expect(actual.reason).toMatch(/hrd-1/);
    });

    it("non-terminal + absent worktree + absent everything → lost", () => {
      const actual = decideVerdict(
        makeInput({
          linear: { kind: "non-terminal", stateName: "In Progress" },
        }),
      );

      expect(actual.kind).toBe("lost");
    });
  });
});

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    linear: {
      projectSlug: "ai-strategy-aaaaaaaaaaaa",
      slugId: "aaaaaaaaaaaa",
      statuses: {
        todo: "Todo",
        inProgress: "In Progress",
        done: "Done",
        terminal: ["Done"],
      },
      ...overrides.linear,
    },
    git: { remote: "origin", defaultBranch: "main", ...overrides.git },
    workspace: {
      projectDir: "/work",
      knownRepositories: ["herds-social/herds"],
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

function makeRaw(overrides: Partial<RawLinearIssue> = {}): RawLinearIssue {
  return {
    uuid: "uuid-1",
    title: "Stub title",
    description: "see herds-social/herds",
    teamId: "team-1",
    labels: [],
    stateName: "Done",
    blockers: [],
    hasMoreBlockers: false,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<TicketStatusDependencies> = {}): TicketStatusDependencies {
  return {
    config: makeConfig(),
    ticket: "HRD-1",
    fetchRawIssue: vi
      .fn<NonNullable<TicketStatusDependencies["fetchRawIssue"]>>()
      .mockResolvedValue(makeRaw()),
    // oxlint-disable-next-line unicorn/no-useless-undefined -- findWorktree returns `WorktreeEntry | undefined`; passing nothing is a TS error
    findWorktree: vi.fn<TicketStatusDependencies["findWorktree"]>().mockReturnValue(undefined),
    probeWorkspaces: vi
      .fn<TicketStatusDependencies["probeWorkspaces"]>()
      .mockResolvedValue({ kind: "ok", names: new Set() }),
    probeWorkingTree: vi
      .fn<TicketStatusDependencies["probeWorkingTree"]>()
      .mockResolvedValue({ kind: "clean" }),
    probeLocalBranch: vi
      .fn<TicketStatusDependencies["probeLocalBranch"]>()
      .mockResolvedValue({ kind: "absent" }),
    probeRemoteBranch: vi
      .fn<TicketStatusDependencies["probeRemoteBranch"]>()
      .mockResolvedValue({ kind: "absent" }),
    probePullRequest: vi
      .fn<TicketStatusDependencies["probePullRequest"]>()
      .mockResolvedValue({ kind: "absent" }),
    doFetch: true,
    ...overrides,
  };
}

describe("ticketStatus — Linear section", () => {
  it("records the ticket title and a terminal-state check when Linear returns Done", async () => {
    const deps = makeDeps();

    const actual: TicketStatusResult = await ticketStatus(deps);

    expect(actual.title).toBe("Stub title");
    expect(actual.linear).toStrictEqual([
      { name: "Ticket exists in Linear", status: "ok", detail: '"Stub title"' },
      { name: "Status is terminal (Done)", status: "ok" },
    ]);
  });

  it("records a non-terminal state without marking the section failed", async () => {
    const deps = makeDeps({
      fetchRawIssue: vi
        .fn<NonNullable<TicketStatusDependencies["fetchRawIssue"]>>()
        .mockResolvedValue(makeRaw({ stateName: "In Progress" })),
    });

    const actual = await ticketStatus(deps);

    expect(actual.linear).toContainEqual({
      name: "Status is non-terminal (In Progress)",
      status: "ok",
    });
  });

  it("returns a lost verdict when fetchRawIssue throws", async () => {
    const deps = makeDeps({
      fetchRawIssue: vi
        .fn<NonNullable<TicketStatusDependencies["fetchRawIssue"]>>()
        .mockRejectedValue(new Error("Ticket HRD-1 not found")),
    });

    const actual = await ticketStatus(deps);
    const [firstLine] = actual.linear;

    expect(actual.verdict.kind).toBe("lost");
    expect(firstLine?.status).toBe("fail");
    expect(firstLine?.detail).toMatch(/not found/);
  });

  it("skips the Linear section when fetchRawIssue is undefined (--no-linear)", async () => {
    const deps = makeDeps({ fetchRawIssue: undefined });

    const actual = await ticketStatus(deps);

    expect(actual.linear).toStrictEqual([]);
    expect(actual.skipReasons.linear).toBe("--no-linear");
  });

  it("stringifies non-Error rejection values in the failure detail", async () => {
    const deps = makeDeps({
      fetchRawIssue: vi
        .fn<NonNullable<TicketStatusDependencies["fetchRawIssue"]>>()
        .mockRejectedValue("plain string failure"),
    });

    const actual = await ticketStatus(deps);
    const [firstLine] = actual.linear;

    expect(firstLine?.status).toBe("fail");
    expect(firstLine?.detail).toBe("plain string failure");
  });
});

describe("ticketStatus — Worktree section", () => {
  const worktreeEntry = {
    repository: "herds-social/herds",
    ticket: "HRD-1",
    branchName: "paul-HRD-1",
    dir: "/work/herds-social/herds-HRD-1",
    kind: "host" as const,
  };

  it("records an ok host-worktree row and a clean working-tree row when both true", async () => {
    const deps = makeDeps({
      findWorktree: vi
        .fn<TicketStatusDependencies["findWorktree"]>()
        .mockReturnValue(worktreeEntry),
      probeWorkingTree: vi
        .fn<TicketStatusDependencies["probeWorkingTree"]>()
        .mockResolvedValue({ kind: "clean" }),
    });

    const actual = await ticketStatus(deps);

    expect(actual.worktree).toStrictEqual([
      { name: "Host worktree exists", status: "ok", detail: worktreeEntry.dir },
      { name: "Working tree clean", status: "ok" },
      { name: "Branch checked out", status: "ok", detail: worktreeEntry.branchName },
    ]);
  });

  it("records a dirty working-tree row with modified/untracked counts", async () => {
    const deps = makeDeps({
      findWorktree: vi
        .fn<TicketStatusDependencies["findWorktree"]>()
        .mockReturnValue(worktreeEntry),
      probeWorkingTree: vi
        .fn<TicketStatusDependencies["probeWorkingTree"]>()
        .mockResolvedValue({ kind: "dirty", modified: 2, untracked: 1 }),
    });

    const actual = await ticketStatus(deps);

    expect(actual.worktree).toContainEqual({
      name: "Working tree clean",
      status: "fail",
      detail: "2 modified, 1 untracked",
    });
  });

  it("records absent host worktree as a fail row with a one-line detail", async () => {
    const deps = makeDeps({
      // oxlint-disable-next-line unicorn/no-useless-undefined -- findWorktree returns `WorktreeEntry | undefined`; passing nothing is a TS error
      findWorktree: vi.fn<TicketStatusDependencies["findWorktree"]>().mockReturnValue(undefined),
    });

    const actual = await ticketStatus(deps);

    expect(actual.worktree).toStrictEqual([
      { name: "Host worktree exists", status: "fail", detail: "no worktree found for this ticket" },
    ]);
  });

  it("records a skipped working-tree row when git status returns unknown", async () => {
    const deps = makeDeps({
      findWorktree: vi
        .fn<TicketStatusDependencies["findWorktree"]>()
        .mockReturnValue(worktreeEntry),
      probeWorkingTree: vi
        .fn<TicketStatusDependencies["probeWorkingTree"]>()
        .mockResolvedValue({ kind: "unknown" }),
    });

    const actual = await ticketStatus(deps);

    expect(actual.worktree).toStrictEqual([
      { name: "Host worktree exists", status: "ok", detail: worktreeEntry.dir },
      { name: "Working tree clean", status: "skipped", detail: "could not inspect" },
      { name: "Branch checked out", status: "ok", detail: worktreeEntry.branchName },
    ]);
  });
});

describe("ticketStatus — Workspace section", () => {
  it("records an ok workspace row when the ticket id appears in the probe set", async () => {
    const deps = makeDeps({
      probeWorkspaces: vi
        .fn<TicketStatusDependencies["probeWorkspaces"]>()
        .mockResolvedValue({ kind: "ok", names: new Set(["HRD-1"]) }),
    });

    const actual = await ticketStatus(deps);

    expect(actual.workspace).toStrictEqual([
      { name: "Workspace pane open", status: "ok", detail: "HRD-1" },
    ]);
  });

  it("records fail when the ticket id is not in the probe set", async () => {
    const deps = makeDeps({
      probeWorkspaces: vi
        .fn<TicketStatusDependencies["probeWorkspaces"]>()
        .mockResolvedValue({ kind: "ok", names: new Set(["HRD-9"]) }),
    });

    const actual = await ticketStatus(deps);

    expect(actual.workspace).toStrictEqual([
      { name: "Workspace pane open", status: "fail", detail: "no pane found for this ticket" },
    ]);
  });

  it("records skipped when the probe is unavailable", async () => {
    const deps = makeDeps({
      probeWorkspaces: vi
        .fn<TicketStatusDependencies["probeWorkspaces"]>()
        .mockResolvedValue({ kind: "unavailable" }),
    });

    const actual = await ticketStatus(deps);

    expect(actual.workspace).toStrictEqual([
      { name: "Workspace pane open", status: "skipped", detail: "workspace probe unavailable" },
    ]);
  });
});
