import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { composeAgentLaunch, openAgentWorkspace, prepareAgentLaunch } from "../lib/agentLaunch.ts";
import { inferAgentCommandName } from "../lib/launchCommand.ts";
import { loadConfig, repositoryBaseDir, type ResolvedConfig } from "../lib/config.ts";
import { resolvePullRequest } from "../lib/pullRequests.ts";
import { resolvePrepareWorktreeCommand } from "../lib/repositoryHooks.ts";
import { recordRunState, readRunState } from "../lib/runState.ts";
import { seedLaunchWorkspaceTrust } from "../lib/seedLaunchWorkspaceTrust.ts";
import {
  removeStagedPrompt,
  stageBuildSecrets,
  stagePromptText,
  stageWorkspaceLaunchCommand,
} from "../lib/stagedLaunch.ts";
import { normalizePlainTaskId } from "../lib/taskId.ts";
import { debug, errorMessage, log, okMark } from "../lib/util.ts";
import { failIfWorkspaceAlreadyLive } from "../lib/workspaceLiveness.ts";
import { resolveLaunchDir, type WorktreeEntry, worktrees } from "../lib/worktrees.ts";

interface PullRequestInput {
  kind: "pr";
  pr: string;
  repositoryHint?: string;
}

interface BranchInput {
  kind: "branch";
  branch: string;
}

export interface OpenWorkspaceOptions {
  input: PullRequestInput | BranchInput;
  repository?: string;
  agent?: string;
  /** Resolved prompt text; when undefined the agent opens interactively. */
  promptText?: string;
  taskOverride?: string;
  dryRun?: boolean;
}

const OPEN_USAGE =
  "Usage: crew open <pr> | --branch <name> [--repo <owner/repo>] [--agent <agent>] [--prompt <text> | --prompt-file <path>] [--task <id>] [--dry-run]";

const PULL_REQUEST_URL_PATTERN =
  /^https?:\/\/github\.com\/(?<repository>[^/]+\/[^/]+)\/pull\/(?<pr>\d+)/;

interface ParsedPullRequestReference {
  repository?: string;
  pr: string;
}

function parsePullRequestReference(reference: string): ParsedPullRequestReference {
  const groups = PULL_REQUEST_URL_PATTERN.exec(reference)?.groups;
  if (groups?.["repository"] !== undefined && groups["pr"] !== undefined) {
    return { repository: groups["repository"], pr: groups["pr"] };
  }
  return { pr: reference };
}

function slugifyBranch(branch: string): string {
  return branch
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
}

function repositoryCloneDir(config: ResolvedConfig, repository: string): string {
  return path.resolve(repositoryBaseDir(config, repository), repository);
}

function assertKnownRepository(config: ResolvedConfig, repository: string): void {
  if (!config.workspace.knownRepositories.includes(repository)) {
    throw new Error(
      `Repository "${repository}" is not in workspace.knownRepositories: ${config.workspace.knownRepositories.join(", ")}`,
    );
  }
}

function repositoryBasename(repository: string): string {
  const lastSlash = repository.lastIndexOf("/");
  return lastSlash === -1 ? repository : repository.slice(lastSlash + 1);
}

function resolveRepositoryHint(config: ResolvedConfig, repositoryHint: string): string {
  const normalizedHint = repositoryHint.toLowerCase();
  const exactMatches = config.workspace.knownRepositories.filter(
    (repository) => repository.toLowerCase() === normalizedHint,
  );
  const [exactMatch] = exactMatches;
  if (exactMatches.length === 1 && exactMatch !== undefined) {
    return exactMatch;
  }

  const basename = repositoryBasename(repositoryHint).toLowerCase();
  const basenameMatches = config.workspace.knownRepositories.filter(
    (repository) => repositoryBasename(repository).toLowerCase() === basename,
  );
  const [basenameMatch] = basenameMatches;
  if (basenameMatches.length === 1 && basenameMatch !== undefined) {
    return basenameMatch;
  }
  if (basenameMatches.length > 1) {
    throw new Error(
      `Repository hint "${repositoryHint}" matches multiple configured repositories: ${basenameMatches.join(", ")}. Pass --repo <name> to choose one.`,
    );
  }
  throw new Error(
    `Repository hint "${repositoryHint}" does not match workspace.knownRepositories: ${config.workspace.knownRepositories.join(", ")}. Pass --repo <name> to choose one.`,
  );
}

