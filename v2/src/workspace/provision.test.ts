import * as fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RepoNotOnDiskError } from "./errors.js";
import { currentBranch } from "./git.js";
import { readMarker } from "./marker.js";
import { acquireWorktree, provisionWorkspace } from "./provision.js";
import { markerFilePath, workspacePath, type WorkspaceConfig } from "./paths.js";
import { commitFile, git, makeSandbox, seedClone, type Sandbox } from "./testRepos.js";

const TASK_ID = "fixture:TASK-1";
const BRANCH = "crew/fixture-task-1";
const SEEDED = ["second commit", "initial commit"];

describe("provisionWorkspace", () => {
  let sandbox: Sandbox;
  let config: WorkspaceConfig;

  beforeEach(() => {
    sandbox = makeSandbox();
    config = { baseDirectory: sandbox.baseDirectory };
  });

  afterEach(() => {
    sandbox.cleanup();
  });

  it("provisions side-by-side worktrees on one branch and records them in the marker", async () => {
    await seedClone({ sandbox, name: "alpha" });
    await seedClone({ sandbox, name: "beta" });

    const result = await provisionWorkspace({ config, taskId: TASK_ID, repos: ["alpha", "beta"] });

    expect(result.branch).toBe(BRANCH);
    expect([...result.repos].toSorted()).toEqual(["alpha", "beta"]);

    const alpha = path.join(result.workspaceDirectory, "alpha");
    const beta = path.join(result.workspaceDirectory, "beta");
    expect(await currentBranch({ worktreePath: alpha })).toBe(BRANCH);
    expect(await currentBranch({ worktreePath: beta })).toBe(BRANCH);

    const marker = readMarker({ workspaceDirectory: result.workspaceDirectory });
    expect(marker?.repos).toEqual(["alpha", "beta"]);
    expect(marker?.branch).toBe(BRANCH);
  });

  it("creates an empty workspace (marker only) for an empty designation", async () => {
    const result = await provisionWorkspace({ config, taskId: TASK_ID });

    expect(result.repos).toEqual([]);
    expect(readMarker({ workspaceDirectory: result.workspaceDirectory })?.repos).toEqual([]);
    const entries = fs
      .readdirSync(result.workspaceDirectory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."));
    expect(entries).toEqual([]);
  });

  it("bails on a missing designated repo, provisioning nothing", async () => {
    await seedClone({ sandbox, name: "alpha" });

    await expect(
      provisionWorkspace({ config, taskId: TASK_ID, repos: ["alpha", "gamma"] }),
    ).rejects.toBeInstanceOf(RepoNotOnDiskError);

    // Not even the marker or the repo that does exist was created.
    expect(fs.existsSync(workspacePath({ config, taskId: TASK_ID }))).toBe(false);
    expect(fs.existsSync(markerFilePath({ workspaceDirectory: workspacePath({ config, taskId: TASK_ID }) }))).toBe(
      false,
    );
  });

  it("names the missing repo on the error", async () => {
    await expect(provisionWorkspace({ config, taskId: TASK_ID, repos: ["gamma"] })).rejects.toMatchObject({
      repo: "gamma",
      baseDirectory: sandbox.baseDirectory,
    });
  });
});

describe("acquireWorktree", () => {
  let sandbox: Sandbox;
  let config: WorkspaceConfig;

  beforeEach(async () => {
    sandbox = makeSandbox();
    config = {
      baseDirectory: sandbox.baseDirectory,
      repositories: { alpha: { prepareWorktree: "touch prepared-by-hook" } },
    };
    await provisionWorkspace({ config, taskId: TASK_ID });
  });

  afterEach(() => {
    sandbox.cleanup();
  });

  it("cuts a fresh worktree from origin/main and runs the prepare hook", async () => {
    await seedClone({ sandbox, name: "alpha" });

    const result = await acquireWorktree({ config, taskId: TASK_ID, repo: "alpha" });

    expect(result.reused).toBe(false);
    expect(result.branch).toBe(BRANCH);
    expect(await currentBranch({ worktreePath: result.worktreePath })).toBe(BRANCH);
    expect(fs.existsSync(path.join(result.worktreePath, "prepared-by-hook"))).toBe(true);

    const marker = readMarker({ workspaceDirectory: workspacePath({ config, taskId: TASK_ID }) });
    expect(marker?.repos).toEqual(["alpha"]);
  });

  it("reuses the prior branch and its commits (DISPATCH-08)", async () => {
    const clone = await seedClone({ sandbox, name: "alpha" });
    await git({ cwd: clone, args: ["checkout", "-b", BRANCH] });
    await commitFile({ cwd: clone, file: "prior.txt", contents: "prior\n", message: "prior work" });
    await git({ cwd: clone, args: ["checkout", "main"] });

    const result = await acquireWorktree({ config, taskId: TASK_ID, repo: "alpha" });

    const { commitSubjectsAhead } = await import("./git.js");
    expect(await commitSubjectsAhead({ worktreePath: result.worktreePath, base: "origin/main" })).toEqual([
      "prior work",
    ]);
    expect(SEEDED).toHaveLength(2);
  });

  it("throws RepoNotOnDiskError when the clone is absent", async () => {
    await expect(acquireWorktree({ config, taskId: TASK_ID, repo: "absent" })).rejects.toBeInstanceOf(
      RepoNotOnDiskError,
    );
  });

  it("is idempotent when the worktree already exists", async () => {
    await seedClone({ sandbox, name: "alpha" });
    await acquireWorktree({ config, taskId: TASK_ID, repo: "alpha" });

    const second = await acquireWorktree({ config, taskId: TASK_ID, repo: "alpha" });

    expect(second.reused).toBe(true);
    expect(readMarker({ workspaceDirectory: workspacePath({ config, taskId: TASK_ID }) })?.repos).toEqual([
      "alpha",
    ]);
  });
});
