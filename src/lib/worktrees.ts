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

import { type Dirent, existsSync, readdirSync, rmSync } from "node:fs";
import { userInfo } from "node:os";
import path from "node:path";

import { runCommandAsync } from "./commandRunner.ts";
import { type ResolvedConfig, repositoryBaseDir, worktreeBaseDir } from "./config.ts";
import { resolveDefaultBranch } from "./defaultBranch.ts";
import { debug, errorMessage, isVerbose } from "./util.ts";
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
  /** Linear task id, lowercased — e.g. "team-220". */
  task: string;
  /** Slash-free `<prefix>-<task>`. */
  branchName: string;
  dir: string;
  kind: WorktreeKind;
}

export interface WorktreeSpec {
  repository: string;
  task: string;
}

const TASK_RE = /^[a-z][\da-z]*-\d+$/;
const TASK_DIR_RE = /^(?<repoBasename>.+)-(?<task>[a-z][\da-z]*-\d+)$/;

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

function repoDirFor(config: ResolvedConfig, repository: string): string {
  if (!config.workspace.knownRepositories.includes(repository)) {
    throw new Error(
      `Repository "${repository}" is not in workspace.knownRepositories: ${config.workspace.knownRepositories.join(", ")}`,
    );
  }
  const repoDir = path.resolve(repositoryBaseDir(config, repository), repository);
  if (!existsSync(repoDir)) {
    throw new Error(`Repository not found: ${repoDir}`);
  }
  return repoDir;
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
  if (!TASK_RE.test(task)) {
    throw new Error(`Invalid task "${task}": must be a plain task id`);
  }

  const repoDir = repoDirFor(config, repository);
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

async function createWorktree(
  config: ResolvedConfig,
  spec: WorktreeSpec,
  signal?: AbortSignal,
): Promise<WorktreeEntry> {
  const base = basePaths(config, spec.repository, spec.task);
  const defaultBranch = await resolveDefaultBranch({
    repoDir: base.repoDir,
    remote: config.git.remote,
    fallback: config.git.defaultBranch,
    ...signalProperty(signal),
  });
  const baseRef = `${config.git.remote}/${defaultBranch}`;
  debug(`Fetching ${baseRef} in ${spec.repository}...`);
  await runLongGitCommand(["-C", base.repoDir, "fetch", config.git.remote, defaultBranch], signal);
  debug(
    `Creating worktree ${spec.repository}-${spec.task} (branch ${base.branchName} from ${baseRef})...`,
  );
  await runLongGitCommand(
    ["-C", base.repoDir, "worktree", "add", "-b", base.branchName, base.hostWorktreeDir, baseRef],
    signal,
  );
  return {
    repository: spec.repository,
    task: spec.task,
    branchName: base.branchName,
    dir: base.hostWorktreeDir,
    kind: "host",
  };
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
      const match = TASK_DIR_RE.exec(entry.name);
      if (!match) {
        continue;
      }
      const [, repoBasename, task] = match;
      /* v8 ignore next 3 @preserve -- TASK_DIR_RE always captures both groups when it matches */
      if (repoBasename === undefined || task === undefined) {
        continue;
      }
      const repository = repoByBasename.get(repoBasename);
      if (repository === undefined) {
        continue;
      }
      entries.push({
        repository,
        task,
        branchName: branchNameForTask(config, task),
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
        const dirtiness = await probeWorktreeDirtiness(entry.dir, options.signal);
        if (dirtiness.kind === "dirty") {
          throw new Error(
            describeDirtyWorktree({
              task: entry.task,
              dir: entry.dir,
              modified: dirtiness.modified,
              untracked: dirtiness.untracked,
            }),
            { cause: error },
          );
        }
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
  await deleteBranchBestEffort({
    cmd: "git",
    cmdArgs: ["-C", repoDir, "branch", "-D", entry.branchName],
    branchName: entry.branchName,
    ...signalProperty(options.signal),
  });
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

async function create(
  config: ResolvedConfig,
  spec: WorktreeSpec,
  signal?: AbortSignal,
): Promise<WorktreeEntry> {
  const existing = findByTask(config, spec.task).find(
    (entry) => entry.repository === spec.repository,
  );
  if (existing !== undefined) {
    throw new WorktreeAlreadyExistsError(existing.dir);
  }
  return await createWorktree(config, spec, signal);
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
  list,
  findByTask,
  remove,
  teardown,
  branchNameForTask,
  probeWorkingTree,
};
