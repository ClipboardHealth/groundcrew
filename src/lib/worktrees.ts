/**
 * Worktree lifecycle — manages host git worktrees for tickets.
 *
 * A worktree is a `git worktree add`'d sibling at
 * `<projectDir>/<repo>-<TICKET>/`. Callers go through the `worktrees`
 * namespace; the module owns creation, listing, removal, and teardown
 * (workspace-close + worktree-remove paired) so callers don't reach into
 * git directly.
 */

import { type Dirent, existsSync, readdirSync } from "node:fs";
import { userInfo } from "node:os";
import { resolve } from "node:path";

import { runCommandAsync, type RunCommandOptions } from "./commandRunner.ts";
import type { ResolvedConfig } from "./config.ts";
import { errorMessage, log } from "./util.ts";
import { type WorkspaceProbe, workspaces } from "./workspaces.ts";

const LONG_RUNNING_COMMAND_OPTIONS = { stdio: "inherit", timeoutMs: 0 } as const;

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
  /** Linear ticket id, lowercased — e.g. "team-220". */
  ticket: string;
  /** Lowercase, slash-free `<user>-<ticket>`. */
  branchName: string;
  dir: string;
  kind: WorktreeKind;
}

export interface WorktreeSpec {
  repository: string;
  ticket: string;
}

const TICKET_RE = /^[a-z][\da-z]*-\d+$/;
const TICKET_DIR_RE = /^(.+)-([a-z][\da-z]*-\d+)$/;

function branchPrefix(): string {
  const name = userInfo().username;
  if (name.length === 0) {
    throw new Error("Could not determine OS username for the branch prefix.");
  }
  return name;
}

function branchNameForTicket(ticket: string): string {
  return `${branchPrefix()}-${ticket}`;
}

function repoDirFor(config: ResolvedConfig, repository: string): string {
  if (!config.workspace.knownRepositories.includes(repository)) {
    throw new Error(
      `Repository "${repository}" is not in workspace.knownRepositories: ${config.workspace.knownRepositories.join(", ")}`,
    );
  }
  const repoDir = resolve(config.workspace.projectDir, repository);
  if (!existsSync(repoDir)) {
    throw new Error(`Repository not found: ${repoDir}`);
  }
  return repoDir;
}

interface BasePaths {
  projectDir: string;
  repoDir: string;
  ticket: string;
  branchName: string;
  hostWorktreeDir: string;
  hostWorktreeName: string;
}

function basePaths(config: ResolvedConfig, repository: string, ticket: string): BasePaths {
  // Tickets must match the same shape the worktree discovery regexes use,
  // so create()/list()/findByTicket() agree on what's a valid worktree.
  // This also rejects traversal tokens before they reach resolve().
  if (!TICKET_RE.test(ticket)) {
    throw new Error(`Invalid ticket "${ticket}": must be a plain ticket id`);
  }

  const projectDir = resolve(config.workspace.projectDir);
  const repoDir = repoDirFor(config, repository);
  const hostWorktreeName = `${repository}-${ticket}`;
  const hostWorktreeDir = resolve(projectDir, hostWorktreeName);

  return {
    projectDir,
    repoDir,
    ticket,
    branchName: branchNameForTicket(ticket),
    hostWorktreeDir,
    hostWorktreeName,
  };
}

function signalProperty(signal?: AbortSignal): { signal: AbortSignal } | Record<never, never> {
  return signal === undefined ? {} : { signal };
}

function longRunningCommandOptions(signal?: AbortSignal): RunCommandOptions & { stdio: "inherit" } {
  return signal === undefined
    ? LONG_RUNNING_COMMAND_OPTIONS
    : { ...LONG_RUNNING_COMMAND_OPTIONS, signal };
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
    log(`Deleted branch ${arguments_.branchName}`);
  } catch (error) {
    if (arguments_.signal?.aborted === true) {
      throw error;
    }
    log(`Branch ${arguments_.branchName} cleanup skipped: ${errorMessage(error)}`);
  }
}

async function createWorktree(
  config: ResolvedConfig,
  spec: WorktreeSpec,
  signal?: AbortSignal,
): Promise<WorktreeEntry> {
  const base = basePaths(config, spec.repository, spec.ticket);
  const baseRef = `${config.git.remote}/${config.git.defaultBranch}`;
  log(`Fetching ${baseRef} in ${spec.repository}...`);
  await runCommandAsync(
    "git",
    ["-C", base.repoDir, "fetch", config.git.remote, config.git.defaultBranch],
    longRunningCommandOptions(signal),
  );
  log(
    `Creating worktree ${spec.repository}-${spec.ticket} (branch ${base.branchName} from ${baseRef})...`,
  );
  await runCommandAsync(
    "git",
    ["-C", base.repoDir, "worktree", "add", "-b", base.branchName, base.hostWorktreeDir, baseRef],
    longRunningCommandOptions(signal),
  );
  return {
    repository: spec.repository,
    ticket: spec.ticket,
    branchName: base.branchName,
    dir: base.hostWorktreeDir,
    kind: "host",
  };
}

