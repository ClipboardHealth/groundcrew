import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  branchPrefixOf,
  clonePath,
  defaultBranchOf,
  markerFilePath,
  markerPath,
  remoteOf,
  worktreePath,
  worktreesRoot,
  workspacePath,
  type WorkspaceConfig,
} from "./paths.js";

const TASK_ID = "fixture:TASK-1";

describe("paths", () => {
  it("defaults the worktrees root to <baseDirectory>/.groundcrew/worktrees", () => {
    const config: WorkspaceConfig = { baseDirectory: "/dev" };

    expect(worktreesRoot({ config })).toBe(path.join("/dev", ".groundcrew", "worktrees"));
  });

  it("honors an explicit worktree directory", () => {
    const config: WorkspaceConfig = { baseDirectory: "/dev", worktreeDirectory: "/scratch/wt" };

    expect(worktreesRoot({ config })).toBe("/scratch/wt");
  });

  it("derives workspace, worktree, and marker paths from the slug", () => {
    const config: WorkspaceConfig = { baseDirectory: "/dev", worktreeDirectory: "/wt" };

    expect(workspacePath({ config, taskId: TASK_ID })).toBe(path.join("/wt", "fixture-task-1"));
    expect(worktreePath({ config, taskId: TASK_ID, repo: "alpha" })).toBe(
      path.join("/wt", "fixture-task-1", "alpha"),
    );
    expect(markerPath({ config, taskId: TASK_ID })).toBe(
      path.join("/wt", "fixture-task-1", ".groundcrew", "task.json"),
    );
  });

  it("derives the marker file inside an arbitrary workspace directory", () => {
    expect(markerFilePath({ workspaceDirectory: "/wt/x" })).toBe(
      path.join("/wt/x", ".groundcrew", "task.json"),
    );
  });

  it("locates a repo's local clone under the base directory", () => {
    const config: WorkspaceConfig = { baseDirectory: "/dev" };

    expect(clonePath({ config, repo: "alpha" })).toBe(path.join("/dev", "alpha"));
  });

  it("resolves git naming defaults and overrides", () => {
    const defaults: WorkspaceConfig = { baseDirectory: "/dev" };
    const overrides: WorkspaceConfig = {
      baseDirectory: "/dev",
      branchPrefix: "bot",
      remote: "upstream",
      defaultBranch: "trunk",
    };

    expect(branchPrefixOf({ config: defaults })).toBe("crew");
    expect(remoteOf({ config: defaults })).toBe("origin");
    expect(defaultBranchOf({ config: defaults })).toBe("main");
    expect(branchPrefixOf({ config: overrides })).toBe("bot");
    expect(remoteOf({ config: overrides })).toBe("upstream");
    expect(defaultBranchOf({ config: overrides })).toBe("trunk");
  });
});
