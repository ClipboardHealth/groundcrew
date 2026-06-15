import { type Board, createBoard } from "../lib/board.ts";
import { buildSources, sourcesFromConfig } from "../lib/buildSources.ts";
import { AGENT_ANY, loadConfig, type ResolvedConfig } from "../lib/config.ts";
import { findPullRequestsForBranch } from "../lib/pullRequests.ts";
import { resolveTaskIdMatches, type TaskResolutionMatches } from "../lib/taskResolution.ts";
import {
  type CanonicalStatus,
  type CreateTaskInput,
  type Issue,
  naturalIdFromCanonical,
  type Task,
  type TaskSource,
} from "../lib/taskSource.ts";
import { parseSourceFilterArgs, writeOutput } from "../lib/util.ts";
import { type WorktreeDirtiness, type WorktreeEntry, worktrees } from "../lib/worktrees.ts";

const TASK_USAGE = `Usage: crew task <subcommand>

Subcommands:
  list [options]                  List tasks across configured sources
  get <task-id> [options]         Get one task
  create "Short title" [options]  Create one task
  done <task-id> [options]        Mark one task done
  validate [source] [options]     Validate task content`;

const LIST_USAGE = `Usage: crew task list [options]

Options:
  --source <name>      Limit to one source.
  --status <status>    Filter by status. Repeatable.
  --agent <name>       Filter by agent name.
  --repo <owner/repo>  Filter by repository.
  --blocked            Show only blocked tasks.
  --unblocked          Show only unblocked tasks.
  --json               Print normalized task JSON.
  --limit <n>          Limit output.`;

const GET_USAGE = `Usage: crew task get <task-id> [options]

Options:
  --source <name>  Resolve a source-native ID against a specific source.
  --json           Print normalized task JSON.
  --prompt         Print only the task description/prompt.`;

const CREATE_USAGE = `Usage: crew task create "Short title" --source <source> [--agent <agent>] [options]`;

const DONE_USAGE = `Usage: crew task done <task-id> [--allow-dirty]`;

const CANONICAL_STATUSES: readonly CanonicalStatus[] = [
  "todo",
  "in-progress",
  "in-review",
  "done",
  "other",
] as const;

const CANONICAL_STATUS_SET: ReadonlySet<string> = new Set(CANONICAL_STATUSES);

interface ListOptions {
  sourceName?: string;
  statuses: CanonicalStatus[];
  agent?: string;
  repository?: string;
  blocked: boolean;
  unblocked: boolean;
  json: boolean;
  limit?: number;
}

interface GetOptions {
  taskId: string;
  sourceName?: string;
  json: boolean;
  prompt: boolean;
}

interface CreateOptions {
  title: string;
  sourceName: string;
  input: CreateTaskInput;
  json: boolean;
}

interface DoneOptions {
  taskId: string;
  allowDirty: boolean;
}

interface CreateParseState {
  positionals: string[];
  sourceName?: string;
  agent?: string;
  repository?: string;
  team?: string;
  id?: string;
  priority?: string;
  projects: string[];
  contexts: string[];
  dependencies: string[];
  due?: string;
  recurrence?: string;
  promptFile?: string;
  description?: string;
  edit: boolean;
  json: boolean;
}

interface PrintableTask {
  id: string;
  source: string;
  title: string;
  description: string;
  status: CanonicalStatus;
  repository: string | undefined;
  agent: string | undefined;
  assignee: string;
  updatedAt: string;
  blockers: Task["blockers"];
  hasMoreBlockers: boolean;
  url?: string;
  priority?: number;
}

function isCanonicalStatus(value: string): value is CanonicalStatus {
  return CANONICAL_STATUS_SET.has(value);
}

function readOptionValue(
  argv: readonly string[],
  index: number,
  option: string,
  usage: string,
): string {
  const value = argv[index + 1];
  if (value === undefined) {
    throw new Error(`crew task: ${option} requires a value\n${usage}`);
  }
  return value;
}

type CreateValueHandler = (state: CreateParseState, value: string) => void;

