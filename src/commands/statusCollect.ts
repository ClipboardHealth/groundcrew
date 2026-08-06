/**
 * Gathers the two status tiers that the `crew status` inventory renders and
 * that `crew status --json` publishes. Owns every subprocess and network call
 * on that path, so the join and the wire format do no I/O.
 *
 * The per-task view in status.ts is deliberately not on this path: it reads
 * its own state, because it reads the whole log where this reads a tail.
 */

import { closeSync, fstatSync, openSync, readSync } from "node:fs";

import { type Board, createBoard } from "../lib/board.ts";
import { buildSources, sourcesFromConfig } from "../lib/buildSources.ts";
import type { ResolvedConfig } from "../lib/config.ts";
import { findPullRequestsForBranch, type PullRequestSummary } from "../lib/pullRequests.ts";
import { readRunState, type RunState } from "../lib/runState.ts";
import {
  type LocalStatusDocument,
  readLocalSnapshot,
  type RemoteFetchResult,
  STATUS_SNAPSHOT_SCHEMA_VERSION,
  type StatusBlockedIssue,
  type StatusBoardIssue,
  type StatusLifecycle,
  type StatusLogCursor,
  type StatusQueueIssue,
  type StatusSessionState,
  type StatusSourceIssue,
  type StatusTask,
  type StatusWorktree,
} from "../lib/statusSnapshot.ts";
import {
  type GroundcrewIssue,
  isGroundcrewIssue,
  type Issue as SourceIssue,
  naturalIdFromCanonical,
} from "../lib/taskSource.ts";
import { errorMessage, withLogOutputSuppressed } from "../lib/util.ts";
import { type WorkspaceProbe, workspaces } from "../lib/workspaces.ts";
import { effectiveBranchNameFromRunState } from "../lib/worktreeRunState.ts";
import { type WorktreeEntry, worktrees } from "../lib/worktrees.ts";

// Enough lines to show what a task just did, short enough for a status row.
const RECENT_LOG_LINE_COUNT = 10;

/**
 * Reverse-scan chunk size for the append-only shared log. Active tasks are
 * normally found in the first chunk; older tasks make the scan continue only
 * until their ten most recent matching lines have been found.
 */
const LOG_SCAN_CHUNK_BYTES = 256 * 1024;

export interface CollectLocalStatusInput {
  config: ResolvedConfig;
}

/**
 * Every call in the local tier is a local subprocess or file read, which is
 * what makes it safe for a monitor to poll every few seconds.
 */
export async function collectLocalStatus(
  input: CollectLocalStatusInput,
): Promise<LocalStatusDocument> {
  const { config } = input;
  const capturedAt = new Date().toISOString();
  const previous = readLocalSnapshot(config);
  const entries = worktrees
    .list(config)
    .toSorted((left, right) => left.task.localeCompare(right.task));
  const uniqueTasks = [...new Set(entries.map((entry) => entry.task))];
  const runStates = new Map(uniqueTasks.map((task) => [task, readRunState(config, task)]));
  const recentLogs = readRecentLogLines({ config, previous, tasks: uniqueTasks });

  // The probe and the git fan-out share no data, so overlap them. Access hints
  // wait for the probe: resolving the workspace adapter is only cached after
  // its first await, so racing them would re-probe host capabilities N times.
  const [probe, collected] = await Promise.all([
    withLogOutputSuppressed(async () => await workspaces.probe(config)),
    collectWorktreesByTask({ entries, runStates }),
  ]);
  const accessHints = await collectAccessHints({ config, tasks: uniqueTasks });

  const tasks: StatusTask[] = [...collected].map(([task, taskWorktrees]) => {
    const runState = runStates.get(task);
    const lifecycle = lifecycleOf(runState);
    const disagreement = probeDisagreement({ lifecycle, probe, task });
    return {
      task,
      title: runState?.title,
      url: runState?.url,
      agent: runState?.agent,
      lifecycle,
      flags: disagreement === undefined ? [] : [disagreementLabel(disagreement)],
      startedAt: runState?.createdAt,
      updatedAt: runState?.updatedAt,
      resumeCount: runState?.resumeCount,
      reason: runState?.reason,
      detail: runState?.detail,
      session: sessionState({ probe, task }),
      attachCommand: accessHints.get(task)?.command,
      hint: disagreement === undefined ? undefined : disagreementHint({ disagreement, task }),
      worktrees: taskWorktrees,
      recentLogLines: recentLogs.linesByTask.get(task) ?? [],
    };
  });

  return {
    schemaVersion: STATUS_SNAPSHOT_SCHEMA_VERSION,
    capturedAt,
    logCursor: recentLogs.cursor,
    maximumInProgress: config.orchestrator.maximumInProgress,
    workspaceProbe: probeState(probe),
    tasks,
    orphanedSessions: orphanedSessions({ probe, entries }),
  };
}

