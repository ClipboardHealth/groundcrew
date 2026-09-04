import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { RunCommandOptions } from "../lib/commandRunner.ts";
import type { ResolvedConfig } from "../lib/config.ts";
import { recordRunState, readRunState } from "../lib/runState.ts";
import { canonicalBlocker, canonicalLinearIssue } from "../lib/testing/canonicalFixtures.ts";
import { isGroundcrewIssue, toCanonicalId, type GroundcrewIssue } from "../lib/taskSource.ts";
import type * as utilModule from "../lib/util.ts";
import { log } from "../lib/util.ts";
import type { UsageByAgent } from "../lib/usage.ts";
import type { WorktreeEntry } from "../lib/worktrees.ts";
import {
  type ClassifyArguments,
  classifyBlockers,
  classifyEligibility,
  classifyUsageExhaustion,
  defaultEligibilityDeps,
  pickBestAgent,
  type EligibilityDeps,
  type SkipVerdict,
} from "./eligibility.ts";

type RunCommandAsyncMock = (
  command: string,
  arguments_: readonly string[],
  options?: RunCommandOptions,
) => Promise<string>;

const runCommandMock = vi.hoisted(() => vi.fn<RunCommandAsyncMock>());

vi.mock(import("../lib/commandRunner.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    runCommandAsync: runCommandMock as unknown as typeof actual.runCommandAsync,
  };
});

vi.mock(import("../lib/util.ts"), async (importOriginal) => {
  const actual = await importOriginal<typeof utilModule>();
  return { ...actual, log: vi.fn<typeof actual.log>() };
});

const logMock = vi.mocked(log);

/** Assert an Issue is groundcrew-eligible (agent + repository defined) and narrow the type. */
function asGroundcrewIssue(issue: ReturnType<typeof canonicalLinearIssue>): GroundcrewIssue {
  if (!isGroundcrewIssue(issue)) {
    throw new Error("Expected a GroundcrewIssue (agent and repository must be defined)");
  }
  return issue;
}

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    sources: [],
    defaults: { hooks: {} },
    git: { remote: "origin", defaultBranch: "main", ...overrides.git },
    workspace: {
      projectDir: "/work",
      knownRepositories: ["repo-a", "repo-b"],
      repositories: [{ name: "repo-a" }, { name: "repo-b" }],
      ...overrides.workspace,
    },
    orchestrator: {
      maximumInProgress: 4,
      pollIntervalMilliseconds: 1000,
      sessionLimitPercentage: 85,
      ...overrides.orchestrator,
    },
    agents: {
      default: "claude",
      definitions: {
        claude: { cmd: "claude", color: "#fff" },
        codex: { cmd: "codex", color: "#000" },
      },
      ...overrides.agents,
    },
    prompts: { initial: "x", ...overrides.prompts },
    workspaceKind: overrides.workspaceKind ?? "auto",
    local: {
      runner: "auto",
      networkEgress: "allowlisted",
      safehouse: { enable: [] },
      readOnlyDirs: [],
    },
    logging: { file: "/tmp/groundcrew-test.log", ...overrides.logging },
  };
}

function todoIssue(overrides: Partial<GroundcrewIssue> = {}): GroundcrewIssue {
  return asGroundcrewIssue(
    canonicalLinearIssue({
      naturalId: "team-1",
      status: "todo",
      repository: "repo-a",
      agent: "claude",
      ...overrides,
    }),
  );
}

function blockedIssue(overrides: Partial<GroundcrewIssue> = {}): GroundcrewIssue {
  return todoIssue({
    blockers: [canonicalBlocker({ naturalId: "team-0", status: "in-progress" })],
    ...overrides,
  });
}

function realReadDeps(pushed: boolean): EligibilityDeps {
  return {
    readParentRunState: readRunState,
    probeParentBranch: vi
      .fn<EligibilityDeps["probeParentBranch"]>()
      .mockResolvedValue(pushed ? "pushed" : "unpushed"),
  };
}

function fullyFakeDeps(pushed: boolean): EligibilityDeps {
  return {
    readParentRunState: vi.fn<EligibilityDeps["readParentRunState"]>(),
    probeParentBranch: vi
      .fn<EligibilityDeps["probeParentBranch"]>()
      .mockResolvedValue(pushed ? "pushed" : "unpushed"),
  };
}

