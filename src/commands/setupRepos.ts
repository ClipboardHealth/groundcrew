/**
 * `crew setup repos` — clone every entry of `workspace.knownRepositories`
 * that does not already exist under `workspace.projectDir`. Entries
 * shaped `<owner>/<repo>` are cloned via `gh repo clone`; bare-name
 * entries are skipped with a hint, because they have no canonical URL
 * we can guess at without involving the user's gh login. Idempotent.
 */

import { opendirSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import { runCommandAsync } from "../lib/commandRunner.ts";
import { loadConfig, type ResolvedConfig } from "../lib/config.ts";
import { which } from "../lib/host.ts";
import { errorMessage, log, writeOutput } from "../lib/util.ts";

export interface SetupReposOptions {
  /** Print the plan without running any clone. */
  dryRun?: boolean;
  /**
   * Restrict the action to this subset of `knownRepositories`. Each entry
   * must match an entry in the config or the call rejects before any side
   * effect.
   */
  only?: readonly string[];
}

export type SetupReposSkipKind = "bare-name" | "invalid-repository" | "invalid-target";

export interface SetupReposSkip {
  repo: string;
  kind: SetupReposSkipKind;
  reason: string;
}

export interface SetupReposResult {
  /** Entries already present under `projectDir`. */
  existing: string[];
  /** Entries that would be cloned in dry-run mode. */
  planned: string[];
  /** Entries successfully cloned this run. */
  cloned: string[];
  /** Entries skipped with a reason (e.g. bare names, invalid targets). */
  skipped: SetupReposSkip[];
  /** Entries that failed during clone. */
  failed: { repo: string; error: Error }[];
  /** True when `gh` is missing and at least one clone was needed. */
  ghMissing: boolean;
}

interface ClonePlan {
  toClone: string[];
  existing: string[];
  skipped: SetupReposSkip[];
}

type ExistingTargetPlan = "clone" | "existing" | "skip-invalid";
type RepositoryEntryPlan = "clone" | "bare-name" | "invalid-repository";

function emptyResult(): SetupReposResult {
  return {
    existing: [],
    planned: [],
    cloned: [],
    skipped: [],
    failed: [],
    ghMissing: false,
  };
}

function selectRepositories(
  config: ResolvedConfig,
  only: readonly string[] | undefined,
): readonly string[] {
  if (only === undefined) {
    return config.workspace.knownRepositories;
  }
  const known = new Set(config.workspace.knownRepositories);
  const unknown = only.filter((entry) => !known.has(entry));
  if (unknown.length > 0) {
    throw new Error(
      `Repositories not in workspace.knownRepositories: ${unknown.join(", ")}. Known: ${config.workspace.knownRepositories.join(", ")}`,
    );
  }
  return only;
}

function pathExists(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false }) !== undefined;
}

function isDirectoryEmpty(path: string): boolean {
  const directory = opendirSync(path);
  try {
    return directory.readSync() === null;
  } finally {
    directory.closeSync();
  }
}

function existingTargetPlan(target: string): ExistingTargetPlan {
  const stats = statSync(target, { throwIfNoEntry: false });
  if (stats === undefined) {
    return "clone";
  }
  if (!stats.isDirectory()) {
    return "skip-invalid";
  }
  if (pathExists(resolve(target, ".git"))) {
    return "existing";
  }
  return isDirectoryEmpty(target) ? "clone" : "skip-invalid";
}

function isInsideProjectDir(projectDir: string, target: string): boolean {
  const relativeTarget = relative(projectDir, target);
  return (
    relativeTarget.length > 0 && !relativeTarget.startsWith("..") && !isAbsolute(relativeTarget)
  );
}

function repositoryEntryPlan(repo: string): RepositoryEntryPlan {
  const parts = repo.split("/");
  if (parts.length === 1) {
    return "bare-name";
  }
  if (parts.length === 2 && parts.every((part) => part.length > 0)) {
    return "clone";
  }
  return "invalid-repository";
}

function bareNameSkip(repo: string, target: string): SetupReposSkip {
  return {
    repo,
    kind: "bare-name",
    reason: `bare name needs owner/ prefix to auto-clone; clone manually into ${target}`,
  };
}

function invalidTargetSkip(repo: string, target: string): SetupReposSkip {
  return {
    repo,
    kind: "invalid-target",
    reason: `target exists but is not a git repository or empty directory: ${target}`,
  };
}