/** The subset of a collected worktree a pull request lookup needs. */
export interface PullRequestTarget {
  dir: string;
  branch: string;
}

export interface CollectRemoteStatusInput {
  /** The board fetch, started by the caller so it can overlap the local pass. */
  board: BoardFetch;
  /**
   * Worktrees from the local tier. Passing the already-resolved branch keeps
   * this collector from re-reading run state and re-resolving branches that
   * the local pass just computed.
   */
  pullRequestTargets: readonly PullRequestTarget[];
}

/** One board fetch attempt. A failure is a value here, never a throw. */
export type BoardFetch =
  | { kind: "ok"; capturedAt: string; issues: readonly SourceIssue[] }
  | { kind: "error"; message: string };

/**
 * The board fetch on its own. Exposed separately because it depends on nothing
 * local, so callers can start it before the local pass finishes.
 */
export async function fetchBoardIssues(config: ResolvedConfig): Promise<BoardFetch> {
  try {
    const board = await buildBoard(config);
    const state = await withLogOutputSuppressed(async () => await board.fetch());
    return { kind: "ok", capturedAt: state.timestamp, issues: state.issues };
  } catch (error) {
    return { kind: "error", message: errorMessage(error) };
  }
}

/**
 * Remote tier: the board fetch and the pull request lookups. Board-side
 * classification is applied here, but the local worktree subtraction
 * deliberately is not — `joinStatus` does that against the freshest local
 * document, because this tier refreshes far more slowly.
 *
 * A failed fetch is a result, not a throw: the caller merges it into the
 * previous document so last-known-good data survives an outage.
 */
export async function collectRemoteStatus(
  input: CollectRemoteStatusInput,
): Promise<RemoteFetchResult> {
  const { board, pullRequestTargets } = input;
  const pullRequestsByWorktree = await collectPullRequests(pullRequestTargets);
  if (board.kind === "error") {
    return { board, pullRequestsByWorktree };
  }
  const { issues } = board;

  // Only groundcrew-eligible todos are dispatchable; the rest lack a repo or
  // an agent, so `crew run` would skip them.
  const todos = issues.filter((issue) => issue.status === "todo").filter(isGroundcrewIssue);

  return {
    pullRequestsByWorktree,
    board: {
      kind: "ok",
      payload: {
        capturedAt: board.capturedAt,
        sourceByTask: sourceByTask(issues),
        inProgress: issues
          .filter((issue) => issue.status === "in-progress")
          .toSorted((left, right) => left.id.localeCompare(right.id))
          .map((issue) => toBoardIssue(issue)),
        queueReady: todos
          .filter((issue) => !hasOpenBlocker(issue))
          .map((issue) => toQueueIssue(issue)),
        queueBlocked: todos
          .filter((issue) => hasOpenBlocker(issue))
          .map((issue) => toBlockedIssue(issue)),
      },
    },
  };
}

export async function buildBoard(config: ResolvedConfig): Promise<Board> {
  const sources = await buildSources(sourcesFromConfig(config), { globalConfig: config });
  return createBoard(sources);
}

export function isWorkspaceExited(input: { probe: WorkspaceProbe; task: string }): boolean {
  const { probe, task } = input;
  return probe.kind === "ok" && probe.exitedNames?.has(task) === true;
}

/**
 * The ways a recorded run lifecycle can disagree with the live session probe.
 */
export type ProbeDisagreement =
  | "stray-session"
  | "stray-exited-session"
  | "session-exited"
  | "session-dead";

/**
 * Classifies the disagreement between the recorded lifecycle and the live
 * probe. An unavailable probe means "we don't know", which is not a
 * disagreement.
 *
 * The row label and the recovery hint both derive from this one
 * classification, so they cannot drift into describing different conditions.
 */
