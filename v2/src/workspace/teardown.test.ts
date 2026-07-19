import * as fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DirtyWorktreeError, WorkspaceError } from "./errors.js";
import { localBranchExists } from "./git.js";
import { provisionWorkspace } from "./provision.js";
import { worktreesRoot, workspacePath, type WorkspaceConfig } from "./paths.js";
import { removeWorkspace } from "./teardown.js";
import { makeSandbox, seedClone, type Sandbox } from "./testRepos.js";

const TASK_ID = "fixture:TASK-1";
const BRANCH = "crew/fixture-task-1";

describe("removeWorkspace", () => {
  let sandbox: Sandbox;
  let config: WorkspaceConfig;

  beforeEach(() => {
    sandbox = makeSandbox();
    config = { baseDirectory: sandbox.baseDirectory };
  });

  afterEach(() => {
    sandbox.cleanup();
  });

  it("is a no-op when the workspace does not exist", async () => {
    await expect(removeWorkspace({ config, taskId: TASK_ID })).resolves.toBeUndefined();
  });

  it("removes worktrees, deletes the task branch, and deletes the workspace directory", async () => {
    const clone = await seedClone({ sandbox, name: "alpha" });
    const { workspaceDirectory } = await provisionWorkspace({ config, taskId: TASK_ID, repos: ["alpha"] });

    await removeWorkspace({ config, taskId: TASK_ID });

    expect(fs.existsSync(workspaceDirectory)).toBe(false);
    expect(await localBranchExists({ repoDirectory: clone, branch: BRANCH })).toBe(false);
  });

  it("refuses a dirty worktree by name, then removes it under force", async () => {
    await seedClone({ sandbox, name: "alpha" });
    const { workspaceDirectory } = await provisionWorkspace({ config, taskId: TASK_ID, repos: ["alpha"] });
    const worktree = path.join(workspaceDirectory, "alpha");
    fs.writeFileSync(path.join(worktree, "dirt.txt"), "uncommitted");

    await expect(removeWorkspace({ config, taskId: TASK_ID })).rejects.toBeInstanceOf(DirtyWorktreeError);
    expect(fs.existsSync(worktree)).toBe(true);

    await removeWorkspace({ config, taskId: TASK_ID, force: true });
    expect(fs.existsSync(workspaceDirectory)).toBe(false);
  });

  it("name the dirty file in the refusal", async () => {
    await seedClone({ sandbox, name: "alpha" });
    const { workspaceDirectory } = await provisionWorkspace({ config, taskId: TASK_ID, repos: ["alpha"] });
    fs.writeFileSync(path.join(workspaceDirectory, "alpha", "dirt.txt"), "x");

    await expect(removeWorkspace({ config, taskId: TASK_ID })).rejects.toThrow(/alpha\/dirt\.txt/u);
  });

  it("removes an orphan directory under force only when the path matches the workspace shape", async () => {
    const orphan = workspacePath({ config, taskId: TASK_ID });
    fs.mkdirSync(orphan, { recursive: true });
    fs.writeFileSync(path.join(orphan, "leftover.txt"), "stale");

    const sibling = path.join(worktreesRoot({ config }), "unrelated-directory");
    fs.mkdirSync(sibling, { recursive: true });
    fs.writeFileSync(path.join(sibling, "keep.txt"), "keep");

    await removeWorkspace({ config, taskId: TASK_ID, force: true });

    expect(fs.existsSync(orphan)).toBe(false);
    expect(fs.existsSync(sibling)).toBe(true);
  });

  it("refuses to remove an orphan directory without force", async () => {
    const orphan = workspacePath({ config, taskId: TASK_ID });
    fs.mkdirSync(orphan, { recursive: true });

    await expect(removeWorkspace({ config, taskId: TASK_ID })).rejects.toBeInstanceOf(WorkspaceError);
    expect(fs.existsSync(orphan)).toBe(true);
  });

  it("discovers and removes a half-created worktree the marker never caught", async () => {
    const clone = await seedClone({ sandbox, name: "alpha" });
    const { workspaceDirectory } = await provisionWorkspace({ config, taskId: TASK_ID, repos: ["alpha"] });

    // A second repo acquired on disk but never written into the marker.
    await seedClone({ sandbox, name: "beta" });
    const { addWorktree } = await import("./git.js");
    await addWorktree({
      repoDirectory: path.join(sandbox.baseDirectory, "beta"),
      worktreePath: path.join(workspaceDirectory, "beta"),
      branch: BRANCH,
      startPoint: "origin/main",
    });

    await removeWorkspace({ config, taskId: TASK_ID, force: true });

    expect(fs.existsSync(workspaceDirectory)).toBe(false);
    expect(await localBranchExists({ repoDirectory: clone, branch: BRANCH })).toBe(false);
    expect(
      await localBranchExists({ repoDirectory: path.join(sandbox.baseDirectory, "beta"), branch: BRANCH }),
    ).toBe(false);
  });
});
