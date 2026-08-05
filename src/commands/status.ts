import { readFileSync } from "node:fs";

import { loadConfig, type ResolvedConfig } from "../lib/config.ts";
import { findPullRequestsForBranch, type PullRequestSummary } from "../lib/pullRequests.ts";
import { readRunState, type RunState } from "../lib/runState.ts";
import { type JoinedStatus, type JoinedTask, joinStatus } from "../lib/statusJoin.ts";
import {
  buildRemoteDocument,
  type LocalStatusDocument,
  readRemoteSnapshot,
  type StatusBlockedIssue,
  type StatusLifecycle,
  type StatusBoardIssue,
  type StatusQueueIssue,
  type StatusWorktree,
  writeLocalSnapshot,
  writeRemoteSnapshot,
} from "../lib/statusSnapshot.ts";
import {
  type CanonicalStatus,
  type Issue as SourceIssue,
  naturalIdFromCanonical,
} from "../lib/taskSource.ts";
import { errorMessage, withLogOutputSuppressed, writeOutput } from "../lib/util.ts";
import { type WorkspaceAccessHint, type WorkspaceProbe, workspaces } from "../lib/workspaces.ts";
import { type WorktreeDirtiness, worktrees } from "../lib/worktrees.ts";
import { effectiveBranchNameFromRunState } from "../lib/worktreeRunState.ts";
import {
  buildBoard,
  collectLocalStatus,
  collectRemoteStatus,
  disagreementLabel,
  fetchBoardIssues,
  isWorkspaceExited,
  probeDisagreement,
  type PullRequestTarget,
  recentTaskLogLines,
  workspaceProbeUnavailableText,
} from "./statusCollect.ts";

export interface StatusOptions {
  task?: string;
  /** Emit the snapshot documents as JSON and persist them. */
  json?: boolean;
  /** Collect the local tier only. Guarantees this run makes no network call. */
  localOnly?: boolean;
}

const STATUS_USAGE = "Usage: crew status [<task>] [--json [--local-only]]";

function parseArguments(argv: string[]): StatusOptions {
  const options: StatusOptions = {};
  for (const argument of argv) {
    if (argument === "--json") {
      options.json = true;
      continue;
    }
    if (argument === "--local-only") {
      options.localOnly = true;
      continue;
    }
    if (argument.length === 0 || argument.startsWith("-") || options.task !== undefined) {
      throw new Error(STATUS_USAGE);
    }
    options.task = argument.toLowerCase();
  }
  return options;
}

function writeSection(title: string): void {
  writeOutput();
  writeOutput(title);
  writeOutput("-".repeat(title.length));
}

function formatDirtiness(dirtiness: WorktreeDirtiness): string {
  if (dirtiness.kind === "dirty") {
    return `dirty (${dirtiness.modified} modified, ${dirtiness.untracked} untracked)`;
  }
  return dirtiness.kind;
}

async function writeTaskWorktrees(config: ResolvedConfig, task: string): Promise<void> {
  writeSection("Worktrees");
  const entries = worktrees.findByTask(config, task);
  if (entries.length === 0) {
    writeOutput("(none)");
    return;
  }
  const runState = readRunState(config, task);
  for (const entry of entries) {
    // oxlint-disable-next-line no-await-in-loop -- status output is easier to read in worktree order.
    const branchName = await effectiveBranchNameFromRunState({ entry, runState });
    // oxlint-disable-next-line no-await-in-loop -- status output is easier to read in worktree order.
    const dirtiness = await worktrees.probeWorkingTree({
      worktreeDir: entry.dir,
    });
    // oxlint-disable-next-line no-await-in-loop -- one gh lookup per worktree is acceptable; multi-worktree-per-task is rare.
    const prs = await findPullRequestsForBranch({
      cwd: entry.dir,
      branchName,
    });
    writeOutput(`- ${entry.repository} ${entry.kind}`);
    writeOutput(`  branch: ${branchName}`);
    writeOutput(`  dir: ${entry.dir}`);
    writeOutput(`  git: ${formatDirtiness(dirtiness)}`);
    if (prs.length > 0) {
      writeOutput(`  pr: ${formatPullRequests(prs)}`);
    }
  }
}

function taskWorkspaceText(probe: WorkspaceProbe, task: string): string {
  if (probe.kind === "unavailable") {
    return workspaceProbeUnavailableText(probe);
  }
  if (isWorkspaceExited({ probe, task })) {
    return "exited";
  }
  return probe.names.has(task) ? "live" : "not live";
}

