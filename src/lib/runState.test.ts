import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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
    linear: {
      projects: [
        {
          projectSlug: "x-aaaaaaaaaaaa",
          slugId: "aaaaaaaaaaaa",
          statuses: { todo: "Todo", inProgress: "In Progress", done: "Done", terminal: ["Done"] },
        },
      ],
    },
    sources: [],
    git: { remote: "origin", defaultBranch: "main" },
    workspace: {
      projectDir: "/work",
      knownRepositories: ["repo-a"],
    },
    orchestrator: {
      maximumInProgress: 4,
      pollIntervalMilliseconds: 1000,
      sessionLimitPercentage: 85,
    },
    models: {
      default: "claude",
      definitions: { claude: { cmd: "claude", color: "#fff" } },
    },
    prompts: { initial: "x" },
    workspaceKind: "auto",
    local: { runner: "auto" },
    sandbox: { authRecipes: {}, gitDefaults: false },
    logging: { file: join(stateRoot, "groundcrew.log") },
  };
}

describe("run state store", () => {
  let stateRoot: string;
  let config: ResolvedConfig;

  beforeEach(() => {
    stateRoot = mkdtempSync(join(tmpdir(), "groundcrew-run-state-"));
    config = makeConfig(stateRoot);
  });

  afterEach(() => {
    rmSync(stateRoot, { recursive: true, force: true });
  });

  it("stores one JSON file per ticket next to the configured log file", () => {
    const actual = recordRunState({
      config,
      state: {
        ticket: "TEAM-1",
        repository: "repo-a",
        model: "claude",
        worktreeDir: "/work/repo-a-team-1",
        branchName: "rocky-team-1",
        workspaceName: "team-1",
        state: "running",
      },
    });

    expect(runStateDirectory(config)).toBe(join(stateRoot, "runs"));
    expect(runStatePath(config, "team-1")).toBe(join(stateRoot, "runs", "team-1.json"));
    expect(actual.ticket).toBe("team-1");
    expect(readRunState(config, "TEAM-1")).toMatchObject({
      ticket: "team-1",
      repository: "repo-a",
      model: "claude",
      state: "running",
      resumeCount: 0,
    });
  });

  it("stores optional reason, detail, and explicit resume count", () => {
    const actual = recordRunState({
      config,
      state: {
        ticket: "team-1",
        repository: "repo-a",
        model: "claude",
        worktreeDir: "/work/repo-a-team-1",
        branchName: "rocky-team-1",
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

  it("round-trips every lifecycle state", () => {
    const states: RunLifecycleState[] = ["running", "interrupted", "resumed", "failed-to-launch"];

    for (const state of states) {
      recordRunState({
        config,
        state: {
          ticket: "team-1",
          repository: "repo-a",
          model: "claude",
          worktreeDir: "/work/repo-a-team-1",
          branchName: "rocky-team-1",
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
        ticket: "team-1",
        repository: "repo-a",
        model: "claude",
        worktreeDir: "/work/repo-a-team-1",
        branchName: "rocky-team-1",
        workspaceName: "team-1",
        state: "running",
      },
    });

    const updated = updateRunState({
      config,
      ticket: "team-1",
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
        ticket: "team-1",
        patch: {
          state: "interrupted",
          reason: "wrong direction",
        },
      }),
    ).toBeUndefined();
  });

  it("returns undefined for missing or malformed state files", () => {
    expect(readRunState(config, "team-1")).toBeUndefined();
    mkdirSync(dirname(runStatePath(config, "team-1")), { recursive: true });
    writeFileSync(runStatePath(config, "team-1"), "{not json");

    expect(readRunState(config, "team-1")).toBeUndefined();
  });

  it("returns undefined for JSON that is not a valid run state object", () => {
    mkdirSync(dirname(runStatePath(config, "team-1")), { recursive: true });
    writeFileSync(runStatePath(config, "team-1"), "null");
    expect(readRunState(config, "team-1")).toBeUndefined();

    writeFileSync(runStatePath(config, "team-1"), JSON.stringify({ ticket: "team-1" }));
    expect(readRunState(config, "team-1")).toBeUndefined();
  });

  it("rejects ticket ids that are not plain Linear-style ids", () => {
    expect(() => runStatePath(config, "../team-1")).toThrow(/plain ticket id/);
  });

  it("removes a run state file", () => {
    recordRunState({
      config,
      state: {
        ticket: "team-1",
        repository: "repo-a",
        model: "claude",
        worktreeDir: "/work/repo-a-team-1",
        branchName: "rocky-team-1",
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
        ticket: "team-1",
        repository: "repo-a",
        model: "claude",
        worktreeDir: "/work/repo-a-team-1",
        branchName: "rocky-team-1",
        workspaceName: "team-1",
        state: "running",
      },
    });

    expect(JSON.parse(readFileSync(runStatePath(config, "team-1"), "utf8"))).toMatchObject({
      ticket: "team-1",
      state: "running",
    });
  });
});
