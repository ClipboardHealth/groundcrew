/**
 * Deep status module: collection produces one discriminated snapshot without
 * printing, then either renderer consumes that same snapshot. JSON exposes the
 * stable integration fields while text keeps operator-only hints and log lines
 * in private renderer details.
 */

import { readFileSync } from "node:fs";

import type { Board } from "../lib/board.ts";
import { loadConfig, type ResolvedConfig } from "../lib/config.ts";
import { probePullRequestsForBranch, type PullRequestSummary } from "../lib/pullRequests.ts";
import { readRunState, type RunState } from "../lib/runState.ts";
import {
  type JoinedStatus,
  type JoinedTask,
  type JoinedWorktree,
  joinStatus,
} from "../lib/statusJoin.ts";
import {
  buildRemoteDocument,
  type LocalStatusDocument,
  type RemoteFetchResult,
  type StatusBlockedIssue,
  type StatusLifecycle,
  type StatusBoardIssue,
  type StatusQueueIssue,
  type StatusSourceIssue,
} from "../lib/statusSnapshot.ts";
import {
  type CanonicalStatus,
  type Issue as SourceIssue,
  naturalIdFromCanonical,
} from "../lib/taskSource.ts";
import { errorMessage, withLogOutputSuppressed, writeOutput } from "../lib/util.ts";
import { type WorkspaceAccessHint, type WorkspaceProbe, workspaces } from "../lib/workspaces.ts";
import { type WorktreeDirtiness, type WorktreeKind, worktrees } from "../lib/worktrees.ts";
import { probeEffectiveBranchNameFromRunState } from "../lib/worktreeRunState.ts";
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
  /** Emit one stable status snapshot as JSON. */
  json?: boolean;
}

export type StatusRecommendedAction =
  | "stop"
  | "resume"
  | "cleanup"
  | "run"
  | "open-task"
  | "open-pr"
  | "open-worktree";

export type StatusProblemCode =
  | "source-probe-failed"
  | "workspace-probe-failed"
  | "git-probe-failed"
  | "github-probe-failed";

export interface StatusProblem {
  code: StatusProblemCode;
  message: string;
  task?: string | undefined;
  source?: string | undefined;
  worktreeDirectory?: string | undefined;
}

export interface StatusTaskIdentity {
  id?: string | undefined;
  naturalId: string;
  title?: string | undefined;
  status?: CanonicalStatus | undefined;
  url?: string | undefined;
}

export interface StatusRun {
  lifecycle: StatusLifecycle;
  agent?: string | undefined;
  startedAt?: string | undefined;
  updatedAt?: string | undefined;
  resumeCount?: number | undefined;
  reason?: string | undefined;
}

export interface StatusWorkspace {
  state: "live" | "exited" | "not-live" | "unknown";
}

export interface StatusPullRequest {
  url: string;
  number: number;
  state: string;
  title: string;
}

export interface TaskStatusWorktree {
  repository: string;
  kind: WorktreeKind;
  branch: string;
  directory: string;
  dirtiness: WorktreeDirtiness;
  pullRequests: StatusPullRequest[];
}

export interface StatusWorktreeSnapshot extends TaskStatusWorktree {
  task: StatusTaskIdentity;
  run: StatusRun;
  workspace: StatusWorkspace;
  recommendedActions: StatusRecommendedAction[];
}

export interface StatusQueueEntry {
  task: StatusTaskIdentity;
  repository?: string | undefined;
  agent?: string | undefined;
  recommendedActions: StatusRecommendedAction[];
}

export interface StatusBlockerSnapshot {
  id: string;
  naturalId: string;
  status: CanonicalStatus;
  nativeStatus?: string | undefined;
}

export interface StatusBlockedQueueEntry extends StatusQueueEntry {
  blockedBy: StatusBlockerSnapshot[];
}

export interface StatusStraySession {
  name: string;
  state: "live" | "exited";
  recommendedActions: StatusRecommendedAction[];
}

