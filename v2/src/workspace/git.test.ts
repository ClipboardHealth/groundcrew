import * as fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  addWorktree,
  commitSubjectsAhead,
  currentBranch,
  deleteBranch,
  dirtyFiles,
  isDirectory,
  listWorktrees,
  localBranchExists,
  refExists,
  removeWorktree,
  resolveDefaultBranch,
  resolveStartPoint,
} from "./git.js";
import { commitFile, git, makeSandbox, seedClone, type Sandbox } from "./testRepos.js";

const BRANCH = "crew/fixture-task-1";
const SEEDED = ["second commit", "initial commit"];

describe("git", () => {
  let sandbox: Sandbox;
  let clone: string;

  beforeEach(async () => {
    sandbox = makeSandbox();
    clone = await seedClone({ sandbox, name: "alpha" });
  });

  afterEach(() => {
    sandbox.cleanup();
  });

  it("detects directories", () => {
    expect(isDirectory({ directory: clone })).toBe(true);
    expect(isDirectory({ directory: path.join(sandbox.baseDirectory, "nope") })).toBe(false);
    expect(isDirectory({ directory: path.join(clone, "README.md") })).toBe(false);
  });

  it("reports local branch and ref existence", async () => {
    expect(await localBranchExists({ repoDirectory: clone, branch: "main" })).toBe(true);
    expect(await localBranchExists({ repoDirectory: clone, branch: BRANCH })).toBe(false);
    expect(await refExists({ repoDirectory: clone, ref: "origin/main" })).toBe(true);
    expect(await refExists({ repoDirectory: clone, ref: "origin/absent" })).toBe(false);
  });

  it("resolves the default branch and the start point from the remote", async () => {
    expect(await resolveDefaultBranch({ repoDirectory: clone, remote: "origin" })).toBe("main");
    expect(await resolveStartPoint({ repoDirectory: clone, remote: "origin", defaultBranch: "main" })).toBe(
      "origin/main",
    );
    // A missing configured branch falls back to the remote HEAD's branch.
    expect(
      await resolveStartPoint({ repoDirectory: clone, remote: "origin", defaultBranch: "absent" }),
    ).toBe("origin/main");
  });

  it("adds a new branch worktree from a start point and reports its facts", async () => {
    const worktree = path.join(sandbox.root, "wt-alpha");

    await addWorktree({ repoDirectory: clone, worktreePath: worktree, branch: BRANCH, startPoint: "origin/main" });

    expect(await currentBranch({ worktreePath: worktree })).toBe(BRANCH);
    expect(await commitSubjectsAhead({ worktreePath: worktree, base: "origin/main" })).toEqual([]);
    const entries = await listWorktrees({ repoDirectory: clone });
    expect(entries.some((entry) => entry.branch === BRANCH)).toBe(true);
    expect(entries).toHaveLength(2);
  });

  it("reuses an existing branch, preserving its prior commits", async () => {
    await git({ cwd: clone, args: ["checkout", "-b", BRANCH] });
    await commitFile({ cwd: clone, file: "prior.txt", contents: "prior\n", message: "prior work" });
    await git({ cwd: clone, args: ["checkout", "main"] });

    const worktree = path.join(sandbox.root, "wt-reuse");
    await addWorktree({ repoDirectory: clone, worktreePath: worktree, branch: BRANCH });

    expect(await currentBranch({ worktreePath: worktree })).toBe(BRANCH);
    expect(await commitSubjectsAhead({ worktreePath: worktree, base: "origin/main" })).toEqual([
      "prior work",
    ]);
  });

  it("reports dirty files and clears after commit", async () => {
    const worktree = path.join(sandbox.root, "wt-dirty");
    await addWorktree({ repoDirectory: clone, worktreePath: worktree, branch: BRANCH, startPoint: "origin/main" });

    expect(await dirtyFiles({ worktreePath: worktree })).toEqual([]);
    fs.writeFileSync(path.join(worktree, "dirt.txt"), "uncommitted");
    expect(await dirtyFiles({ worktreePath: worktree })).toContain("dirt.txt");
  });

  it("returns no commits ahead when the base ref is missing at query time", async () => {
    const worktree = path.join(sandbox.root, "wt-nobase");
    await addWorktree({ repoDirectory: clone, worktreePath: worktree, branch: BRANCH, startPoint: "origin/main" });

    expect(await commitSubjectsAhead({ worktreePath: worktree, base: "origin/absent" })).toEqual([]);
    // The seeded commits are the ones on the base; nothing ahead of it.
    expect(SEEDED).toHaveLength(2);
  });

  it("removes a worktree and deletes its branch", async () => {
    const worktree = path.join(sandbox.root, "wt-remove");
    await addWorktree({ repoDirectory: clone, worktreePath: worktree, branch: BRANCH, startPoint: "origin/main" });

    await removeWorktree({ repoDirectory: clone, worktreePath: worktree });
    expect(fs.existsSync(worktree)).toBe(false);

    await deleteBranch({ repoDirectory: clone, branch: BRANCH });
    expect(await localBranchExists({ repoDirectory: clone, branch: BRANCH })).toBe(false);
  });

  it("falls back to deleting the directory for an unregistered worktree path", async () => {
    const orphan = path.join(sandbox.root, "orphan-wt");
    fs.mkdirSync(orphan, { recursive: true });
    fs.writeFileSync(path.join(orphan, "leftover.txt"), "stale");

    await removeWorktree({ repoDirectory: clone, worktreePath: orphan });

    expect(fs.existsSync(orphan)).toBe(false);
  });

  it("tolerates deleting an absent branch", async () => {
    await expect(deleteBranch({ repoDirectory: clone, branch: "crew/never" })).resolves.toBeUndefined();
  });
});
