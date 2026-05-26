import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Board } from "../lib/board.ts";
import type { RawLinearIssue } from "../lib/adapters/linear/fetch.ts";
import type { ResolvedConfig } from "../lib/config.ts";
import { makeBoard } from "../testHelpers/boardFixtures.ts";
import {
  canonicalBlocker,
  canonicalLinearIssue,
  canonicalShellIssue,
} from "../lib/testing/canonicalFixtures.ts";
import type { Blocker as CanonicalBlocker } from "../lib/ticketSource.ts";
import type { RunState } from "../lib/runState.ts";
import type { WorkspaceAccessHint, WorkspaceProbe } from "../lib/workspaces.ts";
import type { WorktreeDirtiness, WorktreeEntry } from "../lib/worktrees.ts";
import {
  decidePostDispatchVerdict,
  parseTicketDoctorFlags,
  renderTicketDoctorResult,
  ticketDoctor,
  type DecideVerdictInput,
  type LifecycleStatusProbe,
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
      definitions: { claude: { cmd: "claude", color: "#fff" } },
      ...overrides.models,
    },
    prompts: { initial: "x", ...overrides.prompts },
    workspaceKind: overrides.workspaceKind ?? "auto",
    local: { runner: "auto", ...overrides.local },
    sandbox: { authRecipes: {}, gitDefaults: false, ...overrides.sandbox },
    logging: { file: "/tmp/groundcrew-test.log", ...overrides.logging },
  };
}

function stateTypeForStub(name: string | undefined): string {
  switch (name) {
    case "Todo": {
      return "unstarted";
    }
    case "In Progress": {
      return "started";
    }
    case "Done":
    case "Shipped": {
      return "completed";
    }
    case "Canceled":
    case "Won't fix": {
      return "canceled";
    }
    case "Duplicate": {
      return "duplicate";
    }
    case undefined: {
      return "";
    }
    default: {
      // Unknown names (e.g. "In Review", "Backlog") aren't Todo; pin to
      // "triage" so the doctor's Todo check fails as it should.
      return "triage";
    }
  }
}

function makeStubRawIssue(overrides: Partial<RawLinearIssue> = {}): RawLinearIssue {
  const stateName = overrides.stateName ?? "Todo";
  return {
    uuid: "uuid-1",
    title: "Stub",
    description: "",
    teamId: "team-1",
    labels: [],
    stateName,
    stateType: overrides.stateType ?? stateTypeForStub(stateName),
    stateId: "state-stub",
    blockers: [],
    hasMoreBlockers: false,
    hasChildren: false,
    ...overrides,
  };
}