export interface InventoryStatusSnapshot {
  kind: "inventory";
  generatedAt: string;
  slots: { used?: number | undefined; maximum: number };
  worktrees: StatusWorktreeSnapshot[];
  inProgressWithoutWorktrees: StatusQueueEntry[];
  queue: { ready: StatusQueueEntry[]; blocked: StatusBlockedQueueEntry[] };
  straySessions: StatusStraySession[];
  problems: StatusProblem[];
  text: InventoryTextDetails;
}

export interface TaskStatusSnapshot {
  kind: "task";
  generatedAt: string;
  task: StatusTaskIdentity;
  repository?: string | undefined;
  run: StatusRun;
  workspace: StatusWorkspace;
  worktrees: TaskStatusWorktree[];
  recommendedActions: StatusRecommendedAction[];
  problems: StatusProblem[];
  text: TaskTextDetails;
}

export type StatusSnapshot = InventoryStatusSnapshot | TaskStatusSnapshot;

export async function collectStatus(
  config: ResolvedConfig,
  options: StatusOptions = {},
): Promise<StatusSnapshot> {
  const task = options.task?.trim().toLowerCase();
  if (task !== undefined) {
    if (task.length === 0 || task.startsWith("-")) {
      throw new Error("task must be a non-empty value");
    }
    return await collectTaskSnapshot({ config, task, includeRecentLogs: options.json !== true });
  }
  const { local, attemptAt, result } = await collectBothTiers(config);
  const remote = buildRemoteDocument({ previous: undefined, attemptAt, result });
  const joined = joinStatus({ local, remote });
  return inventorySnapshot({
    generatedAt: attemptAt,
    local,
    joined,
    sources: remote.payload?.sourceByTask ?? {},
    githubProblems: result.pullRequestProblems,
    sourceProblems: result.sourceProblems,
    sourceError: remote.lastAttemptError,
  });
}

export function renderStatusJson(snapshot: StatusSnapshot): void {
  if (snapshot.kind === "inventory") {
    writeOutput(
      JSON.stringify(
        {
          kind: snapshot.kind,
          generatedAt: snapshot.generatedAt,
          slots: snapshot.slots,
          worktrees: snapshot.worktrees,
          inProgressWithoutWorktrees: snapshot.inProgressWithoutWorktrees,
          queue: snapshot.queue,
          straySessions: snapshot.straySessions,
          problems: snapshot.problems,
        },
        undefined,
        2,
      ),
    );
    return;
  }
  writeOutput(
    JSON.stringify(
      {
        kind: snapshot.kind,
        generatedAt: snapshot.generatedAt,
        task: snapshot.task,
        repository: snapshot.repository,
        run: snapshot.run,
        workspace: snapshot.workspace,
        worktrees: snapshot.worktrees,
        recommendedActions: snapshot.recommendedActions,
        problems: snapshot.problems,
      },
      undefined,
      2,
    ),
  );
}

export function renderStatusText(snapshot: StatusSnapshot): void {
  if (snapshot.kind === "inventory") {
    writeInventoryStatus(snapshot.text);
    return;
  }
  writeTaskStatus({ snapshot, details: snapshot.text });
}

interface InventoryTextDetails {
  local: LocalStatusDocument;
  joined: JoinedStatus;
  boardError?: string | undefined;
  sourceProblems: RemoteFetchResult["sourceProblems"];
  renderedAt: Date;
}

interface TaskTextDetails {
  task: string;
  runState: RunState | undefined;
  sourceStatus: TaskSourceStatus;
  workspaceProbe: WorkspaceProbe;
  accessHint?: WorkspaceAccessHint | undefined;
  recentLogLines: string[];
}

const STATUS_USAGE = "Usage: crew status [<task>] [--json]";

