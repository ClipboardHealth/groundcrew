import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RawLinearIssue } from "../lib/boardSource.ts";
import type { ResolvedConfig } from "../lib/config.ts";
import type { WorkspaceAccessHint, WorkspaceProbe } from "../lib/workspaces.ts";
import type { WorktreeDirtiness, WorktreeEntry } from "../lib/worktrees.ts";
import {
  decidePostDispatchVerdict,
  parseTicketDoctorFlags,
  renderTicketDoctorResult,
  ticketDoctor,
  type DecideVerdictInput,
  type LinearStatusProbe,
  type LocalBranchProbe,
  type PullRequestProbe,
  type RemoteBranchProbe,
  type TicketDoctorDependencies,
  type TicketDoctorResult,
  type TicketDoctorVerdict,
  type WorktreeProbe,
} from "./ticketDoctor.ts";

/**
 * Narrows a verdict to a specific kind for direct field access in follow-on
 * assertions. Wraps the kind check so tests don't need a runtime `if` (which
 * would trip vitest's no-conditional-in-test rule).
 */
function narrowVerdict<K extends TicketDoctorVerdict["kind"]>(
  verdict: TicketDoctorVerdict | undefined,
  kind: K,
): Extract<TicketDoctorVerdict, { kind: K }> {
  expect(verdict?.kind).toBe(kind);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- safe after the expect above narrows to kind K
  return verdict as Extract<TicketDoctorVerdict, { kind: K }>;
}

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
      .fn<NonNullable<TicketDoctorDependencies["fetchRawIssue"]>>()
      .mockResolvedValue(makeStubRawIssue()),
    fetchBlockersFor: vi.fn<TicketDoctorDependencies["fetchBlockersFor"]>().mockResolvedValue([]),
    fetchUsage: vi.fn<TicketDoctorDependencies["fetchUsage"]>().mockResolvedValue({}),
    countInProgress: vi.fn<TicketDoctorDependencies["countInProgress"]>().mockResolvedValue(0),
    // Default local-state stubs: nothing on disk. Pre-dispatch tests do not
    // care about the post-dispatch sections, so these defaults match the
    // freshly-labelled-ticket world.
    findWorktree: () => undefined as WorktreeEntry | undefined,
    probeWorkspaces: vi
      .fn<TicketDoctorDependencies["probeWorkspaces"]>()
      .mockResolvedValue({ kind: "ok", names: new Set<string>() } satisfies WorkspaceProbe),
    workspaceAccessHint: async () => undefined as WorkspaceAccessHint | undefined,
    probeWorkingTree: vi
      .fn<TicketDoctorDependencies["probeWorkingTree"]>()
      .mockResolvedValue({ kind: "unknown" } satisfies WorktreeDirtiness),
    probeLocalBranch: vi
      .fn<TicketDoctorDependencies["probeLocalBranch"]>()
      .mockResolvedValue({ kind: "absent" } satisfies LocalBranchProbe),
    probeRemoteBranch: vi
      .fn<TicketDoctorDependencies["probeRemoteBranch"]>()
      .mockResolvedValue({ kind: "absent" } satisfies RemoteBranchProbe),
    probePullRequest: vi
      .fn<TicketDoctorDependencies["probePullRequest"]>()
      .mockResolvedValue({ kind: "absent" } satisfies PullRequestProbe),
    doFetch: true,
    ...overrides,
  };
}

