/**
 * Git fixtures and read-only git observation (catalog §1.4 "Git remotes").
 *
 * Real git throughout: scenarios get local bare repos exposed as `file://`
 * remotes with `origin/main` seeded, plus working clones under the scenario's
 * base directory (the repo universe `crew` resolves against). The observation
 * helpers read worktrees, branches, commits, and dirty state back out of any
 * repo or worktree so scenarios can assert on git facts (the observed layer).
 */

import * as fs from "node:fs";
import path from "node:path";

import { run } from "./exec.js";
import type { Scenario } from "./scenario.js";

export interface WorktreeEntry {
  readonly path: string;
  readonly head?: string;
  readonly branch?: string;
}

/**
 * Creates a bare repo under the scenario's remotes directory, seeded with a
 * couple of commits on `main`, and returns its `file://` URL. This is the
 * upstream `origin` working clones are cut from.
 */
export async function createBareRepo(input: {
  readonly scenario: Scenario;
  readonly name: string;
}): Promise<string> {
  const { scenario, name } = input;
  const bareDirectory = path.join(scenario.remotesDirectory, `${name}.git`);
  const seedDirectory = path.join(scenario.remotesDirectory, `.seed-${name}`);

  fs.mkdirSync(seedDirectory, { recursive: true });
  await git({ scenario, cwd: seedDirectory, args: ["init", "-b", "main"] });

  await writeAndCommit({
    scenario,
    repoDirectory: seedDirectory,
    files: { "README.md": `# ${name}\n` },
    message: "initial commit",
  });
  await writeAndCommit({
    scenario,
    repoDirectory: seedDirectory,
    files: { "CHANGELOG.md": "seeded\n" },
    message: "second commit",
  });

  await git({
    scenario,
    cwd: scenario.remotesDirectory,
    args: ["clone", "--bare", seedDirectory, bareDirectory],
  });
  fs.rmSync(seedDirectory, { recursive: true, force: true });

  return `file://${bareDirectory}`;
}

/**
 * Clones a bare repo into the scenario base directory as `<baseDirectory>/<name>`
 * — a working clone with an `origin` remote and `origin/main`. Returns its path.
 */
export async function createClone(input: {
  readonly scenario: Scenario;
  readonly name: string;
  readonly remoteUrl: string;
}): Promise<string> {
  const { scenario, name, remoteUrl } = input;
  const destination = path.join(scenario.baseDirectory, name);
  await git({
    scenario,
    cwd: scenario.baseDirectory,
    args: ["clone", remoteUrl, destination],
  });
  return destination;
}

/**
 * Convenience: creates a bare repo and a working clone in one call, returning
 * both paths. The common single-repo scenario setup.
 */
export async function createRepo(input: {
  readonly scenario: Scenario;
  readonly name: string;
}): Promise<{ readonly remoteUrl: string; readonly clonePath: string }> {
  const remoteUrl = await createBareRepo(input);
  const clonePath = await createClone({ ...input, remoteUrl });
  return { remoteUrl, clonePath };
}

/** Stages the given files, writes them, and commits. Total: throws on git failure. */
export async function writeAndCommit(input: {
  readonly scenario: Scenario;
  readonly repoDirectory: string;
  readonly files: Readonly<Record<string, string>>;
  readonly message: string;
}): Promise<void> {
  const { scenario, repoDirectory, files, message } = input;
  for (const [relativePath, contents] of Object.entries(files)) {
    const target = path.join(repoDirectory, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }

  await git({ scenario, cwd: repoDirectory, args: ["add", "-A"] });
  await git({ scenario, cwd: repoDirectory, args: ["commit", "-m", message] });
}

/** Parses `git worktree list --porcelain` for the given repo. */
export async function worktreeList(input: {
  readonly scenario: Scenario;
  readonly repoDirectory: string;
}): Promise<WorktreeEntry[]> {
  const { stdout } = await git({
    scenario: input.scenario,
    cwd: input.repoDirectory,
    args: ["worktree", "list", "--porcelain"],
  });

  const entries: WorktreeEntry[] = [];
  let current: { path?: string; head?: string; branch?: string } = {};
  for (const line of stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length) };
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//u, "");
    } else if (line.trim() === "" && current.path !== undefined) {
      entries.push(toEntry(current));
      current = {};
    }
  }

  if (current.path !== undefined) {
    entries.push(toEntry(current));
  }

  return entries;
}

/** True when a local branch exists in the repo. */
export async function branchExists(input: {
  readonly scenario: Scenario;
  readonly repoDirectory: string;
  readonly branch: string;
}): Promise<boolean> {
  const result = await run({
    command: "git",
    args: ["rev-parse", "--verify", "--quiet", `refs/heads/${input.branch}`],
    cwd: input.repoDirectory,
    env: input.scenario.env,
  });
  return result.exitCode === 0;
}

/** Commit subject lines for `ref` (default HEAD), newest first. */
export async function commitSubjects(input: {
  readonly scenario: Scenario;
  readonly repoDirectory: string;
  readonly ref?: string;
}): Promise<string[]> {
  const { stdout } = await git({
    scenario: input.scenario,
    cwd: input.repoDirectory,
    args: ["log", "--format=%s", input.ref ?? "HEAD"],
  });
  return stdout.split("\n").filter((line) => line.trim() !== "");
}

/** True when the repo/worktree has uncommitted changes. */
export async function isDirty(input: {
  readonly scenario: Scenario;
  readonly repoDirectory: string;
}): Promise<boolean> {
  const { stdout } = await git({
    scenario: input.scenario,
    cwd: input.repoDirectory,
    args: ["status", "--porcelain"],
  });
  return stdout.trim() !== "";
}

/** The short name of the currently checked-out branch. */
export async function currentBranch(input: {
  readonly scenario: Scenario;
  readonly repoDirectory: string;
}): Promise<string> {
  const { stdout } = await git({
    scenario: input.scenario,
    cwd: input.repoDirectory,
    args: ["rev-parse", "--abbrev-ref", "HEAD"],
  });
  return stdout.trim();
}

function toEntry(current: {
  readonly path?: string;
  readonly head?: string;
  readonly branch?: string;
}): WorktreeEntry {
  if (current.path === undefined) {
    throw new Error("worktree entry is missing its path");
  }

  return {
    path: current.path,
    ...(current.head === undefined ? {} : { head: current.head }),
    ...(current.branch === undefined ? {} : { branch: current.branch }),
  };
}

async function git(input: {
  readonly scenario: Scenario;
  readonly cwd: string;
  readonly args: readonly string[];
}): Promise<{ stdout: string; stderr: string }> {
  const result = await run({
    command: "git",
    args: input.args,
    cwd: input.cwd,
    env: input.scenario.env,
  });

  if (result.exitCode !== 0) {
    throw new Error(
      `git ${input.args.join(" ")} failed (exit ${String(result.exitCode)}) in ${input.cwd}: ${result.stderr.trim()}`,
    );
  }

  return { stdout: result.stdout, stderr: result.stderr };
}