const CREATE_VALUE_HANDLERS: Readonly<Record<string, CreateValueHandler | undefined>> = {
  "--source": (state, value) => {
    state.sourceName = value;
  },
  "--agent": (state, value) => {
    state.agent = value;
  },
  "--repo": (state, value) => {
    state.repository = value;
  },
  "--team": (state, value) => {
    state.team = value;
  },
  "--id": (state, value) => {
    state.id = value;
  },
  "--priority": (state, value) => {
    state.priority = value;
  },
  "--project": (state, value) => {
    state.projects.push(value);
  },
  "--context": (state, value) => {
    state.contexts.push(value);
  },
  "--dep": (state, value) => {
    state.dependencies.push(value);
  },
  "--due": (state, value) => {
    state.due = value;
  },
  "--rec": (state, value) => {
    state.recurrence = value;
  },
  "--prompt-file": (state, value) => {
    state.promptFile = value;
  },
  "--description": (state, value) => {
    state.description = value;
  },
};

function parseLimit(raw: string): number {
  const limit = Number.parseInt(raw, 10);
  if (!Number.isInteger(limit) || limit < 1 || String(limit) !== raw) {
    throw new Error("crew task list: --limit must be a positive integer");
  }
  return limit;
}

function parseListOptions(argv: readonly string[]): ListOptions {
  const options: ListOptions = {
    statuses: [],
    blocked: false,
    unblocked: false,
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    /* v8 ignore next 3 @preserve -- index is bounded by argv.length; guard exists for noUncheckedIndexedAccess */
    if (argument === undefined) {
      continue;
    }
    if (argument === "--source") {
      options.sourceName = readOptionValue(argv, index, argument, LIST_USAGE);
      index += 1;
      continue;
    }
    if (argument === "--status") {
      const status = readOptionValue(argv, index, argument, LIST_USAGE);
      if (!isCanonicalStatus(status)) {
        throw new Error(
          `crew task list: unknown status "${status}" (expected ${CANONICAL_STATUSES.join(", ")})`,
        );
      }
      options.statuses.push(status);
      index += 1;
      continue;
    }
    if (argument === "--agent") {
      options.agent = readOptionValue(argv, index, argument, LIST_USAGE);
      index += 1;
      continue;
    }
    if (argument === "--repo") {
      options.repository = readOptionValue(argv, index, argument, LIST_USAGE);
      index += 1;
      continue;
    }
    if (argument === "--blocked") {
      options.blocked = true;
      continue;
    }
    if (argument === "--unblocked") {
      options.unblocked = true;
      continue;
    }
    if (argument === "--json") {
      options.json = true;
      continue;
    }
    if (argument === "--limit") {
      options.limit = parseLimit(readOptionValue(argv, index, argument, LIST_USAGE));
      index += 1;
      continue;
    }
    throw new Error(`crew task list: unknown argument: ${argument}\n${LIST_USAGE}`);
  }

  if (options.blocked && options.unblocked) {
    throw new Error("crew task list: --blocked and --unblocked are mutually exclusive");
  }

  return options;
}

function parseGetOptions(argv: readonly string[]): GetOptions {
  const positionals: string[] = [];
  let sourceName: string | undefined;
  let json = false;
  let prompt = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    /* v8 ignore next 3 @preserve -- index is bounded by argv.length; guard exists for noUncheckedIndexedAccess */
    if (argument === undefined) {
      continue;
    }
    if (argument === "--source") {
      sourceName = readOptionValue(argv, index, argument, GET_USAGE);
      index += 1;
      continue;
    }
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--prompt") {
      prompt = true;
      continue;
    }
    if (argument.startsWith("-")) {
      throw new Error(`crew task get: unknown option: ${argument}\n${GET_USAGE}`);
    }
    positionals.push(argument);
  }

  const [taskId, ...extras] = positionals;
  if (taskId === undefined || extras.length > 0) {
    throw new Error(GET_USAGE);
  }
  if (json && prompt) {
    throw new Error("crew task get: --json and --prompt are mutually exclusive");
  }

  return { taskId, ...(sourceName === undefined ? {} : { sourceName }), json, prompt };
}