function hostEntryFor(repository: string, task: string): WorktreeEntry {
  return {
    repository,
    task,
    branchName: `dev-${task.toLowerCase()}`,
    dir: `/work/${repository}-${task}`,
    kind: "host",
  };
}

function defaultArguments(overrides: Partial<ClassifyArguments> = {}): ClassifyArguments {
  return {
    config: makeConfig(),
    unblocked: [todoIssue()],
    worktreeEntries: [],
    workspaceProbe: { kind: "ok", names: new Set<string>() },
    usage: {},
    exhausted: new Set<string>(),
    slots: 4,
    dryRun: false,
    ...overrides,
  };
}

describe(defaultEligibilityDeps.probeParentBranch, () => {
  afterEach(() => {
    runCommandMock.mockReset();
    logMock.mockReset();
  });

  it("returns 'pushed' when ls-remote reports the branch", async () => {
    runCommandMock.mockResolvedValue("abc123\trefs/heads/dev-team-1\n");

    await expect(
      defaultEligibilityDeps.probeParentBranch({
        repoDir: "/work/repo-a",
        remote: "origin",
        branch: "dev-team-1",
      }),
    ).resolves.toBe("pushed");

    expect(runCommandMock).toHaveBeenCalledWith("git", [
      "-C",
      "/work/repo-a",
      "ls-remote",
      "--heads",
      "origin",
      "dev-team-1",
    ]);
  });

  it("returns 'unpushed' when ls-remote finds nothing but a local branch exists", async () => {
    runCommandMock.mockResolvedValueOnce("").mockResolvedValueOnce("");

    await expect(
      defaultEligibilityDeps.probeParentBranch({
        repoDir: "/work/repo-a",
        remote: "origin",
        branch: "dev-team-1",
      }),
    ).resolves.toBe("unpushed");

    expect(runCommandMock).toHaveBeenCalledWith(
      "git",
      ["-C", "/work/repo-a", "show-ref", "--verify", "--quiet", "refs/heads/dev-team-1"],
      {},
    );
  });

  it("returns 'unknown' when the branch is missing both on the remote and locally", async () => {
    runCommandMock.mockResolvedValueOnce("").mockRejectedValueOnce(new Error("not a valid ref"));

    await expect(
      defaultEligibilityDeps.probeParentBranch({
        repoDir: "/work/repo-a",
        remote: "origin",
        branch: "dev-team-1",
      }),
    ).resolves.toBe("unknown");
  });

  it("returns 'unpushed' when ls-remote fails (network or auth error), without checking locally", async () => {
    runCommandMock.mockRejectedValue(new Error("could not resolve host"));

    await expect(
      defaultEligibilityDeps.probeParentBranch({
        repoDir: "/work/repo-a",
        remote: "origin",
        branch: "dev-team-1",
      }),
    ).resolves.toBe("unpushed");

    expect(runCommandMock).toHaveBeenCalledTimes(1);
    expect(logMock).toHaveBeenCalledWith(
      expect.stringContaining("Stack parent branch probe failed for dev-team-1"),
    );
    expect(logMock).toHaveBeenCalledWith(expect.stringContaining("could not resolve host"));
  });
});

