import type { ResolvedConfig } from "../lib/config.ts";
import { canonicalBlocker, canonicalLinearIssue } from "../lib/testing/canonicalFixtures.ts";
import { isGroundcrewIssue, type GroundcrewIssue } from "../lib/taskSource.ts";
import type { UsageByAgent } from "../lib/usage.ts";
import type { WorktreeEntry } from "../lib/worktrees.ts";
import {
  type ClassifyArguments,
  classifyBlockers,
  classifyEligibility,
  classifyUsageExhaustion,
  pickBestAgent,
  type SkipVerdict,
} from "./eligibility.ts";

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
    local: { runner: "auto", clearance: { enabled: true } },
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

describe(classifyBlockers, () => {
  it("emits a `blocked` skip when a blocker is in a non-terminal state", () => {
    const { unblocked, skips } = classifyBlockers([
      todoIssue({
        blockers: [canonicalBlocker({ naturalId: "team-0", status: "in-progress" })],
      }),
    ]);

    expect(unblocked).toHaveLength(0);
    expect(skips).toHaveLength(1);
    expect(skips[0]).toMatchObject({
      kind: "skip",
      eventReason: "blocked",
      blockers: ["linear:team-0:in-progress"],
    });
  });

  it("emits a `blockers_paginated` skip when blocker pagination overflowed", () => {
    const { skips } = classifyBlockers([todoIssue({ hasMoreBlockers: true })]);

    expect(skips[0]).toMatchObject({ kind: "skip", eventReason: "blockers_paginated" });
  });

  it("emits a `blocked` skip when the blocker status is 'other' (unknown status)", () => {
    const { skips } = classifyBlockers([
      todoIssue({
        blockers: [canonicalBlocker({ naturalId: "team-0", status: "other" })],
      }),
    ]);

    expect(skips[0]).toMatchObject({
      kind: "skip",
      eventReason: "blocked",
      blockers: ["linear:team-0:other"],
    });
  });

  it("returns the issue as unblocked when its blocker status is 'done'", () => {
    const { unblocked, skips } = classifyBlockers([
      todoIssue({
        blockers: [canonicalBlocker({ naturalId: "team-0", status: "done" })],
      }),
    ]);

    expect(unblocked).toHaveLength(1);
    expect(skips).toHaveLength(0);
  });

  it("partitions a mixed batch into unblocked and skip lists", () => {
    const { unblocked, skips } = classifyBlockers([
      todoIssue({ id: "linear:team-1" }),
      todoIssue({
        id: "linear:team-2",
        blockers: [canonicalBlocker({ naturalId: "team-0", status: "in-progress" })],
      }),
      todoIssue({ id: "linear:team-3" }),
    ]);

    expect(unblocked.map((issue) => issue.id)).toStrictEqual(["linear:team-1", "linear:team-3"]);
    expect(skips.map((skip) => skip.issue.id)).toStrictEqual(["linear:team-2"]);
  });

  it("treats a 'done' blocker as cleared (canonical status)", () => {
    const issue = asGroundcrewIssue(
      canonicalLinearIssue({
        naturalId: "eng-100",
        blockers: [canonicalBlocker({ naturalId: "eng-90", status: "done" })],
        repository: "repo-a",
        agent: "claude",
      }),
    );
    const { unblocked, skips } = classifyBlockers([issue]);

    expect(unblocked).toHaveLength(1);
    expect(skips).toHaveLength(0);
  });

  it("treats an 'in-progress' blocker as blocking", () => {
    const issue = asGroundcrewIssue(
      canonicalLinearIssue({
        naturalId: "eng-100",
        blockers: [canonicalBlocker({ naturalId: "eng-90", status: "in-progress" })],
        repository: "repo-a",
        agent: "claude",
      }),
    );
    const { unblocked, skips } = classifyBlockers([issue]);

    expect(unblocked).toHaveLength(0);
    expect(skips).toHaveLength(1);
  });

  it("treats an 'other' (unknown-status) blocker as blocking", () => {
    // Previously: status: undefined was blocking. Now: status: "other" represents the same.
    const issue = asGroundcrewIssue(
      canonicalLinearIssue({
        naturalId: "eng-100",
        blockers: [canonicalBlocker({ naturalId: "eng-90", status: "other" })],
        repository: "repo-a",
        agent: "claude",
      }),
    );
    const { unblocked, skips } = classifyBlockers([issue]);

    expect(unblocked).toHaveLength(0);
    expect(skips).toHaveLength(1);
  });

  it("treats a 'todo' blocker as blocking", () => {
    const issue = asGroundcrewIssue(
      canonicalLinearIssue({
        naturalId: "eng-100",
        blockers: [canonicalBlocker({ naturalId: "eng-90", status: "todo" })],
        repository: "acme/web",
        agent: "claude",
      }),
    );
    const { unblocked, skips } = classifyBlockers([issue]);

    expect(unblocked).toHaveLength(0);
    expect(skips).toHaveLength(1);
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
      // The suggested `crew cleanup` command must use the natural id so it is actually runnable.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- verdict kind is asserted above
      const { message } = verdicts[0] as SkipVerdict;
      expect(message).toMatch(/crew cleanup team-1/);
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