function parseCreateOptions(argv: readonly string[]): CreateOptions {
  const state: CreateParseState = {
    positionals: [],
    projects: [],
    contexts: [],
    dependencies: [],
    edit: false,
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    /* v8 ignore next 3 @preserve -- index is bounded by argv.length; guard exists for noUncheckedIndexedAccess */
    if (argument === undefined) {
      continue;
    }
    const valueHandler = CREATE_VALUE_HANDLERS[argument];
    if (valueHandler !== undefined) {
      valueHandler(state, readOptionValue(argv, index, argument, CREATE_USAGE));
      index += 1;
      continue;
    }
    if (argument === "--edit") {
      state.edit = true;
      continue;
    }
    if (argument === "--json") {
      state.json = true;
      continue;
    }
    if (argument.startsWith("-")) {
      throw new Error(`crew task create: unknown option: ${argument}\n${CREATE_USAGE}`);
    }
    state.positionals.push(argument);
  }

  const [title, ...extras] = state.positionals;
  if (title === undefined || extras.length > 0) {
    throw new Error(`${CREATE_USAGE}\nQuote multi-word titles as one argument.`);
  }
  if (state.sourceName === undefined) {
    throw new Error("crew task create: --source is required");
  }
  const input: CreateTaskInput = {
    title,
    agent: state.agent ?? AGENT_ANY,
    projects: state.projects,
    contexts: state.contexts,
    dependencies: state.dependencies,
    edit: state.edit,
    ...(state.repository === undefined ? {} : { repository: state.repository }),
    ...(state.team === undefined ? {} : { team: state.team }),
    ...(state.id === undefined ? {} : { id: state.id }),
    ...(state.priority === undefined ? {} : { priority: state.priority }),
    ...(state.due === undefined ? {} : { due: state.due }),
    ...(state.recurrence === undefined ? {} : { recurrence: state.recurrence }),
    ...(state.promptFile === undefined ? {} : { promptFile: state.promptFile }),
    ...(state.description === undefined ? {} : { description: state.description }),
  };

  return { title, sourceName: state.sourceName, input, json: state.json };
}

function parseDoneOptions(argv: readonly string[]): DoneOptions {
  const positionals: string[] = [];
  let allowDirty = false;

  for (const argument of argv) {
    if (argument === "--allow-dirty") {
      allowDirty = true;
      continue;
    }
    if (argument.startsWith("-")) {
      throw new Error(`crew task done: unknown option: ${argument}\n${DONE_USAGE}`);
    }
    positionals.push(argument);
  }

  const [taskId, ...extras] = positionals;
  if (taskId === undefined || taskId.length === 0 || extras.length > 0) {
    throw new Error(DONE_USAGE);
  }
  return { taskId, allowDirty };
}

async function loadTaskSources(): Promise<TaskSource[]> {
  const config: ResolvedConfig = await loadConfig();
  return await buildSources(sourcesFromConfig(config), { globalConfig: config });
}

async function loadTaskBoard(): Promise<{ config: ResolvedConfig; board: Board }> {
  const config: ResolvedConfig = await loadConfig();
  const sources = await buildSources(sourcesFromConfig(config), { globalConfig: config });
  return { config, board: createBoard(sources) };
}

function findSource(sources: readonly TaskSource[], sourceName: string): TaskSource {
  const source = sources.find((candidate) => candidate.name === sourceName);
  if (source === undefined) {
    throw new Error(`crew task: no source named "${sourceName}"`);
  }
  return source;
}

function taskIsBlocked(task: Task): boolean {
  return task.hasMoreBlockers || task.blockers.some((blocker) => blocker.status !== "done");
}

function filterTasks(tasks: readonly Task[], options: ListOptions): Task[] {
  let filtered = [...tasks];
  if (options.statuses.length > 0) {
    filtered = filtered.filter((task) => options.statuses.includes(task.status));
  }
  if (options.agent !== undefined) {
    filtered = filtered.filter((task) => task.agent === options.agent);
  }
  if (options.repository !== undefined) {
    filtered = filtered.filter((task) => task.repository === options.repository);
  }
  if (options.blocked) {
    filtered = filtered.filter(taskIsBlocked);
  }
  if (options.unblocked) {
    filtered = filtered.filter((task) => !taskIsBlocked(task));
  }
  if (options.limit !== undefined) {
    filtered = filtered.slice(0, options.limit);
  }
  return filtered;
}

