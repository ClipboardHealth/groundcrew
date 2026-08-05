/**
 * Gathers the two status tiers that `crew status` renders and that
 * `crew status --json` publishes. Owns every subprocess and network call so
 * the renderers, the join, and the wire format stay free of I/O.
 */

import { readFileSync } from "node:fs";

import { createBoard } from "../lib/board.ts";
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

const RECENT_LOG_LINE_COUNT = 10;

/**
 * Upper bound on how much of the append-only log the collector reads. The log
 * is shared across runs and grows without limit, and a monitor polls this
 * every few seconds, so reading it whole would make the fast path scale with
 * the log's lifetime. `crew status <task>` is a one-shot command and still
 * reads the whole file.
 */
const LOG_TAIL_BYTES = 256 * 1024;

export interface CollectLocalStatusInput {
  config: ResolvedConfig;
}

/**
 * Local tier: worktrees, run states, sessions, git dirtiness, log lines. Every
 * call here is a local subprocess or file read, which is what makes this safe
 * to poll every few seconds.
 */
export async function collectLocalStatus(
  input: CollectLocalStatusInput,
): Promise<LocalStatusDocument> {
  const { config } = input;
  const entries = worktrees
    .list(config)
    .toSorted((left, right) => left.task.localeCompare(right.task));
  const probe = await withLogOutputSuppressed(async () => await workspaces.probe(config));

  const uniqueTasks = [...new Set(entries.map((entry) => entry.task))];
  const runStates = new Map(uniqueTasks.map((task) => [task, readRunState(config, task)]));
  const accessHints = await collectAccessHints({ config, tasks: uniqueTasks });
  const logLines = readLogTail(config);
  const worktreesByTask = await collectWorktreesByTask({ entries, runStates });

  const tasks: StatusTask[] = uniqueTasks.map((task) => {
    const runState = runStates.get(task);
    return {
      task,
      title: runState?.title,
      url: runState?.url,
      repository: repositoryForTask({ entries, task }),
      agent: runState?.agent,
      lifecycle: lifecycleOf(runState),
      flags: runProbeFlags({ runState, probe, task }),
      startedAt: runState?.createdAt,
      updatedAt: runState?.updatedAt,
      resumeCount: runState?.resumeCount,
      reason: runState?.reason,
      detail: runState?.detail,
      session: sessionState({ probe, task }),
      attachCommand: accessHints.get(task)?.command,
      hint: inventoryHint({ runState, probe, task }),
      worktrees: worktreesByTask.get(task) ?? [],
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
  let issues: readonly SourceIssue[];
  try {
    const sources = await buildSources(sourcesFromConfig(config), { globalConfig: config });
    const board = createBoard(sources);
    const state = await withLogOutputSuppressed(async () => await board.fetch());
    issues = state.issues;
  } catch (error) {
    return { kind: "error", message: errorMessage(error) };
  }

  // Only groundcrew-eligible todos are dispatchable; the rest lack a repo or
  // an agent, so `crew run` would skip them.
  const todos = issues.filter((issue) => issue.status === "todo").filter(isGroundcrewIssue);

  return {
    kind: "ok",
    payload: {
      capturedAt: new Date().toISOString(),
      statusByTask: statusByTask(issues),
      pullRequestsByTask: await collectPullRequests(pullRequestTargets),
      inProgress: issues
        .filter((issue) => issue.status === "in-progress")
        .toSorted((left, right) => left.id.localeCompare(right.id))
        .map((issue) => toBoardIssue(issue)),
      queueReady: todos.filter((issue) => !hasOpenBlocker(issue)).map((issue) => toQueueIssue(issue)),
      queueBlocked: todos
        .filter((issue) => hasOpenBlocker(issue))
        .map((issue) => toBlockedIssue(issue)),
    },
  };
}

export function lifecycleOf(runState: RunState | undefined): StatusLifecycle {
  return runState?.state ?? "idle";
}

export function sessionState(input: {
  probe: WorkspaceProbe;
  task: string;
}): StatusSessionState {
  const { probe, task } = input;
  if (probe.kind !== "ok") {
    return "unknown";
  }
  if (isWorkspaceExited({ probe, task })) {
    return "exited";
  }
  return probe.names.has(task) ? "live" : "not-live";
}

export function isWorkspaceExited(input: { probe: WorkspaceProbe; task: string }): boolean {
  const { probe, task } = input;
  return probe.kind === "ok" && probe.exitedNames?.has(task) === true;
}

/**
 * Flags the two interesting disagreements between the recorded RunState
 * lifecycle and the live workspace probe: a running dispatch with a missing or
 * exited session, and an idle row with a stray session. An unavailable probe
 * means "we don't know" and yields no flags.
 */
export function runProbeFlags(input: {
  runState: RunState | undefined;
  probe: WorkspaceProbe;
  task: string;
}): string[] {
  const { runState, probe, task } = input;
  if (probe.kind !== "ok") {
    return [];
  }
  const lifecycle = lifecycleOf(runState);
  const sessionPresent = probe.names.has(task);
  const sessionExited = isWorkspaceExited({ probe, task });
  const flags: string[] = [];
  if (lifecycle === "idle" && sessionPresent) {
    flags.push(sessionExited ? "stray exited session" : "stray session");
  }
  if ((lifecycle === "running" || lifecycle === "resumed") && sessionExited) {
    flags.push("session exited");
  } else if ((lifecycle === "running" || lifecycle === "resumed") && !sessionPresent) {
    flags.push("session dead");
  }
  return flags;
}

/**
 * Recovery command for a row where the run-state and the probe disagree. No
 * hint when the probe is unavailable, since we genuinely don't know whether
 * there is a disagreement, or when the row is healthy.
 */
export function inventoryHint(input: {
  runState: RunState | undefined;
  probe: WorkspaceProbe;
  task: string;
}): string | undefined {
  const { runState, probe, task } = input;
  if (probe.kind === "unavailable") {
    return undefined;
  }
  const lifecycle = lifecycleOf(runState);
  const sessionPresent = probe.names.has(task);
  const sessionExited = isWorkspaceExited({ probe, task });
  if (lifecycle === "idle" && sessionPresent) {
    return sessionExited
      ? `run 'crew cleanup ${task}' to clear this stray exited session`
      : `run 'crew cleanup ${task}' to clear this stray session`;
  }
  if ((lifecycle === "running" || lifecycle === "resumed") && sessionExited) {
    return `attach to inspect scrollback, then run 'crew resume ${task}'`;
  }
  if ((lifecycle === "running" || lifecycle === "resumed") && !sessionPresent) {
    return `run 'crew resume ${task}' to bring the session back`;
  }
  return undefined;
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

/**
 * One entry per task, in worktree-list order. The renderer flattens this back
 * to one row per worktree, so the order must stay stable.
 */
async function collectWorktreesByTask(input: {
  entries: readonly WorktreeEntry[];
  runStates: ReadonlyMap<string, RunState | undefined>;
}): Promise<Map<string, StatusWorktree[]>> {
  const { entries, runStates } = input;
  const collected = await Promise.all(
    entries.map(
      async (entry) => await collectWorktree({ entry, runState: runStates.get(entry.task) }),
    ),
  );
  const byTask = new Map<string, StatusWorktree[]>();
  for (const [index, entry] of entries.entries()) {
    const worktree = collected[index];
    /* v8 ignore next 3 @preserve -- Promise.all preserves index alignment with entries */
    if (worktree === undefined) {
      continue;
    }
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

function repositoryForTask(input: { entries: readonly WorktreeEntry[]; task: string }): string {
  const { entries, task } = input;
  const entry = entries.find((candidate) => candidate.task === task);
  /* v8 ignore next @preserve -- tasks are derived from entries, so a match always exists */
  return entry?.repository ?? "";
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

function readLogTail(config: ResolvedConfig): string[] {
  let raw: string;
  try {
    raw = readFileSync(config.logging.file, "utf8");
  } catch {
    return [];
  }
  const tail = raw.length > LOG_TAIL_BYTES ? raw.slice(-LOG_TAIL_BYTES) : raw;
  return tail.split("\n");
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
          target.task,
          await findPullRequestsForBranch({ cwd: target.dir, branchName: target.branch }),
        ] as const,
    ),
  );
  const byTask: Record<string, PullRequestSummary[]> = {};
  for (const result of results) {
    if (result.status !== "fulfilled") {
      continue;
    }
    const [task, pullRequests] = result.value;
    byTask[task] = [...(byTask[task] ?? []), ...pullRequests];
  }
  return byTask;
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

function recentTaskLogLines(input: { lines: readonly string[]; task: string }): string[] {
  const { lines, task } = input;
  const pattern = new RegExp(`(^|[^a-z0-9])${escapeRegExp(task)}([^a-z0-9]|$)`, "i");
  return lines.filter((line) => pattern.test(line)).slice(-RECENT_LOG_LINE_COUNT);
}