function formatRunState(state: RunState | undefined, flags: readonly string[] = []): string {
  if (state === undefined) {
    return "(none)";
  }
  // Only the leading lifecycle token gains the reconciliation flags; the
  // `;`-separated detail (agent/updated/resumes/reason) is preserved verbatim.
  const lifecycle = flags.length === 0 ? state.state : `${state.state} (${flags.join(", ")})`;
  const summary = `${lifecycle}; agent=${state.agent}; updated=${state.updatedAt}; resumes=${state.resumeCount}`;
  const detail = state.reason ?? state.detail;
  return detail === undefined ? summary : `${summary}; ${detail}`;
}

/**
 * The one-shot per-task view reads the whole log rather than the bounded tail
 * the pollable collector uses, so an old task still shows its history.
 */
function wholeLogLines(config: ResolvedConfig): string[] {
  try {
    return readFileSync(config.logging.file, "utf8").split("\n");
  } catch {
    return [];
  }
}

async function resolveTaskSource(
  config: ResolvedConfig,
  task: string,
): Promise<SourceIssue | undefined> {
  const board = await buildBoard(config);
  return await withLogOutputSuppressed(async () => await board.resolveOne(task));
}

type TaskSourceStatus =
  | { kind: "found"; issue: SourceIssue }
  | { kind: "not-found" }
  | { kind: "unavailable"; reason: string };

async function readTaskSourceStatus(
  config: ResolvedConfig,
  task: string,
): Promise<TaskSourceStatus> {
  try {
    const issue = await resolveTaskSource(config, task);
    if (issue === undefined) {
      return { kind: "not-found" };
    }
    return { kind: "found", issue };
  } catch (error) {
    return { kind: "unavailable", reason: errorMessage(error) };
  }
}

function writeRecentLogs(config: ResolvedConfig, task: string): void {
  const logLines = recentTaskLogLines({ lines: wholeLogLines(config), task });
  if (logLines.length === 0) {
    return;
  }
  writeSection("Recent logs");
  writeOutput(logLines.join("\n"));
}

async function exitedWorkspaceAccessHint(
  config: ResolvedConfig,
  probe: WorkspaceProbe,
  task: string,
): Promise<WorkspaceAccessHint | undefined> {
  if (!isWorkspaceExited({ probe, task })) {
    return undefined;
  }
  try {
    return await withLogOutputSuppressed(async () => await workspaces.accessHint(config, task));
  } catch {
    return undefined;
  }
}

function formatTaskLine(
  task: string,
  runState: RunState | undefined,
  sourceStatus: TaskSourceStatus,
): string {
  const parts = [`task: ${task}`];
  if (sourceStatus.kind === "found") {
    parts.push(sourceStatus.issue.status);
  }
  const url =
    sourceStatus.kind === "found" ? (sourceStatus.issue.url ?? runState?.url) : runState?.url;
  if (url !== undefined) {
    parts.push(url);
  }
  if (sourceStatus.kind === "not-found") {
    parts.push("source not found");
  }
  if (sourceStatus.kind === "unavailable") {
    parts.push(`source unavailable: ${sourceStatus.reason}`);
  }
  return parts.join("  ");
}

function writeTaskTitle(runState: RunState | undefined, sourceStatus: TaskSourceStatus): void {
  const cachedTitle = runState?.title;
  const sourceTitle = sourceStatus.kind === "found" ? sourceStatus.issue.title : undefined;
  const title = cachedTitle ?? sourceTitle;
  if (title !== undefined) {
    writeOutput(`title: ${title}`);
  }
  if (cachedTitle !== undefined && sourceTitle !== undefined && cachedTitle !== sourceTitle) {
    writeOutput(`source title: ${sourceTitle}`);
  }
}

async function writeTaskStatus(config: ResolvedConfig, rawTask: string): Promise<void> {
  const task = rawTask.toLowerCase();
  const displayTask = task.toUpperCase();
  writeOutput(`groundcrew status ${displayTask}`);
  writeOutput("=".repeat(`groundcrew status ${displayTask}`.length));

  const runState = readRunState(config, task);
  const [workspaceProbe, sourceStatus] = await Promise.all([
    withLogOutputSuppressed(async () => await workspaces.probe(config)),
    readTaskSourceStatus(config, task),
  ]);
  const accessHint = await exitedWorkspaceAccessHint(config, workspaceProbe, task);
  writeOutput(formatTaskLine(task, runState, sourceStatus));
  writeTaskTitle(runState, sourceStatus);
  const disagreement = probeDisagreement({
    lifecycle: runState?.state ?? "idle",
    probe: workspaceProbe,
    task,
  });
  writeOutput(
    `run: ${formatRunState(runState, disagreement === undefined ? [] : [disagreementLabel(disagreement)])}`,
  );
  writeOutput(`workspace: ${taskWorkspaceText(workspaceProbe, task)}`);
  if (accessHint !== undefined) {
    writeOutput(`attach: ${accessHint.command}`);
  }

  await writeTaskWorktrees(config, task);
  writeRecentLogs(config, task);
}