describe(classifyBlockers, () => {
  it("emits a `blocked` skip when a blocker is in a non-terminal state", async () => {
    const { unblocked, skips } = await classifyBlockers(
      [
        todoIssue({
          blockers: [canonicalBlocker({ naturalId: "team-0", status: "in-progress" })],
        }),
      ],
      makeConfig(),
    );

    expect(unblocked).toHaveLength(0);
    expect(skips).toHaveLength(1);
    expect(skips[0]).toMatchObject({
      kind: "skip",
      eventReason: "blocked",
      blockers: ["linear:team-0:in-progress"],
    });
  });

  it("emits a `blockers_paginated` skip when blocker pagination overflowed", async () => {
    const { skips } = await classifyBlockers([todoIssue({ hasMoreBlockers: true })], makeConfig());

    expect(skips[0]).toMatchObject({ kind: "skip", eventReason: "blockers_paginated" });
  });

  it("emits a `blocked` skip when the blocker status is 'other' (unknown status)", async () => {
    const { skips } = await classifyBlockers(
      [
        todoIssue({
          blockers: [canonicalBlocker({ naturalId: "team-0", status: "other" })],
        }),
      ],
      makeConfig(),
    );

    expect(skips[0]).toMatchObject({
      kind: "skip",
      eventReason: "blocked",
      blockers: ["linear:team-0:other"],
    });
  });

  it("returns the issue as unblocked when its blocker status is 'done'", async () => {
    const { unblocked, skips } = await classifyBlockers(
      [
        todoIssue({
          blockers: [canonicalBlocker({ naturalId: "team-0", status: "done" })],
        }),
      ],
      makeConfig(),
    );

    expect(unblocked).toHaveLength(1);
    expect(skips).toHaveLength(0);
  });

  it("partitions a mixed batch into unblocked and skip lists", async () => {
    const { unblocked, skips } = await classifyBlockers(
      [
        todoIssue({ id: "linear:team-1" }),
        todoIssue({
          id: "linear:team-2",
          blockers: [canonicalBlocker({ naturalId: "team-0", status: "in-progress" })],
        }),
        todoIssue({ id: "linear:team-3" }),
      ],
      makeConfig(),
    );

    expect(unblocked.map((issue) => issue.id)).toStrictEqual(["linear:team-1", "linear:team-3"]);
    expect(skips.map((skip) => skip.issue.id)).toStrictEqual(["linear:team-2"]);
  });

  it("treats a 'done' blocker as cleared (canonical status)", async () => {
    const issue = asGroundcrewIssue(
      canonicalLinearIssue({
        naturalId: "eng-100",
        blockers: [canonicalBlocker({ naturalId: "eng-90", status: "done" })],
        repository: "repo-a",
        agent: "claude",
      }),
    );
    const { unblocked, skips } = await classifyBlockers([issue], makeConfig());

    expect(unblocked).toHaveLength(1);
    expect(skips).toHaveLength(0);
  });

  it("treats an 'in-progress' blocker as blocking", async () => {
    const issue = asGroundcrewIssue(
      canonicalLinearIssue({
        naturalId: "eng-100",
        blockers: [canonicalBlocker({ naturalId: "eng-90", status: "in-progress" })],
        repository: "repo-a",
        agent: "claude",
      }),
    );
    const { unblocked, skips } = await classifyBlockers([issue], makeConfig());

    expect(unblocked).toHaveLength(0);
    expect(skips).toHaveLength(1);
  });

  it("treats an 'other' (unknown-status) blocker as blocking", async () => {
    // Previously: status: undefined was blocking. Now: status: "other" represents the same.
    const issue = asGroundcrewIssue(
      canonicalLinearIssue({
        naturalId: "eng-100",
        blockers: [canonicalBlocker({ naturalId: "eng-90", status: "other" })],
        repository: "repo-a",
        agent: "claude",
      }),
    );
    const { unblocked, skips } = await classifyBlockers([issue], makeConfig());

    expect(unblocked).toHaveLength(0);
    expect(skips).toHaveLength(1);
  });

  it("treats a 'todo' blocker as blocking", async () => {
    const issue = asGroundcrewIssue(
      canonicalLinearIssue({
        naturalId: "eng-100",
        blockers: [canonicalBlocker({ naturalId: "eng-90", status: "todo" })],
        repository: "acme/web",
        agent: "claude",
      }),
    );
    const { unblocked, skips } = await classifyBlockers([issue], makeConfig());

    expect(unblocked).toHaveLength(0);
    expect(skips).toHaveLength(1);
  });

  describe("stacking", () => {
    let tempDir: string;

    function stackingConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
      return makeConfig({
        git: { remote: "origin", defaultBranch: "main", stacking: true },
        logging: { file: path.join(tempDir, "state", "groundcrew.log") },
        ...overrides,
      });
    }

    function recordParentRunState(overrides: { repository?: string } = {}): void {
      recordRunState({
        config: stackingConfig(),
        state: {
          task: "team-0",
          repository: overrides.repository ?? "repo-a",
          agent: "claude",
          worktreeDir: "/work/repo-a-team-0",
          branchName: "dev-team-0",
          workspaceName: "team-0",
          state: "running",
        },
      });
    }

    beforeEach(() => {
      tempDir = mkdtempSync(path.join(tmpdir(), "groundcrew-eligibility-stacking-"));
    });

    afterEach(() => {
      rmSync(tempDir, { recursive: true, force: true });
    });

    it("produces a stack decision when every condition holds", async () => {
      recordParentRunState();
      const deps = realReadDeps(true);
      const issue = blockedIssue();

      const { unblocked, stackDecisions, skips } = await classifyBlockers(
        [issue],
        stackingConfig(),
        deps,
      );

      expect(skips).toHaveLength(0);
      expect(unblocked).toStrictEqual([issue]);
      expect(stackDecisions.get(issue.id)).toStrictEqual({
        baseBranch: "dev-team-0",
        parentTask: "team-0",
      });
      expect(deps.probeParentBranch).toHaveBeenCalledWith({
        repoDir: "/work/repo-a",
        remote: "origin",
        branch: "dev-team-0",
      });
    });

    it("memoizes probeParentBranch per parent branch within a single classifyBlockers call", async () => {
      recordParentRunState();
      const deps = realReadDeps(true);
      const siblingOne = blockedIssue({ id: toCanonicalId("linear", "team-1") });
      const siblingTwo = blockedIssue({ id: toCanonicalId("linear", "team-2") });

      const { unblocked, stackDecisions } = await classifyBlockers(
        [siblingOne, siblingTwo],
        stackingConfig(),
        deps,
      );

      expect(unblocked).toHaveLength(2);
      expect(stackDecisions.get(siblingOne.id)).toStrictEqual({
        baseBranch: "dev-team-0",
        parentTask: "team-0",
      });
      expect(stackDecisions.get(siblingTwo.id)).toStrictEqual({
        baseBranch: "dev-team-0",
        parentTask: "team-0",
      });
      expect(deps.probeParentBranch).toHaveBeenCalledTimes(1);
    });

    it("emits `stack_multiple_blockers` when more than one blocker is unresolved", async () => {
      const issue = blockedIssue({
        blockers: [
          canonicalBlocker({ naturalId: "team-0", status: "in-progress" }),
          canonicalBlocker({ naturalId: "team-a", status: "in-progress" }),
        ],
      });

      const { unblocked, skips } = await classifyBlockers(
        [issue],
        stackingConfig(),
        realReadDeps(true),
      );

      expect(unblocked).toHaveLength(0);
      expect(skips[0]).toMatchObject({ kind: "skip", eventReason: "stack_multiple_blockers" });
    });

    it("emits `stack_parent_unknown` when the blocker has no run state", async () => {
      const { skips } = await classifyBlockers(
        [blockedIssue()],
        stackingConfig(),
        realReadDeps(true),
      );

      expect(skips[0]).toMatchObject({ kind: "skip", eventReason: "stack_parent_unknown" });
    });

    it("emits `stack_parent_unknown` when the blocker's run state names a different repository", async () => {
      recordParentRunState({ repository: "repo-b" });

      const { skips } = await classifyBlockers(
        [blockedIssue()],
        stackingConfig(),
        realReadDeps(true),
      );

      expect(skips[0]).toMatchObject({ kind: "skip", eventReason: "stack_parent_unknown" });
    });

    it("emits `stack_parent_unpushed` when the blocker's branch isn't pushed", async () => {
      recordParentRunState();

      const { skips } = await classifyBlockers(
        [blockedIssue()],
        stackingConfig(),
        realReadDeps(false),
      );

      expect(skips[0]).toMatchObject({ kind: "skip", eventReason: "stack_parent_unpushed" });
    });

    it("emits `stack_parent_unknown` when the blocker's branch is missing locally and on the remote", async () => {
      recordParentRunState();
      const deps: EligibilityDeps = {
        readParentRunState: readRunState,
        probeParentBranch: vi
          .fn<EligibilityDeps["probeParentBranch"]>()
          .mockResolvedValue("unknown"),
      };

      const { skips } = await classifyBlockers([blockedIssue()], stackingConfig(), deps);

      expect(skips[0]).toMatchObject({ kind: "skip", eventReason: "stack_parent_unknown" });
    });

    it("emits `stack_provisioned_repo` when the child repository is scripted-provisioner", async () => {
      const config = stackingConfig({
        workspace: {
          projectDir: "/work",
          knownRepositories: ["repo-a"],
          repositories: [{ name: "repo-a", provision: { create: "create", remove: "remove" } }],
        },
      });

      const { skips } = await classifyBlockers([blockedIssue()], config, realReadDeps(true));

      expect(skips[0]).toMatchObject({ kind: "skip", eventReason: "stack_provisioned_repo" });
    });

    it("emits `stack_opted_out` when the issue carries the groundcrew-no-stack label", async () => {
      const issue = blockedIssue({ stacking: "opted-out" });

      const { skips } = await classifyBlockers([issue], stackingConfig(), realReadDeps(true));

      expect(skips[0]).toMatchObject({ kind: "skip", eventReason: "stack_opted_out" });
    });

    it("yields the legacy `blocked` reason when stacking is disabled, without any run-state or git access", async () => {
      const deps = fullyFakeDeps(true);
      const issue = blockedIssue();

      const { skips } = await classifyBlockers([issue], makeConfig(), deps);

      expect(skips[0]).toMatchObject({ kind: "skip", eventReason: "blocked" });
      expect(deps.readParentRunState).not.toHaveBeenCalled();
      expect(deps.probeParentBranch).not.toHaveBeenCalled();
    });
  });
});