function printableTask(task: Task): PrintableTask {
  return {
    id: task.id,
    source: task.source,
    title: task.title,
    description: task.description,
    status: task.status,
    repository: task.repository,
    agent: task.agent,
    assignee: task.assignee,
    updatedAt: task.updatedAt,
    blockers: task.blockers,
    hasMoreBlockers: task.hasMoreBlockers,
    ...(task.url === undefined ? {} : { url: task.url }),
    ...(task.priority === undefined ? {} : { priority: task.priority }),
  };
}

function writeJson(tasks: readonly Task[]): void {
  writeOutput(JSON.stringify(tasks.map(printableTask), null, 2));
}

function writeTaskJson(task: Task): void {
  writeOutput(JSON.stringify(printableTask(task), null, 2));
}

function writeTaskTable(tasks: readonly Task[]): void {
  if (tasks.length === 0) {
    writeOutput("(no tasks)");
    return;
  }

  const rows = tasks.map((task) => ({
    id: task.id,
    status: task.status,
    agent: task.agent ?? "-",
    repository: task.repository ?? "-",
    blocked: taskIsBlocked(task) ? "yes" : "no",
    title: task.title,
  }));
  const idWidth = Math.max(2, ...rows.map((row) => row.id.length));
  const statusWidth = Math.max(6, ...rows.map((row) => row.status.length));
  const agentWidth = Math.max(5, ...rows.map((row) => row.agent.length));
  const repositoryWidth = Math.max(4, ...rows.map((row) => row.repository.length));

  writeOutput(
    [
      "ID".padEnd(idWidth),
      "STATUS".padEnd(statusWidth),
      "AGENT".padEnd(agentWidth),
      "REPO".padEnd(repositoryWidth),
      "BLOCKED",
      "TITLE",
    ].join("  "),
  );
  for (const row of rows) {
    writeOutput(
      [
        row.id.padEnd(idWidth),
        row.status.padEnd(statusWidth),
        row.agent.padEnd(agentWidth),
        row.repository.padEnd(repositoryWidth),
        row.blocked.padEnd(7),
        row.title,
      ].join("  "),
    );
  }
}

function canonicalParts(taskId: string): { sourceName: string; naturalId: string } | undefined {
  const colonIndex = taskId.indexOf(":");
  if (colonIndex === -1) {
    return undefined;
  }
  const sourceName = taskId.slice(0, colonIndex);
  const naturalId = taskId.slice(colonIndex + 1);
  if (sourceName.length === 0 || naturalId.length === 0) {
    throw new Error(`crew task get: invalid canonical task id "${taskId}"`);
  }
  return { sourceName, naturalId };
}

interface TaskFromResolutionArguments {
  taskId: string;
  resolution: TaskResolutionMatches;
  sourceName?: string;
}

function taskFromResolution({ taskId, resolution, sourceName }: TaskFromResolutionArguments): Task {
  if (resolution.matches.length === 0) {
    if (resolution.rejections.length > 0) {
      throw resolution.rejections[0];
    }
    if (sourceName !== undefined) {
      throw new Error(`Task ${taskId} not found in source "${sourceName}".`);
    }
    throw new Error(`Task ${taskId} not found across configured sources.`);
  }
  if (resolution.matches.length > 1) {
    if (resolution.matchKind === "exact" && sourceName === undefined) {
      throw new Error(
        `Task id "${taskId}" matched multiple sources: ${resolution.matches.map((task) => task.id).join(", ")}. Re-run with a canonical id or --source <name>.`,
      );
    }
    throw new Error(
      `Task id "${taskId}" matched multiple tasks: ${resolution.matches.map((task) => task.id).join(", ")}. Re-run with a longer prefix or canonical id.`,
    );
  }
  const [match] = resolution.matches;
  /* v8 ignore next 3 @preserve -- matches.length was checked above; guard exists for noUncheckedIndexedAccess */
  if (match === undefined) {
    throw new Error(`Task ${taskId} not found across configured sources.`);
  }
  return match;
}