function resolveOpenRepository(config: ResolvedConfig, options: OpenWorkspaceOptions): string {
  if (options.repository !== undefined) {
    assertKnownRepository(config, options.repository);
    return options.repository;
  }
  if (options.input.kind === "pr" && options.input.repositoryHint !== undefined) {
    return resolveRepositoryHint(config, options.input.repositoryHint);
  }
  throw new Error(`crew open: --repo <owner/repo> is required\n${OPEN_USAGE}`);
}

function failIfAlreadyTracked(config: ResolvedConfig, task: string, repository: string): void {
  const hasWorktree = worktrees
    .findByTask(config, task)
    .some((entry) => entry.repository === repository);
  if (hasWorktree || readRunState(config, task) !== undefined) {
    throw new Error(
      `Task ${task} already has a worktree or run state. Use 'crew resume ${task}' to continue it, or 'crew status ${task}' to inspect it.`,
    );
  }
}

interface ResolvedTarget {
  branch: string;
  title: string;
  task: string;
  url?: string;
}

async function resolveTarget(
  config: ResolvedConfig,
  options: OpenWorkspaceOptions,
  repository: string,
): Promise<ResolvedTarget> {
  if (options.input.kind === "branch") {
    const { branch } = options.input;
    return {
      branch,
      title: branch,
      task: normalizePlainTaskId(options.taskOverride ?? slugifyBranch(branch)),
    };
  }
  const pullRequest = await resolvePullRequest({
    repoDir: repositoryCloneDir(config, repository),
    pr: options.input.pr,
  });
  if (pullRequest.isCrossRepository) {
    throw new Error(
      `PR #${pullRequest.number} is from a fork (cross-repository); crew open cannot fetch fork branches. Check the branch out locally, then run crew open --branch <name> --repo ${repository}.`,
    );
  }
  return {
    branch: pullRequest.branch,
    title: pullRequest.title,
    task: normalizePlainTaskId(options.taskOverride ?? `pr-${pullRequest.number}`),
    url: pullRequest.url,
  };
}

async function rollback(arguments_: {
  config: ResolvedConfig;
  entry: WorktreeEntry;
  promptDir: string;
}): Promise<void> {
  log(
    `Open failed; rolling back worktree ${arguments_.entry.repository}-${arguments_.entry.task}...`,
  );
  try {
    await worktrees.teardown(arguments_.config, [arguments_.entry], { force: true });
  } catch (error) {
    log(`Worktree teardown failed during rollback: ${errorMessage(error)}`);
  }
  try {
    removeStagedPrompt(arguments_.promptDir);
  } catch {
    // already gone
  }
}