/**
 * Wall-clock time since the run was first recorded. Undefined unless the row is
 * actively running, so an idle or finished row shows no age.
 */
function runDurationMs(input: {
  lifecycle: StatusLifecycle;
  startedAt: string | undefined;
  now: Date;
}): number | undefined {
  const { lifecycle, startedAt, now } = input;
  if (lifecycle !== "running" && lifecycle !== "resumed") {
    return undefined;
  }
  /* v8 ignore next @preserve -- a running lifecycle always carries a run state, which always has createdAt */
  const created = Date.parse(startedAt ?? "");
  if (Number.isNaN(created)) {
    return undefined;
  }
  return now.getTime() - created;
}

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

function formatDuration(ms: number): string {
  if (ms < MS_PER_MINUTE) {
    return "<1m";
  }
  if (ms < MS_PER_HOUR) {
    return `${Math.floor(ms / MS_PER_MINUTE)}m`;
  }
  if (ms < MS_PER_DAY) {
    const hours = Math.floor(ms / MS_PER_HOUR);
    const minutes = Math.floor((ms - hours * MS_PER_HOUR) / MS_PER_MINUTE);
    return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
  }
  const days = Math.floor(ms / MS_PER_DAY);
  const hours = Math.floor((ms - days * MS_PER_DAY) / MS_PER_HOUR);
  return hours === 0 ? `${days}d` : `${days}d ${hours}h`;
}

/** Elapsed time is derived here, never stored, so a row cannot show a stale age. */
function inventoryStateText(task: JoinedTask, now: Date): string {
  const flags = [...task.flags];
  const duration = runDurationMs({ lifecycle: task.lifecycle, startedAt: task.startedAt, now });
  if (duration !== undefined) {
    flags.push(formatDuration(duration));
  }
  return flags.length === 0 ? task.lifecycle : `${task.lifecycle} (${flags.join(", ")})`;
}

const INVENTORY_LABEL_WIDTH = "worktree:".length;

function inventoryField(label: string, value: string): string {
  return `  ${`${label}:`.padEnd(INVENTORY_LABEL_WIDTH)}  ${value}`;
}

function formatPullRequests(prs: readonly PullRequestSummary[]): string {
  return prs.map((pr) => `${pr.url} (${pr.state})`).join(", ");
}

/**
 * Inventory `task:` value: the worktree's remote canonical status. Slots are
 * consumed solely by `in-progress` issues, so that one status is spelled out as
 * `slot held` to make the otherwise-implicit rule legible on the row; every
 * other status renders bare.
 */
function formatTaskStatus(canonicalStatus: CanonicalStatus): string {
  return canonicalStatus === "in-progress" ? "in-progress (slot held)" : canonicalStatus;
}

/** The document groups worktrees by task; rows are per worktree. */
function writeInventoryWorktrees(joined: JoinedStatus, now: Date): void {
  writeSection("Worktrees");
  const rows = joined.tasks.flatMap((task) =>
    task.worktrees.map((worktree) => ({ task, worktree })),
  );
  if (rows.length === 0) {
    writeOutput("(none)");
    return;
  }
  for (const [index, row] of rows.entries()) {
    if (index > 0) {
      writeOutput();
    }
    writeInventoryRow({ ...row, now });
  }
}

