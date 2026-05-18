/**
 * `crew setup discover-repos <org>` — query GitHub for every active
 * (non-archived, non-fork, non-disabled) repository in `<org>` and add
 * the resulting `<org>/<repo>` entries to `workspace.knownRepositories`
 * in the user's `config.ts`. Idempotent: re-runs add nothing when every
 * active repo is already tracked. Pair with `crew setup repos` to clone
 * the new entries.
 */
import { runCommand } from "../lib/commandRunner.ts";
import { loadConfig, resolveConfigPath, type ResolvedConfig } from "../lib/config.ts";
import { updateKnownRepositoriesInConfigFile } from "../lib/configFileWriter.ts";
import { which } from "../lib/host.ts";
import { errorMessage, log, writeError, writeOutput } from "../lib/util.ts";

export interface DiscoverReposOptions {
  /** Print the planned changes without modifying `config.ts`. */
  dryRun?: boolean;
}

export interface FilteredRepo {
  repo: string;
  reasons: string[];
}

export interface DiscoverReposResult {
  org: string;
  active: string[];
  alreadyKnown: string[];
  added: string[];
  filtered: FilteredRepo[];
  ghMissing: boolean;
}

interface GhRepoEntry {
  name: string;
  isArchived: boolean;
  isFork: boolean;
  isDisabled: boolean;
}

const USAGE = "Usage: crew setup discover-repos [--dry-run] <org>";
const GH_INSTALL_HINT =
  "gh CLI not found — install from https://cli.github.com/ (or add entries to workspace.knownRepositories manually).";
const GH_REPO_LIST_LIMIT = 1000;

function emptyResult(org: string): DiscoverReposResult {
  return {
    org,
    active: [],
    alreadyKnown: [],
    added: [],
    filtered: [],
    ghMissing: false,
  };
}

function isGhRepoEntry(value: unknown): value is GhRepoEntry {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if (!("name" in value) || typeof value.name !== "string") {
    return false;
  }
  if (!("isArchived" in value) || typeof value.isArchived !== "boolean") {
    return false;
  }
  if (!("isFork" in value) || typeof value.isFork !== "boolean") {
    return false;
  }
  if (!("isDisabled" in value) || typeof value.isDisabled !== "boolean") {
    return false;
  }
  return true;
}

function parseGhRepoList(stdout: string): GhRepoEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`gh repo list returned non-JSON output: ${errorMessage(error)}`, {
      cause: error,
    });
  }
  if (!Array.isArray(parsed)) {
    throw new TypeError("gh repo list did not return an array");
  }
  return parsed.filter(isGhRepoEntry);
}

function dropReasons(entry: GhRepoEntry): string[] {
  const reasons: string[] = [];
  if (entry.isArchived) {
    reasons.push("archived");
  }
  if (entry.isFork) {
    reasons.push("fork");
  }
  if (entry.isDisabled) {
    reasons.push("disabled");
  }
  return reasons;
}

export async function discoverRepos(
  config: ResolvedConfig,
  org: string,
  options: DiscoverReposOptions,
): Promise<DiscoverReposResult> {
  const result = emptyResult(org);

  const ghPath = await which("gh");
  if (ghPath === undefined) {
    result.ghMissing = true;
    writeError(GH_INSTALL_HINT);
    return result;
  }

  const stdout = runCommand("gh", [
    "repo",
    "list",
    org,
    "--no-archived",
    "--source",
    "--limit",
    String(GH_REPO_LIST_LIMIT),
    "--json",
    "name,isArchived,isFork,isDisabled",
  ]);
  const entries = parseGhRepoList(stdout);
  if (entries.length === GH_REPO_LIST_LIMIT) {
    writeError(
      `discover-repos: warning — gh returned exactly ${GH_REPO_LIST_LIMIT} repos for ${org}; the org may have more. Results may be incomplete.`,
    );
  }

  const active: string[] = [];
  for (const entry of entries) {
    const reasons = dropReasons(entry);
    if (reasons.length > 0) {
      result.filtered.push({ repo: `${org}/${entry.name}`, reasons });
      continue;
    }
    active.push(`${org}/${entry.name}`);
  }
  result.active = active;

  const known = new Set(config.workspace.knownRepositories);
  for (const repo of active) {
    if (known.has(repo)) {
      result.alreadyKnown.push(repo);
    } else {
      result.added.push(repo);
    }
  }

  if (result.added.length === 0) {
    log(
      `discover-repos: nothing new (${active.length} active, ${result.alreadyKnown.length} already known, ${result.filtered.length} filtered)`,
    );
    return result;
  }

  if (options.dryRun === true) {
    writeOutput(`discover-repos (dry-run): ${result.added.length} would be added to ${org}`);
    for (const repo of active) {
      writeOutput(`  ${known.has(repo) ? " " : "+"} ${repo}`);
    }
    return result;
  }

  const configPath = resolveConfigPath();
  updateKnownRepositoriesInConfigFile({ configPath, toAdd: result.added });
  writeOutput(
    `discover-repos: added ${result.added.length} entries to workspace.knownRepositories (${result.alreadyKnown.length} already known, ${result.filtered.length} filtered)`,
  );
  for (const repo of result.added) {
    writeOutput(`  + ${repo}`);
  }
  return result;
}

interface ParsedArguments {
  org: string;
  dryRun: boolean;
}

function parseArguments(argv: string[]): ParsedArguments {
  const dryRun = argv.includes("--dry-run");
  const positionals = argv.filter((argument) => argument !== "--dry-run");
  const stray = positionals.find((argument) => argument.startsWith("-"));
  if (stray !== undefined) {
    throw new Error(`Unknown option: ${stray}\n${USAGE}`);
  }
  const [first, ...rest] = positionals;
  if (first === undefined || first.length === 0) {
    throw new Error(`<org> is required\n${USAGE}`);
  }
  if (rest.length > 0) {
    throw new Error(`Too many positional arguments\n${USAGE}`);
  }
  return { org: first, dryRun };
}

export async function discoverReposCli(argv: string[]): Promise<void> {
  const { org, dryRun } = parseArguments(argv);
  const config = await loadConfig();
  const result = await discoverRepos(config, org, { dryRun });
  if (result.ghMissing) {
    process.exitCode = 1;
  }
}
