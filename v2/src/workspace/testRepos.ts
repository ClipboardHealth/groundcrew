/**
 * Real temp-git-repo fixtures for the workspace unit tests. No mocks: every test
 * runs against actual `git` in an OS tmpdir, mirroring the e2e harness's
 * `gitFixtures`. Bare repos stand in for `origin`; working clones live under a
 * base directory, exactly the repo universe the workspace module resolves
 * against. Not imported by production code.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";

import { execa } from "execa";

const GIT_ENV: Readonly<Record<string, string>> = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

export interface Sandbox {
  readonly root: string;
  readonly baseDirectory: string;
  cleanup(): void;
}

/** A base directory (the repo universe) inside a throwaway tmpdir. */
export function makeSandbox(): Sandbox {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gc-ws-"));
  const baseDirectory = path.join(root, "dev");
  fs.mkdirSync(baseDirectory, { recursive: true });
  return {
    root,
    baseDirectory,
    cleanup(): void {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/**
 * Creates a bare `origin` seeded with two commits on `main` and a working clone
 * at `<baseDirectory>/<name>`. Returns the clone path.
 */
export async function seedClone(input: {
  readonly sandbox: Sandbox;
  readonly name: string;
}): Promise<string> {
  const { sandbox, name } = input;
  const remotes = path.join(sandbox.root, "remotes");
  fs.mkdirSync(remotes, { recursive: true });

  const seed = path.join(remotes, `.seed-${name}`);
  fs.mkdirSync(seed, { recursive: true });
  await git({ cwd: seed, args: ["init", "-b", "main"] });
  await commitFile({ cwd: seed, file: "README.md", contents: `# ${name}\n`, message: "initial commit" });
  await commitFile({ cwd: seed, file: "CHANGELOG.md", contents: "seeded\n", message: "second commit" });

  const bare = path.join(remotes, `${name}.git`);
  await git({ cwd: remotes, args: ["clone", "--bare", seed, bare] });
  fs.rmSync(seed, { recursive: true, force: true });

  const clone = path.join(sandbox.baseDirectory, name);
  await git({ cwd: sandbox.baseDirectory, args: ["clone", bare, clone] });
  return clone;
}

/** Stages and commits a file into a repo or worktree. */
export async function commitFile(input: {
  readonly cwd: string;
  readonly file: string;
  readonly contents: string;
  readonly message: string;
}): Promise<void> {
  const target = path.join(input.cwd, input.file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, input.contents);
  await git({ cwd: input.cwd, args: ["add", "-A"] });
  await git({ cwd: input.cwd, args: ["commit", "-m", input.message] });
}

/** Runs a git command in the fixture env; throws on nonzero exit. */
export async function git(input: {
  readonly cwd: string;
  readonly args: readonly string[];
}): Promise<string> {
  const result = await execa("git", [...input.args], {
    cwd: input.cwd,
    env: GIT_ENV,
    extendEnv: true,
    reject: false,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${input.args.join(" ")} failed in ${input.cwd}: ${result.stderr}`,
    );
  }

  return typeof result.stdout === "string" ? result.stdout : "";
}