export async function openWorkspace(
  config: ResolvedConfig,
  options: OpenWorkspaceOptions,
): Promise<void> {
  const repository = resolveOpenRepository(config, options);
  const repoDir = repositoryCloneDir(config, repository);
  if (!existsSync(repoDir)) {
    throw new Error(`Repository not found: ${repoDir}`);
  }

  const target = await resolveTarget(config, options, repository);
  await failIfWorkspaceAlreadyLive(config, target.task, "opening");
  failIfAlreadyTracked(config, target.task, repository);

  const agent = options.agent ?? config.agents.default;
  const definition = config.agents.definitions[agent];
  if (definition === undefined) {
    throw new Error(`Unknown agent: ${agent}`);
  }

  if (options.dryRun === true) {
    log(
      `[dry-run] Would open ${target.task} on branch ${target.branch} in ${repository} (${agent})`,
    );
    return;
  }

  const { runner, networkEgress, sandboxName, workspaceKind, ensureReady } =
    await prepareAgentLaunch({
      config,
      agent,
      definition,
      purpose: "runs",
    });
  await ensureReady();

  const created = await worktrees.open(config, {
    repository,
    task: target.task,
    branch: target.branch,
  });
  const launchDir = resolveLaunchDir(config, repository, created.dir);

  const omitPromptArgument = options.promptText === undefined;
  const stagedPrompt = stagePromptText({
    prefix: "groundcrew-open",
    task: target.task,
    text: options.promptText ?? "",
  });
  let cleanupAgentLaunch: (() => void) | undefined;
  try {
    const repositoryEntry = config.workspace.repositories.find(
      (entry) => entry.name === repository,
    );
    const prepareWorktreeCommand = resolvePrepareWorktreeCommand({
      worktreeDir: launchDir,
      // Spread-conditional: exactOptionalPropertyTypes forbids an explicit
      // `undefined` for an optional field, and the lookup yields undefined for
      // repos with no hooks. Mirrors setupWorkspace so `crew open` honors the
      // same per-repo operator hooks as `crew setup`.
      ...(repositoryEntry?.hooks === undefined ? {} : { perRepoHooks: repositoryEntry.hooks }),
      defaultHooks: config.defaults.hooks,
    });
    const prepareWorktreeUnsandboxedCommand = repositoryEntry?.unsandboxedHooks?.prepareWorktree;
    const secretsFile =
      prepareWorktreeCommand === undefined && prepareWorktreeUnsandboxedCommand === undefined
        ? undefined
        : stageBuildSecrets(stagedPrompt.directory);
    seedLaunchWorkspaceTrust({
      agentCommandName: inferAgentCommandName(definition.cmd),
      launchDir,
    });
    const launch = composeAgentLaunch({
      runner,
      networkEgress,
      task: target.task,
      definition,
      promptFile: stagedPrompt.file,
      worktreeDir: created.dir,
      workingDir: launchDir,
      secretsFile,
      prepareWorktreeCommand,
      prepareWorktreeUnsandboxedCommand,
      sandboxName,
      workspaceKind,
      readOnlyDirs: config.local.readOnlyDirs,
      omitPromptArgument,
    });
    cleanupAgentLaunch = launch.cleanup;
    const launchCmd = stageWorkspaceLaunchCommand(stagedPrompt.directory, launch.command);
    await openAgentWorkspace({
      config,
      name: target.task,
      displayName: target.title,
      cwd: launchDir,
      command: launchCmd,
      agent,
      color: definition.color,
    });
  } catch (error) {
    cleanupAgentLaunch?.();
    await rollback({ config, entry: created, promptDir: stagedPrompt.directory });
    throw error;
  }

  recordRunState({
    config,
    state: {
      task: target.task,
      repository,
      agent,
      worktreeDir: created.dir,
      branchName: target.branch,
      workspaceName: target.task,
      state: "running",
      title: target.title,
      adoptedBranch: true,
      ...(target.url === undefined ? {} : { url: target.url }),
    },
  });

  log(`${okMark()} "${target.task}" opened on branch ${target.branch} (${agent})`);
  debug(`  Worktree: ${launchDir}`);
  if (omitPromptArgument) {
    debug("  Launched interactively (no prompt).");
  }
}

interface ParsedArguments {
  positional?: string;
  repository?: string;
  agent?: string;
  promptText?: string;
  promptFile?: string;
  branch?: string;
  task?: string;
  dryRun: boolean;
}

function readValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("-")) {
    throw new Error(`crew open: ${flag} requires a value\n${OPEN_USAGE}`);
  }
  return value;
}