function makeStubDependencies(
  overrides: Partial<TicketDoctorDependencies> = {},
): TicketDoctorDependencies {
  // Default board: resolveOne returns a canonical issue that passes eligibility.
  // Tests that exercise the pre-dispatch path need resolveOne to succeed so
  // the eligibility checks can run. Tests that exercise the post-dispatch path
  // don't reach resolveOne.
  const defaultBoard = makeBoard({
    resolveOne: vi.fn<Board["resolveOne"]>().mockResolvedValue(
      canonicalLinearIssue({
        naturalId: "hrd-1",
        status: "todo",
        repository: "repo-a",
        model: "claude",
      }),
    ),
  });
  return {
    config: makeConfig(),
    ticket: "HRD-1",
    enrichWithLinear: vi
      .fn<NonNullable<TicketDoctorDependencies["enrichWithLinear"]>>()
      .mockResolvedValue(makeStubRawIssue()),
    board: defaultBoard,
    fetchUsage: vi.fn<TicketDoctorDependencies["fetchUsage"]>().mockResolvedValue({}),
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
    resolveDefaultBranch: vi
      .fn<TicketDoctorDependencies["resolveDefaultBranch"]>()
      .mockResolvedValue("main"),
    probeLocalBranch: vi
      .fn<TicketDoctorDependencies["probeLocalBranch"]>()
      .mockResolvedValue({ kind: "absent" } satisfies LocalBranchProbe),
    probeRemoteBranch: vi
      .fn<TicketDoctorDependencies["probeRemoteBranch"]>()
      .mockResolvedValue({ kind: "absent" } satisfies RemoteBranchProbe),
    probePullRequest: vi
      .fn<TicketDoctorDependencies["probePullRequest"]>()
      .mockResolvedValue({ kind: "absent" } satisfies PullRequestProbe),
    readRunState: vi.fn<TicketDoctorDependencies["readRunState"]>(),
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

function makeRunState(overrides: Partial<RunState> = {}): RunState {
  return {
    ticket: "hrd-1",
    repository: "repo-a",
    model: "claude",
    worktreeDir: "/work/repo-a-hrd-1",
    branchName: "rocky-hrd-1",
    workspaceName: "hrd-1",
    state: "interrupted",
    resumeCount: 0,
    createdAt: "2026-05-21T00:00:00.000Z",
    updatedAt: "2026-05-21T00:00:00.000Z",
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// decidePostDispatchVerdict — pure verdict logic
// ─────────────────────────────────────────────────────────────────────────

function makeVerdictInput(overrides: Partial<DecideVerdictInput> = {}): DecideVerdictInput {
  return {
    lifecycle: { kind: "terminal", nativeStatus: "Done" } satisfies LifecycleStatusProbe,
    worktree: { kind: "absent" } satisfies WorktreeProbe,
    localBranch: { kind: "absent" } satisfies LocalBranchProbe,
    remoteBranch: { kind: "absent" } satisfies RemoteBranchProbe,
    pullRequest: { kind: "absent" } satisfies PullRequestProbe,
    branch: "rocky-hrd-1",
    remote: "origin",
    worktreeDir: undefined,
    workspaceName: undefined,
    runState: undefined,
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
        lifecycle: { kind: "active", nativeStatus: "In Progress" },
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

  it("returns in-flight when lifecycle is active and the worktree is present", () => {
    const verdict = decidePostDispatchVerdict(
      makeVerdictInput({
        lifecycle: { kind: "active", nativeStatus: "In Progress" },
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
        lifecycle: { kind: "active", nativeStatus: "In Progress" },
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
        lifecycle: { kind: "terminal", nativeStatus: "Done" },
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
        lifecycle: { kind: "terminal", nativeStatus: "Done" },
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

  it("uses the configured remote (not hardcoded `origin`) in the recoverable push nextStep", () => {
    const verdict = decidePostDispatchVerdict(
      makeVerdictInput({
        lifecycle: { kind: "terminal", nativeStatus: "Done" },
        worktree: { kind: "present-clean" },
        localBranch: { kind: "present", ahead: 2, behind: 0 },
        remoteBranch: { kind: "absent" },
        worktreeDir: "/work/repo-a-hrd-1",
        remote: "upstream",
      }),
    );
    const recoverable = narrowVerdict(verdict, "recoverable");
    expect(recoverable.nextStep).toContain("git push -u upstream rocky-hrd-1");
    expect(recoverable.nextStep).not.toContain("origin");
  });

  it("returns recoverable (pr-create) when only the remote branch exists", () => {
    const verdict = decidePostDispatchVerdict(
      makeVerdictInput({
        lifecycle: { kind: "terminal", nativeStatus: "Done" },
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
        lifecycle: { kind: "active", nativeStatus: "In Progress" },
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
        lifecycle: { kind: "active", nativeStatus: "In Progress" },
        worktree: { kind: "present-clean" },
        pullRequest: { kind: "open", number: 9, url: "u" },
      }),
    );
    expect(verdict).toMatchObject({ kind: "pr-open" });
  });

  it("ranks pr-open above interrupted run state", () => {
    const verdict = decidePostDispatchVerdict(
      makeVerdictInput({
        pullRequest: { kind: "open", number: 9, url: "u" },
        runState: makeRunState({ state: "interrupted" }),
      }),
    );
    expect(verdict).toMatchObject({ kind: "pr-open" });
  });

  it("returns interrupted when the local run state was stopped and no recovery action wins", () => {
    const verdict = decidePostDispatchVerdict(
      makeVerdictInput({
        runState: makeRunState({ state: "interrupted", reason: "freeing terminal" }),
      }),
    );
    const interrupted = narrowVerdict(verdict, "interrupted");
    expect(interrupted.reason).toBe("freeing terminal");
    expect(interrupted.nextStep).toContain("crew resume hrd-1");
  });

  it("uses interrupted run detail when no interrupt reason was recorded", () => {
    const verdict = decidePostDispatchVerdict(
      makeVerdictInput({
        runState: makeRunState({ state: "interrupted", detail: "workspace missing" }),
      }),
    );
    expect(verdict).toMatchObject({ kind: "interrupted", reason: "workspace missing" });
  });

  it("uses a generic interrupted reason when no detail was recorded", () => {
    const verdict = decidePostDispatchVerdict(
      makeVerdictInput({
        runState: makeRunState({ state: "interrupted" }),
      }),
    );
    expect(verdict).toMatchObject({ kind: "interrupted", reason: "workspace stopped" });
  });

  it("ranks recoverable work above interrupted run state", () => {
    const verdict = decidePostDispatchVerdict(
      makeVerdictInput({
        worktree: { kind: "present-dirty", modified: 1, untracked: 0 },
        worktreeDir: "/work/repo-a-hrd-1",
        runState: makeRunState({ state: "interrupted" }),
      }),
    );
    expect(verdict).toMatchObject({ kind: "recoverable" });
  });

  it("returns failed-launch when setup recorded a launch failure", () => {
    const verdict = decidePostDispatchVerdict(
      makeVerdictInput({
        runState: makeRunState({ state: "failed-to-launch", detail: "cmux missing" }),
      }),
    );
    const failedLaunch = narrowVerdict(verdict, "failed-launch");
    expect(failedLaunch.reason).toBe("cmux missing");
    expect(failedLaunch.nextStep).toContain("crew resume hrd-1");
  });

  it("uses a generic failed-launch reason when setup did not record details", () => {
    const verdict = decidePostDispatchVerdict(
      makeVerdictInput({
        runState: makeRunState({ state: "failed-to-launch" }),
      }),
    );
    expect(verdict).toMatchObject({ kind: "failed-launch", reason: "workspace launch failed" });
  });

  it("treats present-unknown-dirtiness as worktree-present for in-flight", () => {
    const verdict = decidePostDispatchVerdict(
      makeVerdictInput({
        lifecycle: { kind: "active", nativeStatus: "In Progress" },
        worktree: { kind: "present-unknown-dirtiness", reason: "git status failed" },
      }),
    );
    expect(verdict).toMatchObject({ kind: "in-flight" });
  });

  it("falls through to recoverable when only stranded local branch matches", () => {
    const verdict = decidePostDispatchVerdict(
      makeVerdictInput({
        lifecycle: { kind: "active", nativeStatus: "In Progress" },
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

  it("returns unresolvable when enrichWithLinear throws an Error", async () => {
    const dependencies = makeStubDependencies({
      enrichWithLinear: vi
        .fn<NonNullable<TicketDoctorDependencies["enrichWithLinear"]>>()
        .mockRejectedValue(new Error("Ticket HRD-1 not found in Linear")),
    });
    const result = await ticketDoctor(dependencies);
    const unresolvable = narrowVerdict(result.verdict, "unresolvable");
    expect(unresolvable.reason).toMatch(/not found/);
  });

  it("returns unresolvable when enrichWithLinear throws a non-Error value", async () => {
    const dependencies = makeStubDependencies({
      enrichWithLinear: vi
        .fn<NonNullable<TicketDoctorDependencies["enrichWithLinear"]>>()
        .mockRejectedValue("string error"),
    });
    const result = await ticketDoctor(dependencies);
    expect(result.verdict).toMatchObject({ kind: "unresolvable", reason: "string error" });
  });

  it("records the resolved ticket title in the result", async () => {
    const dependencies = makeStubDependencies({
      enrichWithLinear: vi
        .fn<NonNullable<TicketDoctorDependencies["enrichWithLinear"]>>()
        .mockResolvedValue(makeStubRawIssue({ title: "Some title" })),
    });
    const result = await ticketDoctor(dependencies);
    expect(result.title).toBe("Some title");
  });
});

describe("ticketDoctor resolution checks", () => {
  it("records status-mismatch as ineligible with current state in detail", async () => {
    const dependencies = makeStubDependencies({
      enrichWithLinear: vi
        .fn<NonNullable<TicketDoctorDependencies["enrichWithLinear"]>>()
        .mockResolvedValue(
          makeStubRawIssue({
            labels: [{ name: "agent-claude" }],
            stateName: "In Review",
            stateType: "triage",
            stateId: "state-review",
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

  // The "off-config Linear project" and "no Linear project" tests were dropped
  // post-#110: linear.projects no longer exists, so doctor can't reject a
  // ticket on project misconfig. State.type classification is universal.

  it("records missing agent-* label as ineligible and skips the model check", async () => {
    const dependencies = makeStubDependencies({
      enrichWithLinear: vi
        .fn<NonNullable<TicketDoctorDependencies["enrichWithLinear"]>>()
        .mockResolvedValue(
          makeStubRawIssue({
            labels: [],
            stateName: "Todo",
            stateType: "unstarted",
            stateId: "state-todo",
            description: "see repo-a",
          }),
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
      enrichWithLinear: vi
        .fn<NonNullable<TicketDoctorDependencies["enrichWithLinear"]>>()
        .mockResolvedValue(
          makeStubRawIssue({
            labels: [{ name: "agent-claude" }],
            stateName: "Todo",
            stateType: "unstarted",
            stateId: "state-todo",
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
      enrichWithLinear: vi
        .fn<NonNullable<TicketDoctorDependencies["enrichWithLinear"]>>()
        .mockResolvedValue(
          makeStubRawIssue({
            labels: [{ name: "agent-codex" }],
            stateName: "Todo",
            stateType: "unstarted",
            stateId: "state-todo",
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

  it("treats an agent-* label with an unknown model name as a match to models.default", async () => {
    // When a label like "agent-removed-model" is present but "removed-model" is not in
    // config.models.definitions and is not a shipped default, boardSource's
    // parseAgentLabels falls back to models.default. resolveModelFromLabels must mirror
    // this behavior — the previous implementation returned "no-label" on this path
    // (line 336), causing a divergence from the adapter's resolved model.
    const dependencies = makeStubDependencies({
      enrichWithLinear: vi
        .fn<NonNullable<TicketDoctorDependencies["enrichWithLinear"]>>()
        .mockResolvedValue(
          makeStubRawIssue({
            labels: [{ name: "agent-removed-model" }],
            stateName: "Todo",
            stateType: "unstarted",
            stateId: "state-todo",
            description: "see repo-a",
          }),
        ),
      config: makeConfig({
        models: {
          default: "claude",
          definitions: {
            claude: { cmd: "claude", color: "#fff" },
            // "removed-model" intentionally absent from both definitions and
            // DEFAULT_MODEL_DEFINITIONS → falls through to models.default.
          },
        },
      }),
    });
    const result = await ticketDoctor(dependencies);
    const labelCheck = result.resolution.find((check) => check.name === "Has agent-* label");
    const modelCheck = result.resolution.find(
      (check) => check.name === "Model resolves from agent-* label",
    );
    expect(labelCheck?.status).toBe("ok");
    expect(labelCheck?.detail).toBe("agent-claude");
    expect(modelCheck?.status).toBe("ok");
    expect(modelCheck?.detail).toMatch(/claude/);
  });

  it("records repo recognition as ok when description matches a known repo", async () => {
    const dependencies = makeStubDependencies({
      enrichWithLinear: vi
        .fn<NonNullable<TicketDoctorDependencies["enrichWithLinear"]>>()
        .mockResolvedValue(
          makeStubRawIssue({
            labels: [{ name: "agent-claude" }],
            stateName: "Todo",
            stateType: "unstarted",
            stateId: "state-todo",
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
      enrichWithLinear: vi
        .fn<NonNullable<TicketDoctorDependencies["enrichWithLinear"]>>()
        .mockResolvedValue(
          makeStubRawIssue({
            labels: [{ name: "agent-claude" }],
            stateName: "Todo",
            stateType: "unstarted",
            stateId: "state-todo",
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
      enrichWithLinear: vi
        .fn<NonNullable<TicketDoctorDependencies["enrichWithLinear"]>>()
        .mockResolvedValue(
          makeStubRawIssue({
            labels: [{ name: "agent-any" }],
            stateName: "Todo",
            stateType: "unstarted",
            stateId: "state-todo",
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

  // A parent ticket (one with sub-issues) is silently dropped by
  // `fetchBoard` so the dispatcher never sees it. Doctor must surface that
  // explicitly — otherwise the diagnostic lies, reporting "would dispatch"
  // for a ticket the orchestrator will never touch.
  it("records 'Has no sub-issues' as fail when the ticket has children", async () => {
    const dependencies = makeStubDependencies({
      enrichWithLinear: vi
        .fn<NonNullable<TicketDoctorDependencies["enrichWithLinear"]>>()
        .mockResolvedValue(
          makeStubRawIssue({
            labels: [{ name: "agent-claude" }],
            stateName: "Todo",
            stateType: "unstarted",
            stateId: "state-todo",
            description: "see repo-a",
            hasChildren: true,
          }),
        ),
    });
    const result = await ticketDoctor(dependencies);
    const childrenCheck = result.resolution.find((check) => check.name === "Has no sub-issues");
    expect(childrenCheck?.status).toBe("fail");
    const ineligible = narrowVerdict(result.verdict, "ineligible");
    expect(ineligible.reason).toMatch(/sub-issue/i);
  });

  it("records 'Has no sub-issues' as ok when the ticket has no children", async () => {
    const dependencies = makeStubDependencies({
      enrichWithLinear: vi
        .fn<NonNullable<TicketDoctorDependencies["enrichWithLinear"]>>()
        .mockResolvedValue(
          makeStubRawIssue({
            labels: [{ name: "agent-claude" }],
            stateName: "Todo",
            stateType: "unstarted",
            stateId: "state-todo",
            description: "see repo-a",
            hasChildren: false,
          }),
        ),
    });
    const result = await ticketDoctor(dependencies);
    const childrenCheck = result.resolution.find((check) => check.name === "Has no sub-issues");
    expect(childrenCheck?.status).toBe("ok");
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
        enrichWithLinear: vi
          .fn<NonNullable<TicketDoctorDependencies["enrichWithLinear"]>>()
          .mockResolvedValue({
            uuid: "u",
            title: "X",
            description: "see herds-social/herds",
            teamId: "team-1",
            labels: [{ name: "agent-claude" }],
            stateName: "Todo",
            stateType: "unstarted",
            stateId: "state-todo",
            blockers: [],
            hasMoreBlockers: false,
            hasChildren: false,
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
        enrichWithLinear: vi
          .fn<NonNullable<TicketDoctorDependencies["enrichWithLinear"]>>()
          .mockResolvedValue({
            uuid: "u",
            title: "X",
            description: "see herds-social/herds",
            teamId: "team-1",
            labels: [{ name: "agent-claude" }],
            stateName: "Todo",
            stateType: "unstarted",
            stateId: "state-todo",
            blockers: [],
            hasMoreBlockers: false,
            hasChildren: false,
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

  it("records repo-dir as ok when the description uses a bare name but the org-nested clone exists", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "td-"));
    mkdirSync(join(projectDir, "herds-social", "herds_mobile_app"), { recursive: true });
    try {
      const dependencies = makeStubDependencies({
        config: makeConfig({
          workspace: {
            knownRepositories: ["herds-social/herds_mobile_app"],
            projectDir,
          },
        }),
        enrichWithLinear: vi
          .fn<NonNullable<TicketDoctorDependencies["enrichWithLinear"]>>()
          .mockResolvedValue({
            uuid: "u",
            title: "X",
            description: "work on herds_mobile_app",
            teamId: "team-1",
            labels: [{ name: "agent-claude" }],
            stateName: "Todo",
            stateType: "unstarted",
            stateId: "state-todo",
            blockers: [],
            hasMoreBlockers: false,
            hasChildren: false,
          }),
      });
      const result = await ticketDoctor(dependencies);
      const repoDir = result.resolution.find(
        (check) => check.name === "Resolved repo is cloned locally",
      );
      expect(repoDir?.status).toBe("ok");
      expect(repoDir?.detail).toContain(join(projectDir, "herds-social", "herds_mobile_app"));
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("skips the repo-dir check when the repo couldn't be resolved", async () => {
    const dependencies = makeStubDependencies({
      config: makeConfig({
        workspace: { knownRepositories: ["herds-social/herds"], projectDir: "/tmp" },
      }),
      enrichWithLinear: vi
        .fn<NonNullable<TicketDoctorDependencies["enrichWithLinear"]>>()
        .mockResolvedValue({
          uuid: "u",
          title: "X",
          description: "no known repo mentioned here",
          teamId: "team-1",
          labels: [{ name: "agent-claude" }],
          stateName: "Todo",
          stateType: "unstarted",
          stateId: "state-todo",
          blockers: [],
          hasMoreBlockers: false,
          hasChildren: false,
        }),
    });
    const result = await ticketDoctor(dependencies);
    const repoDir = result.resolution.find(
      (check) => check.name === "Resolved repo is cloned locally",
    );
    expect(repoDir?.status).toBe("skipped");
  });

  it("treats an empty knownRepositories config as missing rather than matching an empty string", async () => {
    // Regression: an empty knownRepositories list used to build the regex
    // /\b()\b/, which matches the empty string at any word boundary and
    // returned { kind: "ok", repository: "" } — a false positive.
    const dependencies = makeStubDependencies({
      config: makeConfig({
        workspace: { knownRepositories: [], projectDir: "/tmp" },
      }),
      enrichWithLinear: vi
        .fn<NonNullable<TicketDoctorDependencies["enrichWithLinear"]>>()
        .mockResolvedValue({
          uuid: "u",
          title: "X",
          description: "anything at all",
          teamId: "team-1",
          labels: [{ name: "agent-claude" }],
          stateName: "Todo",
          stateType: "unstarted",
          stateId: "state-todo",
          blockers: [],
          hasMoreBlockers: false,
          hasChildren: false,
        }),
    });
    const result = await ticketDoctor(dependencies);
    const mentionsRepo = result.resolution.find(
      (check) => check.name === "Description mentions known repo",
    );
    expect(mentionsRepo?.status).toBe("fail");
    const repoDir = result.resolution.find(
      (check) => check.name === "Resolved repo is cloned locally",
    );
    expect(repoDir?.status).toBe("skipped");
  });

  it("treats an ambiguous bare-name match as missing so the diagnostic matches dispatch behavior", async () => {
    // When knownRepositories contains multiple entries sharing a bare name
    // (e.g. `org1/repo-a` + `org2/repo-a`) and the description mentions only
    // the bare `repo-a`, the dispatch path throws RepositoryResolutionError
    // because it can't pick one. The doctor must surface the same outcome —
    // a green check here would mislead the operator into thinking dispatch
    // will succeed when it won't.
    const dependencies = makeStubDependencies({
      config: makeConfig({
        workspace: {
          knownRepositories: ["org1/repo-a", "org2/repo-a"],
          projectDir: "/work",
        },
      }),
      enrichWithLinear: vi
        .fn<NonNullable<TicketDoctorDependencies["enrichWithLinear"]>>()
        .mockResolvedValue(
          makeStubRawIssue({
            labels: [{ name: "agent-claude" }],
            stateName: "Todo",
            stateType: "unstarted",
            stateId: "state-todo",
            description: "touches repo-a somewhere",
          }),
        ),
    });
    const result = await ticketDoctor(dependencies);
    const mentionsRepo = result.resolution.find(
      (check) => check.name === "Description mentions known repo",
    );
    expect(mentionsRepo?.status).toBe("fail");
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
      enrichWithLinear: vi
        .fn<NonNullable<TicketDoctorDependencies["enrichWithLinear"]>>()
        .mockResolvedValue({
          uuid: "uuid-1",
          title: "X",
          description: "see herds-social/herds",
          teamId: "team-1",
          labels: [{ name: "agent-claude" }],
          stateName: "Todo",
          stateType: "unstarted",
          stateId: "state-todo",
          blockers: [],
          hasMoreBlockers: false,
          hasChildren: false,
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

  it("flags blocker check as fail when board.refreshBlockers returns a non-terminal blocker", async () => {
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
        board: makeBoard({
          resolveOne: vi.fn<Board["resolveOne"]>().mockResolvedValue(
            canonicalLinearIssue({
              naturalId: "hrd-1",
              status: "todo",
              repository: "herds-social/herds",
              model: "claude",
            }),
          ),
          refreshBlockers: vi.fn<Board["refreshBlockers"]>().mockResolvedValue([
            {
              id: "linear:HRD-2",
              title: "Blocking ticket",
              status: "in-progress",
              nativeStatus: "In Progress",
            },
          ]),
        }),
      });
      const result = await ticketDoctor(dependencies);
      const check = result.eligibility.find((c) => c.name === "No active blockers");
      expect(check?.status).toBe("fail");
      // detail uses the richer blocker diagnostic message (mapped status with nativeStatus)
      expect(check?.detail).toContain("Blocking ticket");
      expect(check?.detail).toContain("In Progress");
      expect(check?.detail).toContain("in-progress");
      expect(result.verdict).toMatchObject({
        kind: "ineligible",
        reason: "blocked by linear:HRD-2:in-progress",
      });
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  // Tiny helper for the blocker-diagnostic tests below — they only assert on
  // the "No active blockers" eligibility detail, but the surrounding
  // dependencies still need a real projectDir + repo dir to reach that section.
  async function blockerDetailFor(
    blocker: CanonicalBlocker,
  ): Promise<{ detail: string | undefined; cleanup: () => void }> {
    const projectDir = mkdtempSync(join(tmpdir(), "td-bd-"));
    mkdirSync(join(projectDir, "herds-social", "herds"), { recursive: true });
    const result = await ticketDoctor(
      makeFullStub({
        config: makeConfig({
          workspace: { projectDir, knownRepositories: ["herds-social/herds"] },
        }),
        board: makeBoard({
          resolveOne: vi.fn<Board["resolveOne"]>().mockResolvedValue(
            canonicalLinearIssue({
              naturalId: "hrd-1",
              status: "todo",
              repository: "herds-social/herds",
              model: "claude",
            }),
          ),
          refreshBlockers: vi
            .fn<Board["refreshBlockers"]>()
            .mockResolvedValue([blocker satisfies CanonicalBlocker]),
        }),
      }),
    );
    return {
      detail: result.eligibility.find((c) => c.name === "No active blockers")?.detail,
      cleanup: () => {
        rmSync(projectDir, { recursive: true, force: true });
      },
    };
  }

  it("renders 'missing' statusReason in blocker detail when source returned no status", async () => {
    const { detail, cleanup } = await blockerDetailFor({
      id: "linear:HRD-3",
      title: "Deleted blocker",
      status: "other",
      statusReason: "missing",
    });
    try {
      expect(detail).toContain("source returned no status");
      expect(detail).toContain("HRD-3");
    } finally {
      cleanup();
    }
  });

  it("renders 'unmapped' statusReason with nativeStatus name and config-update hint", async () => {
    const { detail, cleanup } = await blockerDetailFor({
      id: "linear:HRD-4",
      title: "Triage blocker",
      status: "other",
      statusReason: "unmapped",
      nativeStatus: "Triage",
    });
    try {
      expect(detail).toContain("Triage");
      expect(detail).toContain("isn't mapped");
    } finally {
      cleanup();
    }
  });

  it("renders the canonical status verbatim for a mapped blocker with no nativeStatus", async () => {
    const { detail, cleanup } = await blockerDetailFor({
      id: "linear:HRD-5",
      title: "Plain blocker",
      status: "in-progress",
    });
    try {
      expect(detail).toContain('in status "in-progress"');
    } finally {
      cleanup();
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
        board: makeBoard({
          resolveOne: vi.fn<Board["resolveOne"]>().mockResolvedValue(
            canonicalLinearIssue({
              naturalId: "hrd-1",
              status: "todo",
              repository: "herds-social/herds",
              model: "claude",
            }),
          ),
          countInProgress: vi.fn<Board["countInProgress"]>().mockResolvedValue(2),
        }),
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
        enrichWithLinear: vi
          .fn<NonNullable<TicketDoctorDependencies["enrichWithLinear"]>>()
          .mockResolvedValue({
            uuid: "uuid-1",
            title: "X",
            description: "see herds-social/herds",
            teamId: "team-1",
            labels: [{ name: "agent-any" }],
            stateName: "Todo",
            stateType: "unstarted",
            stateId: "state-todo",
            blockers: [],
            hasMoreBlockers: false,
            hasChildren: false,
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

  it("leaves eligibility empty and skips board.refreshBlockers when status is not Todo", async () => {
    const refreshBlockers = vi.fn<Board["refreshBlockers"]>().mockResolvedValue([]);
    const dependencies = makeStubDependencies({
      enrichWithLinear: vi
        .fn<NonNullable<TicketDoctorDependencies["enrichWithLinear"]>>()
        .mockResolvedValue(makeStubRawIssue({ stateName: "Done", labels: [], description: "" })),
      board: makeBoard({ refreshBlockers }),
    });
    const result = await ticketDoctor(dependencies);
    expect(result.eligibility).toHaveLength(0);
    expect(refreshBlockers).not.toHaveBeenCalled();
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

describe("ticketDoctor — Run state section", () => {
  it("records skipped when no run state exists", async () => {
    const result = await ticketDoctor(makeStubDependencies());
    expect(result.runState).toStrictEqual([
      { name: "Local run state", status: "skipped", detail: "none found" },
    ]);
  });

  it("records persisted run metadata when present", async () => {
    const dependencies = makeStubDependencies({
      readRunState: vi
        .fn<TicketDoctorDependencies["readRunState"]>()
        .mockReturnValue(
          makeRunState({ state: "interrupted", reason: "pause", detail: "workspace missing" }),
        ),
    });
    const result = await ticketDoctor(dependencies);
    expect(result.runState).toContainEqual({
      name: "Local run state",
      status: "ok",
      detail: "interrupted",
    });
    expect(result.runState).toContainEqual({
      name: "Last reason",
      status: "ok",
      detail: "pause",
    });
    expect(result.runState).toContainEqual({
      name: "Last detail",
      status: "ok",
      detail: "workspace missing",
    });
  });

  it("omits optional run metadata rows when the state has no reason or detail", async () => {
    const dependencies = makeStubDependencies({
      readRunState: vi
        .fn<TicketDoctorDependencies["readRunState"]>()
        .mockReturnValue(makeRunState({ state: "running" })),
    });

    const result = await ticketDoctor(dependencies);

    expect(result.runState).not.toContainEqual(expect.objectContaining({ name: "Last reason" }));
    expect(result.runState).not.toContainEqual(expect.objectContaining({ name: "Last detail" }));
  });

  it("uses interrupted run state for the verdict when no stronger local state exists", async () => {
    const dependencies = makeStubDependencies({
      readRunState: vi
        .fn<TicketDoctorDependencies["readRunState"]>()
        .mockReturnValue(makeRunState({ state: "interrupted", reason: "operator pause" })),
    });
    const result = await ticketDoctor(dependencies);
    expect(result.verdict).toMatchObject({ kind: "interrupted", reason: "operator pause" });
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

  it("resolves the per-repo default branch and feeds it to probeLocalBranch (e.g. master)", async () => {
    const entry = makeWorktreeEntry();
    const probeLocalBranchMock = vi
      .fn<TicketDoctorDependencies["probeLocalBranch"]>()
      .mockResolvedValue({ kind: "present", ahead: 1, behind: 0, defaultBranch: "master" });
    const dependencies = makeStubDependencies({
      findWorktree: vi.fn<TicketDoctorDependencies["findWorktree"]>().mockReturnValue(entry),
      resolveDefaultBranch: vi
        .fn<TicketDoctorDependencies["resolveDefaultBranch"]>()
        .mockResolvedValue("master"),
      probeLocalBranch: probeLocalBranchMock,
    });
    const result = await ticketDoctor(dependencies);
    expect(probeLocalBranchMock).toHaveBeenCalledWith({
      repoDir: "/work/repo-a",
      branch: entry.branchName,
      remote: "origin",
      defaultBranch: "master",
    });
    expect(result.localBranch[0]?.detail).toContain("origin/master");
  });

  it("uses the configured remote name for local branch probes and details", async () => {
    const entry = makeWorktreeEntry();
    const probeLocalBranchMock = vi
      .fn<TicketDoctorDependencies["probeLocalBranch"]>()
      .mockResolvedValue({ kind: "present", ahead: 1, behind: 0, defaultBranch: "master" });
    const dependencies = makeStubDependencies({
      config: makeConfig({ git: { remote: "upstream", defaultBranch: "main" } }),
      findWorktree: vi.fn<TicketDoctorDependencies["findWorktree"]>().mockReturnValue(entry),
      resolveDefaultBranch: vi
        .fn<TicketDoctorDependencies["resolveDefaultBranch"]>()
        .mockResolvedValue("master"),
      probeLocalBranch: probeLocalBranchMock,
    });
    const result = await ticketDoctor(dependencies);
    expect(probeLocalBranchMock).toHaveBeenCalledWith({
      repoDir: "/work/repo-a",
      branch: entry.branchName,
      remote: "upstream",
      defaultBranch: "master",
    });
    expect(result.localBranch[0]?.detail).toContain("upstream/master");
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

  it("uses the configured remote name for remote branch probes and check names", async () => {
    const probeRemoteBranch = vi
      .fn<TicketDoctorDependencies["probeRemoteBranch"]>()
      .mockResolvedValue({ kind: "present" });
    const dependencies = makeStubDependencies({
      config: makeConfig({ git: { remote: "upstream", defaultBranch: "main" } }),
      findWorktree: vi
        .fn<TicketDoctorDependencies["findWorktree"]>()
        .mockReturnValue(makeWorktreeEntry()),
      probeRemoteBranch,
    });

    const result = await ticketDoctor(dependencies);

    expect(probeRemoteBranch).toHaveBeenCalledWith(expect.objectContaining({ remote: "upstream" }));
    expect(result.remoteBranch[0]?.name).toBe("Branch present on upstream");
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
      enrichWithLinear: vi
        .fn<NonNullable<TicketDoctorDependencies["enrichWithLinear"]>>()
        .mockResolvedValue(
          makeStubRawIssue({
            stateName: "In Review",
            stateType: "triage",
            stateId: "state-review",
            labels: [],
          }),
        ),
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

  it("returns in-flight when active Linear status combines with a present worktree", async () => {
    const entry = makeWorktreeEntry();
    const dependencies = makeStubDependencies({
      enrichWithLinear: vi
        .fn<NonNullable<TicketDoctorDependencies["enrichWithLinear"]>>()
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
        enrichWithLinear: vi
          .fn<NonNullable<TicketDoctorDependencies["enrichWithLinear"]>>()
          .mockResolvedValue(
            makeStubRawIssue({
              labels: [{ name: "agent-claude" }],
              stateName: "Todo",
              stateType: "unstarted",
              stateId: "state-todo",
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
    const dependencies = makeStubDependencies({ enrichWithLinear: undefined });
    const result = await ticketDoctor(dependencies);
    expect(result.verdict).toMatchObject({ kind: "lost" });
    expect(result.skipReasons.resolution).toBe("--no-linear");
    expect(result.skipReasons.eligibility).toBe("--no-linear");
  });

  it("still produces in-flight from local state under --no-linear when a worktree is present", async () => {
    const dependencies = makeStubDependencies({
      enrichWithLinear: undefined,
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
    runState: [],
    worktree: [],
    workspace: [],
    localBranch: [],
    remoteBranch: [],
    pullRequest: [],
    skipReasons: {
      resolution: "",
      eligibility: "",
      worktree: "",
      runState: "",
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

  it("formats interrupted verdicts with reason + next step", () => {
    const lines = renderTicketDoctorResult(
      emptyResult({
        verdict: { kind: "interrupted", reason: "operator pause", nextStep: "crew resume hrd-1" },
      }),
    );
    expect(lines.some((l) => l.includes("→ interrupted: operator pause; crew resume hrd-1"))).toBe(
      true,
    );
  });

  it("formats failed-launch verdicts with reason + next step", () => {
    const lines = renderTicketDoctorResult(
      emptyResult({
        verdict: { kind: "failed-launch", reason: "cmux missing", nextStep: "crew resume hrd-1" },
      }),
    );
    expect(lines.some((l) => l.includes("→ failed-launch: cmux missing; crew resume hrd-1"))).toBe(
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
          runState: "",
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
          runState: "",
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
          runState: "skip-rs",
          workspace: "skip-ws",
          localBranch: "skip-lb",
          remoteBranch: "skip-rb",
          pullRequest: "skip-pr",
        },
      }),
    );
    for (const tag of [
      "skip-r",
      "skip-e",
      "skip-w",
      "skip-rs",
      "skip-ws",
      "skip-lb",
      "skip-rb",
      "skip-pr",
    ]) {
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

function makeShellIssue(overrides: Partial<Parameters<typeof canonicalLinearIssue>[0]> = {}) {
  return canonicalLinearIssue({
    naturalId: "test-1",
    source: "shell-test",
    status: "todo",
    repository: "repo-a",
    model: "claude",
    title: "Shell ticket",
    ...overrides,
  });
}

describe("ticketDoctor — non-Linear source path", () => {
  it("produces would-dispatch for a shell-source ticket when Linear would throw", async () => {
    const deps = makeStubDependencies({
      ticket: "TEST-1",
      board: makeBoard({
        resolveOne: vi.fn<Board["resolveOne"]>().mockResolvedValue(makeShellIssue()),
      }),
      enrichWithLinear: vi
        .fn<NonNullable<TicketDoctorDependencies["enrichWithLinear"]>>()
        .mockRejectedValue(new Error("Entity not found")),
    });
    const result = await ticketDoctor(deps);
    expect(result.verdict.kind).toBe("would-dispatch");
    const existsCheck = result.resolution.find((c) => c.name.startsWith("Ticket exists in source"));
    expect(existsCheck?.status).toBe("ok");
    expect(existsCheck?.name).toContain("shell-test");
  });

  it("returns ineligible when shell-source ticket has non-todo status", async () => {
    const deps = makeStubDependencies({
      ticket: "TEST-1",
      board: makeBoard({
        resolveOne: vi
          .fn<Board["resolveOne"]>()
          .mockResolvedValue(makeShellIssue({ status: "in-progress" })),
      }),
    });
    const result = await ticketDoctor(deps);
    const ineligible = narrowVerdict(result.verdict, "ineligible");
    expect(ineligible.reason).toContain("in-progress");
  });

  it("returns ineligible when shell-source ticket has done status (terminal canonical state)", async () => {
    // Covers the `issue.status === "done"` branch in the canonical LifecycleStatusProbe
    // synthesis — a done canonical issue produces a terminal probe.
    const deps = makeStubDependencies({
      ticket: "TEST-1",
      board: makeBoard({
        resolveOne: vi
          .fn<Board["resolveOne"]>()
          .mockResolvedValue(makeShellIssue({ status: "done" })),
      }),
    });
    const result = await ticketDoctor(deps);
    const ineligible = narrowVerdict(result.verdict, "ineligible");
    expect(ineligible.reason).toContain("done");
  });

  it("returns ineligible when shell-source ticket has an active blocker", async () => {
    const mockBoard = makeBoard({
      resolveOne: vi.fn<Board["resolveOne"]>().mockResolvedValue(makeShellIssue()),
      refreshBlockers: vi
        .fn<Board["refreshBlockers"]>()
        .mockResolvedValue([canonicalBlocker({ naturalId: "test-2", status: "in-progress" })]),
    });
    const deps = makeStubDependencies({ ticket: "TEST-1", board: mockBoard });
    const result = await ticketDoctor(deps);
    expect(result.verdict.kind).toBe("ineligible");
  });

  it("uses enrichLinearSection for a linear-source ticket (regression)", async () => {
    const deps = makeStubDependencies({
      board: makeBoard({
        resolveOne: vi.fn<Board["resolveOne"]>().mockResolvedValue(
          canonicalLinearIssue({
            naturalId: "hrd-1",
            status: "todo",
            repository: "repo-a",
            model: "claude",
          }),
        ),
      }),
    });
    const result = await ticketDoctor(deps);
    const linearCheck = result.resolution.find((c) => c.name === "Ticket exists in Linear");
    expect(linearCheck?.status).toBe("ok");
  });

  it("returns unresolvable when ticket is found nowhere and Linear also fails", async () => {
    // board.resolveOne returns undefined; Linear enrichment is tried as a fallback
    // for the case where the board threw on RepositoryResolutionError, but if
    // Linear also cannot resolve the ticket the verdict is unresolvable.
    const deps = makeStubDependencies({
      board: makeBoard(),
      enrichWithLinear: vi
        .fn<NonNullable<TicketDoctorDependencies["enrichWithLinear"]>>()
        .mockRejectedValue(new Error("Entity not found: Issue")),
    });
    const result = await ticketDoctor(deps);
    const unresolvable = narrowVerdict(result.verdict, "unresolvable");
    expect(unresolvable.reason).toContain("Entity not found");
  });

  it("returns unresolvable when board returns undefined and --no-linear suppresses enrichment", async () => {
    // board.resolveOne returns undefined (e.g. Linear adapter threw RepositoryResolutionError
    // which was caught and swallowed) AND enrichWithLinear is undefined (--no-linear).
    // No source can resolve the ticket → unresolvable.
    const deps = makeStubDependencies({
      board: makeBoard(),
      enrichWithLinear: undefined,
    });
    const result = await ticketDoctor(deps);
    expect(result.verdict.kind).toBe("unresolvable");
  });

  it("records resolution fail when shell-source ticket has no repository", async () => {
    const deps = makeStubDependencies({
      ticket: "TEST-1",
      board: makeBoard({
        resolveOne: vi
          .fn<Board["resolveOne"]>()
          .mockResolvedValue(makeShellIssue({ repository: undefined })),
      }),
    });
    const result = await ticketDoctor(deps);
    const repoCheck = result.resolution.find(
      (c) => c.name === "Resolved repo is in workspace.knownRepositories",
    );
    expect(repoCheck?.status).toBe("fail");
    expect(repoCheck?.detail).toContain("no repository");
    expect(narrowVerdict(result.verdict, "ineligible").reason).toContain("no resolved repository");
  });

  it("records resolution fail when shell-source ticket has no model", async () => {
    const deps = makeStubDependencies({
      ticket: "TEST-1",
      board: makeBoard({
        resolveOne: vi
          .fn<Board["resolveOne"]>()
          .mockResolvedValue(makeShellIssue({ model: undefined })),
      }),
    });
    const result = await ticketDoctor(deps);
    const modelCheck = result.resolution.find((c) => c.name === "Has resolved model");
    expect(modelCheck?.status).toBe("fail");
    expect(modelCheck?.detail).toContain("no model");
    expect(narrowVerdict(result.verdict, "ineligible").reason).toContain("no resolved model");
  });

  it("returns in-flight for shell-source ticket when worktree is present", async () => {
    const deps = makeStubDependencies({
      ticket: "TEST-1",
      board: makeBoard({
        resolveOne: vi.fn<Board["resolveOne"]>().mockResolvedValue(makeShellIssue()),
      }),
      findWorktree: vi
        .fn<TicketDoctorDependencies["findWorktree"]>()
        .mockReturnValue(makeWorktreeEntry()),
      probeWorkingTree: vi
        .fn<TicketDoctorDependencies["probeWorkingTree"]>()
        .mockResolvedValue({ kind: "clean" }),
    });
    const result = await ticketDoctor(deps);
    expect(result.verdict).toMatchObject({ kind: "in-flight" });
    expect(result.skipReasons.resolution).toContain("post-dispatch");
  });

  it("runs canonical resolution when shell-source ticket has --no-linear suppression (no enrichWithLinear)", async () => {
    const deps = makeStubDependencies({
      ticket: "TEST-1",
      board: makeBoard({
        resolveOne: vi.fn<Board["resolveOne"]>().mockResolvedValue(
          makeShellIssue({
            source: "shell-test",
            naturalId: "test-1",
            status: "todo",
            repository: "repo-a",
            model: "claude",
          }),
        ),
      }),
      enrichWithLinear: undefined, // --no-linear suppression
    });
    const result = await ticketDoctor(deps);
    expect(result.verdict.kind).toBe("would-dispatch");
    const existsCheck = result.resolution.find((c) => c.name.startsWith("Ticket exists in source"));
    expect(existsCheck?.status).toBe("ok");
  });

  it("non-Linear in-progress ticket synthesizes active lifecycleStatus → in-flight when worktree present", async () => {
    const resolveOne = vi
      .fn<Board["resolveOne"]>()
      .mockResolvedValue(makeShellIssue({ status: "in-progress" }));
    const findWorktree = vi
      .fn<TicketDoctorDependencies["findWorktree"]>()
      .mockReturnValue(makeWorktreeEntry());
    const result = await ticketDoctor(
      makeStubDependencies({ board: makeBoard({ resolveOne }), findWorktree }),
    );
    expect(result.verdict).toMatchObject({ kind: "in-flight" });
  });
  it("--no-linear Linear-source ticket produces lost verdict with source name in reason", async () => {
    const result = await ticketDoctor(makeStubDependencies({ enrichWithLinear: undefined }));
    const lost = narrowVerdict(result.verdict, "lost");
    expect(lost.reason).toContain("linear");
    expect(lost.reason).not.toContain("<source>");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Source-agnosticism contract — the universal canonical path must not
// hardcode any single non-Linear source name (e.g., "shell-test") in its
// rendered output, and must produce structurally identical results for
// different non-Linear sources given equivalent canonical Issues. These
// tests catch a regression class where someone reintroduces
// `if (issue.source === "linear")` style branching in the canonical
// renderer or wires a literal "Linear" string into a check that fires
// for non-Linear sources.
// ─────────────────────────────────────────────────────────────────────────

const SOURCE_AGNOSTIC_SOURCES = ["shell-jira", "shell-clubhouse"] as const;

function stripSourceName(checkNames: string[]): string[] {
  return checkNames.map((name) => name.replace(/source \S+/, "source <SOURCE>"));
}

describe("ticketDoctor — source-agnostic canonical rendering", () => {
  function shellDeps(
    sourceName: (typeof SOURCE_AGNOSTIC_SOURCES)[number],
    issueOverrides: Partial<Parameters<typeof canonicalShellIssue>[0]> = {},
  ): TicketDoctorDependencies {
    const issue = canonicalShellIssue({
      naturalId: "x-1",
      sourceName,
      status: "todo",
      repository: "repo-a",
      model: "claude",
      title: "X-1 title",
      ...issueOverrides,
    });
    return makeStubDependencies({
      ticket: "X-1",
      board: makeBoard({
        resolveOne: vi.fn<Board["resolveOne"]>().mockResolvedValue(issue),
      }),
      // Suppress Linear enrichment so we exercise the universal canonical path.
      enrichWithLinear: undefined,
    });
  }

  it.each(SOURCE_AGNOSTIC_SOURCES)(
    "renders the universal canonical resolution checks for source %s",
    async (sourceName) => {
      const result = await ticketDoctor(shellDeps(sourceName));
      expect(result.resolution.map((c) => c.name)).toStrictEqual([
        `Ticket exists in source ${sourceName}`,
        "Status is Todo",
        "Resolved repo is in workspace.knownRepositories",
        "Has resolved model",
      ]);
    },
  );

  it("produces structurally identical results across two different non-Linear sources", async () => {
    const [a, b] = await Promise.all([
      ticketDoctor(shellDeps("shell-jira")),
      ticketDoctor(shellDeps("shell-clubhouse")),
    ]);

    // Verdict shape parity: both Todo + repo + model → would-dispatch.
    expect(a.verdict.kind).toBe("would-dispatch");
    expect(b.verdict.kind).toBe("would-dispatch");

    // Check-name parity modulo the source-name segment.
    expect(stripSourceName(a.resolution.map((c) => c.name))).toStrictEqual(
      stripSourceName(b.resolution.map((c) => c.name)),
    );
  });

  it("renders no 'Linear' substring for a non-Linear source ticket", async () => {
    // Regression catcher: if anyone introduces a hardcoded "Linear" string into
    // `buildResolutionFromCanonical` (e.g., copy-pasting from the Linear-
    // enrichment branch), this fails for every non-Linear source.
    const rendered = renderTicketDoctorResult(await ticketDoctor(shellDeps("shell-jira")));
    const joined = rendered.join("\n");
    expect(joined).not.toMatch(/\bLinear\b/i);
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
