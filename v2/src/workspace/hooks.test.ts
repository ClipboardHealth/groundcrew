import * as fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PrepareWorktreeError } from "./errors.js";
import { resolvePrepareWorktreeCommand, runPrepareWorktree } from "./hooks.js";
import { makeSandbox, type Sandbox } from "./testRepos.js";

describe("hooks", () => {
  let sandbox: Sandbox;
  let worktreeDirectory: string;

  beforeEach(() => {
    sandbox = makeSandbox();
    worktreeDirectory = path.join(sandbox.root, "worktree");
    fs.mkdirSync(worktreeDirectory, { recursive: true });
  });

  afterEach(() => {
    sandbox.cleanup();
  });

  it("returns undefined when neither a committed nor a per-repo hook exists", () => {
    expect(resolvePrepareWorktreeCommand({ worktreeDirectory })).toBeUndefined();
  });

  it("uses the per-repo config hook when there is no committed override", () => {
    expect(resolvePrepareWorktreeCommand({ worktreeDirectory, perRepoHook: "npm ci" })).toBe("npm ci");
  });

  it("prefers a repo-committed .groundcrew/config.json hook over the per-repo hook", () => {
    writeCommittedHook({ worktreeDirectory, command: "make setup" });

    expect(resolvePrepareWorktreeCommand({ worktreeDirectory, perRepoHook: "npm ci" })).toBe(
      "make setup",
    );
  });

  it("falls back to the workspace default hook when no per-repo hook exists", () => {
    expect(resolvePrepareWorktreeCommand({ worktreeDirectory, defaultHook: "make setup" })).toBe(
      "make setup",
    );
  });

  it("prefers the per-repo hook over the workspace default hook", () => {
    expect(
      resolvePrepareWorktreeCommand({
        worktreeDirectory,
        perRepoHook: "npm ci",
        defaultHook: "make setup",
      }),
    ).toBe("npm ci");
  });

  it("prefers a committed hook over both the per-repo and default hooks", () => {
    writeCommittedHook({ worktreeDirectory, command: "make setup" });

    expect(
      resolvePrepareWorktreeCommand({
        worktreeDirectory,
        perRepoHook: "npm ci",
        defaultHook: "make bootstrap",
      }),
    ).toBe("make setup");
  });

  it("overlays workspace.environment onto the hook process env", async () => {
    await runPrepareWorktree({
      worktreeDirectory,
      repo: "alpha",
      defaultHook: 'printf %s "$MY_HOOK_VAR" > hook-env.txt',
      environment: { MY_HOOK_VAR: "from-workspace" },
    });

    expect(fs.readFileSync(path.join(worktreeDirectory, "hook-env.txt"), "utf8")).toBe(
      "from-workspace",
    );
  });

  it("rejects a malformed committed config", () => {
    fs.mkdirSync(path.join(worktreeDirectory, ".groundcrew"), { recursive: true });
    fs.writeFileSync(
      path.join(worktreeDirectory, ".groundcrew", "config.json"),
      JSON.stringify({ version: 2 }),
    );

    expect(() => resolvePrepareWorktreeCommand({ worktreeDirectory })).toThrow(/version must be 1/u);
  });

  it("runs the hook at the worktree root", async () => {
    await runPrepareWorktree({
      worktreeDirectory,
      repo: "alpha",
      perRepoHook: "touch prepared-by-hook",
    });

    expect(fs.existsSync(path.join(worktreeDirectory, "prepared-by-hook"))).toBe(true);
  });

  it("is a no-op when no hook applies", async () => {
    await expect(runPrepareWorktree({ worktreeDirectory, repo: "alpha" })).resolves.toBeUndefined();
  });

  it("throws PrepareWorktreeError on a nonzero hook exit", async () => {
    await expect(
      runPrepareWorktree({ worktreeDirectory, repo: "alpha", perRepoHook: "exit 3" }),
    ).rejects.toBeInstanceOf(PrepareWorktreeError);
  });
});

function writeCommittedHook(input: { readonly worktreeDirectory: string; readonly command: string }): void {
  const dir = path.join(input.worktreeDirectory, ".groundcrew");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "config.json"),
    JSON.stringify({ version: 1, hooks: { prepareWorktree: input.command } }),
  );
}