async function resolveTask(
  sources: readonly TaskSource[],
  taskId: string,
  sourceName: string | undefined,
): Promise<Task> {
  const canonical = canonicalParts(taskId);
  if (canonical !== undefined) {
    if (sourceName !== undefined && sourceName !== canonical.sourceName) {
      throw new Error(
        `crew task get: canonical id "${taskId}" already names source "${canonical.sourceName}"`,
      );
    }
    const source = findSource(sources, canonical.sourceName);
    return taskFromResolution({
      taskId,
      sourceName: source.name,
      resolution: await resolveTaskIdMatches({ sources: [source], naturalId: canonical.naturalId }),
    });
  }

  if (sourceName !== undefined) {
    const source = findSource(sources, sourceName);
    return taskFromResolution({
      taskId,
      sourceName: source.name,
      resolution: await resolveTaskIdMatches({ sources: [source], naturalId: taskId }),
    });
  }

  return taskFromResolution({
    taskId,
    resolution: await resolveTaskIdMatches({ sources, naturalId: taskId }),
  });
}

function writeTaskDetails(task: Task): void {
  writeOutput(task.id);
  writeOutput(`title: ${task.title}`);
  writeOutput(`status: ${task.status}`);
  writeOutput(`source: ${task.source}`);
  if (task.repository !== undefined) {
    writeOutput(`repo: ${task.repository}`);
  }
  if (task.agent !== undefined) {
    writeOutput(`agent: ${task.agent}`);
  }
  if (task.url !== undefined) {
    writeOutput(`url: ${task.url}`);
  }
  if (task.blockers.length > 0) {
    writeOutput(
      `blockers: ${task.blockers.map((blocker) => `${naturalIdFromCanonical(blocker.id)}(${blocker.status})`).join(", ")}`,
    );
  }
  if (task.description.trim().length > 0) {
    writeOutput("");
    writeOutput(task.description);
  }
}

async function taskListCli(argv: readonly string[]): Promise<void> {
  const options = parseListOptions(argv);
  const sources = await loadTaskSources();
  const selectedSources =
    options.sourceName === undefined ? sources : [findSource(sources, options.sourceName)];
  const sourceTasks = await Promise.all(
    selectedSources.map(async (source) => await source.listTasks()),
  );
  const tasks = filterTasks(sourceTasks.flat(), options);

  if (options.json) {
    writeJson(tasks);
    return;
  }
  writeTaskTable(tasks);
}

async function taskGetCli(argv: readonly string[]): Promise<void> {
  const options = parseGetOptions(argv);
  const sources = await loadTaskSources();
  const task = await resolveTask(sources, options.taskId, options.sourceName);

  if (options.prompt) {
    writeOutput(task.description);
    return;
  }
  if (options.json) {
    writeTaskJson(task);
    return;
  }
  writeTaskDetails(task);
}

async function taskCreateCli(argv: readonly string[]): Promise<void> {
  const options = parseCreateOptions(argv);
  const sources = await loadTaskSources();
  const source = findSource(sources, options.sourceName);
  if (source.createTask === undefined) {
    throw new Error(`crew task create: source "${source.name}" does not support task creation`);
  }
  const created = await source.createTask(options.input);

  if (options.json) {
    writeTaskJson(created);
    return;
  }
  writeOutput(created.id);
}

function matchingWorktreeEntries(arguments_: {
  config: ResolvedConfig;
  issue: Issue;
}): WorktreeEntry[] {
  const task = naturalIdFromCanonical(arguments_.issue.id);
  return worktrees
    .findByTask(arguments_.config, task)
    .filter(
      (entry) =>
        arguments_.issue.repository === undefined ||
        entry.repository === arguments_.issue.repository,
    );
}

function describeDirtiness(dirtiness: WorktreeDirtiness): string {
  if (dirtiness.kind === "dirty") {
    return `${dirtiness.modified} modified, ${dirtiness.untracked} untracked`;
  }
  return "unknown git status";
}

async function worktreeHasPullRequest(entry: WorktreeEntry): Promise<boolean> {
  const pullRequests = await findPullRequestsForBranch({
    cwd: entry.dir,
    branchName: entry.branchName,
  });
  return pullRequests.length > 0;
}