export function probeDisagreement(input: {
  lifecycle: StatusLifecycle;
  probe: WorkspaceProbe;
  task: string;
}): ProbeDisagreement | undefined {
  const { lifecycle, probe, task } = input;
  if (probe.kind !== "ok") {
    return undefined;
  }
  const sessionExited = isWorkspaceExited({ probe, task });
  const sessionPresent = probe.names.has(task);
  if (lifecycle === "idle") {
    if (!sessionPresent) {
      return undefined;
    }
    return sessionExited ? "stray-exited-session" : "stray-session";
  }
  if (lifecycle !== "running" && lifecycle !== "resumed") {
    return undefined;
  }
  if (sessionExited) {
    return "session-exited";
  }
  return sessionPresent ? undefined : "session-dead";
}

const DISAGREEMENT_LABELS: Record<ProbeDisagreement, string> = {
  "stray-session": "stray session",
  "stray-exited-session": "stray exited session",
  "session-exited": "session exited",
  "session-dead": "session dead",
};

export function disagreementLabel(disagreement: ProbeDisagreement): string {
  return DISAGREEMENT_LABELS[disagreement];
}

/** Recovery command for a row whose recorded state and live session disagree. */
function disagreementHint(input: { disagreement: ProbeDisagreement; task: string }): string {
  const { disagreement, task } = input;
  const hints: Record<ProbeDisagreement, string> = {
    "stray-session": `run 'crew cleanup ${task}' to clear this stray session`,
    "stray-exited-session": `run 'crew cleanup ${task}' to clear this stray exited session`,
    "session-exited": `attach to inspect scrollback, then run 'crew resume ${task}'`,
    "session-dead": `run 'crew resume ${task}' to bring the session back`,
  };
  return hints[disagreement];
}

export function workspaceProbeUnavailableText(
  probe: Extract<WorkspaceProbe, { kind: "unavailable" }>,
): string {
  return probe.error === undefined
    ? "Workspace probe unavailable"
    : `Workspace probe unavailable: ${errorMessage(probe.error)}`;
}

function probeState(probe: WorkspaceProbe): LocalStatusDocument["workspaceProbe"] {
  if (probe.kind === "ok") {
    return { status: "ok", error: undefined };
  }
  return {
    status: "unavailable",
    error: probe.error === undefined ? undefined : errorMessage(probe.error),
  };
}

/** Worktree-list order is preserved: the renderer flattens this back to rows. */
async function collectWorktreesByTask(input: {
  entries: readonly WorktreeEntry[];
  runStates: ReadonlyMap<string, RunState | undefined>;
}): Promise<Map<string, StatusWorktree[]>> {
  const { entries, runStates } = input;
  const byTask = new Map<string, StatusWorktree[]>();
  const collected = await Promise.all(
    entries.map(async (entry) => ({
      entry,
      worktree: await collectWorktree({ entry, runState: runStates.get(entry.task) }),
    })),
  );
  for (const { entry, worktree } of collected) {
    const existing = byTask.get(entry.task);
    if (existing === undefined) {
      byTask.set(entry.task, [worktree]);
    } else {
      existing.push(worktree);
    }
  }
  return byTask;
}

async function collectWorktree(input: {
  entry: WorktreeEntry;
  runState: RunState | undefined;
}): Promise<StatusWorktree> {
  const { entry, runState } = input;
  const [branch, git] = await Promise.all([
    effectiveBranchNameFromRunState({ entry, runState }),
    worktrees.probeWorkingTree({ worktreeDir: entry.dir }),
  ]);
  return { repository: entry.repository, kind: entry.kind, dir: entry.dir, branch, git };
}

async function collectAccessHints(input: {
  config: ResolvedConfig;
  tasks: readonly string[];
}): Promise<Map<string, { command: string } | undefined>> {
  const { config, tasks } = input;
  const results = await Promise.allSettled(
    tasks.map(async (task) => await workspaces.accessHint(config, task)),
  );
  return new Map(
    tasks.map((task, index) => {
      const result = results[index];
      return [task, result?.status === "fulfilled" ? result.value : undefined] as const;
    }),
  );
}

function orphanedSessions(input: {
  probe: WorkspaceProbe;
  entries: readonly WorktreeEntry[];
}): string[] {
  const { probe, entries } = input;
  if (probe.kind !== "ok") {
    return [];
  }
  const worktreeTasks = new Set(entries.map((entry) => entry.task));
  return [...probe.names].filter((name) => !worktreeTasks.has(name)).toSorted();
}

interface RecentLogResult {
  linesByTask: Map<string, string[]>;
  cursor?: StatusLogCursor | undefined;
}

