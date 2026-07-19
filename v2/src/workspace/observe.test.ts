import * as fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isWorktreeDirty, observeWorkspace } from "./observe.js";
import { provisionWorkspace } from "./provision.js";
import { workspacePath, type WorkspaceConfig } from "./paths.js";
import { commitFile, makeSandbox, seedClone, type Sandbox } from "./testRepos.js";

const TASK_ID = "fixture:TASK-1";
const BRANCH = "crew/fixture-task-1";

describe("observeWorkspace", () => {
  let sandbox: Sandbox;
  let config: WorkspaceConfig;

  beforeEach(() => {
    sandbox = makeSandbox();
    config = { baseDirectory: sandbox.baseDirectory };
  });

  afterEach(() => {
    sandbox.cleanup();
  });

  it("returns undefined when the workspace has no marker", async () => {
    expect(await observeWorkspace({ config, taskId: TASK_ID })).toBeUndefined();
  });

  it("reports branch, commits ahead, and dirty files per repo", async () => {
    await seedClone({ sandbox, name: "alpha" });
    await provisionWorkspace({ config, taskId: TASK_ID, repos: ["alpha"] });
    const worktree = path.join(workspacePath({ config, taskId: TASK_ID }), "alpha");

    await commitFile({ cwd: worktree, file: "work.txt", contents: "work\n", message: "did the work" });
    fs.writeFileSync(path.join(worktree, "scratch.txt"), "uncommitted");

    const observation = await observeWorkspace({ config, taskId: TASK_ID });

    expect(observation?.branch).toBe(BRANCH);
    expect(observation?.repos).toHaveLength(1);
    const alpha = observation?.repos[0];
    expect(alpha?.repo).toBe("alpha");
    expect(alpha?.branch).toBe(BRANCH);
    expect(alpha?.commitsAhead).toEqual(["did the work"]);
    expect(alpha?.dirtyFiles).toContain("scratch.txt");
  });

  it("skips a repo recorded in the marker whose worktree is gone", async () => {
    await seedClone({ sandbox, name: "alpha" });
    await provisionWorkspace({ config, taskId: TASK_ID, repos: ["alpha"] });
    fs.rmSync(path.join(workspacePath({ config, taskId: TASK_ID }), "alpha"), {
      recursive: true,
      force: true,
    });

    const observation = await observeWorkspace({ config, taskId: TASK_ID });

    expect(observation?.repos).toEqual([]);
  });

  it("reports an empty workspace with no repos", async () => {
    await provisionWorkspace({ config, taskId: TASK_ID });

    const observation = await observeWorkspace({ config, taskId: TASK_ID });

    expect(observation?.repos).toEqual([]);
    expect(observation?.branch).toBe(BRANCH);
  });
});

describe("isWorktreeDirty", () => {
  let sandbox: Sandbox;

  beforeEach(() => {
    sandbox = makeSandbox();
  });

  afterEach(() => {
    sandbox.cleanup();
  });

  it("is false for a clean worktree and true once modified", async () => {
    await seedClone({ sandbox, name: "alpha" });
    const config: WorkspaceConfig = { baseDirectory: sandbox.baseDirectory };
    await provisionWorkspace({ config, taskId: TASK_ID, repos: ["alpha"] });
    const worktree = path.join(workspacePath({ config, taskId: TASK_ID }), "alpha");

    expect(await isWorktreeDirty({ worktreePath: worktree })).toBe(false);
    fs.writeFileSync(path.join(worktree, "dirt.txt"), "x");
    expect(await isWorktreeDirty({ worktreePath: worktree })).toBe(true);
  });
});
