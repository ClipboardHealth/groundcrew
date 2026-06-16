/**
 * Worktree lifecycle — manages host git worktrees for tasks.
 *
 * A worktree is a `git worktree add`'d directory at
 * `<worktreeDir>/<repo>-<TASK>/` (where `worktreeDir` defaults to
 * `projectDir`). The source repo it is cut from may live under a different
 * per-repo `projectDirOverride`. Callers go through the `worktrees` namespace;
 * the module owns creation, listing, removal, and teardown (workspace-close +
 * worktree-remove paired) so callers don't reach into git directly.
 */

import { type Dirent, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { userInfo } from "node:os";
import path from "node:path";

import { applySubstitutions } from "./adapters/shell/invoke.ts";
import { runCommandAsync } from "./commandRunner.ts";
import {
  type KnownRepository,
  type ResolvedConfig,
  repositoryBaseDir,
  worktreeBaseDir,
} from "./config.ts";
import { resolveDefaultBranch } from "./defaultBranch.ts";
import { assertPlainTaskId, isPlainTaskId } from "./taskId.ts";
import { debug, errorMessage, isVerbose } from "./util.ts";
import { hasAdoptedBranch } from "./worktreeRunState.ts";
import { type WorkspaceProbe, workspaces } from "./workspaces.ts";

const WORKTREE_LIST_PREFIX = "worktree ";

export type WorktreeKind = "host";

export class WorktreeAlreadyExistsError extends Error {
  public readonly dir: string;

  public constructor(dir: string) {
    super(`Worktree already exists: ${dir}`);
    this.dir = dir;
    this.name = "WorktreeAlreadyExistsError";
  }
}

export function isWorktreeAlreadyExistsError(error: unknown): error is WorktreeAlreadyExistsError {
  return error instanceof WorktreeAlreadyExistsError;
}

export interface WorktreeEntry {
  repository: string;
  /** Source task id, lowercased — e.g. "team-220" or "gc-20260608-001". */
  task: string;
  /** Slash-free `<prefix>-<task>`, except when `adoptedBranch` is true. */
  branchName: string;
  dir: string;
  kind: WorktreeKind;
  /**
   * True when `branchName` is a pre-existing branch groundcrew checked out but
   * did not create (e.g. an open PR via `crew open`). Such a branch must never
   * be deleted on teardown — doing so would destroy the user's local branch.
   */
  adoptedBranch?: boolean;
}

export interface WorktreeSpec {
  repository: string;
  task: string;
}

export interface WorktreeOpenSpec {
  repository: string;
  task: string;
  /** Existing branch to check out (the PR head), used verbatim. */
  branch: string;
}

function branchPrefix(config: ResolvedConfig): string {
  const fromConfig = config.git.branchPrefix;
  if (fromConfig !== undefined) {
    return fromConfig;
  }

  const name = userInfo().username;
  if (name.length === 0) {
    throw new Error("Could not determine OS username for the branch prefix.");
  }
  return name;
}

function branchNameForTask(config: ResolvedConfig, task: string): string {
  return `${branchPrefix(config)}-${task}`;
}

// Membership in knownRepositories is enforced by recipeFor (called first in
// basePaths), so this resolves the clone dir for a repo already known to exist
// in config and only guards against the clone being absent on disk.
function repoDirFor(config: ResolvedConfig, repository: string): string {
  const repoDir = path.resolve(repositoryBaseDir(config, repository), repository);
  if (!existsSync(repoDir)) {
    throw new Error(`Repository not found: ${repoDir}`);
  }
  return repoDir;
}

function recipeFor(config: ResolvedConfig, repository: string): KnownRepository {
  const recipe = config.workspace.repositories.find((entry) => entry.name === repository);
  if (recipe === undefined) {
    throw new Error(
      `Repository "${repository}" is not in workspace.knownRepositories: ${config.workspace.knownRepositories.join(", ")}`,
    );
  }
  return recipe;
}

/**
 * The directory the agent and its setup hooks actually run in. Equals the
 * worktree root unless the repo recipe sets a `workdir`, in which case it is
 * `<worktreeDir>/<workdir>` — a monorepo subproject inside a sparse checkout.
 * Pure path resolution; existence is enforced at create time by
 * assertWorkdirPresent.
 */
export function resolveLaunchDir(
  config: ResolvedConfig,
  repository: string,
  worktreeDir: string,
): string {
  const recipe = recipeFor(config, repository);
  return recipe.workdir === undefined ? worktreeDir : path.resolve(worktreeDir, recipe.workdir);
}

function assertWorkdirPresent(config: ResolvedConfig, entry: WorktreeEntry): void {
  const recipe = recipeFor(config, entry.repository);
  if (recipe.workdir === undefined) {
    return;
  }
  const launchDir = path.resolve(entry.dir, recipe.workdir);
  if (!existsSync(launchDir) || !statSync(launchDir).isDirectory()) {
    throw new Error(
      `Configured workdir "${recipe.workdir}" not found in worktree ${entry.dir}; the create template must produce it (looked for ${launchDir}).`,
    );
  }
}

function provisionerSubstitutions(
  config: ResolvedConfig,
  arguments_: { branchName: string; dir: string; task: string; repository: string },
): Record<string, string> {
  return {
    branch: arguments_.branchName,
    dir: arguments_.dir,
    baseRef: `${config.git.remote}/${config.git.defaultBranch}`,
    repo: arguments_.repository,
    task: arguments_.task,
  };
}

/**
 * Runs a provisioner template (`create`/`remove`) with no timeout. Mirrors
 * runLongGitCommand: under --verbose the child streams live; otherwise it is
 * captured and discarded on success (failures still carry stderr via the
 * thrown error).
 */
async function runLongShellCommand(
  command: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<void> {
  const signalOption = signal === undefined ? {} : { signal };
  if (isVerbose()) {
    await runCommandAsync("sh", ["-c", command], {
      cwd,
      stdio: "inherit",
      timeoutMs: 0,
      ...signalOption,
    });
    return;
  }
  await runCommandAsync("sh", ["-c", command], {
    cwd,
    stdio: "captured",
    timeoutMs: 0,
    ...signalOption,
  });
}

interface BasePaths {
  repoDir: string;
  task: string;
  branchName: string;
  hostWorktreeDir: string;
  hostWorktreeName: string;
}

function basePaths(config: ResolvedConfig, repository: string, task: string): BasePaths {
  // Tasks must match the same shape the worktree discovery regexes use,
  // so create()/list()/findByTask() agree on what's a valid worktree.
  // This also rejects traversal tokens before they reach path.resolve().
  assertPlainTaskId(task);

  const recipe = recipeFor(config, repository);
  // Scripted entries have no source clone — graft owns the checkout — so run
  // templates with cwd = the worktree root and never resolve a clone dir.
  const repoDir =
    recipe.provision === undefined
      ? repoDirFor(config, repository)
      : path.resolve(worktreeBaseDir(config));
  const hostWorktreeName = `${repository}-${task}`;
  const hostWorktreeDir = path.resolve(worktreeBaseDir(config), hostWorktreeName);

  return {
    repoDir,
    task,
    branchName: branchNameForTask(config, task),
    hostWorktreeDir,
    hostWorktreeName,
  };
}

function signalProperty(signal?: AbortSignal): { signal: AbortSignal } | Record<never, never> {
  return signal === undefined ? {} : { signal };
}

function parseWorktreeDirectoryName(
  directoryName: string,
  repositoryEntriesByLongestName: readonly (readonly [string, string])[],
): { repository: string; task: string } | undefined {
  // Match the longest repository basename first so overlapping names like
  // "repo-a" and "repo-a-admin" parse to the intended repository.
  for (const [repositoryBaseName, repository] of repositoryEntriesByLongestName) {
    const worktreePrefix = `${repositoryBaseName}-`;
    if (!directoryName.startsWith(worktreePrefix)) {
      continue;
    }
    const task = directoryName.slice(worktreePrefix.length);
    if (!isPlainTaskId(task)) {
      continue;
    }
    return { repository, task };
  }
  return undefined;
}

/**
 * Runs a long-running git command (fetch, worktree add/remove/prune) with no
 * timeout. Under --verbose the git porcelain streams live to the terminal;
 * otherwise it is captured and discarded on success — the bracketing debug()
 * lines record what ran, and a failure still carries git's stderr via the
 * thrown error (see normalizeCommandError in commandRunner.ts).
 */
async function runLongGitCommand(
  arguments_: readonly string[],
  signal?: AbortSignal,
): Promise<void> {
  const signalOption = signal === undefined ? {} : { signal };
  if (isVerbose()) {
    await runCommandAsync("git", arguments_, { stdio: "inherit", timeoutMs: 0, ...signalOption });
    return;
  }
  await runCommandAsync("git", arguments_, { stdio: "captured", timeoutMs: 0, ...signalOption });
}

async function deleteBranchBestEffort(arguments_: {
  cmd: string;
  cmdArgs: readonly string[];
  branchName: string;
  signal?: AbortSignal;
}): Promise<void> {
  try {
    await (arguments_.signal === undefined
      ? runCommandAsync(arguments_.cmd, arguments_.cmdArgs)
      : runCommandAsync(arguments_.cmd, arguments_.cmdArgs, { signal: arguments_.signal }));
    debug(`Deleted branch ${arguments_.branchName}`);
  } catch (error) {
    if (arguments_.signal?.aborted === true) {
      throw error;
    }
    debug(`Branch ${arguments_.branchName} cleanup skipped: ${errorMessage(error)}`);
  }
}

function hostWorktreeEntry(arguments_: {
  repository: string;
  task: string;
  branchName: string;
  dir: string;
  adoptedBranch?: boolean;
}): WorktreeEntry {
  return { ...arguments_, kind: "host" };
}

async function createWorktree(
  config: ResolvedConfig,
  spec: WorktreeSpec,
  signal?: AbortSignal,
): Promise<WorktreeEntry> {
  const base = basePaths(config, spec.repository, spec.task);
  const recipe = recipeFor(config, spec.repository);
  if (recipe.provision === undefined) {
    // A prior run can leave the `<prefix>-<task>` branch behind after its
    // worktree directory is gone — teardown deletes the branch only
    // best-effort, and operators sometimes remove the directory by hand.
    // Attaching the surviving branch reuses its work instead of crashing on
    // `git worktree add -b <existing branch>`.
    if (await localBranchExists(base.repoDir, base.branchName, signal)) {
      debug(
        `Branch ${base.branchName} already exists; attaching it to worktree ${spec.repository}-${spec.task}...`,
      );
      await runLongGitCommand(
        ["-C", base.repoDir, "worktree", "add", base.hostWorktreeDir, base.branchName],
        signal,
      );
    } else {
      const defaultBranch = await resolveDefaultBranch({
        repoDir: base.repoDir,
        remote: config.git.remote,
        fallback: config.git.defaultBranch,
        ...signalProperty(signal),
      });
      const baseRef = `${config.git.remote}/${defaultBranch}`;
      debug(`Fetching ${baseRef} in ${spec.repository}...`);
      await runLongGitCommand(
        ["-C", base.repoDir, "fetch", config.git.remote, defaultBranch],
        signal,
      );
      debug(
        `Creating worktree ${spec.repository}-${spec.task} (branch ${base.branchName} from ${baseRef})...`,
      );
      await runLongGitCommand(
        [
          "-C",
          base.repoDir,
          "worktree",
          "add",
          "-b",
          base.branchName,
          base.hostWorktreeDir,
          baseRef,
        ],
        signal,
      );
    }
  } else {
    const command = applySubstitutions(
      recipe.provision.create,
      provisionerSubstitutions(config, {
        branchName: base.branchName,
        dir: base.hostWorktreeDir,
        task: spec.task,
        repository: spec.repository,
      }),
    );
    debug(`Provisioning worktree ${spec.repository}-${spec.task} via create template...`);
    await runLongShellCommand(command, base.repoDir, signal);
  }
  return hostWorktreeEntry({
    repository: spec.repository,
    task: spec.task,
    branchName: base.branchName,
    dir: base.hostWorktreeDir,
  });
}

async function localBranchExists(
  repoDir: string,
  branch: string,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    await runCommandAsync(
      "git",
      ["-C", repoDir, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      signalProperty(signal),
    );
    return true;
  } catch (error) {
    if (signal?.aborted === true) {
      throw error;
    }
    // `show-ref --verify --quiet` exits non-zero when the ref is absent, which
    // runCommandAsync surfaces as a throw — that is the "branch not local"
    // signal, so any non-abort failure resolves to false.
    return false;
  }
}

/**
 * Check out an *existing* branch into a fresh worktree, for iterating on work
 * groundcrew did not create (e.g. an open PR). Unlike `createWorktree`, the
 * branch is not derived from the task id and is not cut from the default
 * branch: an already-local branch is checked out as-is, otherwise the branch is
 * fetched from the remote and a local tracking branch is created. The returned
 * entry's `branchName` is the real branch, which diverges from the
 * `<prefix>-<task>` convention and is persisted in RunState as the source of
 * truth.
 */
async function openWorktree(
  config: ResolvedConfig,
  spec: WorktreeOpenSpec,
  signal?: AbortSignal,
): Promise<WorktreeEntry> {
  const base = basePaths(config, spec.repository, spec.task);
  const recipe = recipeFor(config, spec.repository);
  if (recipe.provision !== undefined) {
    throw new Error(
      `crew open does not support provision/sparse-checkout repository "${spec.repository}".`,
    );
  }
  if (await localBranchExists(base.repoDir, spec.branch, signal)) {
    debug(
      `Adding worktree ${spec.repository}-${spec.task} for existing local branch ${spec.branch}...`,
    );
    await runLongGitCommand(
      ["-C", base.repoDir, "worktree", "add", base.hostWorktreeDir, spec.branch],
      signal,
    );
  } else {
    const { remote } = config.git;
    debug(`Fetching ${remote}/${spec.branch} in ${spec.repository}...`);
    await runLongGitCommand(["-C", base.repoDir, "fetch", remote, spec.branch], signal);
    await runLongGitCommand(
      [
        "-C",
        base.repoDir,
        "worktree",
        "add",
        "--track",
        "-b",
        spec.branch,
        base.hostWorktreeDir,
        `${remote}/${spec.branch}`,
      ],
      signal,
    );
  }
  return hostWorktreeEntry({
    repository: spec.repository,
    task: spec.task,
    branchName: spec.branch,
    dir: base.hostWorktreeDir,
    adoptedBranch: true,
  });
}

function listWorktrees(config: ResolvedConfig): WorktreeEntry[] {
  const worktreeRoot = path.resolve(worktreeBaseDir(config));
  const entries: WorktreeEntry[] = [];

  // Worktrees live at `worktreeRoot/<repository>-<task>`. When `repository`
  // contains a slash (e.g. "owner/repo"), `path.resolve()` nests one level
  // deeper, so the worktree path is `worktreeRoot/owner/repo-<task>`.
  // Scan each known repository's parent directory under the worktree root
  // rather than the root itself, so nested worktrees are discovered alongside
  // bare ones.
  const reposByParent = new Map<string, Map<string, string>>();
  for (const repository of config.workspace.knownRepositories) {
    const lastSlash = repository.lastIndexOf("/");
    const parentDir =
      lastSlash === -1 ? worktreeRoot : path.resolve(worktreeRoot, repository.slice(0, lastSlash));
    const basename = lastSlash === -1 ? repository : repository.slice(lastSlash + 1);
    let repoByBasename = reposByParent.get(parentDir);
    if (repoByBasename === undefined) {
      repoByBasename = new Map();
      reposByParent.set(parentDir, repoByBasename);
    }
    repoByBasename.set(basename, repository);
  }

  for (const [parentDir, repoByBasename] of reposByParent) {
    const repositoryEntriesByLongestName = [...repoByBasename.entries()].toSorted(
      ([nameA], [nameB]) => nameB.length - nameA.length,
    );
    let children: Dirent[];
    try {
      children = readdirSync(parentDir, { withFileTypes: true });
    } catch {
      children = [];
    }
    for (const entry of children) {
      if (!entry.isDirectory()) {
        continue;
      }
      const parsed = parseWorktreeDirectoryName(entry.name, repositoryEntriesByLongestName);
      if (parsed === undefined) {
        continue;
      }
      entries.push({
        repository: parsed.repository,
        task: parsed.task,
        branchName: branchNameForTask(config, parsed.task),
        dir: path.resolve(parentDir, entry.name),
        kind: "host",
      });
    }
  }

  return entries;
}

async function removeWorktree(
  config: ResolvedConfig,
  entry: WorktreeEntry,
  options: { force: boolean; signal?: AbortSignal },
): Promise<void> {
  const recipe = recipeFor(config, entry.repository);
  if (recipe.provision !== undefined) {
    await removeScriptedWorktree(config, entry, recipe.provision.remove, options);
    return;
  }
  const repoDir = path.resolve(repositoryBaseDir(config, entry.repository), entry.repository);

  if (existsSync(entry.dir)) {
    debug(`Removing worktree ${entry.dir}${options.force ? " (--force)" : ""}...`);
    const removeArguments = ["-C", repoDir, "worktree", "remove"];
    if (options.force) {
      removeArguments.push("--force");
    }
    removeArguments.push(entry.dir);
    try {
      await runLongGitCommand(removeArguments, options.signal);
    } catch (error) {
      // Under --verbose git's `fatal: ...` streams to the terminal rather than
      // the captured error, so the failure may surface as just "Exit status:
      // 128". Probe the worktree ourselves so the failure message names the
      // condition either way — dirty
      // (modified/untracked files, fixable with `crew cleanup --force`) or
      // orphan (directory exists on disk but is not registered with the
      // parent repo, fixable with `crew cleanup --force` when the path still
      // matches groundcrew's expected worktree location).
      if (options.signal?.aborted === true) {
        throw error;
      }
      if (options.force) {
        const registration = await probeWorktreeRegistration({
          repoDir,
          worktreeDir: entry.dir,
          ...signalProperty(options.signal),
        });
        if (registration !== "orphan") {
          throw error;
        }
        removeOrphanWorktreeDirectory(config, entry);
      } else {
        const dirtiness = await throwIfWorktreeDirty(entry, options.signal, error);
        if (dirtiness.kind === "unknown") {
          const registration = await probeWorktreeRegistration({
            repoDir,
            worktreeDir: entry.dir,
            ...signalProperty(options.signal),
          });
          if (registration === "orphan") {
            throw new Error(describeOrphanWorktree({ task: entry.task, dir: entry.dir }), {
              cause: error,
            });
          }
        }
        throw error;
      }
    }
  } else {
    debug(`Worktree directory ${entry.dir} not found, pruning stale refs...`);
    await runLongGitCommand(["-C", repoDir, "worktree", "prune"], options.signal);
  }
  if (hasAdoptedBranch({ config, entry })) {
    debug(`Preserving adopted branch ${entry.branchName} (not groundcrew-created).`);
    return;
  }
  await deleteBranchBestEffort({
    cmd: "git",
    cmdArgs: ["-C", repoDir, "branch", "-D", entry.branchName],
    branchName: entry.branchName,
    ...signalProperty(options.signal),
  });
}

async function removeScriptedWorktree(
  config: ResolvedConfig,
  entry: WorktreeEntry,
  removeTemplate: string,
  options: { force: boolean; signal?: AbortSignal },
): Promise<void> {
  const worktreeRoot = path.resolve(worktreeBaseDir(config));
  // A scripted worktree's teardown lives in the remove template (e.g. `graft rm`),
  // which owns provisioner-side branch/metadata beyond the checkout dir. Run it
  // even when the dir is already gone so that state is still cleaned up; only the
  // dirtiness guard — which needs the dir to inspect — is skipped in that case.
  const worktreeExists = existsSync(entry.dir);
  if (worktreeExists && !options.force) {
    // Keep the data-loss guard: a dirty worktree is not removed without --force.
    // Fail closed when the dirtiness probe can't confirm the worktree is clean,
    // so the remove template never runs over uncommitted work.
    const dirtiness = await throwIfWorktreeDirty(entry, options.signal);
    if (dirtiness.kind !== "clean") {
      throw new Error(
        `Could not verify ${entry.dir} is clean; rerun with --force after manual inspection.`,
      );
    }
  }
  const command = applySubstitutions(
    removeTemplate,
    provisionerSubstitutions(config, {
      branchName: entry.branchName,
      dir: entry.dir,
      task: entry.task,
      repository: entry.repository,
    }),
  );
  debug(`Removing worktree ${entry.dir} via remove template...`);
  await runLongShellCommand(command, worktreeRoot, options.signal);
}

export type WorktreeDirtiness =
  | { kind: "dirty"; modified: number; untracked: number }
  | { kind: "clean" }
  | { kind: "unknown" };

async function probeWorktreeDirtiness(
  worktreeDir: string,
  signal: AbortSignal | undefined,
): Promise<WorktreeDirtiness> {
  let output: string;
  try {
    output = await runCommandAsync(
      "git",
      ["-C", worktreeDir, "status", "--porcelain"],
      signalProperty(signal),
    );
  } catch {
    return { kind: "unknown" };
  }
  let modified = 0;
  let untracked = 0;
  for (const line of output.split("\n")) {
    if (line.length === 0) {
      continue;
    }
    if (line.startsWith("??")) {
      untracked += 1;
    } else {
      modified += 1;
    }
  }
  if (modified === 0 && untracked === 0) {
    return { kind: "clean" };
  }
  return { kind: "dirty", modified, untracked };
}

/**
 * Probe a worktree and, when it has uncommitted work, throw the data-loss guard
 * error. Returns the dirtiness so the git-native path can still branch on
 * `unknown`. `cause` chains the underlying git failure when called from a catch.
 */
async function throwIfWorktreeDirty(
  entry: WorktreeEntry,
  signal: AbortSignal | undefined,
  cause?: unknown,
): Promise<WorktreeDirtiness> {
  const dirtiness = await probeWorktreeDirtiness(entry.dir, signal);
  if (dirtiness.kind === "dirty") {
    const message = describeDirtyWorktree({
      task: entry.task,
      dir: entry.dir,
      modified: dirtiness.modified,
      untracked: dirtiness.untracked,
    });
    throw cause === undefined ? new Error(message) : new Error(message, { cause });
  }
  return dirtiness;
}

function describeDirtyWorktree(arguments_: {
  task: string;
  dir: string;
  modified: number;
  untracked: number;
}): string {
  const { task, dir, modified, untracked } = arguments_;
  const parts: string[] = [];
  if (modified > 0) {
    parts.push(`${modified} modified file${modified === 1 ? "" : "s"}`);
  }
  if (untracked > 0) {
    parts.push(`${untracked} untracked file${untracked === 1 ? "" : "s"}`);
  }
  const summary = parts.join(" and ");
  const pronoun = modified + untracked === 1 ? "it" : "them";
  return `worktree has ${summary}. Run \`crew cleanup --force ${task}\` to discard ${pronoun}, or commit/stash in ${dir} first.`;
}

type WorktreeRegistration = "registered" | "orphan" | "unknown";

async function probeWorktreeRegistration(arguments_: {
  repoDir: string;
  worktreeDir: string;
  signal?: AbortSignal;
}): Promise<WorktreeRegistration> {
  let output: string;
  try {
    output = await runCommandAsync(
      "git",
      ["-C", arguments_.repoDir, "worktree", "list", "--porcelain"],
      signalProperty(arguments_.signal),
    );
  } catch {
    return "unknown";
  }
  const resolvedWorktreeDir = path.resolve(arguments_.worktreeDir);
  for (const line of output.split("\n")) {
    if (!line.startsWith(WORKTREE_LIST_PREFIX)) {
      continue;
    }
    if (path.resolve(line.slice(WORKTREE_LIST_PREFIX.length)) === resolvedWorktreeDir) {
      return "registered";
    }
  }
  return "orphan";
}

function describeOrphanWorktree(arguments_: { task: string; dir: string }): string {
  const { task, dir } = arguments_;
  return `directory exists but is not a registered git worktree. Run \`crew cleanup --force ${task}\` to remove ${dir}, or inspect it first if it may contain valuable files.`;
}

function expectedHostWorktreeDir(config: ResolvedConfig, entry: WorktreeEntry): string {
  return path.resolve(worktreeBaseDir(config), `${entry.repository}-${entry.task}`);
}

function isInsideDirectory(parentDir: string, childDir: string): boolean {
  const childRelativePath = path.relative(parentDir, childDir);
  return (
    childRelativePath.length > 0 &&
    !childRelativePath.startsWith("..") &&
    !path.isAbsolute(childRelativePath)
  );
}

function removeOrphanWorktreeDirectory(config: ResolvedConfig, entry: WorktreeEntry): void {
  const worktreeRoot = path.resolve(worktreeBaseDir(config));
  const expectedDir = expectedHostWorktreeDir(config, entry);
  const targetDir = path.resolve(entry.dir);
  if (targetDir !== expectedDir || !isInsideDirectory(worktreeRoot, targetDir)) {
    throw new Error(
      `Refusing to force-delete ${entry.dir}: expected groundcrew worktree path ${expectedDir}.`,
    );
  }
  debug(`Removing orphaned worktree directory ${entry.dir} (--force)...`);
  rmSync(targetDir, { recursive: true, force: true });
}

function list(config: ResolvedConfig): WorktreeEntry[] {
  return listWorktrees(config);
}

function findByTask(config: ResolvedConfig, task: string): WorktreeEntry[] {
  return list(config).filter((entry) => entry.task === task);
}

// Shared by create() and open(): reject a duplicate worktree for the same
// task+repo before building, then assert the configured workdir materialized,
// rolling the worktree back if it did not. The build callback owns the git
// porcelain that differs between a fresh branch and an existing one.
async function provisionWorktree(
  config: ResolvedConfig,
  repository: string,
  task: string,
  build: () => Promise<WorktreeEntry>,
  signal?: AbortSignal,
): Promise<WorktreeEntry> {
  const existing = findByTask(config, task).find((entry) => entry.repository === repository);
  if (existing !== undefined) {
    throw new WorktreeAlreadyExistsError(existing.dir);
  }
  const entry = await build();
  try {
    assertWorkdirPresent(config, entry);
  } catch (error) {
    await removeWorktree(config, entry, { force: true, ...signalProperty(signal) });
    throw error;
  }
  return entry;
}

async function create(
  config: ResolvedConfig,
  spec: WorktreeSpec,
  signal?: AbortSignal,
): Promise<WorktreeEntry> {
  return await provisionWorktree(
    config,
    spec.repository,
    spec.task,
    async () => await createWorktree(config, spec, signal),
    signal,
  );
}

async function open(
  config: ResolvedConfig,
  spec: WorktreeOpenSpec,
  signal?: AbortSignal,
): Promise<WorktreeEntry> {
  return await provisionWorktree(
    config,
    spec.repository,
    spec.task,
    async () => await openWorktree(config, spec, signal),
    signal,
  );
}

async function remove(
  config: ResolvedConfig,
  entry: WorktreeEntry,
  options?: { force?: boolean; signal?: AbortSignal },
): Promise<void> {
  await removeWorktree(config, entry, {
    force: options?.force ?? false,
    ...signalProperty(options?.signal),
  });
}

export type TeardownStep = "workspace_close" | "worktree_remove";

export interface TeardownFailure {
  entry: WorktreeEntry;
  step: TeardownStep;
  error: unknown;
}

export interface TeardownResult {
  /** Tasks whose Workspace was closed (deduped per task). */
  closed: string[];
  /** Worktrees successfully removed. */
  removed: WorktreeEntry[];
  /** Per-entry failures; teardown continues past them. */
  failures: TeardownFailure[];
  workspaceProbe: WorkspaceProbe;
}

async function closeWorkspaceForTeardown(
  config: ResolvedConfig,
  task: string,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  const closeResult = await workspaces.close(config, task, signal);
  return closeResult.kind === "closed";
}

function shouldCloseWorkspaceForTeardown(
  task: string,
  workspaceProbe: WorkspaceProbe,
  liveNames: ReadonlySet<string>,
  closedTasks: ReadonlySet<string>,
): boolean {
  return !closedTasks.has(task) && (workspaceProbe.kind === "unavailable" || liveNames.has(task));
}

// A flaky cmux/tmux must not abort the batch — otherwise every on-disk
// worktree gets stranded. The probe verdict is captured on the result and
// removal proceeds with no live-workspace knowledge (so no close attempts).
async function teardown(
  config: ResolvedConfig,
  entries: readonly WorktreeEntry[],
  options?: { force?: boolean; signal?: AbortSignal },
): Promise<TeardownResult> {
  if (entries.length === 0) {
    return {
      closed: [],
      removed: [],
      failures: [],
      workspaceProbe: { kind: "ok", names: new Set<string>() },
    };
  }
  const force = options?.force ?? false;
  const workspaceProbe = await workspaces.probe(config, options?.signal);
  const liveNames = workspaceProbe.kind === "ok" ? workspaceProbe.names : new Set<string>();
  const closedTasks = new Set<string>();
  const result: TeardownResult = {
    closed: [],
    removed: [],
    failures: [],
    workspaceProbe,
  };

  for (const entry of entries) {
    if (shouldCloseWorkspaceForTeardown(entry.task, workspaceProbe, liveNames, closedTasks)) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- teardown is intentionally sequential per task
        const closed = await closeWorkspaceForTeardown(config, entry.task, options?.signal);
        if (closed) {
          result.closed.push(entry.task);
        }
      } catch (error) {
        if (options?.signal?.aborted === true) {
          throw error;
        }
        result.failures.push({ entry, step: "workspace_close", error });
      }
      closedTasks.add(entry.task);
    }
    try {
      // oxlint-disable-next-line no-await-in-loop -- one worktree at a time avoids racing on git
      await remove(config, entry, { force, ...signalProperty(options?.signal) });
      result.removed.push(entry);
    } catch (error) {
      if (options?.signal?.aborted === true) {
        throw error;
      }
      result.failures.push({ entry, step: "worktree_remove", error });
    }
  }

  return result;
}

async function probeWorkingTree(input: {
  worktreeDir: string;
  signal?: AbortSignal;
}): Promise<WorktreeDirtiness> {
  return await probeWorktreeDirtiness(input.worktreeDir, input.signal);
}

export const worktrees = {
  create,
  open,
  list,
  findByTask,
  remove,
  teardown,
  branchNameForTask,
  probeWorkingTree,
};