function writeInventoryRow(input: { task: JoinedTask; worktree: StatusWorktree; now: Date }): void {
  const { task, worktree, now } = input;
  writeOutput(task.url === undefined ? task.task : `${task.task}  ${task.url}`);
  if (task.title !== undefined) {
    writeOutput(inventoryField("title", task.title));
  }
  writeOutput(inventoryField("state", inventoryStateText(task, now)));
  // `state:` is the local run lifecycle; `task:` is the remote status that
  // actually drives the slot count. They're sourced independently and can
  // legitimately disagree, so they sit adjacent. Omitted when the board fetch
  // failed or the task isn't in the fetched board.
  if (task.boardStatus !== undefined) {
    writeOutput(inventoryField("task", formatTaskStatus(task.boardStatus)));
  }
  writeOutput(inventoryField("repo", worktree.repository));
  writeOutput(inventoryField("worktree", worktree.dir));
  if (task.attachCommand !== undefined) {
    writeOutput(inventoryField("attach", task.attachCommand));
  }
  if (task.pullRequests.length > 0) {
    writeOutput(inventoryField("pr", formatPullRequests(task.pullRequests)));
  }
  if (task.hint !== undefined) {
    writeOutput(inventoryField("hint", task.hint));
  }
}

const ORPHANED_SESSIONS_HEADER = "Orphaned sessions (no matching worktree)";
const ORPHANED_SESSIONS_ACTION =
  "What to do: run 'crew stop <task>' to close the session, or 'tmux kill-session -t <task>' if no run-state exists.";

function writeStraySessions(local: LocalStatusDocument): void {
  if (local.workspaceProbe.status === "unavailable") {
    // Surface probe failures so the user knows we couldn't classify orphans
    // (silently dropping the section would hide that diagnostic). The action
    // hint is omitted here — there's no row to act on.
    writeSection(ORPHANED_SESSIONS_HEADER);
    writeOutput(
      local.workspaceProbe.error === undefined
        ? "Workspace probe unavailable"
        : `Workspace probe unavailable: ${local.workspaceProbe.error}`,
    );
    return;
  }
  if (local.orphanedSessions.length === 0) {
    return;
  }
  writeSection(ORPHANED_SESSIONS_HEADER);
  writeOutput(ORPHANED_SESSIONS_ACTION);
  writeOutput(local.orphanedSessions.join("\n"));
}

function describeOpenBlockers(issue: StatusBlockedIssue): string {
  return issue.blockedBy
    .map(
      (blocker) =>
        `${naturalIdFromCanonical(blocker.id)} (${blocker.nativeStatus ?? blocker.status})`,
    )
    .join(", ");
}

function writeQueueIssue(issue: StatusQueueIssue): void {
  writeOutput(issue.url === undefined ? issue.naturalId : `${issue.naturalId}  ${issue.url}`);
  writeOutput(inventoryField("title", issue.title));
  writeOutput(inventoryField("repo", issue.repository));
  writeOutput(inventoryField("agent", issue.agent));
}

function writeQueueSections(input: { joined: JoinedStatus; boardError: string | undefined }): void {
  const { joined, boardError } = input;
  if (boardError !== undefined) {
    writeSection("Queue");
    writeOutput(`unavailable: ${boardError}`);
    return;
  }

  // Hide the section entirely when nothing's queued and nothing's blocked.
  if (joined.queueReady.length > 0) {
    writeSection("Queue");
    for (const [index, issue] of joined.queueReady.entries()) {
      if (index > 0) {
        writeOutput();
      }
      writeQueueIssue(issue);
    }
  }

  if (joined.queueBlocked.length > 0) {
    writeSection("Blocked");
    for (const [index, issue] of joined.queueBlocked.entries()) {
      if (index > 0) {
        writeOutput();
      }
      writeQueueIssue(issue);
      writeOutput(inventoryField("blocked by", describeOpenBlockers(issue)));
    }
  }
}

function writeInProgressIssue(issue: StatusBoardIssue): void {
  writeOutput(issue.url === undefined ? issue.naturalId : `${issue.naturalId}  ${issue.url}`);
  writeOutput(inventoryField("title", issue.title));
  // These are all in-progress by definition, but spell out the slot-held
  // status so every holder row reads the same whether or not it has a worktree.
  writeOutput(inventoryField("task", formatTaskStatus("in-progress")));
  if (issue.repository !== undefined) {
    writeOutput(inventoryField("repo", issue.repository));
  }
}

/** Reuses the branches the local pass resolved, so the remote pass re-reads nothing. */
function pullRequestTargetsOf(local: LocalStatusDocument): PullRequestTarget[] {
  return local.tasks.flatMap((task) =>
    task.worktrees.map((worktree) => ({
      task: task.task,
      dir: worktree.dir,
      branch: worktree.branch,
    })),
  );
}

const SLOT_HOLDERS_HEADER = "Slot holders with no local worktree";
const SLOT_HOLDERS_ACTION =
  "What to do: transition the ticket off 'in-progress' on the board, or run 'crew run <task>' to recreate the worktree locally.";