function readRecentLogLines(input: {
  config: ResolvedConfig;
  previous: LocalStatusDocument | undefined;
  tasks: readonly string[];
}): RecentLogResult {
  const { config, previous, tasks } = input;
  if (tasks.length === 0) {
    return { linesByTask: new Map() };
  }
  let handle: number;
  try {
    handle = openSync(config.logging.file, "r");
  } catch {
    return { linesByTask: new Map() };
  }
  try {
    const stats = fstatSync(handle);
    const cursor: StatusLogCursor = {
      device: stats.dev,
      inode: stats.ino,
      offset: stats.size,
    };
    const previousCursor = previous?.logCursor;
    const canResume =
      previousCursor !== undefined &&
      previousCursor.device === cursor.device &&
      previousCursor.inode === cursor.inode &&
      previousCursor.offset <= cursor.offset;
    const previousTasks = new Map(previous?.tasks.map((task) => [task.task, task]) ?? []);
    const reusableTasks = canResume ? tasks.filter((task) => previousTasks.has(task)) : [];
    const tasksNeedingHistory = tasks.filter((task) => !reusableTasks.includes(task));
    const appendedLines = scanRecentLogLines({
      handle,
      startOffset: previousCursor?.offset ?? 0,
      endOffset: cursor.offset,
      tasks: reusableTasks,
    });
    const historicalLines = scanRecentLogLines({
      handle,
      startOffset: 0,
      endOffset: cursor.offset,
      tasks: tasksNeedingHistory,
    });
    const linesByTask = new Map<string, string[]>();
    for (const task of reusableTasks) {
      const cached = requiredMapValue(previousTasks, task).recentLogLines;
      linesByTask.set(
        task,
        [...cached, ...requiredMapValue(appendedLines, task)].slice(-RECENT_LOG_LINE_COUNT),
      );
    }
    for (const task of tasksNeedingHistory) {
      linesByTask.set(task, requiredMapValue(historicalLines, task));
    }
    return { linesByTask, cursor };
  } finally {
    closeSync(handle);
  }
}

function scanRecentLogLines(input: {
  handle: number;
  startOffset: number;
  endOffset: number;
  tasks: readonly string[];
}): Map<string, string[]> {
  const { handle, startOffset, endOffset, tasks } = input;
  const matchers = tasks.map((task) => ({
    task,
    pattern: taskLogPattern(task),
    linesNewestFirst: [] as string[],
  }));
  let startsAtLineBoundary = startOffset === 0;
  if (startOffset > 0) {
    const priorByte = Buffer.alloc(1);
    startsAtLineBoundary =
      readSync(handle, priorByte, 0, 1, startOffset - 1) === 1 && priorByte[0] === 10;
  }
  let leadingFragment: Buffer = Buffer.alloc(0);
  let position = endOffset;

  while (
    position > startOffset &&
    matchers.some((matcher) => matcher.linesNewestFirst.length < RECENT_LOG_LINE_COUNT)
  ) {
    const length = Math.min(position - startOffset, LOG_SCAN_CHUNK_BYTES);
    const start = position - length;
    const buffer = Buffer.alloc(length);
    const bytesRead = readSync(handle, buffer, 0, length, start);
    const split = splitLogBuffer(Buffer.concat([buffer.subarray(0, bytesRead), leadingFragment]));
    const includeFirst = start === startOffset && startsAtLineBoundary;
    const lines = includeFirst ? [split.first, ...split.rest] : split.rest;
    leadingFragment = start > startOffset ? split.first : Buffer.alloc(0);

    for (const lineBuffer of lines.toReversed()) {
      const line = lineBuffer.toString("utf8");
      for (const matcher of matchers) {
        if (matcher.linesNewestFirst.length < RECENT_LOG_LINE_COUNT && matcher.pattern.test(line)) {
          matcher.linesNewestFirst.push(line);
        }
      }
    }
    position = start;
  }

  return new Map(
    matchers.map((matcher) => [matcher.task, matcher.linesNewestFirst.toReversed()] as const),
  );
}

function requiredMapValue<Key, Value>(map: ReadonlyMap<Key, Value>, key: Key): Value {
  const value = map.get(key);
  /* v8 ignore next @preserve -- callers pass keys used to construct these maps */
  if (value === undefined) {
    throw new Error("Missing expected map value");
  }
  return value;
}

