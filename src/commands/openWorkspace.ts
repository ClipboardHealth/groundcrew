import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

import { composeAgentLaunch, openAgentWorkspace, prepareAgentLaunch } from "../lib/agentLaunch.ts";
import { loadConfig, repositoryBaseDir, type ResolvedConfig } from "../lib/config.ts";
import { resolvePullRequest } from "../lib/pullRequests.ts";
import { resolvePrepareWorktreeCommand } from "../lib/repositoryHooks.ts";
import { recordRunState, readRunState } from "../lib/runState.ts";
import {
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
}

interface BranchInput {
  kind: "branch";
  branch: string;
}

export interface OpenWorkspaceOptions {
  input: PullRequestInput | BranchInput;
  repository: string;
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
    repoDir: repositoryCloneDir(config, options.repository),
    repo: options.repository,
    pr: options.input.pr,
  });
  if (pullRequest.isCrossRepository) {
    throw new Error(
      `PR #${pullRequest.number} is from a fork (cross-repository); crew open cannot fetch fork branches. Check the branch out locally, then run crew open --branch <name> --repo ${options.repository}.`,
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
  promptDir: string | undefined;
  srtSettingsDir: string | undefined;
}): Promise<void> {
  log(
    `Open failed; rolling back worktree ${arguments_.entry.repository}-${arguments_.entry.task}...`,
  );
  try {
    await worktrees.teardown(arguments_.config, [arguments_.entry], { force: true });
  } catch (error) {
    log(`Worktree teardown failed during rollback: ${errorMessage(error)}`);
  }
  for (const dir of [arguments_.promptDir, arguments_.srtSettingsDir]) {
    if (dir !== undefined) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // already gone
      }
    }
  }
}

export async function openWorkspace(
  config: ResolvedConfig,
  options: OpenWorkspaceOptions,
): Promise<void> {
  assertKnownRepository(config, options.repository);
  const repoDir = repositoryCloneDir(config, options.repository);
  if (!existsSync(repoDir)) {
    throw new Error(`Repository not found: ${repoDir}`);
  }

  const target = await resolveTarget(config, options);
  await failIfWorkspaceAlreadyLive(config, target.task, "opening");
  failIfAlreadyTracked(config, target.task, options.repository);

  const agent = options.agent ?? config.agents.default;
  const definition = config.agents.definitions[agent];
  if (definition === undefined) {
    throw new Error(`Unknown agent: ${agent}`);
  }

  if (options.dryRun === true) {
    log(
      `[dry-run] Would open ${target.task} on branch ${target.branch} in ${options.repository} (${agent})`,
    );
    return;
  }

  const { runner, sandboxName, workspaceKind, ensureReady } = await prepareAgentLaunch({
    config,
    agent,
    definition,
    purpose: "runs",
  });
  await ensureReady();

  const created = await worktrees.open(config, {
    repository: options.repository,
    task: target.task,
    branch: target.branch,
  });
  const launchDir = resolveLaunchDir(config, options.repository, created.dir);

  const omitPromptArgument = options.promptText === undefined;
  const stagedPrompt = stagePromptText({
    prefix: "groundcrew-open",
    task: target.task,
    text: options.promptText ?? "",
  });
  let srtSettingsDir: string | undefined;
  try {
    const prepareWorktreeCommand = resolvePrepareWorktreeCommand({
      worktreeDir: launchDir,
      defaultHooks: config.defaults.hooks,
    });
    const secretsFile =
      prepareWorktreeCommand === undefined ? undefined : stageBuildSecrets(stagedPrompt.directory);
    let launchCommand: string;
    ({ launchCommand, srtSettingsDir } = composeAgentLaunch({
      runner,
      task: target.task,
      definition,
      promptFile: stagedPrompt.file,
      worktreeDir: created.dir,
      workingDir: launchDir,
      secretsFile,
      prepareWorktreeCommand,
      sandboxName,
      workspaceKind,
      omitPromptArgument,
    }));
    const launchCmd = stageWorkspaceLaunchCommand(stagedPrompt.directory, launchCommand);
    await openAgentWorkspace({
      config,
      name: target.task,
      cwd: launchDir,
      command: launchCmd,
      agent,
      color: definition.color,
    });
  } catch (error) {
    await rollback({ config, entry: created, promptDir: stagedPrompt.directory, srtSettingsDir });
    throw error;
  }

  recordRunState({
    config,
    state: {
      task: target.task,
      repository: options.repository,
      agent,
      worktreeDir: created.dir,
      branchName: target.branch,
      workspaceName: target.task,
      state: "running",
      title: target.title,
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
  const repository = parsed.repository ?? reference.repository;
  if (repository === undefined) {
    throw new Error(
      `crew open: --repo <owner/repo> is required when the PR is given by number\n${OPEN_USAGE}`,
    );
  }
  return { input: { kind: "pr", pr: reference.pr }, repository, ...common };
}

export function parseOpenWorkspaceArgs(argv: string[]): OpenWorkspaceOptions {
  return toOpenWorkspaceOptions(parseArguments(argv));
}

export async function openWorkspaceCli(argv: string[]): Promise<void> {
  const options = parseOpenWorkspaceArgs(argv);
  const config = await loadConfig();
  await openWorkspace(config, options);
}