function invalidRepositorySkip(repo: string, target: string): SetupReposSkip {
  return {
    repo,
    kind: "invalid-repository",
    reason: `repository must be owner/repo to auto-clone; clone manually into ${target}`,
  };
}

function escapingTargetSkip(repo: string, projectDir: string, target: string): SetupReposSkip {
  return {
    repo,
    kind: "invalid-repository",
    reason: `repository resolves outside workspace.projectDir (${projectDir}): ${target}`,
  };
}

function planClones(config: ResolvedConfig, repositories: readonly string[]): ClonePlan {
  const projectDir = resolve(config.workspace.projectDir);
  const toClone: string[] = [];
  const existing: string[] = [];
  const skipped: SetupReposSkip[] = [];
  const seen = new Set<string>();

  for (const entry of repositories) {
    if (seen.has(entry)) {
      continue;
    }
    seen.add(entry);
    const target = resolve(projectDir, entry);
    if (!isInsideProjectDir(projectDir, target)) {
      skipped.push(escapingTargetSkip(entry, projectDir, target));
      continue;
    }
    const targetPlan = existingTargetPlan(target);
    if (targetPlan === "existing") {
      existing.push(entry);
      continue;
    }
    if (targetPlan === "skip-invalid") {
      skipped.push(invalidTargetSkip(entry, target));
      continue;
    }
    const repositoryPlan = repositoryEntryPlan(entry);
    if (repositoryPlan === "bare-name") {
      skipped.push(bareNameSkip(entry, target));
      continue;
    }
    if (repositoryPlan === "invalid-repository") {
      skipped.push(invalidRepositorySkip(entry, target));
      continue;
    }
    toClone.push(entry);
  }

  return { toClone, existing, skipped };
}

export async function setupRepos(
  config: ResolvedConfig,
  options: SetupReposOptions,
): Promise<SetupReposResult> {
  const repositories = selectRepositories(config, options.only);
  const plan = planClones(config, repositories);
  const result = emptyResult();
  result.existing = plan.existing;
  result.skipped = plan.skipped;

  for (const entry of plan.existing) {
    log(`[exists] ${entry}`);
  }
  for (const { repo, reason } of plan.skipped) {
    log(`[skip] ${repo} — ${reason}`);
  }

  if (options.dryRun === true) {
    result.planned = plan.toClone;
    for (const entry of plan.toClone) {
      log(`[dry-run] would clone ${entry}`);
    }
    return result;
  }

  if (plan.toClone.length === 0) {
    return result;
  }

  const ghPath = await which("gh");
  if (ghPath === undefined) {
    result.ghMissing = true;
    writeOutput(
      "gh CLI not found - install GitHub CLI from https://cli.github.com/ (or clone the missing repos manually).",
    );
    return result;
  }

  const projectDir = resolve(config.workspace.projectDir);
  // Sequential on purpose: each `gh repo clone` inherits stdio for progress
  // bars and auth prompts. Parallel clones would interleave output and make
  // any interactive 2FA prompt unanswerable.
  for (const entry of plan.toClone) {
    const target = resolve(projectDir, entry);
    log(`[clone] ${entry} → ${target}`);
    try {
      // oxlint-disable-next-line no-await-in-loop -- see comment above
      await runCommandAsync("gh", ["repo", "clone", entry, target], {
        stdio: "inherit",
        timeoutMs: 0,
      });
      result.cloned.push(entry);
    } catch (error) {
      const wrapped = error instanceof Error ? error : new Error(errorMessage(error));
      log(`[fail]  ${entry}: ${wrapped.message}`);
      result.failed.push({ repo: entry, error: wrapped });
    }
  }

  return result;
}

function parseArguments(argv: string[]): SetupReposOptions {
  let dryRun = false;
  const positionals: string[] = [];
  for (const argument of argv) {
    if (argument === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (argument.startsWith("-")) {
      throw new Error(
        `Unknown option: ${argument}\nUsage: crew setup repos [--dry-run] [<repo>...]`,
      );
    }
    positionals.push(argument);
  }
  const options: SetupReposOptions = { dryRun };
  if (positionals.length > 0) {
    options.only = positionals;
  }
  return options;
}

export async function setupReposCli(argv: string[]): Promise<void> {
  const options = parseArguments(argv);
  const config = await loadConfig();
  const result = await setupRepos(config, options);

  if (result.ghMissing || result.failed.length > 0) {
    process.exitCode = 1;
    return;
  }
  // Remaining skips mean setup is incomplete — signal that to CI gates.
  if (result.skipped.length > 0) {
    process.exitCode = 1;
  }
}