function splitLogBuffer(buffer: Buffer): {
  first: Buffer;
  rest: Buffer[];
} {
  const firstNewline = buffer.indexOf("\n");
  if (firstNewline === -1) {
    return { first: buffer, rest: [] };
  }
  const rest: Buffer[] = [];
  let start = firstNewline + 1;
  for (let newline = buffer.indexOf("\n", start); newline !== -1;) {
    rest.push(buffer.subarray(start, newline));
    start = newline + 1;
    newline = buffer.indexOf("\n", start);
  }
  rest.push(buffer.subarray(start));
  return { first: buffer.subarray(0, firstNewline), rest };
}

function hasOpenBlocker(issue: SourceIssue): boolean {
  return issue.blockers.some((blocker) => blocker.status !== "done");
}

function toBoardIssue(issue: SourceIssue): StatusBoardIssue {
  return {
    id: issue.id,
    naturalId: naturalIdFromCanonical(issue.id),
    title: issue.title,
    url: issue.url,
    repository: issue.repository,
    agent: issue.agent,
  };
}

function toSourceIssue(issue: SourceIssue): StatusSourceIssue {
  return { ...toBoardIssue(issue), status: issue.status };
}

function toQueueIssue(issue: GroundcrewIssue): StatusQueueIssue {
  return { ...toBoardIssue(issue), repository: issue.repository, agent: issue.agent };
}

function toBlockedIssue(issue: GroundcrewIssue): StatusBlockedIssue {
  return {
    ...toQueueIssue(issue),
    blockedBy: issue.blockers
      .filter((blocker) => blocker.status !== "done")
      .map((blocker) => ({
        id: blocker.id,
        naturalId: naturalIdFromCanonical(blocker.id),
        status: blocker.status,
        nativeStatus: blocker.nativeStatus,
      })),
  };
}

/**
 * Lowercased natural id to canonical status, omitting any id claimed by more
 * than one source rather than guessing which one a worktree row means.
 */
function sourceByTask(issues: readonly SourceIssue[]): Record<string, StatusSourceIssue> {
  const sources = new Map<string, StatusSourceIssue>();
  const matchCounts = new Map<string, number>();
  for (const issue of issues) {
    const task = naturalIdFromCanonical(issue.id).toLowerCase();
    matchCounts.set(task, (matchCounts.get(task) ?? 0) + 1);
    sources.set(task, toSourceIssue(issue));
  }
  for (const [task, matchCount] of matchCounts) {
    if (matchCount > 1) {
      sources.delete(task);
    }
  }
  return Object.fromEntries(sources);
}

async function collectPullRequests(
  targets: readonly PullRequestTarget[],
): Promise<Record<string, PullRequestSummary[]>> {
  // allSettled, not all: one worktree whose lookup throws must not take down
  // the whole status run, which is what the base command guaranteed. An empty
  // or missing entry therefore means "none found, or the lookup failed".
  const results = await Promise.allSettled(
    targets.map(
      async (target) =>
        [
          target.dir,
          await findPullRequestsForBranch({ cwd: target.dir, branchName: target.branch }),
        ] as const,
    ),
  );
  const byWorktree: Record<string, PullRequestSummary[]> = {};
  for (const result of results) {
    if (result.status !== "fulfilled") {
      continue;
    }
    const [dir, pullRequests] = result.value;
    byWorktree[dir] = [...pullRequests];
  }
  return byWorktree;
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

function taskLogPattern(task: string): RegExp {
  return new RegExp(`(^|[^a-z0-9])${escapeRegExp(task)}([^a-z0-9]|$)`, "i");
}

/**
 * The most recent log lines mentioning `task`. Callers supply the lines so the
 * pollable collector can pass a bounded tail while the one-shot per-task view
 * passes the whole file.
 */
export function recentTaskLogLines(input: { lines: readonly string[]; task: string }): string[] {
  const { lines, task } = input;
  // The boundary class is not \b on purpose: task ids contain hyphens, and \b
  // counts `_` as a word character, so `\btask\b` would match inside `x_eng-220`.
  const pattern = taskLogPattern(task);
  return lines.filter((line) => pattern.test(line)).slice(-RECENT_LOG_LINE_COUNT);
}

function lifecycleOf(runState: RunState | undefined): StatusLifecycle {
  return runState?.state ?? "idle";
}

function sessionState(input: { probe: WorkspaceProbe; task: string }): StatusSessionState {
  const { probe, task } = input;
  if (probe.kind !== "ok") {
    return "unknown";
  }
  if (isWorkspaceExited({ probe, task })) {
    return "exited";
  }
  return probe.names.has(task) ? "live" : "not-live";
}