function makeWorktreeEntry(overrides: Partial<WorktreeEntry> = {}): WorktreeEntry {
  return {
    repository: "repo-a",
    ticket: "hrd-1",
    branchName: "rocky-hrd-1",
    dir: "/work/repo-a-hrd-1",
    kind: "host",
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// decidePostDispatchVerdict — pure verdict logic
// ─────────────────────────────────────────────────────────────────────────

function makeVerdictInput(overrides: Partial<DecideVerdictInput> = {}): DecideVerdictInput {
  return {
    linear: { kind: "terminal", stateName: "Done" } satisfies LinearStatusProbe,
    worktree: { kind: "absent" } satisfies WorktreeProbe,
    localBranch: { kind: "absent" } satisfies LocalBranchProbe,
    remoteBranch: { kind: "absent" } satisfies RemoteBranchProbe,
    pullRequest: { kind: "absent" } satisfies PullRequestProbe,
    branch: "rocky-hrd-1",
    worktreeDir: undefined,
    workspaceName: undefined,
    ...overrides,
  };
}

describe(decidePostDispatchVerdict, () => {
  it("returns undefined when nothing post-dispatch is present", () => {
    expect(decidePostDispatchVerdict(makeVerdictInput())).toBeUndefined();
  });

  it("returns pr-open when the PR is open, regardless of Linear or worktree state", () => {
    const verdict = decidePostDispatchVerdict(
      makeVerdictInput({
        pullRequest: { kind: "open", number: 224, url: "https://github.com/x/y/pull/224" },
        worktree: { kind: "present-dirty", modified: 3, untracked: 1 },
        linear: { kind: "non-terminal", stateName: "In Progress" },
      }),
    );
    expect(verdict).toStrictEqual({
      kind: "pr-open",
      number: 224,
      url: "https://github.com/x/y/pull/224",
    });
  });

  it("returns pr-merged when the PR is merged", () => {
    const verdict = decidePostDispatchVerdict(
      makeVerdictInput({
        pullRequest: { kind: "merged", number: 224, url: "https://github.com/x/y/pull/224" },
      }),
    );
    expect(verdict).toMatchObject({ kind: "pr-merged", number: 224 });
  });

  it("returns in-flight when Linear is non-terminal and the worktree is present", () => {
    const verdict = decidePostDispatchVerdict(
      makeVerdictInput({
        linear: { kind: "non-terminal", stateName: "In Progress" },
        worktree: { kind: "present-clean" },
        worktreeDir: "/work/repo-a-hrd-1",
        workspaceName: "hrd-1",
      }),
    );
    const inFlight = narrowVerdict(verdict, "in-flight");
    expect(inFlight.reason).toContain('workspace "hrd-1"');
  });

  it("returns in-flight with worktree path when no workspace name is set", () => {
    const verdict = decidePostDispatchVerdict(
      makeVerdictInput({
        linear: { kind: "non-terminal", stateName: "In Progress" },
        worktree: { kind: "present-dirty", modified: 1, untracked: 0 },
        worktreeDir: "/work/repo-a-hrd-1",
        workspaceName: undefined,
      }),
    );
    const inFlight = narrowVerdict(verdict, "in-flight");
    expect(inFlight.reason).toContain("worktree at /work/repo-a-hrd-1");
  });

  it("returns recoverable (dirty) when the worktree is dirty without an open PR", () => {
    const verdict = decidePostDispatchVerdict(
      makeVerdictInput({
        linear: { kind: "terminal", stateName: "Done" },
        worktree: { kind: "present-dirty", modified: 2, untracked: 1 },
        worktreeDir: "/work/repo-a-hrd-1",
      }),
    );
    const recoverable = narrowVerdict(verdict, "recoverable");
    expect(recoverable.reason).toContain("dirty worktree (2 modified, 1 untracked)");
    expect(recoverable.nextStep).toContain("commit or stash");
  });

  it("returns recoverable (push) when the local branch is un-pushed", () => {
    const verdict = decidePostDispatchVerdict(
      makeVerdictInput({
        linear: { kind: "terminal", stateName: "Done" },
        worktree: { kind: "present-clean" },
        localBranch: { kind: "present", ahead: 2, behind: 0 },
        remoteBranch: { kind: "absent" },
        worktreeDir: "/work/repo-a-hrd-1",
      }),
    );
    const recoverable = narrowVerdict(verdict, "recoverable");
    expect(recoverable.reason).toContain("clean worktree with un-pushed local branch");
    expect(recoverable.nextStep).toContain("git push -u origin rocky-hrd-1");
  });

  it("returns recoverable (pr-create) when only the remote branch exists", () => {
    const verdict = decidePostDispatchVerdict(
      makeVerdictInput({
        linear: { kind: "terminal", stateName: "Done" },
        worktree: { kind: "absent" },
        remoteBranch: { kind: "present" },
        pullRequest: { kind: "absent" },
      }),
    );
    const recoverable = narrowVerdict(verdict, "recoverable");
    expect(recoverable.nextStep).toContain("gh pr create --head rocky-hrd-1");
  });

  it("returns recoverable (stranded) when a local branch exists without a worktree", () => {
    const verdict = decidePostDispatchVerdict(
      makeVerdictInput({
        worktree: { kind: "absent" },
        localBranch: { kind: "present", ahead: 0, behind: 0 },
      }),
    );
    const recoverable = narrowVerdict(verdict, "recoverable");
    expect(recoverable.reason).toContain("stranded local branch");
  });

  it("ranks in-flight above recoverable (dirty)", () => {
    const verdict = decidePostDispatchVerdict(
      makeVerdictInput({
        linear: { kind: "non-terminal", stateName: "In Progress" },
        worktree: { kind: "present-dirty", modified: 1, untracked: 0 },
        worktreeDir: "/work/repo-a-hrd-1",
        workspaceName: "hrd-1",
      }),
    );
    expect(verdict).toMatchObject({ kind: "in-flight" });
  });

  it("ranks pr-open above in-flight", () => {
    const verdict = decidePostDispatchVerdict(
      makeVerdictInput({
        linear: { kind: "non-terminal", stateName: "In Progress" },
        worktree: { kind: "present-clean" },
        pullRequest: { kind: "open", number: 9, url: "u" },
      }),
    );
    expect(verdict).toMatchObject({ kind: "pr-open" });
  });

  it("treats present-unknown-dirtiness as worktree-present for in-flight", () => {
    const verdict = decidePostDispatchVerdict(
      makeVerdictInput({
        linear: { kind: "non-terminal", stateName: "In Progress" },
        worktree: { kind: "present-unknown-dirtiness", reason: "git status failed" },
      }),
    );
    expect(verdict).toMatchObject({ kind: "in-flight" });
  });

  it("falls through to recoverable when only stranded local branch matches", () => {
    const verdict = decidePostDispatchVerdict(
      makeVerdictInput({
        linear: { kind: "non-terminal", stateName: "In Progress" },
        worktree: { kind: "absent" },
        localBranch: { kind: "present", ahead: 1, behind: 0 },
      }),
    );
    const recoverable = narrowVerdict(verdict, "recoverable");
    expect(recoverable.reason).toContain("stranded");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// ticketDoctor — Linear resolution (pre-dispatch path)
// ─────────────────────────────────────────────────────────────────────────

describe("ticketDoctor pure function — Linear resolution", () => {
  it("normalizes the ticket id to upper case", async () => {
    const result = await ticketDoctor(makeStubDependencies({ ticket: "hrd-1" }));
    expect(result.ticket).toBe("HRD-1");
  });

  it("returns unresolvable when fetchRawIssue throws an Error", async () => {
    const dependencies = makeStubDependencies({
      fetchRawIssue: vi
        .fn<NonNullable<TicketDoctorDependencies["fetchRawIssue"]>>()
        .mockRejectedValue(new Error("Ticket HRD-1 not found in Linear")),
    });
    const result = await ticketDoctor(dependencies);
    const unresolvable = narrowVerdict(result.verdict, "unresolvable");
    expect(unresolvable.reason).toMatch(/not found/);
  });

  it("returns unresolvable when fetchRawIssue throws a non-Error value", async () => {
    const dependencies = makeStubDependencies({
      fetchRawIssue: vi
        .fn<NonNullable<TicketDoctorDependencies["fetchRawIssue"]>>()
        .mockRejectedValue("string error"),
    });
    const result = await ticketDoctor(dependencies);
    expect(result.verdict).toMatchObject({ kind: "unresolvable", reason: "string error" });
  });

  it("records the resolved ticket title in the result", async () => {
    const dependencies = makeStubDependencies({
      fetchRawIssue: vi
        .fn<NonNullable<TicketDoctorDependencies["fetchRawIssue"]>>()
        .mockResolvedValue(makeStubRawIssue({ title: "Some title" })),
    });
    const result = await ticketDoctor(dependencies);
    expect(result.title).toBe("Some title");
  });
});

describe("ticketDoctor resolution checks", () => {
  it("records status-mismatch as ineligible with current state in detail", async () => {
    const dependencies = makeStubDependencies({
      fetchRawIssue: vi
        .fn<NonNullable<TicketDoctorDependencies["fetchRawIssue"]>>()
        .mockResolvedValue(
          makeStubRawIssue({
            labels: [{ name: "agent-claude" }],
            stateName: "In Review",
            description: "see herds-social/herds",
          }),
        ),
      config: makeConfig({
        workspace: { projectDir: "/work", knownRepositories: ["herds-social/herds"] },
      }),
    });
    const result = await ticketDoctor(dependencies);
    const statusCheck = result.resolution.find((check) => check.name === "Status is Todo");
    expect(statusCheck?.status).toBe("fail");
    expect(statusCheck?.detail).toMatch(/In Review/);
    expect(result.verdict).toMatchObject({
      kind: "ineligible",
      reason: "status is In Review (need Todo)",
    });
  });

  it("records missing agent-* label as ineligible and skips the model check", async () => {
    const dependencies = makeStubDependencies({
      fetchRawIssue: vi
        .fn<NonNullable<TicketDoctorDependencies["fetchRawIssue"]>>()
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
    expect(result.verdict).toMatchObject({ kind: "ineligible" });
  });

  it("records agent-* label and matched model as ok", async () => {
    const dependencies = makeStubDependencies({
      fetchRawIssue: vi
        .fn<NonNullable<TicketDoctorDependencies["fetchRawIssue"]>>()
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

  it("reports disabled-fallback model resolution with both names in detail", async () => {
    const dependencies = makeStubDependencies({
      fetchRawIssue: vi
        .fn<NonNullable<TicketDoctorDependencies["fetchRawIssue"]>>()
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
            // codex intentionally absent → disabled-fallback path
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
      fetchRawIssue: vi
        .fn<NonNullable<TicketDoctorDependencies["fetchRawIssue"]>>()
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
        .fn<NonNullable<TicketDoctorDependencies["fetchRawIssue"]>>()
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
        .fn<NonNullable<TicketDoctorDependencies["fetchRawIssue"]>>()
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

describe("ticketDoctor — env checks", () => {
  it("records repo-dir-missing as fail when the resolved repo isn't cloned", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "td-"));
    try {
      const dependencies = makeStubDependencies({
        config: makeConfig({
          workspace: { knownRepositories: ["herds-social/herds"], projectDir },
        }),
        fetchRawIssue: vi
          .fn<NonNullable<TicketDoctorDependencies["fetchRawIssue"]>>()
          .mockResolvedValue({
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
          workspace: { knownRepositories: ["herds-social/herds"], projectDir },
        }),
        fetchRawIssue: vi
          .fn<NonNullable<TicketDoctorDependencies["fetchRawIssue"]>>()
          .mockResolvedValue({
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
      fetchRawIssue: vi
        .fn<NonNullable<TicketDoctorDependencies["fetchRawIssue"]>>()
        .mockResolvedValue({
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
  function makeFullStub(
    overrides: Partial<TicketDoctorDependencies> = {},
  ): TicketDoctorDependencies {
    return makeStubDependencies({
      config: makeConfig({
        orchestrator: {
          maximumInProgress: 2,
          pollIntervalMilliseconds: 1000,
          sessionLimitPercentage: 85,
        },
        workspace: { projectDir: "/tmp", knownRepositories: ["herds-social/herds"] },
      }),
      ticket: "HRD-1",
      fetchRawIssue: vi
        .fn<NonNullable<TicketDoctorDependencies["fetchRawIssue"]>>()
        .mockResolvedValue({
          uuid: "uuid-1",
          title: "X",
          description: "see herds-social/herds",
          teamId: "team-1",
          labels: [{ name: "agent-claude" }],
          stateName: "Todo",
          blockers: [],
          hasMoreBlockers: false,
        }),
      fetchUsage: vi.fn<TicketDoctorDependencies["fetchUsage"]>().mockResolvedValue({
        claude: { session: 0.23, sessionEndDuration: null, weekly: null, weekEndDuration: null },
      }),
      ...overrides,
    });
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
          workspace: { projectDir, knownRepositories: ["herds-social/herds"] },
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
          workspace: { projectDir, knownRepositories: ["herds-social/herds"] },
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
          workspace: { projectDir, knownRepositories: ["herds-social/herds"] },
        }),
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
          workspace: { projectDir, knownRepositories: ["herds-social/herds"] },
        }),
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
      const dependencies = makeFullStub({
        config: makeConfig({
          orchestrator: {
            maximumInProgress: 2,
            pollIntervalMilliseconds: 1000,
            sessionLimitPercentage: 85,
          },
          workspace: { projectDir, knownRepositories: ["herds-social/herds"] },
        }),
        fetchRawIssue: vi
          .fn<NonNullable<TicketDoctorDependencies["fetchRawIssue"]>>()
          .mockResolvedValue({
            uuid: "uuid-1",
            title: "X",
            description: "see herds-social/herds",
            teamId: "team-1",
            labels: [{ name: "agent-any" }],
            stateName: "Todo",
            blockers: [],
            hasMoreBlockers: false,
          }),
        fetchUsage: vi.fn<TicketDoctorDependencies["fetchUsage"]>().mockResolvedValue({
          claude: { session: 0.1, sessionEndDuration: null, weekly: null, weekEndDuration: null },
        }),
      });
      const result = await ticketDoctor(dependencies);
      const usageCheck = result.eligibility.find(
        (c) => c.name === 'Model "claude" usage under sessionLimitPercentage',
      );
      expect(usageCheck?.status).toBe("ok");
      expect(result.verdict.kind).toBe("would-dispatch");
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("leaves eligibility empty and skips fetchBlockersFor when status is not Todo", async () => {
    const fetchBlockersFor = vi
      .fn<TicketDoctorDependencies["fetchBlockersFor"]>()
      .mockResolvedValue([]);
    const dependencies = makeStubDependencies({
      fetchRawIssue: vi
        .fn<NonNullable<TicketDoctorDependencies["fetchRawIssue"]>>()
        .mockResolvedValue(makeStubRawIssue({ stateName: "Done", labels: [], description: "" })),
      fetchBlockersFor,
    });
    const result = await ticketDoctor(dependencies);
    expect(result.eligibility).toHaveLength(0);
    expect(fetchBlockersFor).not.toHaveBeenCalled();
    expect(result.verdict).toMatchObject({
      kind: "ineligible",
      reason: "status is Done (need Todo)",
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// ticketDoctor — post-dispatch sections (worktree/workspace/branch/PR)
// ─────────────────────────────────────────────────────────────────────────

describe("ticketDoctor — Worktree section", () => {
  it("records ok host-worktree + clean working-tree rows", async () => {
    const entry = makeWorktreeEntry();
    const dependencies = makeStubDependencies({
      findWorktree: vi.fn<TicketDoctorDependencies["findWorktree"]>().mockReturnValue(entry),
      probeWorkingTree: vi
        .fn<TicketDoctorDependencies["probeWorkingTree"]>()
        .mockResolvedValue({ kind: "clean" }),
    });
    const result = await ticketDoctor(dependencies);
    expect(result.worktree).toStrictEqual([
      { name: "Host worktree exists", status: "ok", detail: entry.dir },
      { name: "Working tree clean", status: "ok" },
      { name: "Branch checked out", status: "ok", detail: entry.branchName },
    ]);
  });

  it("records dirty working-tree row with modified/untracked counts", async () => {
    const dependencies = makeStubDependencies({
      findWorktree: vi
        .fn<TicketDoctorDependencies["findWorktree"]>()
        .mockReturnValue(makeWorktreeEntry()),
      probeWorkingTree: vi
        .fn<TicketDoctorDependencies["probeWorkingTree"]>()
        .mockResolvedValue({ kind: "dirty", modified: 3, untracked: 1 }),
    });
    const result = await ticketDoctor(dependencies);
    const cleanRow = result.worktree.find((c) => c.name === "Working tree clean");
    expect(cleanRow).toMatchObject({
      status: "fail",
      detail: "3 modified, 1 untracked",
    });
  });

  it("records absent host worktree as fail with a one-line detail", async () => {
    const dependencies = makeStubDependencies({
      findWorktree: () => undefined as WorktreeEntry | undefined,
    });
    const result = await ticketDoctor(dependencies);
    expect(result.worktree).toStrictEqual([
      { name: "Host worktree exists", status: "fail", detail: "no worktree found for this ticket" },
    ]);
  });

  it("records skipped working-tree row when probe returns unknown", async () => {
    const dependencies = makeStubDependencies({
      findWorktree: vi
        .fn<TicketDoctorDependencies["findWorktree"]>()
        .mockReturnValue(makeWorktreeEntry()),
      probeWorkingTree: vi
        .fn<TicketDoctorDependencies["probeWorkingTree"]>()
        .mockResolvedValue({ kind: "unknown" }),
    });
    const result = await ticketDoctor(dependencies);
    const cleanRow = result.worktree.find((c) => c.name === "Working tree clean");
    expect(cleanRow).toMatchObject({ status: "skipped", detail: "could not inspect" });
  });
});

describe("ticketDoctor — Workspace section", () => {
  it("records ok when the ticket id appears in the probe set", async () => {
    const dependencies = makeStubDependencies({
      probeWorkspaces: vi
        .fn<TicketDoctorDependencies["probeWorkspaces"]>()
        .mockResolvedValue({ kind: "ok", names: new Set(["hrd-1"]) }),
    });
    const result = await ticketDoctor(dependencies);
    expect(result.workspace[0]).toMatchObject({ name: "Workspace pane open", status: "ok" });
  });

  it("records fail when the ticket id is not in the probe set", async () => {
    const dependencies = makeStubDependencies({
      probeWorkspaces: vi
        .fn<TicketDoctorDependencies["probeWorkspaces"]>()
        .mockResolvedValue({ kind: "ok", names: new Set<string>() }),
    });
    const result = await ticketDoctor(dependencies);
    expect(result.workspace[0]).toMatchObject({ name: "Workspace pane open", status: "fail" });
  });

  it("records skipped when the probe is unavailable", async () => {
    const dependencies = makeStubDependencies({
      probeWorkspaces: vi
        .fn<TicketDoctorDependencies["probeWorkspaces"]>()
        .mockResolvedValue({ kind: "unavailable" }),
    });
    const result = await ticketDoctor(dependencies);
    expect(result.workspace[0]).toMatchObject({ name: "Workspace pane open", status: "skipped" });
  });

  it("appends the attach command to the workspace detail when accessHint returns one", async () => {
    const dependencies = makeStubDependencies({
      probeWorkspaces: vi
        .fn<TicketDoctorDependencies["probeWorkspaces"]>()
        .mockResolvedValue({ kind: "ok", names: new Set(["hrd-1"]) }),
      workspaceAccessHint: vi
        .fn<TicketDoctorDependencies["workspaceAccessHint"]>()
        .mockResolvedValue({ kind: "attachCommand", command: "tmux attach -t groundcrew:hrd-1" }),
    });
    const result = await ticketDoctor(dependencies);
    expect(result.workspace[0]?.detail).toContain("tmux attach -t groundcrew:hrd-1");
  });

  it("uses the bare pane name as detail when accessHint is undefined", async () => {
    const dependencies = makeStubDependencies({
      probeWorkspaces: vi
        .fn<TicketDoctorDependencies["probeWorkspaces"]>()
        .mockResolvedValue({ kind: "ok", names: new Set(["hrd-1"]) }),
      workspaceAccessHint: async () => undefined as WorkspaceAccessHint | undefined,
    });
    const result = await ticketDoctor(dependencies);
    expect(result.workspace[0]?.detail).toBe("hrd-1");
  });
});

describe("ticketDoctor — ticket case normalization", () => {
  it("passes the lowercase ticket to findWorktree even when the caller supplies HRD-1", async () => {
    const findWorktree = vi.fn<TicketDoctorDependencies["findWorktree"]>(
      () => undefined as WorktreeEntry | undefined,
    );
    await ticketDoctor(makeStubDependencies({ ticket: "HRD-1", findWorktree }));
    expect(findWorktree).toHaveBeenCalledWith("hrd-1");
  });

  it("matches a workspace whose probe set holds the lowercase ticket even when the caller supplies HRD-1", async () => {
    const dependencies = makeStubDependencies({
      ticket: "HRD-1",
      probeWorkspaces: vi
        .fn<TicketDoctorDependencies["probeWorkspaces"]>()
        .mockResolvedValue({ kind: "ok", names: new Set(["hrd-1"]) }),
    });
    const result = await ticketDoctor(dependencies);
    expect(result.workspace[0]?.status).toBe("ok");
  });

  it("keeps the uppercase ticket in the result header for cosmetics", async () => {
    const result = await ticketDoctor(makeStubDependencies({ ticket: "hrd-1" }));
    expect(result.ticket).toBe("HRD-1");
  });
});

describe("ticketDoctor — Local branch section", () => {
  it("records ahead/behind counts when the branch exists", async () => {
    const entry = makeWorktreeEntry();
    const dependencies = makeStubDependencies({
      findWorktree: vi.fn<TicketDoctorDependencies["findWorktree"]>().mockReturnValue(entry),
      probeLocalBranch: vi
        .fn<TicketDoctorDependencies["probeLocalBranch"]>()
        .mockResolvedValue({ kind: "present", ahead: 2, behind: 0, defaultBranch: "main" }),
    });
    const result = await ticketDoctor(dependencies);
    expect(result.localBranch[0]?.name).toBe("Local branch exists");
    expect(result.localBranch[0]?.status).toBe("ok");
    expect(result.localBranch[0]?.detail).toContain("2 ahead / 0 behind origin/main");
  });

  it("falls back to the config default branch when the probe omits it", async () => {
    const dependencies = makeStubDependencies({
      findWorktree: vi
        .fn<TicketDoctorDependencies["findWorktree"]>()
        .mockReturnValue(makeWorktreeEntry()),
      probeLocalBranch: vi
        .fn<TicketDoctorDependencies["probeLocalBranch"]>()
        .mockResolvedValue({ kind: "present", ahead: 0, behind: 0 }),
    });
    const result = await ticketDoctor(dependencies);
    expect(result.localBranch[0]?.detail).toContain("origin/main");
  });

  it("records fail when the branch is not in git", async () => {
    const dependencies = makeStubDependencies({
      findWorktree: vi
        .fn<TicketDoctorDependencies["findWorktree"]>()
        .mockReturnValue(makeWorktreeEntry()),
      probeLocalBranch: vi
        .fn<TicketDoctorDependencies["probeLocalBranch"]>()
        .mockResolvedValue({ kind: "absent" }),
    });
    const result = await ticketDoctor(dependencies);
    expect(result.localBranch[0]).toMatchObject({ status: "fail", detail: "branch not in git" });
  });

  it("records skipped when probeLocalBranch reports unknown", async () => {
    const dependencies = makeStubDependencies({
      findWorktree: vi
        .fn<TicketDoctorDependencies["findWorktree"]>()
        .mockReturnValue(makeWorktreeEntry()),
      probeLocalBranch: vi
        .fn<TicketDoctorDependencies["probeLocalBranch"]>()
        .mockResolvedValue({ kind: "unknown", reason: "git failed" }),
    });
    const result = await ticketDoctor(dependencies);
    expect(result.localBranch[0]).toMatchObject({ status: "skipped", detail: "git failed" });
  });

  it("skips the section when no worktree resolves the repo dir", async () => {
    const result = await ticketDoctor(
      makeStubDependencies({
        findWorktree: () => undefined as WorktreeEntry | undefined,
      }),
    );
    expect(result.localBranch).toStrictEqual([]);
    expect(result.skipReasons.localBranch).toBe("repo dir unresolved");
  });
});

describe("ticketDoctor — Remote branch section", () => {
  it("records ok when the remote returns the branch", async () => {
    const dependencies = makeStubDependencies({
      findWorktree: vi
        .fn<TicketDoctorDependencies["findWorktree"]>()
        .mockReturnValue(makeWorktreeEntry()),
      probeRemoteBranch: vi
        .fn<TicketDoctorDependencies["probeRemoteBranch"]>()
        .mockResolvedValue({ kind: "present" }),
    });
    const result = await ticketDoctor(dependencies);
    expect(result.remoteBranch[0]).toMatchObject({
      name: "Branch present on origin",
      status: "ok",
    });
  });

  it("records fail with `(not pushed)` when absent", async () => {
    const dependencies = makeStubDependencies({
      findWorktree: vi
        .fn<TicketDoctorDependencies["findWorktree"]>()
        .mockReturnValue(makeWorktreeEntry()),
      probeRemoteBranch: vi
        .fn<TicketDoctorDependencies["probeRemoteBranch"]>()
        .mockResolvedValue({ kind: "absent" }),
    });
    const result = await ticketDoctor(dependencies);
    expect(result.remoteBranch[0]).toMatchObject({ status: "fail", detail: "not pushed" });
  });

  it("records skipped when probeRemoteBranch reports unknown", async () => {
    const dependencies = makeStubDependencies({
      findWorktree: vi
        .fn<TicketDoctorDependencies["findWorktree"]>()
        .mockReturnValue(makeWorktreeEntry()),
      probeRemoteBranch: vi
        .fn<TicketDoctorDependencies["probeRemoteBranch"]>()
        .mockResolvedValue({ kind: "unknown", reason: "ls-remote failed" }),
    });
    const result = await ticketDoctor(dependencies);
    expect(result.remoteBranch[0]).toMatchObject({
      status: "skipped",
      detail: "ls-remote failed",
    });
  });

  it("passes `doFetch: false` through when configured", async () => {
    const probeRemoteBranch = vi
      .fn<TicketDoctorDependencies["probeRemoteBranch"]>()
      .mockResolvedValue({ kind: "present" });
    await ticketDoctor(
      makeStubDependencies({
        findWorktree: vi
          .fn<TicketDoctorDependencies["findWorktree"]>()
          .mockReturnValue(makeWorktreeEntry()),
        probeRemoteBranch,
        doFetch: false,
      }),
    );
    expect(probeRemoteBranch).toHaveBeenCalledWith(expect.objectContaining({ doFetch: false }));
  });
});

describe("ticketDoctor — Pull request section", () => {
  it("records ok with number and url for an open PR, and the verdict is pr-open", async () => {
    const dependencies = makeStubDependencies({
      findWorktree: vi
        .fn<TicketDoctorDependencies["findWorktree"]>()
        .mockReturnValue(makeWorktreeEntry()),
      probePullRequest: vi.fn<TicketDoctorDependencies["probePullRequest"]>().mockResolvedValue({
        kind: "open",
        number: 224,
        url: "https://github.com/x/y/pull/224",
      }),
    });
    const result = await ticketDoctor(dependencies);
    expect(result.pullRequest[0]?.detail).toContain("#224");
    expect(result.verdict).toMatchObject({ kind: "pr-open", number: 224 });
  });

  it("records ok with number and url for a merged PR", async () => {
    const dependencies = makeStubDependencies({
      findWorktree: vi
        .fn<TicketDoctorDependencies["findWorktree"]>()
        .mockReturnValue(makeWorktreeEntry()),
      probePullRequest: vi.fn<TicketDoctorDependencies["probePullRequest"]>().mockResolvedValue({
        kind: "merged",
        number: 224,
        url: "https://github.com/x/y/pull/224",
      }),
    });
    const result = await ticketDoctor(dependencies);
    expect(result.verdict).toMatchObject({ kind: "pr-merged", number: 224 });
  });

  it("records fail when no PR is found", async () => {
    const dependencies = makeStubDependencies({
      findWorktree: vi
        .fn<TicketDoctorDependencies["findWorktree"]>()
        .mockReturnValue(makeWorktreeEntry()),
      probePullRequest: vi
        .fn<TicketDoctorDependencies["probePullRequest"]>()
        .mockResolvedValue({ kind: "absent" }),
    });
    const result = await ticketDoctor(dependencies);
    expect(result.pullRequest[0]).toMatchObject({ status: "fail", detail: "none found" });
  });

  it("records skipped when gh is missing", async () => {
    const dependencies = makeStubDependencies({
      findWorktree: vi
        .fn<TicketDoctorDependencies["findWorktree"]>()
        .mockReturnValue(makeWorktreeEntry()),
      probePullRequest: vi
        .fn<TicketDoctorDependencies["probePullRequest"]>()
        .mockResolvedValue({ kind: "gh-missing" }),
    });
    const result = await ticketDoctor(dependencies);
    expect(result.pullRequest[0]).toMatchObject({
      status: "skipped",
      detail: "gh CLI not on PATH",
    });
  });

  it("records skipped with the unknown reason text", async () => {
    const dependencies = makeStubDependencies({
      findWorktree: vi
        .fn<TicketDoctorDependencies["findWorktree"]>()
        .mockReturnValue(makeWorktreeEntry()),
      probePullRequest: vi
        .fn<TicketDoctorDependencies["probePullRequest"]>()
        .mockResolvedValue({ kind: "unknown", reason: "auth required" }),
    });
    const result = await ticketDoctor(dependencies);
    expect(result.pullRequest[0]).toMatchObject({ status: "skipped", detail: "auth required" });
  });

  it("skips the section when no worktree resolves the repo dir", async () => {
    const result = await ticketDoctor(
      makeStubDependencies({
        findWorktree: () => undefined as WorktreeEntry | undefined,
      }),
    );
    expect(result.pullRequest).toStrictEqual([]);
    expect(result.skipReasons.pullRequest).toBe("repo dir unresolved");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// ticketDoctor — merged verdict precedence
// ─────────────────────────────────────────────────────────────────────────

describe("ticketDoctor — verdict precedence (post-dispatch wins over pre-dispatch)", () => {
  it("returns pr-open and skips eligibility even when status is not Todo", async () => {
    const dependencies = makeStubDependencies({
      fetchRawIssue: vi
        .fn<NonNullable<TicketDoctorDependencies["fetchRawIssue"]>>()
        .mockResolvedValue(makeStubRawIssue({ stateName: "In Review", labels: [] })),
      findWorktree: vi
        .fn<TicketDoctorDependencies["findWorktree"]>()
        .mockReturnValue(makeWorktreeEntry()),
      probePullRequest: vi.fn<TicketDoctorDependencies["probePullRequest"]>().mockResolvedValue({
        kind: "open",
        number: 7,
        url: "https://github.com/x/y/pull/7",
      }),
    });
    const result = await ticketDoctor(dependencies);
    expect(result.verdict).toMatchObject({ kind: "pr-open", number: 7 });
    expect(result.eligibility).toStrictEqual([]);
    expect(result.skipReasons.eligibility).toContain("post-dispatch");
    expect(result.skipReasons.resolution).toContain("post-dispatch");
  });

  it("returns in-flight when non-terminal Linear status combines with a present worktree", async () => {
    const entry = makeWorktreeEntry();
    const dependencies = makeStubDependencies({
      fetchRawIssue: vi
        .fn<NonNullable<TicketDoctorDependencies["fetchRawIssue"]>>()
        .mockResolvedValue(
          makeStubRawIssue({ stateName: "In Progress", labels: [{ name: "agent-claude" }] }),
        ),
      findWorktree: vi.fn<TicketDoctorDependencies["findWorktree"]>().mockReturnValue(entry),
      probeWorkingTree: vi
        .fn<TicketDoctorDependencies["probeWorkingTree"]>()
        .mockResolvedValue({ kind: "clean" }),
      probeWorkspaces: vi
        .fn<TicketDoctorDependencies["probeWorkspaces"]>()
        .mockResolvedValue({ kind: "ok", names: new Set(["hrd-1"]) }),
    });
    const result = await ticketDoctor(dependencies);
    expect(result.verdict).toMatchObject({ kind: "in-flight" });
  });

  it("returns would-dispatch when everything is fresh: no worktree, no PR, eligible", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "td-wd-"));
    mkdirSync(join(projectDir, "herds-social", "herds"), { recursive: true });
    try {
      const dependencies = makeStubDependencies({
        config: makeConfig({
          workspace: { projectDir, knownRepositories: ["herds-social/herds"] },
        }),
        fetchRawIssue: vi
          .fn<NonNullable<TicketDoctorDependencies["fetchRawIssue"]>>()
          .mockResolvedValue(
            makeStubRawIssue({
              labels: [{ name: "agent-claude" }],
              stateName: "Todo",
              description: "see herds-social/herds",
            }),
          ),
        fetchUsage: vi.fn<TicketDoctorDependencies["fetchUsage"]>().mockResolvedValue({
          claude: { session: 0.1, sessionEndDuration: null, weekly: null, weekEndDuration: null },
        }),
      });
      const result = await ticketDoctor(dependencies);
      expect(result.verdict.kind).toBe("would-dispatch");
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("returns lost when --no-linear suppresses Linear and nothing local is actionable", async () => {
    const dependencies = makeStubDependencies({ fetchRawIssue: undefined });
    const result = await ticketDoctor(dependencies);
    expect(result.verdict).toMatchObject({ kind: "lost" });
    expect(result.skipReasons.resolution).toBe("--no-linear");
    expect(result.skipReasons.eligibility).toBe("--no-linear");
  });

  it("still produces in-flight from local state under --no-linear when a worktree is present", async () => {
    const dependencies = makeStubDependencies({
      fetchRawIssue: undefined,
      findWorktree: vi
        .fn<TicketDoctorDependencies["findWorktree"]>()
        .mockReturnValue(makeWorktreeEntry()),
      probeWorkingTree: vi
        .fn<TicketDoctorDependencies["probeWorkingTree"]>()
        .mockResolvedValue({ kind: "clean" }),
    });
    const result = await ticketDoctor(dependencies);
    expect(result.verdict).toMatchObject({ kind: "in-flight" });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Renderer
// ─────────────────────────────────────────────────────────────────────────

function emptyResult(overrides: Partial<TicketDoctorResult> = {}): TicketDoctorResult {
  return {
    ticket: "HRD-1",
    resolution: [],
    eligibility: [],
    worktree: [],
    workspace: [],
    localBranch: [],
    remoteBranch: [],
    pullRequest: [],
    skipReasons: {
      resolution: "",
      eligibility: "",
      worktree: "",
      workspace: "",
      localBranch: "",
      remoteBranch: "",
      pullRequest: "",
    },
    verdict: { kind: "lost", reason: "test" },
    ...overrides,
  };
}

describe(renderTicketDoctorResult, () => {
  it("renders a would-dispatch verdict with all sections", () => {
    const lines = renderTicketDoctorResult(
      emptyResult({
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
      }),
    );
    expect(lines.some((l) => l.includes("HRD-446"))).toBe(true);
    expect(lines.some((l) => l.includes("Multi-event"))).toBe(true);
    expect(lines.some((l) => l.includes("Resolution"))).toBe(true);
    expect(lines.some((l) => l.includes("Eligibility"))).toBe(true);
    expect(lines.some((l) => l.includes("would be dispatched on next tick"))).toBe(true);
  });

  it("formats pr-open verdicts with url and PR number", () => {
    const lines = renderTicketDoctorResult(
      emptyResult({
        verdict: { kind: "pr-open", number: 224, url: "https://github.com/x/y/pull/224" },
      }),
    );
    expect(lines.some((l) => l.includes("→ pr-open: https://github.com/x/y/pull/224 (#224)"))).toBe(
      true,
    );
  });

  it("formats pr-merged verdicts with url and PR number", () => {
    const lines = renderTicketDoctorResult(
      emptyResult({
        verdict: { kind: "pr-merged", number: 9, url: "u" },
      }),
    );
    expect(lines.some((l) => l.includes("→ pr-merged: u (#9)"))).toBe(true);
  });

  it("formats in-flight verdicts with the reason", () => {
    const lines = renderTicketDoctorResult(
      emptyResult({
        verdict: { kind: "in-flight", reason: 'mid-flight in workspace "hrd-1"' },
      }),
    );
    expect(lines.some((l) => l.includes('→ in-flight: mid-flight in workspace "hrd-1"'))).toBe(
      true,
    );
  });

  it("formats recoverable verdicts with reason + next step", () => {
    const lines = renderTicketDoctorResult(
      emptyResult({
        verdict: { kind: "recoverable", reason: "dirty worktree", nextStep: "commit or stash" },
      }),
    );
    expect(lines.some((l) => l.includes("→ recoverable: dirty worktree; commit or stash"))).toBe(
      true,
    );
  });

  it("formats ineligible verdicts with the reason", () => {
    const lines = renderTicketDoctorResult(
      emptyResult({
        resolution: [
          { name: "Ticket exists in Linear", status: "ok", detail: '"Bad Ticket"' },
          { name: "Status is Todo", status: "fail", detail: "current: Done" },
        ],
        verdict: { kind: "ineligible", reason: "status is Done (need Todo)" },
      }),
    );
    expect(lines.some((l) => l.includes("→ ineligible: status is Done (need Todo)"))).toBe(true);
    expect(lines.find((l) => l.includes("Status is Todo"))).toMatch(/\[--\]/);
  });

  it("formats lost verdicts with the reason", () => {
    const lines = renderTicketDoctorResult(
      emptyResult({ verdict: { kind: "lost", reason: "no local state and no PR" } }),
    );
    expect(lines.some((l) => l.includes("→ lost: no local state and no PR"))).toBe(true);
  });

  it("formats unresolvable verdicts with the reason", () => {
    const lines = renderTicketDoctorResult(
      emptyResult({
        resolution: [
          { name: "Ticket exists in Linear", status: "fail", detail: "HRD-404 not found" },
        ],
        skipReasons: {
          resolution: "",
          eligibility: "ticket unresolved",
          worktree: "",
          workspace: "",
          localBranch: "",
          remoteBranch: "",
          pullRequest: "",
        },
        verdict: { kind: "unresolvable", reason: "HRD-404 not found" },
      }),
    );
    expect(lines.some((l) => l.includes("→ unresolvable: HRD-404 not found"))).toBe(true);
    expect(lines.some((l) => l.includes("(skipped — ticket unresolved)"))).toBe(true);
  });

  it("renders the section title with skip reason when checks are empty", () => {
    const lines = renderTicketDoctorResult(
      emptyResult({
        skipReasons: {
          resolution: "",
          eligibility: "",
          worktree: "",
          workspace: "",
          localBranch: "repo dir unresolved",
          remoteBranch: "",
          pullRequest: "",
        },
      }),
    );
    expect(lines.some((l) => l.includes("(skipped — repo dir unresolved)"))).toBe(true);
  });

  it("renders a non-empty skipReason on every section when set", () => {
    const lines = renderTicketDoctorResult(
      emptyResult({
        skipReasons: {
          resolution: "skip-r",
          eligibility: "skip-e",
          worktree: "skip-w",
          workspace: "skip-ws",
          localBranch: "skip-lb",
          remoteBranch: "skip-rb",
          pullRequest: "skip-pr",
        },
      }),
    );
    for (const tag of ["skip-r", "skip-e", "skip-w", "skip-ws", "skip-lb", "skip-rb", "skip-pr"]) {
      expect(lines.some((l) => l.includes(`(skipped — ${tag})`))).toBe(true);
    }
  });

  it("renders a title in the header when present", () => {
    const lines = renderTicketDoctorResult(
      emptyResult({ ticket: "HRD-1", title: "Some Ticket Title" }),
    );
    expect(lines[0]).toContain("Some Ticket Title");
  });

  it("renders a skipped check with the [? ] tag", () => {
    const lines = renderTicketDoctorResult(
      emptyResult({
        resolution: [
          { name: "Has agent-* label", status: "fail", detail: "no agent-* label" },
          { name: "Model resolves from agent-* label", status: "skipped" },
        ],
        verdict: { kind: "ineligible", reason: "ticket has no agent-* label" },
      }),
    );
    const modelLine = lines.find((l) => l.includes("Model resolves from agent-* label"));
    expect(modelLine).toMatch(/\[\? \]/);
  });
});

describe("parseTicketDoctorFlags — argument parsing", () => {
  it("returns the default flag values when given an empty argv", () => {
    expect(parseTicketDoctorFlags([])).toStrictEqual({ doLinear: true, doFetch: true });
  });

  it("accepts --no-linear", () => {
    expect(parseTicketDoctorFlags(["--no-linear"])).toStrictEqual({
      doLinear: false,
      doFetch: true,
    });
  });

  it("accepts --no-fetch", () => {
    expect(parseTicketDoctorFlags(["--no-fetch"])).toStrictEqual({
      doLinear: true,
      doFetch: false,
    });
  });

  it("accepts both flags together", () => {
    expect(parseTicketDoctorFlags(["--no-linear", "--no-fetch"])).toStrictEqual({
      doLinear: false,
      doFetch: false,
    });
  });

  it("throws on unknown flags", () => {
    expect(() => parseTicketDoctorFlags(["--bogus"])).toThrow(/unknown argument: --bogus/);
  });

  it("throws on stray positional arguments (the ticket is consumed earlier)", () => {
    expect(() => parseTicketDoctorFlags(["extra"])).toThrow(/unknown argument: extra/);
  });
});