function listWorktrees(config: ResolvedConfig): WorktreeEntry[] {
  const projectDir = resolve(config.workspace.projectDir);
  const entries: WorktreeEntry[] = [];

  // Worktrees live at `projectDir/<repository>-<ticket>`. When `repository`
  // contains a slash (e.g. "owner/repo"), `resolve()` nests one level
  // deeper, so the worktree path is `projectDir/owner/repo-<ticket>`.
  // Scan each known repository's parent directory rather than the project
  // root, so nested worktrees are discovered alongside bare ones.
  const reposByParent = new Map<string, Map<string, string>>();
  for (const repository of config.workspace.knownRepositories) {
    const lastSlash = repository.lastIndexOf("/");
    const parentDir =
      lastSlash === -1 ? projectDir : resolve(projectDir, repository.slice(0, lastSlash));
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
      const match = TICKET_DIR_RE.exec(entry.name);
      if (!match) {
        continue;
      }
      const [, repoBasename, ticket] = match;
      /* v8 ignore next 3 @preserve -- TICKET_DIR_RE always captures both groups when it matches */
      if (repoBasename === undefined || ticket === undefined) {
        continue;
      }
      const repository = repoByBasename.get(repoBasename);
      if (repository === undefined) {
        continue;
      }
      entries.push({
        repository,
        ticket,
        branchName: branchNameForTicket(ticket),
        dir: resolve(parentDir, entry.name),
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
  const projectDir = resolve(config.workspace.projectDir);
  const repoDir = resolve(projectDir, entry.repository);

  if (existsSync(entry.dir)) {
    log(`Removing worktree ${entry.dir}${options.force ? " (--force)" : ""}...`);
    const removeArguments = ["-C", repoDir, "worktree", "remove"];
    if (options.force) {
      removeArguments.push("--force");
    }
    removeArguments.push(entry.dir);
    try {
      await runCommandAsync("git", removeArguments, longRunningCommandOptions(options.signal));
    } catch (error) {
      // git's `fatal: ... use --force to delete it` line goes to inherited
      // stderr, so the captured error is just "Exit status: 128". Probe the
      // worktree ourselves so the failure message explains the condition
      // (modified/untracked files) and points at `crew cleanup --force`.
      if (options.force || options.signal?.aborted === true) {
        throw error;
      }
      const dirtiness = await probeWorktreeDirtiness(entry.dir, options.signal);
      if (dirtiness.kind !== "dirty") {
        throw error;
      }
      throw new Error(
        describeDirtyWorktree({
          ticket: entry.ticket,
          dir: entry.dir,
          modified: dirtiness.modified,
          untracked: dirtiness.untracked,
        }),
        { cause: error },
      );
    }
  } else {
    log(`Worktree directory ${entry.dir} not found, pruning stale refs...`);
    await runCommandAsync(
      "git",
      ["-C", repoDir, "worktree", "prune"],
      longRunningCommandOptions(options.signal),
    );
  }
  await deleteBranchBestEffort({
    cmd: "git",
    cmdArgs: ["-C", repoDir, "branch", "-D", entry.branchName],
    branchName: entry.branchName,
    ...signalProperty(options.signal),
  });
}

type WorktreeDirtiness =
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
  ticket: string;
  dir: string;
  modified: number;
  untracked: number;
}): string {
  const { ticket, dir, modified, untracked } = arguments_;
  const parts: string[] = [];
  if (modified > 0) {
    parts.push(`${modified} modified file${modified === 1 ? "" : "s"}`);
  }
  if (untracked > 0) {
    parts.push(`${untracked} untracked file${untracked === 1 ? "" : "s"}`);
  }
  const summary = parts.join(" and ");
  const pronoun = modified + untracked === 1 ? "it" : "them";
  return `worktree has ${summary}. Run \`crew cleanup --force ${ticket}\` to discard ${pronoun}, or commit/stash in ${dir} first.`;
}

function list(config: ResolvedConfig): WorktreeEntry[] {
  return listWorktrees(config);
}

function findByTicket(config: ResolvedConfig, ticket: string): WorktreeEntry[] {
  return list(config).filter((entry) => entry.ticket === ticket);
}

async function create(
  config: ResolvedConfig,
  spec: WorktreeSpec,
  signal?: AbortSignal,
): Promise<WorktreeEntry> {
  const existing = findByTicket(config, spec.ticket).find(
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
  /** Tickets whose Workspace was closed (deduped per ticket). */
  closed: string[];
  /** Worktrees successfully removed. */
  removed: WorktreeEntry[];
  /** Per-entry failures; teardown continues past them. */
  failures: TeardownFailure[];
  workspaceProbe: WorkspaceProbe;
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
  const closedTickets = new Set<string>();
  const result: TeardownResult = {
    closed: [],
    removed: [],
    failures: [],
    workspaceProbe,
  };

  for (const entry of entries) {
    if (
      !closedTickets.has(entry.ticket) &&
      (workspaceProbe.kind === "unavailable" || liveNames.has(entry.ticket))
    ) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- teardown is intentionally sequential per ticket
        await workspaces.close(config, entry.ticket, options?.signal);
        result.closed.push(entry.ticket);
      } catch (error) {
        if (options?.signal?.aborted === true) {
          throw error;
        }
        result.failures.push({ entry, step: "workspace_close", error });
      }
      closedTickets.add(entry.ticket);
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

export const worktrees = {
  create,
  list,
  findByTicket,
  remove,
  teardown,
};
