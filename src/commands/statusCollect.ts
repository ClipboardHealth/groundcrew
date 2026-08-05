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
  type RemoteFetchResult,
  STATUS_SNAPSHOT_SCHEMA_VERSION,
  type StatusBlockedIssue,
  type StatusBoardIssue,
  type StatusLifecycle,
  type StatusQueueIssue,
  type StatusSessionState,
  type StatusTask,
  type StatusWorktree,
} from "../lib/statusSnapshot.ts";
import {
  type CanonicalStatus,
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
 * Upper bound on how much of the append-only log the collector reads. The log
 * is shared across runs and grows without limit, and a monitor polls this
 * every few seconds, so reading it whole would make the fast path scale with
 * the log's lifetime. `crew status <task>` is a one-shot command and still
 * reads the whole file. 256 KiB holds several thousand lines, far past the ten
 * this keeps per task.
 */
const LOG_TAIL_BYTES = 256 * 1024;

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
  const entries = worktrees
    .list(config)
    .toSorted((left, right) => left.task.localeCompare(right.task));
  const uniqueTasks = [...new Set(entries.map((entry) => entry.task))];
  const runStates = new Map(uniqueTasks.map((task) => [task, readRunState(config, task)]));
  const logLines = readLogTail(config);

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
      recentLogLines: recentTaskLogLines({ lines: logLines, task }),
    };
  });

  return {
    schemaVersion: STATUS_SNAPSHOT_SCHEMA_VERSION,
    capturedAt: new Date().toISOString(),
    maximumInProgress: config.orchestrator.maximumInProgress,
    workspaceProbe: probeState(probe),
    tasks,
    orphanedSessions: orphanedSessions({ probe, entries }),
  };
}

/** The subset of a collected worktree a pull request lookup needs. */
export interface PullRequestTarget {
  task: string;
  dir: string;
  branch: string;
}

export interface CollectRemoteStatusInput {
  config: ResolvedConfig;
  /**
   * Worktrees from the local tier. Passing the already-resolved branch keeps
   * this collector from re-reading run state and re-resolving branches that
   * the local pass just computed.
   */
  pullRequestTargets: readonly PullRequestTarget[];
  /** A board fetch already in flight. Omit to fetch inline. */
  board?: BoardFetch;
}

/** One board fetch attempt. A failure is a value here, never a throw. */
export type BoardFetch =
  | { kind: "ok"; issues: readonly SourceIssue[] }
  | { kind: "error"; message: string };

/**
 * The board fetch on its own. Exposed separately because it depends on nothing
 * local, so callers can start it before the local pass finishes.
 */
export async function fetchBoardIssues(config: ResolvedConfig): Promise<BoardFetch> {
  try {
    const board = await buildBoard(config);
    const state = await withLogOutputSuppressed(async () => await board.fetch());
    return { kind: "ok", issues: state.issues };
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
  const { config, pullRequestTargets } = input;
  const board = input.board ?? (await fetchBoardIssues(config));
  if (board.kind === "error") {
    return { kind: "error", message: board.message };
  }
  const { issues } = board;

  // Only groundcrew-eligible todos are dispatchable; the rest lack a repo or
  // an agent, so `crew run` would skip them.
  const todos = issues.filter((issue) => issue.status === "todo").filter(isGroundcrewIssue);

  return {
    kind: "ok",
    payload: {
      capturedAt: new Date().toISOString(),
      statusByTask: statusByTask(issues),
      pullRequestsByWorktree: await collectPullRequests(pullRequestTargets),
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

/**
 * Reads at most the last `LOG_TAIL_BYTES` of the log. Seeking rather than
 * reading the whole file and slicing is the point: the log grows without
 * limit, and this runs on every poll.
 */
function readLogTail(config: ResolvedConfig): string[] {
  let handle: number;
  try {
    handle = openSync(config.logging.file, "r");
  } catch {
    return [];
  }
  try {
    const { size } = fstatSync(handle);
    const length = Math.min(size, LOG_TAIL_BYTES);
    const start = size - length;
    const buffer = Buffer.alloc(length);
    readSync(handle, buffer, 0, length, start);
    const lines = buffer.toString("utf8").split("\n");
    // A bounded read starts mid-line, so the leading fragment is not a log
    // line and must not be matched against a task id.
    return start > 0 ? lines.slice(1) : lines;
  } finally {
    closeSync(handle);
  }
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
function statusByTask(issues: readonly SourceIssue[]): Record<string, CanonicalStatus> {
  const statuses = new Map<string, CanonicalStatus>();
  const matchCounts = new Map<string, number>();
  for (const issue of issues) {
    const task = naturalIdFromCanonical(issue.id).toLowerCase();
    matchCounts.set(task, (matchCounts.get(task) ?? 0) + 1);
    statuses.set(task, issue.status);
  }
  for (const [task, matchCount] of matchCounts) {
    if (matchCount > 1) {
      statuses.delete(task);
    }
  }
  return Object.fromEntries(statuses);
}

async function collectPullRequests(
  targets: readonly PullRequestTarget[],
): Promise<Record<string, PullRequestSummary[]>> {
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

/**
 * The most recent log lines mentioning `task`. Callers supply the lines so the
 * pollable collector can pass a bounded tail while the one-shot per-task view
 * passes the whole file.
 */
export function recentTaskLogLines(input: { lines: readonly string[]; task: string }): string[] {
  const { lines, task } = input;
  // The boundary class is not \b on purpose: task ids contain hyphens, and \b
  // counts `_` as a word character, so `\btask\b` would match inside `x_eng-220`.
  const pattern = new RegExp(`(^|[^a-z0-9])${escapeRegExp(task)}([^a-z0-9]|$)`, "i");
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