describe(classifyEligibility, () => {
  describe("agent-any resolution", () => {
    it("resolves agent-any to the agent with the most session capacity", () => {
      const verdicts = classifyEligibility(
        defaultArguments({
          unblocked: [todoIssue({ agent: "any" })],
          usage: {
            claude: { session: 0.6, sessionEndDuration: 30, weekly: null, weekEndDuration: null },
            codex: { session: 0.2, sessionEndDuration: 30, weekly: null, weekEndDuration: null },
          },
        }),
      );

      expect(verdicts[0]).toMatchObject({
        kind: "start",
        resolvedFromAny: true,
        issue: { agent: "codex" },
      });
    });

    it("emits `agent_any_capacity` when every agent is exhausted", () => {
      const verdicts = classifyEligibility(
        defaultArguments({
          unblocked: [todoIssue({ agent: "any" })],
          exhausted: new Set(["claude", "codex"]),
        }),
      );

      expect(verdicts[0]).toMatchObject({ kind: "skip", eventReason: "agent_any_capacity" });
    });

    it("excludes exhausted agents from agent-any resolution", () => {
      const verdicts = classifyEligibility(
        defaultArguments({
          unblocked: [todoIssue({ agent: "any" })],
          exhausted: new Set(["claude"]),
          usage: {
            claude: { session: 0.1, sessionEndDuration: 30, weekly: null, weekEndDuration: null },
            codex: { session: 0.4, sessionEndDuration: 30, weekly: null, weekEndDuration: null },
          },
        }),
      );

      expect(verdicts[0]).toMatchObject({
        kind: "start",
        issue: { agent: "codex" },
      });
    });

    it("does not flag resolvedFromAny when the agent was already concrete", () => {
      const verdicts = classifyEligibility(
        defaultArguments({ unblocked: [todoIssue({ agent: "claude" })] }),
      );

      expect(verdicts[0]).toMatchObject({ kind: "start", resolvedFromAny: false });
    });
  });

  describe("session exhaustion", () => {
    it("skips a concrete-agent task when its agent is exhausted", () => {
      const verdicts = classifyEligibility(
        defaultArguments({
          unblocked: [todoIssue({ agent: "claude" })],
          exhausted: new Set(["claude"]),
        }),
      );

      expect(verdicts[0]).toMatchObject({ kind: "skip", eventReason: "agent_exhausted" });
    });
  });

  describe("workspace recovery", () => {
    it("starts as recovery=true when worktree exists and a live workspace matches", () => {
      const verdicts = classifyEligibility(
        defaultArguments({
          worktreeEntries: [hostEntryFor("repo-a", "team-1")],
          workspaceProbe: { kind: "ok", names: new Set(["team-1"]) },
        }),
      );

      expect(verdicts[0]).toMatchObject({ kind: "start", recovery: true });
    });

    it("emits `workspace_missing` when the worktree exists but no live workspace matches", () => {
      const verdicts = classifyEligibility(
        defaultArguments({
          worktreeEntries: [hostEntryFor("repo-a", "team-1")],
          workspaceProbe: { kind: "ok", names: new Set<string>() },
        }),
      );

      expect(verdicts[0]).toMatchObject({ kind: "skip", eventReason: "workspace_missing" });
    });

    it("workspace_missing hint uses the natural id in the cleanup command", () => {
      const verdicts = classifyEligibility(
        defaultArguments({
          worktreeEntries: [hostEntryFor("repo-a", "team-1")],
          workspaceProbe: { kind: "ok", names: new Set<string>() },
        }),
      );

      expect(verdicts[0]).toMatchObject({ kind: "skip", eventReason: "workspace_missing" });
      // The suggested cleanup command must use the natural id so it is actually runnable.
      const { message } = verdicts[0] as SkipVerdict;
      expect(message).toContain("Run 'crew cleanup team-1'");
      expect(message).not.toContain("`");
    });

    it("emits `workspace_list_unavailable` when the workspace adapter probe failed", () => {
      const verdicts = classifyEligibility(
        defaultArguments({
          worktreeEntries: [hostEntryFor("repo-a", "team-1")],
          workspaceProbe: { kind: "unavailable" },
        }),
      );

      expect(verdicts[0]).toMatchObject({
        kind: "skip",
        eventReason: "workspace_list_unavailable",
      });
    });

    it("starts as recovery=false when the worktree exists but dry-run skips the probe", () => {
      const verdicts = classifyEligibility(
        defaultArguments({
          worktreeEntries: [hostEntryFor("repo-a", "team-1")],
          workspaceProbe: { kind: "ok", names: new Set<string>() },
          dryRun: true,
        }),
      );

      expect(verdicts[0]).toMatchObject({ kind: "start", recovery: false });
    });
  });

  describe("slot cap", () => {
    it("stops producing start verdicts once the slot cap is reached", () => {
      const verdicts = classifyEligibility(
        defaultArguments({
          slots: 1,
          unblocked: [todoIssue({ id: "linear:team-1" }), todoIssue({ id: "linear:team-2" })],
        }),
      );

      expect(verdicts).toHaveLength(1);
      expect(verdicts[0]).toMatchObject({ kind: "start", issue: { id: "linear:team-1" } });
    });
  });
});