function parseArguments(argv: string[]): StatusOptions {
  const options: StatusOptions = {};
  for (const argument of argv) {
    if (argument === "--json") {
      options.json = true;
      continue;
    }
    if (argument.startsWith("-")) {
      throw new Error(`crew status: unknown option: ${argument}\n${STATUS_USAGE}`);
    }
    if (argument.length === 0 || options.task !== undefined) {
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

function writeTaskWorktrees(entries: readonly TaskStatusWorktree[]): void {
  writeSection("Worktrees");
  if (entries.length === 0) {
    writeOutput("(none)");
    return;
  }
  for (const entry of entries) {
    writeOutput(`- ${entry.repository} ${entry.kind}`);
    writeOutput(`  branch: ${entry.branch}`);
    writeOutput(`  dir: ${entry.directory}`);
    writeOutput(`  git: ${formatDirtiness(entry.dirtiness)}`);
    if (entry.pullRequests.length > 0) {
      writeOutput(`  pr: ${formatPullRequests(entry.pullRequests)}`);
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
): Promise<Awaited<ReturnType<Board["resolveOneWithFailures"]>>> {
  return await withLogOutputSuppressed(async () => {
    const board = await buildBoard(config);
    return await board.resolveOneWithFailures(task);
  });
}

type TaskSourceStatus =
  | {
      kind: "found";
      issue: SourceIssue;
      failures: Array<{ source: string; reason: string }>;
    }
  | { kind: "not-found" }
  | { kind: "unavailable"; reason: string };

async function readTaskSourceStatus(
  config: ResolvedConfig,
  task: string,
): Promise<TaskSourceStatus> {
  try {
    const resolution = await resolveTaskSource(config, task);
    if (resolution.issue === undefined) {
      return { kind: "not-found" };
    }
    return {
      kind: "found",
      issue: resolution.issue,
      failures: resolution.failures.map((failure) => ({
        source: failure.source,
        reason: errorMessage(failure.reason),
      })),
    };
  } catch (error) {
    return { kind: "unavailable", reason: errorMessage(error) };
  }
}

function writeRecentLogs(logLines: readonly string[]): void {
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

function writeTaskStatus(input: { snapshot: TaskStatusSnapshot; details: TaskTextDetails }): void {
  const { snapshot, details } = input;
  const { task, runState, sourceStatus, workspaceProbe, accessHint, recentLogLines } = details;
  const displayTask = task.toUpperCase();
  writeOutput(`groundcrew status ${displayTask}`);
  writeOutput("=".repeat(`groundcrew status ${displayTask}`.length));

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

  writeTaskWorktrees(snapshot.worktrees);
  writeRecentLogs(recentLogLines);
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
  const rows: Array<{ task: JoinedTask; worktree: JoinedWorktree }> = joined.tasks.flatMap((task) =>
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

function writeInventoryRow(input: { task: JoinedTask; worktree: JoinedWorktree; now: Date }): void {
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
  if (worktree.pullRequests.length > 0) {
    writeOutput(inventoryField("pr", formatPullRequests(worktree.pullRequests)));
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

interface CollectedTiers {
  local: LocalStatusDocument;
  attemptAt: string;
  result: RemoteFetchResult;
}

/**
 * Runs both tiers. The board fetch starts first because it needs nothing
 * local; only the pull request lookups wait on resolved branches.
 */
async function collectBothTiers(config: ResolvedConfig): Promise<CollectedTiers> {
  const attemptAt = new Date().toISOString();
  const boardPromise = fetchBoardIssues(config);
  const local = await collectLocalStatus({ config });
  const result = await collectRemoteStatus({
    board: await boardPromise,
    pullRequestTargets: pullRequestTargetsOf(local),
  });
  return { local, attemptAt, result };
}

function taskIdentity(input: {
  naturalId: string;
  cachedTitle?: string | undefined;
  cachedUrl?: string | undefined;
  source?: StatusSourceIssue | undefined;
}): StatusTaskIdentity {
  const { naturalId, cachedTitle, cachedUrl, source } = input;
  return {
    id: source?.id,
    naturalId,
    title: source?.title ?? cachedTitle,
    status: source?.status,
    url: source?.url ?? cachedUrl,
  };
}

function runSnapshot(task: JoinedTask): StatusRun {
  return {
    lifecycle: task.lifecycle,
    agent: task.agent,
    startedAt: task.startedAt,
    updatedAt: task.updatedAt,
    resumeCount: task.resumeCount,
    reason: task.reason,
  };
}

function worktreeActions(input: {
  task: JoinedTask;
  identity: StatusTaskIdentity;
  pullRequests: readonly PullRequestSummary[];
}): StatusRecommendedAction[] {
  const { task, identity, pullRequests } = input;
  const actions: StatusRecommendedAction[] = [];
  if (task.flags.includes("stray session") || task.flags.includes("stray exited session")) {
    actions.push("cleanup");
  } else if (task.flags.includes("session dead") || task.flags.includes("session exited")) {
    actions.push("resume");
  } else if (task.session === "live") {
    actions.push("stop");
  } else if (task.lifecycle === "interrupted" && task.session !== "unknown") {
    actions.push("resume");
  }
  if (identity.url !== undefined) {
    actions.push("open-task");
  }
  if (pullRequests.length > 0) {
    actions.push("open-pr");
  }
  actions.push("open-worktree");
  return actions;
}

interface QueueIdentityInput {
  issue: StatusBoardIssue | StatusQueueIssue | StatusBlockedIssue;
  canonicalStatus: CanonicalStatus;
}

function queueIdentity(input: QueueIdentityInput): StatusTaskIdentity {
  const { issue, canonicalStatus } = input;
  return {
    id: issue.id,
    naturalId: issue.naturalId,
    title: issue.title,
    status: canonicalStatus,
    url: issue.url,
  };
}

function queueEntry(input: QueueIdentityInput): StatusQueueEntry {
  const { issue, canonicalStatus } = input;
  const task = queueIdentity({ issue, canonicalStatus });
  return {
    task,
    repository: issue.repository,
    agent: issue.agent,
    recommendedActions: task.url === undefined ? [] : ["open-task"],
  };
}

function inProgressWithoutWorktreeEntry(issue: StatusBoardIssue): StatusQueueEntry {
  const entry = queueEntry({ issue, canonicalStatus: "in-progress" });
  const canRun = issue.repository !== undefined && issue.agent !== undefined;
  return {
    ...entry,
    recommendedActions: canRun ? [...entry.recommendedActions, "run"] : entry.recommendedActions,
  };
}

function publicProblemMessage(input: {
  code: StatusProblemCode;
  source?: string | undefined;
}): string {
  const { code, source } = input;
  if (code === "source-probe-failed" && source !== undefined) {
    return `Source "${source}" probe failed`;
  }
  return {
    "source-probe-failed": "Source probe failed",
    "workspace-probe-failed": "Workspace probe failed",
    "git-probe-failed": "Git probe failed",
    "github-probe-failed": "GitHub probe failed",
  }[code];
}

function inventoryProblems(input: {
  local: LocalStatusDocument;
  joined: JoinedStatus;
  githubProblems: RemoteFetchResult["pullRequestProblems"];
  sourceProblems: RemoteFetchResult["sourceProblems"];
  sourceError?: string | undefined;
}): StatusProblem[] {
  const { local, joined, githubProblems, sourceProblems, sourceError } = input;
  const problems: StatusProblem[] = [];
  if (sourceError !== undefined) {
    problems.push({
      code: "source-probe-failed",
      message: publicProblemMessage({ code: "source-probe-failed" }),
    });
  }
  for (const problem of sourceProblems) {
    problems.push({
      code: "source-probe-failed",
      source: problem.source,
      message: publicProblemMessage({ code: "source-probe-failed", source: problem.source }),
    });
  }
  if (local.workspaceProbe.status === "unavailable") {
    problems.push({
      code: "workspace-probe-failed",
      message: publicProblemMessage({ code: "workspace-probe-failed" }),
    });
  }
  for (const task of joined.tasks) {
    for (const worktree of task.worktrees) {
      if (worktree.branchProblem !== undefined || worktree.git.kind === "unknown") {
        problems.push({
          code: "git-probe-failed",
          message: publicProblemMessage({ code: "git-probe-failed" }),
          task: task.task,
          worktreeDirectory: worktree.dir,
        });
      }
    }
  }
  for (const problem of githubProblems) {
    const task = joined.tasks.find((candidate) =>
      candidate.worktrees.some((worktree) => worktree.dir === problem.directory),
    );
    problems.push({
      code: "github-probe-failed",
      message: publicProblemMessage({ code: "github-probe-failed" }),
      task: task?.task,
      worktreeDirectory: problem.directory,
    });
  }
  return problems;
}

function inventorySnapshot(input: {
  generatedAt: string;
  local: LocalStatusDocument;
  joined: JoinedStatus;
  sources: Record<string, StatusSourceIssue>;
  githubProblems: RemoteFetchResult["pullRequestProblems"];
  sourceProblems: RemoteFetchResult["sourceProblems"];
  sourceError?: string | undefined;
}): InventoryStatusSnapshot {
  const { generatedAt, local, joined, sources, githubProblems, sourceProblems, sourceError } =
    input;
  const worktreeSnapshots = joined.tasks.flatMap((task) => {
    const source = Object.hasOwn(sources, task.task) ? sources[task.task] : undefined;
    const identity = taskIdentity({
      naturalId: task.task,
      cachedTitle: task.title,
      cachedUrl: task.url,
      source,
    });
    return task.worktrees.map((worktree) => ({
      task: identity,
      run: runSnapshot(task),
      workspace: { state: task.session },
      repository: worktree.repository,
      kind: worktree.kind,
      branch: worktree.branch,
      directory: worktree.dir,
      dirtiness: worktree.git,
      pullRequests: [...worktree.pullRequests],
      recommendedActions: worktreeActions({
        task,
        identity,
        pullRequests: worktree.pullRequests,
      }),
    }));
  });

  return {
    kind: "inventory",
    generatedAt,
    slots: {
      used: sourceProblems.length === 0 ? joined.slots?.used : undefined,
      maximum: local.maximumInProgress,
    },
    worktrees: worktreeSnapshots,
    inProgressWithoutWorktrees: joined.inProgressWithoutWorktree.map(
      inProgressWithoutWorktreeEntry,
    ),
    queue: {
      ready: joined.queueReady.map((issue) => queueEntry({ issue, canonicalStatus: "todo" })),
      blocked: joined.queueBlocked.map((issue) => ({
        ...queueEntry({ issue, canonicalStatus: "todo" }),
        blockedBy: issue.blockedBy,
      })),
    },
    straySessions: local.orphanedSessions.map((name) => ({
      name,
      state: local.exitedOrphanedSessions?.includes(name) === true ? "exited" : "live",
      recommendedActions: ["stop"],
    })),
    problems: inventoryProblems({
      local,
      joined,
      githubProblems,
      sourceProblems,
      sourceError,
    }),
    text: {
      local,
      joined,
      boardError: sourceError,
      sourceProblems,
      renderedAt: new Date(),
    },
  };
}

function taskIdentityFromStatus(input: {
  task: string;
  runState: RunState | undefined;
  sourceStatus: TaskSourceStatus;
}): StatusTaskIdentity {
  const { task, runState, sourceStatus } = input;
  if (sourceStatus.kind === "found") {
    return {
      id: sourceStatus.issue.id,
      naturalId: naturalIdFromCanonical(sourceStatus.issue.id),
      title: sourceStatus.issue.title,
      status: sourceStatus.issue.status,
      url: sourceStatus.issue.url ?? runState?.url,
    };
  }
  return {
    naturalId: task,
    title: runState?.title,
    url: runState?.url,
  };
}

function runSnapshotFromState(runState: RunState | undefined): StatusRun {
  return {
    lifecycle: runState?.state ?? "idle",
    agent: runState?.agent,
    startedAt: runState?.createdAt,
    updatedAt: runState?.updatedAt,
    resumeCount: runState?.resumeCount,
    reason: runState?.reason,
  };
}

function workspaceSnapshot(input: { probe: WorkspaceProbe; task: string }): StatusWorkspace {
  const { probe, task } = input;
  if (probe.kind === "unavailable") {
    return { state: "unknown" };
  }
  if (isWorkspaceExited({ probe, task })) {
    return { state: "exited" };
  }
  return { state: probe.names.has(task) ? "live" : "not-live" };
}

async function collectTaskWorktree(input: {
  entry: ReturnType<typeof worktrees.findByTask>[number];
  runState: RunState | undefined;
}): Promise<{
  worktree: TaskStatusWorktree;
  branchProblem?: string | undefined;
  githubProblem?: string | undefined;
}> {
  const { entry, runState } = input;
  const [branchProbe, dirtiness] = await Promise.all([
    probeEffectiveBranchNameFromRunState({ entry, runState }),
    worktrees.probeWorkingTree({ worktreeDir: entry.dir }),
  ]);
  let pullRequests: readonly PullRequestSummary[] = [];
  let githubProblem: string | undefined;
  try {
    const result = await probePullRequestsForBranch({
      cwd: entry.dir,
      branchName: branchProbe.branch,
    });
    pullRequests = result.pullRequests;
    githubProblem = result.problem;
  } catch (error) {
    githubProblem = errorMessage(error);
  }
  return {
    worktree: {
      repository: entry.repository,
      kind: entry.kind,
      branch: branchProbe.branch,
      directory: entry.dir,
      dirtiness,
      pullRequests: [...pullRequests],
    },
    branchProblem: branchProbe.problem,
    githubProblem,
  };
}

function taskRecommendedActions(input: {
  identity: StatusTaskIdentity;
  run: StatusRun;
  workspace: StatusWorkspace;
  worktrees: readonly TaskStatusWorktree[];
}): StatusRecommendedAction[] {
  const { identity, run, workspace, worktrees: taskWorktrees } = input;
  const actions: StatusRecommendedAction[] = [];
  if (run.lifecycle === "idle" && (workspace.state === "live" || workspace.state === "exited")) {
    actions.push(taskWorktrees.length === 0 ? "stop" : "cleanup");
  } else if (workspace.state === "live") {
    actions.push("stop");
  } else if (
    taskWorktrees.length > 0 &&
    (workspace.state === "not-live" || workspace.state === "exited") &&
    (run.lifecycle === "interrupted" || run.lifecycle === "running" || run.lifecycle === "resumed")
  ) {
    actions.push("resume");
  }
  if (identity.url !== undefined) {
    actions.push("open-task");
  }
  if (taskWorktrees.some((worktree) => worktree.pullRequests.length > 0)) {
    actions.push("open-pr");
  }
  if (taskWorktrees.length > 0) {
    actions.push("open-worktree");
  }
  return actions;
}

async function collectTaskSnapshot(input: {
  config: ResolvedConfig;
  task: string;
  includeRecentLogs: boolean;
}): Promise<TaskStatusSnapshot> {
  const { config, task, includeRecentLogs } = input;
  const localTask = naturalIdFromCanonical(task);
  const generatedAt = new Date().toISOString();
  const runState = readRunState(config, localTask);
  const [workspaceProbe, sourceStatus] = await Promise.all([
    withLogOutputSuppressed(async () => await workspaces.probe(config)),
    readTaskSourceStatus(config, task),
  ]);
  const accessHint = await exitedWorkspaceAccessHint(config, workspaceProbe, localTask);
  const entries = worktrees.findByTask(config, localTask);
  const collectedWorktrees = await Promise.all(
    entries.map(async (entry) => await collectTaskWorktree({ entry, runState })),
  );
  const taskWorktrees = collectedWorktrees.map((collected) => collected.worktree);
  const identity = taskIdentityFromStatus({ task: localTask, runState, sourceStatus });
  const run = runSnapshotFromState(runState);
  const workspace = workspaceSnapshot({ probe: workspaceProbe, task: localTask });
  const problems: StatusProblem[] = [];
  if (sourceStatus.kind === "unavailable") {
    problems.push({
      code: "source-probe-failed",
      message: publicProblemMessage({ code: "source-probe-failed" }),
      task: localTask,
    });
  } else if (sourceStatus.kind === "found") {
    for (const failure of sourceStatus.failures) {
      problems.push({
        code: "source-probe-failed",
        message: publicProblemMessage({
          code: "source-probe-failed",
          source: failure.source,
        }),
        source: failure.source,
        task: localTask,
      });
    }
  }
  if (workspaceProbe.kind === "unavailable") {
    problems.push({
      code: "workspace-probe-failed",
      message: publicProblemMessage({ code: "workspace-probe-failed" }),
      task: localTask,
    });
  }
  for (const collected of collectedWorktrees) {
    if (collected.branchProblem !== undefined || collected.worktree.dirtiness.kind === "unknown") {
      problems.push({
        code: "git-probe-failed",
        message: publicProblemMessage({ code: "git-probe-failed" }),
        task: localTask,
        worktreeDirectory: collected.worktree.directory,
      });
    }
    if (collected.githubProblem === undefined) {
      continue;
    }
    problems.push({
      code: "github-probe-failed",
      message: publicProblemMessage({ code: "github-probe-failed" }),
      task: localTask,
      worktreeDirectory: collected.worktree.directory,
    });
  }
  const snapshot: TaskStatusSnapshot = {
    kind: "task",
    generatedAt,
    task: identity,
    repository:
      sourceStatus.kind === "found"
        ? (sourceStatus.issue.repository ?? runState?.repository)
        : runState?.repository,
    run,
    workspace,
    worktrees: taskWorktrees,
    recommendedActions: taskRecommendedActions({
      identity,
      run,
      workspace,
      worktrees: taskWorktrees,
    }),
    problems,
    text: {
      task: localTask,
      runState,
      sourceStatus,
      workspaceProbe,
      accessHint,
      recentLogLines: includeRecentLogs
        ? recentTaskLogLines({ lines: wholeLogLines(config), task: localTask })
        : [],
    },
  };
  return snapshot;
}

function writeInventoryStatus(details: InventoryTextDetails): void {
  const { local, joined, boardError, sourceProblems, renderedAt } = details;
  writeInventoryWorktrees(joined, renderedAt);
  writeStraySessions(local);
  writeInProgressWithoutWorktree(joined);
  if (sourceProblems.length > 0) {
    writeSection("Source problems");
    for (const problem of sourceProblems) {
      writeOutput(`${problem.source}: ${problem.message}`);
    }
  }
  if (joined.slots !== undefined) {
    writeOutput();
    writeOutput(
      sourceProblems.length === 0
        ? `slots: ${joined.slots.used}/${joined.slots.maximum} used`
        : `slots: unknown/${joined.slots.maximum} used (source data incomplete)`,
    );
  }
  writeQueueSections({ joined, boardError });
}

export async function status(config: ResolvedConfig, options: StatusOptions = {}): Promise<void> {
  const snapshot = await collectStatus(config, options);
  if (options.json === true) {
    renderStatusJson(snapshot);
  } else {
    renderStatusText(snapshot);
  }
}

export async function statusCli(argv: string[]): Promise<void> {
  const options = parseArguments(argv);
  const config =
    options.json === true
      ? await withLogOutputSuppressed(async () => await loadConfig())
      : await loadConfig();
  await status(config, options);
}