async function assertCanMarkDone(arguments_: {
  config: ResolvedConfig;
  issue: Issue;
  allowDirty: boolean;
}): Promise<void> {
  if (arguments_.allowDirty) {
    return;
  }

  for (const entry of matchingWorktreeEntries({
    config: arguments_.config,
    issue: arguments_.issue,
  })) {
    // oxlint-disable-next-line no-await-in-loop -- one git status per matching worktree keeps diagnostics deterministic.
    const dirtiness = await worktrees.probeWorkingTree({ worktreeDir: entry.dir });
    if (dirtiness.kind === "clean") {
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- only dirty/unknown worktrees need the PR lookup.
    if (dirtiness.kind === "dirty" && (await worktreeHasPullRequest(entry))) {
      continue;
    }
    throw new Error(
      `crew task done: refusing to mark ${arguments_.issue.id} done because ${entry.dir} has ${describeDirtiness(dirtiness)} and no matching PR. Commit or stash the work, open a PR, or rerun with --allow-dirty.`,
    );
  }
}

async function taskDoneCli(argv: readonly string[]): Promise<void> {
  const options = parseDoneOptions(argv);
  const { config, board } = await loadTaskBoard();
  const issue = await board.resolveOne(options.taskId);
  if (issue === undefined) {
    throw new Error(`Task ${options.taskId} not found across configured sources.`);
  }

  await assertCanMarkDone({ config, issue, allowDirty: options.allowDirty });
  const result = await board.markDone(issue);
  if (result.outcome === "unsupported") {
    throw new Error(`crew task done: ${result.reason}`);
  }
  writeOutput(`Marked ${issue.id} done.`);
}

const VALIDATE_USAGE = `Usage: crew task validate [source]

Options:
  --json  Print results as JSON.`;

interface ValidateResult {
  source: string;
  supported: boolean;
  errors: string[];
}

async function taskValidateCli(argv: string[]): Promise<void> {
  const { targetSource, jsonOutput } = parseSourceFilterArgs(
    argv,
    "crew task validate",
    VALIDATE_USAGE,
  );

  // jscpd:ignore-start -- shared source-loading boilerplate; extracting to a helper would break vi.mock
  const config = await loadConfig();
  const rawSources = sourcesFromConfig(config);
  const allSources = await buildSources(rawSources, { globalConfig: config });

  let sources = allSources;
  if (targetSource !== undefined) {
    sources = allSources.filter((s) => s.name === targetSource);
    if (sources.length === 0) {
      throw new Error(`crew task validate: no source named "${targetSource}"`);
    }
  }
  // jscpd:ignore-end

  const results: ValidateResult[] = await Promise.all(
    sources.map(async (source): Promise<ValidateResult> => {
      if (source.validate === undefined) {
        return { source: source.name, supported: false, errors: [] };
      }
      const errors = await source.validate();
      return { source: source.name, supported: true, errors };
    }),
  );

  const hasErrors = results.some((r) => r.errors.length > 0);

  if (jsonOutput) {
    writeOutput(
      JSON.stringify(
        results.map(({ source, supported, errors }) => ({ source, supported, errors })),
        null,
        2,
      ),
    );
    if (hasErrors) {
      process.exitCode = 1;
    }
    return;
  }

  const nameWidth = Math.max(...results.map((r) => r.source.length));
  for (const result of results) {
    if (!result.supported) {
      writeOutput(`${result.source.padEnd(nameWidth)}  not supported`);
      continue;
    }
    if (result.errors.length === 0) {
      writeOutput(`${result.source.padEnd(nameWidth)}  ok`);
    } else {
      writeOutput(
        `${result.source.padEnd(nameWidth)}  ${result.errors.length} error(s)\n${result.errors.map((e) => `  - ${e}`).join("\n")}`,
      );
    }
  }

  if (hasErrors) {
    process.exitCode = 1;
  }
}

export async function taskCli(argv: string[]): Promise<void> {
  const [verb, ...rest] = argv;
  if (verb === "list") {
    await taskListCli(rest);
    return;
  }
  if (verb === "get") {
    await taskGetCli(rest);
    return;
  }
  if (verb === "create") {
    await taskCreateCli(rest);
    return;
  }
  if (verb === "done") {
    await taskDoneCli(rest);
    return;
  }
  if (verb === "validate") {
    await taskValidateCli(rest);
    return;
  }
  throw new Error(TASK_USAGE);
}