describe(pickBestAgent, () => {
  it("returns undefined when every agent is exhausted", () => {
    expect(pickBestAgent(makeConfig(), {}, new Set(["claude", "codex"]))).toBeUndefined();
  });

  it("falls back to the default agent when no usage data is available", () => {
    expect(pickBestAgent(makeConfig(), {}, new Set())).toBe("claude");
  });

  it("breaks ties in favor of the default agent", () => {
    const usage: UsageByAgent = {
      claude: { session: 0.5, sessionEndDuration: 30, weekly: null, weekEndDuration: null },
      codex: { session: 0.5, sessionEndDuration: 30, weekly: null, weekEndDuration: null },
    };
    expect(pickBestAgent(makeConfig(), usage, new Set())).toBe("claude");
  });

  it("picks the agent with the lowest session score", () => {
    const usage: UsageByAgent = {
      claude: { session: 0.7, sessionEndDuration: 30, weekly: null, weekEndDuration: null },
      codex: { session: 0.3, sessionEndDuration: 30, weekly: null, weekEndDuration: null },
    };
    expect(pickBestAgent(makeConfig(), usage, new Set())).toBe("codex");
  });
});

describe(classifyUsageExhaustion, () => {
  const MINUTES_PER_DAY = 24 * 60;
  const MINUTES_PER_WEEK = 7 * MINUTES_PER_DAY;

  it("reports session exhaustion", () => {
    expect(
      classifyUsageExhaustion(makeConfig(), {
        claude: { session: 0.95, sessionEndDuration: 30, weekly: null, weekEndDuration: null },
      }),
    ).toStrictEqual([
      {
        kind: "session",
        agent: "claude",
        usedPercentage: 95,
        limitPercentage: 85,
        resetMinutes: 30,
      },
    ]);
  });

  it("reports weekly paced-budget exhaustion", () => {
    expect(
      classifyUsageExhaustion(makeConfig(), {
        claude: {
          session: 0.1,
          sessionEndDuration: 30,
          weekly: 0.2,
          weekEndDuration: MINUTES_PER_WEEK - MINUTES_PER_DAY,
        },
      }),
    ).toStrictEqual([
      {
        kind: "weekly",
        agent: "claude",
        usedPercentage: 20,
        allowedPercentage: (1 / 7) * 100,
        resetMinutes: MINUTES_PER_WEEK - MINUTES_PER_DAY,
      },
    ]);
  });
});
