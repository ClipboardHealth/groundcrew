import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ResolvedConfig } from "./config.ts";
import {
  readRunState,
  recordRunState,
  removeRunState,
  type RunLifecycleState,
  runStateDirectory,
  runStatePath,
  updateRunState,
} from "./runState.ts";

function makeConfig(stateRoot: string): ResolvedConfig {
  return {
    sources: [],
    defaults: { hooks: {} },
    git: { remote: "origin", defaultBranch: "main" },
    workspace: {
      projectDir: "/work",
      knownRepositories: ["repo-a"],
      repositories: [{ name: "repo-a" }],
    },
    orchestrator: {
      maximumInProgress: 4,
      pollIntervalMilliseconds: 1000,
      sessionLimitPercentage: 85,
    },
    agents: {
      default: "claude",
      definitions: { claude: { cmd: "claude", color: "#fff" } },
    },
    prompts: { initial: "x" },
    workspaceKind: "auto",
    local: {
      runner: "auto",
      networkEgress: "allowlisted",
      safehouse: { enable: [] },
      readOnlyDirs: [],
    },
    logging: { file: path.join(stateRoot, "groundcrew.log") },
  };
}

describe("run state store", () => {
  let stateRoot: string;
  let config: ResolvedConfig;

  beforeEach(() => {
    stateRoot = mkdtempSync(path.join(tmpdir(), "groundcrew-run-state-"));
    config = makeConfig(stateRoot);
  });

  afterEach(() => {
    rmSync(stateRoot, { recursive: true, force: true });
  });

  it("stores one JSON file per task next to the configured log file", () => {
    const actual = recordRunState({
      config,
      state: {
        task: "TEAM-1",
        repository: "repo-a",
        agent: "claude",
        worktreeDir: "/work/repo-a-team-1",
        branchName: "dev-team-1",
        workspaceName: "team-1",
        state: "running",
      },
    });

    expect(runStateDirectory(config)).toBe(path.join(stateRoot, "runs"));
    expect(runStatePath(config, "team-1")).toBe(path.join(stateRoot, "runs", "team-1.json"));
    expect(actual.task).toBe("team-1");
    expect(readRunState(config, "TEAM-1")).toMatchObject({
      task: "team-1",
      repository: "repo-a",
      agent: "claude",
      state: "running",
      resumeCount: 0,
    });
  });

  it("stores optional reason, detail, and explicit resume count", () => {
    const actual = recordRunState({
      config,
      state: {
        task: "team-1",
        repository: "repo-a",
        agent: "claude",
        worktreeDir: "/work/repo-a-team-1",
        branchName: "dev-team-1",
        workspaceName: "team-1",
        state: "interrupted",
        reason: "pause",
        detail: "workspace missing",
        resumeCount: 3,
      },
    });

    expect(actual).toMatchObject({
      reason: "pause",
      detail: "workspace missing",
      resumeCount: 3,
    });
    expect(readRunState(config, "team-1")).toMatchObject({
      reason: "pause",
      detail: "workspace missing",
      resumeCount: 3,
    });
  });

  it("round-trips an optional task title", () => {
    recordRunState({
      config,
      state: {
        task: "team-1",
        repository: "repo-a",
        agent: "claude",
        worktreeDir: "/work/repo-a-team-1",
        branchName: "dev-team-1",
        workspaceName: "team-1",
        state: "running",
        title: "Improve crew status command output",
      },
    });

    expect(readRunState(config, "team-1")).toMatchObject({
      title: "Improve crew status command output",
    });
  });

  it("preserves a previously-recorded title when a later recordRunState omits it", () => {
    recordRunState({
      config,
      state: {
        task: "team-1",
        repository: "repo-a",
        agent: "claude",
        worktreeDir: "/work/repo-a-team-1",
        branchName: "dev-team-1",
        workspaceName: "team-1",
        state: "running",
        title: "Improve crew status command output",
      },
    });

    // resume/interrupt callers don't carry the title; the title should
    // survive on disk so `crew status` can still surface it.
    recordRunState({
      config,
      state: {
        task: "team-1",
        repository: "repo-a",
        agent: "claude",
        worktreeDir: "/work/repo-a-team-1",
        branchName: "dev-team-1",
        workspaceName: "team-1",
        state: "interrupted",
        reason: "manual pause",
      },
    });

    expect(readRunState(config, "team-1")).toMatchObject({
      state: "interrupted",
      title: "Improve crew status command output",
    });
  });

  it("round-trips an optional task url and preserves it across transitions", () => {
    recordRunState({
      config,
      state: {
        task: "team-1",
        repository: "repo-a",
        agent: "claude",
        worktreeDir: "/work/repo-a-team-1",
        branchName: "dev-team-1",
        workspaceName: "team-1",
        state: "running",
        url: "https://linear.app/example/issue/TEAM-1",
      },
    });

    expect(readRunState(config, "team-1")).toMatchObject({
      url: "https://linear.app/example/issue/TEAM-1",
    });

    // Subsequent transition omits url — must be preserved.
    recordRunState({
      config,
      state: {
        task: "team-1",
        repository: "repo-a",
        agent: "claude",
        worktreeDir: "/work/repo-a-team-1",
        branchName: "dev-team-1",
        workspaceName: "team-1",
        state: "interrupted",
      },
    });

    expect(readRunState(config, "team-1")).toMatchObject({
      state: "interrupted",
      url: "https://linear.app/example/issue/TEAM-1",
    });
  });

  it("round-trips the canonical completion task id and preserves it across transitions", () => {
    recordRunState({
      config,
      state: {
        task: "team-1",
        repository: "repo-a",
        agent: "claude",
        worktreeDir: "/work/repo-a-team-1",
        branchName: "dev-team-1",
        workspaceName: "team-1",
        state: "running",
        completionTaskId: "linear:team-1",
      },
    });

    expect(readRunState(config, "team-1")).toMatchObject({
      completionTaskId: "linear:team-1",
    });

    recordRunState({
      config,
      state: {
        task: "team-1",
        repository: "repo-a",
        agent: "claude",
        worktreeDir: "/work/repo-a-team-1",
        branchName: "dev-team-1",
        workspaceName: "team-1",
        state: "interrupted",
      },
    });

    expect(readRunState(config, "team-1")).toMatchObject({
      state: "interrupted",
      completionTaskId: "linear:team-1",
    });
  });

  it("round-trips adopted branch state and preserves it across transitions", () => {
    recordRunState({
      config,
      state: {
        task: "pr-42",
        repository: "repo-a",
        agent: "claude",
        worktreeDir: "/work/repo-a-pr-42",
        branchName: "jdoe/fix-thing",
        workspaceName: "pr-42",
        state: "running",
        adoptedBranch: true,
      },
    });

    expect(readRunState(config, "pr-42")).toMatchObject({
      branchName: "jdoe/fix-thing",
      adoptedBranch: true,
    });

    recordRunState({
      config,
      state: {
        task: "pr-42",
        repository: "repo-a",
        agent: "claude",
        worktreeDir: "/work/repo-a-pr-42",
        branchName: "jdoe/fix-thing",
        workspaceName: "pr-42",
        state: "interrupted",
      },
    });

    expect(readRunState(config, "pr-42")).toMatchObject({
      state: "interrupted",
      adoptedBranch: true,
    });
  });

  it("prefers a freshly provided title over the previously-recorded one", () => {
    recordRunState({
      config,
      state: {
        task: "team-1",
        repository: "repo-a",
        agent: "claude",
        worktreeDir: "/work/repo-a-team-1",
        branchName: "dev-team-1",
        workspaceName: "team-1",
        state: "running",
        title: "Old title",
      },
    });

    recordRunState({
      config,
      state: {
        task: "team-1",
        repository: "repo-a",
        agent: "claude",
        worktreeDir: "/work/repo-a-team-1",
        branchName: "dev-team-1",
        workspaceName: "team-1",
        state: "running",
        title: "New title",
      },
    });

    expect(readRunState(config, "team-1")).toMatchObject({ title: "New title" });
  });

  it("round-trips every lifecycle state", () => {
    const states: RunLifecycleState[] = [
      "provisioning",
      "running",
      "interrupted",
      "resumed",
      "failed-to-launch",
    ];

    for (const state of states) {
      recordRunState({
        config,
        state: {
          task: "team-1",
          repository: "repo-a",
          agent: "claude",
          worktreeDir: "/work/repo-a-team-1",
          branchName: "dev-team-1",
          workspaceName: "team-1",
          state,
        },
      });
      expect(readRunState(config, "team-1")?.state).toBe(state);
    }
  });

  it("updates existing state while preserving createdAt", () => {
    const first = recordRunState({
      config,
      state: {
        task: "team-1",
        repository: "repo-a",
        agent: "claude",
        worktreeDir: "/work/repo-a-team-1",
        branchName: "dev-team-1",
        workspaceName: "team-1",
        state: "running",
      },
    });

    const updated = updateRunState({
      config,
      task: "team-1",
      patch: {
        state: "interrupted",
        reason: "wrong direction",
      },
    });

    expect(updated).toMatchObject({ state: "interrupted", reason: "wrong direction" });
    expect(updated?.createdAt).toBe(first.createdAt);
  });

  it("returns undefined when updating missing state", () => {
    expect(
      updateRunState({
        config,
        task: "team-1",
        patch: {
          state: "interrupted",
          reason: "wrong direction",
        },
      }),
    ).toBeUndefined();
  });

  it("returns undefined for missing or malformed state files", () => {
    expect(readRunState(config, "team-1")).toBeUndefined();
    mkdirSync(path.dirname(runStatePath(config, "team-1")), { recursive: true });
    writeFileSync(runStatePath(config, "team-1"), "{not json");

    expect(readRunState(config, "team-1")).toBeUndefined();
  });

  it("returns undefined for JSON that is not a valid run state object", () => {
    mkdirSync(path.dirname(runStatePath(config, "team-1")), { recursive: true });
    writeFileSync(runStatePath(config, "team-1"), "null");
    expect(readRunState(config, "team-1")).toBeUndefined();

    writeFileSync(runStatePath(config, "team-1"), JSON.stringify({ task: "team-1" }));
    expect(readRunState(config, "team-1")).toBeUndefined();
  });

  it("reads the legacy `model` field when `agent` is absent", () => {
    mkdirSync(path.dirname(runStatePath(config, "team-1")), { recursive: true });
    writeFileSync(
      runStatePath(config, "team-1"),
      JSON.stringify({
        task: "team-1",
        repository: "repo-a",
        model: "claude",
        worktreeDir: "/work/repo-a-team-1",
        branchName: "dev-team-1",
        workspaceName: "team-1",
        state: "running",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        resumeCount: 0,
      }),
    );
    expect(readRunState(config, "team-1")).toMatchObject({ agent: "claude" });
  });

  it("accepts multi-segment source task ids", () => {
    expect(runStatePath(config, "gc-20260608-001")).toBe(
      path.join(stateRoot, "runs", "gc-20260608-001.json"),
    );
  });

  it("rejects task ids that are not plain source task ids", () => {
    expect(() => runStatePath(config, "../team-1")).toThrow(/plain task id/);
  });

  it("removes a run state file", () => {
    recordRunState({
      config,
      state: {
        task: "team-1",
        repository: "repo-a",
        agent: "claude",
        worktreeDir: "/work/repo-a-team-1",
        branchName: "dev-team-1",
        workspaceName: "team-1",
        state: "running",
      },
    });

    removeRunState(config, "team-1");

    expect(readRunState(config, "team-1")).toBeUndefined();
  });

  it("writes readable JSON", () => {
    recordRunState({
      config,
      state: {
        task: "team-1",
        repository: "repo-a",
        agent: "claude",
        worktreeDir: "/work/repo-a-team-1",
        branchName: "dev-team-1",
        workspaceName: "team-1",
        state: "running",
      },
    });

    expect(JSON.parse(readFileSync(runStatePath(config, "team-1"), "utf8"))).toMatchObject({
      task: "team-1",
      state: "running",
    });
  });

  describe("token usage", () => {
    const usage = {
      inputTokens: 11,
      cacheCreationInputTokens: 22,
      cacheReadInputTokens: 33,
      outputTokens: 44,
      messages: 5,
    };

    function seed(): void {
      recordRunState({
        config,
        state: {
          task: "TEAM-9",
          repository: "repo-a",
          agent: "claude",
          worktreeDir: "/work/repo-a-team-9",
          branchName: "dev-team-9",
          workspaceName: "team-9",
          state: "running",
        },
      });
    }

    it("round-trips through a write and a read", () => {
      // The parser builds RunState field by field, so a field it forgets is
      // written to disk and silently dropped on the way back.
      seed();
      updateRunState({ config, task: "TEAM-9", patch: { state: "running", usage } });

      expect(readRunState(config, "TEAM-9")?.usage).toStrictEqual(usage);
    });

    it("survives a lifecycle transition that does not mention it", () => {
      seed();
      updateRunState({ config, task: "TEAM-9", patch: { state: "running", usage } });

      updateRunState({ config, task: "TEAM-9", patch: { state: "interrupted" } });

      expect(readRunState(config, "TEAM-9")?.usage).toStrictEqual(usage);
    });

    it("survives a resume that rebuilds the record", () => {
      // recordRunState reconstructs the state rather than spreading it, so the
      // counts have to be carried forward explicitly.
      seed();
      updateRunState({ config, task: "TEAM-9", patch: { state: "running", usage } });

      recordRunState({
        config,
        state: {
          task: "TEAM-9",
          repository: "repo-a",
          agent: "claude",
          worktreeDir: "/work/repo-a-team-9",
          branchName: "dev-team-9",
          workspaceName: "team-9",
          state: "resumed",
          resumeCount: 1,
        },
      });

      expect(readRunState(config, "TEAM-9")?.usage).toStrictEqual(usage);
    });

    it("is absent rather than zero when nothing was recorded", () => {
      // Consumers must be able to tell "no transcript" from "cost nothing".
      seed();

      expect(readRunState(config, "TEAM-9")?.usage).toBeUndefined();
    });

    it("reads a malformed total on disk as zeroes rather than failing the record", () => {
      seed();
      const statePath = runStatePath(config, "TEAM-9");
      const onDisk: unknown = JSON.parse(readFileSync(statePath, "utf8"));
      writeFileSync(
        statePath,
        JSON.stringify({ ...(onDisk as object), usage: { outputTokens: "lots" } }),
      );

      expect(readRunState(config, "TEAM-9")?.usage).toStrictEqual({
        inputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        outputTokens: 0,
        messages: 0,
      });
    });
  });
});