function writeInProgressWithoutWorktree(joined: JoinedStatus): void {
  if (joined.inProgressWithoutWorktree.length === 0) {
    return;
  }
  writeSection(SLOT_HOLDERS_HEADER);
  writeOutput(SLOT_HOLDERS_ACTION);
  for (const [index, issue] of joined.inProgressWithoutWorktree.entries()) {
    if (index > 0) {
      writeOutput();
    }
    writeInProgressIssue(issue);
  }
}

/**
 * `previous: undefined` is deliberate. Carry-forward is a monitor concern: a
 * one-shot text run must report only what this attempt saw, or a failed fetch
 * would print a queue recovered from an old snapshot where it prints
 * "unavailable" today.
 */
async function writeInventoryStatus(config: ResolvedConfig): Promise<void> {
  // The board fetch needs nothing local, so start it before awaiting the
  // local pass; only the pull request lookups depend on resolved branches.
  const boardPromise = fetchBoardIssues(config);
  const local = await collectLocalStatus({ config });
  const result = await collectRemoteStatus({
    config,
    board: await boardPromise,
    pullRequestTargets: pullRequestTargetsOf(local),
  });
  const remote = buildRemoteDocument({
    previous: undefined,
    attemptAt: new Date().toISOString(),
    result,
  });
  const joined = joinStatus({ local, remote });
  const now = new Date();

  writeInventoryWorktrees(joined, now);
  writeStraySessions(local);
  writeInProgressWithoutWorktree(joined);
  if (joined.slots !== undefined) {
    writeOutput();
    writeOutput(`slots: ${joined.slots.used}/${joined.slots.maximum} used`);
  }
  writeQueueSections({ joined, boardError: result.kind === "error" ? result.message : undefined });
}

/**
 * Emits the snapshot documents on stdout and persists them beside the log
 * file. The persisted copies let a monitor start warm, and let any other
 * reader see state without spawning a process.
 *
 * `--local-only` omits the `remote` key rather than setting it null: absent
 * means "not collected", where null would mean "collected and empty".
 */
async function writeJsonStatus(input: {
  config: ResolvedConfig;
  localOnly: boolean;
}): Promise<void> {
  const { config, localOnly } = input;
  // Started only in the full form, so --local-only never touches the network.
  const boardPromise = localOnly ? undefined : fetchBoardIssues(config);
  const local = await collectLocalStatus({ config });
  writeLocalSnapshot({ config, document: local });
  if (boardPromise === undefined) {
    writeOutput(JSON.stringify({ local }, undefined, 2));
    return;
  }
  const result = await collectRemoteStatus({
    config,
    board: await boardPromise,
    pullRequestTargets: pullRequestTargetsOf(local),
  });
  // Print what landed on disk, not what we built. When the monotonic guard
  // rejects our document because a concurrent run wrote a newer one, the two
  // differ, and stdout must never contradict the file.
  const remote = writeRemoteSnapshot({
    config,
    document: buildRemoteDocument({
      previous: readRemoteSnapshot(config),
      attemptAt: new Date().toISOString(),
      result,
    }),
  });
  writeOutput(JSON.stringify({ local, remote }, undefined, 2));
}

/**
 * The option combinations the command refuses. Lives apart from
 * `parseArguments` so the exported `status` enforces it too: a library caller
 * passing `localOnly` without `json` must not silently get the text path.
 */
function assertSupportedOptions(options: StatusOptions): void {
  if (options.localOnly === true && options.json !== true) {
    throw new Error("crew status: --local-only requires --json");
  }
  if (options.json === true && options.task !== undefined) {
    throw new Error("crew status: --json is not supported for a single task");
  }
}

export async function status(config: ResolvedConfig, options: StatusOptions = {}): Promise<void> {
  assertSupportedOptions(options);
  const task = options.task?.trim();
  if (options.json === true) {
    await writeJsonStatus({ config, localOnly: options.localOnly === true });
    return;
  }
  if (task === undefined) {
    await writeInventoryStatus(config);
    return;
  }
  if (task.length === 0 || task.startsWith("-")) {
    throw new Error("task must be a non-empty value");
  }
  await writeTaskStatus(config, task);
}

export async function statusCli(argv: string[]): Promise<void> {
  const options = parseArguments(argv);
  // Validate before loading config so a bad flag combination fails fast.
  assertSupportedOptions(options);
  const config = await loadConfig();
  await status(config, options);
}