function parseArguments(argv: string[]): ParsedArguments {
  const parsed: ParsedArguments = { dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    /* v8 ignore next @preserve -- loop bound guarantees argv[index] is defined; the guard narrows the type */
    if (argument === undefined) {
      continue;
    }
    switch (argument) {
      case "--repo": {
        parsed.repository = readValue(argv, index, "--repo");
        index += 1;
        break;
      }
      case "--agent": {
        parsed.agent = readValue(argv, index, "--agent");
        index += 1;
        break;
      }
      case "--prompt": {
        parsed.promptText = readValue(argv, index, "--prompt");
        index += 1;
        break;
      }
      case "--prompt-file": {
        parsed.promptFile = readValue(argv, index, "--prompt-file");
        index += 1;
        break;
      }
      case "--branch": {
        parsed.branch = readValue(argv, index, "--branch");
        index += 1;
        break;
      }
      case "--task": {
        parsed.task = readValue(argv, index, "--task");
        index += 1;
        break;
      }
      case "--dry-run": {
        parsed.dryRun = true;
        break;
      }
      default: {
        if (argument.startsWith("-")) {
          throw new Error(`crew open: unknown option: ${argument}\n${OPEN_USAGE}`);
        }
        if (parsed.positional !== undefined) {
          throw new Error(`crew open: unexpected extra argument: ${argument}\n${OPEN_USAGE}`);
        }
        parsed.positional = argument;
      }
    }
  }
  return parsed;
}

function resolvePromptText(parsed: ParsedArguments): string | undefined {
  if (parsed.promptText !== undefined && parsed.promptFile !== undefined) {
    throw new Error(`crew open: --prompt and --prompt-file are mutually exclusive\n${OPEN_USAGE}`);
  }
  if (parsed.promptText !== undefined) {
    return parsed.promptText;
  }
  if (parsed.promptFile !== undefined) {
    try {
      return readFileSync(parsed.promptFile, "utf8");
    } catch (error) {
      throw new Error(`crew open: could not read --prompt-file ${parsed.promptFile}`, {
        cause: error,
      });
    }
  }
  return undefined;
}

function toOpenWorkspaceOptions(parsed: ParsedArguments): OpenWorkspaceOptions {
  if (parsed.branch !== undefined && parsed.positional !== undefined) {
    throw new Error(`crew open: pass either a PR or --branch, not both\n${OPEN_USAGE}`);
  }
  const promptText = resolvePromptText(parsed);
  const common = {
    ...(parsed.agent === undefined ? {} : { agent: parsed.agent }),
    ...(promptText === undefined ? {} : { promptText }),
    ...(parsed.task === undefined ? {} : { taskOverride: parsed.task }),
    dryRun: parsed.dryRun,
  };

  if (parsed.branch !== undefined) {
    if (parsed.repository === undefined) {
      throw new Error(`crew open: --branch requires --repo <owner/repo>\n${OPEN_USAGE}`);
    }
    return {
      input: { kind: "branch", branch: parsed.branch },
      repository: parsed.repository,
      ...common,
    };
  }

  if (parsed.positional === undefined) {
    throw new Error(`crew open: a PR (number or URL) or --branch is required\n${OPEN_USAGE}`);
  }
  const reference = parsePullRequestReference(parsed.positional);
  if (parsed.repository === undefined && reference.repository === undefined) {
    throw new Error(
      `crew open: --repo <owner/repo> is required when the PR is given by number\n${OPEN_USAGE}`,
    );
  }
  return {
    input: {
      kind: "pr",
      pr: reference.pr,
      ...(reference.repository === undefined ? {} : { repositoryHint: reference.repository }),
    },
    ...(parsed.repository === undefined ? {} : { repository: parsed.repository }),
    ...common,
  };
}

export function parseOpenWorkspaceArgs(argv: string[]): OpenWorkspaceOptions {
  return toOpenWorkspaceOptions(parseArguments(argv));
}

export async function openWorkspaceCli(argv: string[]): Promise<void> {
  const options = parseOpenWorkspaceArgs(argv);
  const config = await loadConfig();
  await openWorkspace(config, options);
}
