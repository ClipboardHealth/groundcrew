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
    local: { runner: "auto" },
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
    const states: RunLifecycleState[] = ["running", "interrupted", "resumed", "failed-to-launch"];

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
});
