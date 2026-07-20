/**
 * The picker's core (design doc §3, §5, §9.3). `tick` runs one poll/dispatch
 * cycle; `startTask` is its single-task sibling for `crew start <task>`.
 *
 * Per-task pipeline, in order: eligibility (not blocked, routing resolves, not
 * already live) → repo-designation gate (missing ⇒ verdict, provision NOTHING) →
 * slot check → claim (`update:claimed`; a rejection provisions nothing) → create
 * the run record (with the injected Writeback adapter, BEFORE provisioning so a
 * claimed task always has a record to reconcile against) → provision the
 * workspace → launch the session → mark running. A `LaunchError` is truthful:
 * `complete{failed, reason: launch}` plus a full workspace/branch rollback
 * (COMPLETE-03). Every skip is persisted as a `dispatch.json` verdict (§10.4).
 *
 * A terminal sweep (COMPLETE-07) reaps the clean lingering workspaces of
 * source-terminal tasks and loudly leaves the dirty ones.
 */

import * as fs from "node:fs";

import type { Task } from "../acquisition/index.js";
import type { Logger } from "../logging/index.js";
import { createRun, deleteRun, generateRunId, listRuns, type RunRecord } from "../run/index.js";
import { LaunchError, launchSession, sessionNameFor } from "../session/index.js";
import {
  canonicalTaskId,
  clonePath,
  DirtyWorktreeError,
  provisionWorkspace,
  removeWorkspace,
  RepoNotOnDiskError,
  taskSlug,
  workspacePath,
} from "../workspace/index.js";
import { reconcile } from "./reconcile.js";
import { orderByPriority, resolveAgent, type ResolvedAgent } from "./routing.js";
import { persistVerdicts, upsertVerdict } from "./state.js";
import type {
  DispatchDeps,
  DispatchSource,
  DispatchVerdict,
  SkipReason,
  SourcedTask,
  StartTaskInput,
  StartTaskReport,
  TickInput,
  TickReport,
} from "./types.js";
import { createSourceWriteback, localIdOf } from "./writeback.js";

const MODULE = "dispatch";
const LIVE_STATES = new Set<RunRecord["state"]>(["provisioning", "running", "paused"]);

/** One poll/dispatch cycle across every configured source. */
export async function tick(input: TickInput): Promise<TickReport> {
  const now = input.now ?? ((): Date => new Date());
  const report: TickReport = { dispatched: [], reaped: [], skipped: {} };

  if (input.reconcile !== false) {
    report.reconcile = await reconcile({
      stateRoot: input.stateRoot,
      workspaceConfig: input.workspaceConfig,
      presenter: input.presenter,
      ...(input.logger === undefined ? {} : { logger: input.logger }),
      ...(input.now === undefined ? {} : { now: input.now }),
    });
  }

  // One live-run snapshot per tick: the slot budget and the already-live guard.
  const records = await listRuns({ stateRoot: input.stateRoot });
  const liveStateByTaskId = new Map<string, RunRecord["state"]>(
    records.filter((record) => LIVE_STATES.has(record.state)).map((record) => [record.taskId, record.state]),
  );
  let availableSlots = input.maximumInProgress - liveStateByTaskId.size;

  const verdicts: Record<string, DispatchVerdict> = {};

  for (const source of input.sources) {
    let tasks: Task[];
    try {
      // eslint-disable-next-line no-await-in-loop -- sources are polled in order
      tasks = await source.handle.list();
    } catch (error) {
      logSourceListFailure({ logger: input.logger, source: source.handle.name, error });
      continue;
    }

    const sourced = tasks.map((task): SourcedTask => ({ task, source }));
    // eslint-disable-next-line no-await-in-loop -- ordered per source
    const reaped = await sweepTerminal({ input, tasks: sourced, now });
    report.reaped.push(...reaped);

    const candidates = orderByPriority(sourced.filter((entry) => entry.task.terminal !== true));
    for (const entry of candidates) {
      const taskId = canonicalOf(entry);

      if (liveStateByTaskId.has(taskId)) {
        continue; // already live — skip silently, its slot is already counted
      }

      // eslint-disable-next-line no-await-in-loop -- dispatch is strictly sequential
      const result = await considerTask({ input, entry, taskId, availableSlots, now });
      if (result.verdict !== undefined) {
        verdicts[taskId] = result.verdict;
        continue;
      }

      if (result.dispatched === true) {
        report.dispatched.push(taskId);
        availableSlots -= 1;
      }
    }
  }

  report.skipped = verdicts;
  persistVerdicts({ stateRoot: input.stateRoot, verdicts });
  return report;
}

/** Single-task dispatch (`crew start <task>`); `force` bypasses everything but the repo gate. */
export async function startTask(input: StartTaskInput): Promise<StartTaskReport> {
  const now = input.now ?? ((): Date => new Date());
  const { source, localId } = findSource({ taskId: input.taskId, sources: input.sources });
  const task = await source.handle.get(localId);
  const entry: SourcedTask = { task, source };
  const taskId = input.taskId;

  // The repo gate is never bypassed — bail surfaces as a typed error (exit 2).
  assertReposOnDisk({ config: input.workspaceConfig, repos: task.repos ?? [] });

  // Never duplicate a live run, even under `--force`.
  if (await liveRunExists({ stateRoot: input.stateRoot, taskId })) {
    return skipReport({ stateRoot: input.stateRoot, taskId, reason: "ineligible", detail: "already-running", now });
  }

  const resolved = resolveAgent({
    task,
    source,
    agents: input.agents,
    ...(input.agent === undefined ? {} : { override: input.agent }),
  });

  if (input.force !== true) {
    if (task.blocked === true) {
      return skipReport({ stateRoot: input.stateRoot, taskId, reason: "ineligible", detail: "blocked", now });
    }

    if (await liveRunCountAtCap(input)) {
      return skipReport({ stateRoot: input.stateRoot, taskId, reason: "slots-full", now });
    }
  }

  if (resolved === undefined) {
    // Routing is required even under `--force`: nothing can be launched unrouted.
    return skipReport({ stateRoot: input.stateRoot, taskId, reason: "ineligible", detail: "unrouted", now });
  }

  const runId = generateRunId();
  const claim = await source.handle.update(localId, { type: "claimed", runId });
  if (claim.result === "rejected") {
    return skipReport({
      stateRoot: input.stateRoot,
      taskId,
      reason: "claim-rejected",
      now,
      ...(claim.reason === undefined ? {} : { detail: claim.reason }),
    });
  }

  const dispatched = await provisionAndLaunch({ input, entry, resolved, runId });
  upsertVerdict({ stateRoot: input.stateRoot, taskId, verdict: undefined });
  return { taskId, dispatched, runId };
}

interface ConsiderResult {
  verdict?: DispatchVerdict;
  dispatched?: boolean;
}

/** Evaluates one queued task: a verdict (skip) or a dispatch attempt. */
async function considerTask(context: {
  input: TickInput;
  entry: SourcedTask;
  taskId: string;
  availableSlots: number;
  now: () => Date;
}): Promise<ConsiderResult> {
  const { input, entry, taskId, availableSlots, now } = context;
  const { task, source } = entry;

  if (task.blocked === true) {
    return { verdict: verdict({ reason: "ineligible", detail: "blocked", now }) };
  }

  const resolved = resolveAgent({ task, source, agents: input.agents });
  if (resolved === undefined) {
    logVerdict({ logger: input.logger, taskId, reason: "ineligible", detail: "unrouted" });
    return { verdict: verdict({ reason: "ineligible", detail: "unrouted", now }) };
  }

  const missing = missingRepos({ config: input.workspaceConfig, repos: task.repos ?? [] });
  if (missing.length > 0) {
    const detail = missing.join(", ");
    logVerdict({ logger: input.logger, taskId, reason: "repo-not-on-disk", detail });
    return { verdict: verdict({ reason: "repo-not-on-disk", detail, now }) };
  }

  if (availableSlots <= 0) {
    return { verdict: verdict({ reason: "slots-full", now }) };
  }

  const runId = generateRunId();
  const claim = await source.handle.update(task.id, { type: "claimed", runId });
  if (claim.result === "rejected") {
    logVerdict({
      logger: input.logger,
      taskId,
      reason: "claim-rejected",
      ...(claim.reason === undefined ? {} : { detail: claim.reason }),
    });
    return {
      verdict: verdict({
        reason: "claim-rejected",
        now,
        ...(claim.reason === undefined ? {} : { detail: claim.reason }),
      }),
    };
  }

  const dispatched = await provisionAndLaunch({ input, entry, resolved, runId });
  return { dispatched };
}

/**
 * The claim-onward provisioning: create the run (record + claimed event), provision
 * the workspace, launch the session, mark running. A `LaunchError` rolls the whole
 * thing back to `complete{failed, reason: launch}` (COMPLETE-03).
 */
async function provisionAndLaunch(context: {
  input: DispatchDeps;
  entry: SourcedTask;
  resolved: ResolvedAgent;
  runId: string;
}): Promise<boolean> {
  const { input, entry, resolved, runId } = context;
  const { task, source } = entry;
  const taskId = canonicalTaskId({ sourceName: source.handle.name, localId: task.id });
  const repos = task.repos ?? [];
  const workspaceDirectory = workspacePath({ config: input.workspaceConfig, taskId });

  const run = await createRun({
    stateRoot: input.stateRoot,
    taskSlug: taskSlug({ taskId }),
    taskId,
    source: source.handle.name,
    agentProfile: resolved.name,
    sessionName: sessionNameFor({ taskId }),
    workspaceDirectory,
    repos,
    runId,
    writeback: createSourceWriteback({ source: source.handle, localId: task.id }),
    ...(input.logger === undefined ? {} : { logger: input.logger }),
    ...(input.now === undefined ? {} : { now: input.now }),
  });

  try {
    await provisionWorkspace({
      config: input.workspaceConfig,
      taskId,
      repos,
      ...(input.logger === undefined ? {} : { logger: input.logger }),
    });
  } catch (error) {
    await run.complete({ outcome: "failed", reason: "provision" });
    await rollbackWorkspace({ config: input.workspaceConfig, taskId, logger: input.logger });
    logDispatchError({ logger: input.logger, taskId, event: "provision_failed", error });
    return false;
  }

  try {
    const launched = await launchSession({
      taskId,
      workspaceDirectory,
      profileName: resolved.name,
      profile: resolved.profile,
      environment: input.environment,
      presenter: input.presenter,
      ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
      // The per-task grant (contracts §9): the config policy names host-wide
      // read-only dirs and egress; the workspace and the state root (run
      // records, log file — what in-session `crew` writes) are granted per task.
      ...(input.policy === undefined
        ? {}
        : {
            policy: {
              ...input.policy,
              writablePaths: [
                ...input.policy.writablePaths,
                workspaceDirectory,
                input.stateRoot,
              ],
            },
          }),
      ...(input.wrapCommand === undefined ? {} : { wrapCommand: input.wrapCommand }),
    });

    if (launched.sessionId !== undefined) {
      await run.recordSessionId(launched.sessionId);
    }

    await run.markRunning();
    return true;
  } catch (error) {
    if (!(error instanceof LaunchError)) {
      throw error;
    }

    // Truthful launch failure: complete{failed, launch} then roll the workspace back.
    await run.complete({ outcome: "failed", reason: "launch" });
    await rollbackWorkspace({ config: input.workspaceConfig, taskId, logger: input.logger });
    input.logger?.log({
      level: "warn",
      module: MODULE,
      event: "launch_failed",
      taskId,
      runId,
      msg: `launch failed for ${taskId}, rolled back: ${error.message}`,
    });
    return false;
  }
}

/** Reaps clean lingering workspaces of source-terminal tasks; leaves dirty ones loudly. */
async function sweepTerminal(context: {
  input: DispatchDeps;
  tasks: readonly SourcedTask[];
  now: () => Date;
}): Promise<string[]> {
  const { input } = context;
  const reaped: string[] = [];

  for (const entry of context.tasks) {
    if (entry.task.terminal !== true) {
      continue;
    }

    const taskId = canonicalOf(entry);
    const slug = taskSlug({ taskId });
    // eslint-disable-next-line no-await-in-loop -- ordered, disk-bound reap
    const record = await loadRunRecordIfComplete({ stateRoot: input.stateRoot, taskSlug: slug });
    if (record === undefined) {
      continue; // never ran, or still live — leave it
    }

    try {
      // eslint-disable-next-line no-await-in-loop -- removeWorkspace refuses dirty by throwing
      await removeWorkspace({
        config: input.workspaceConfig,
        taskId,
        force: false,
        ...(input.logger === undefined ? {} : { logger: input.logger }),
      });
      // eslint-disable-next-line no-await-in-loop -- record delete follows its worktree removal
      await deleteRun({ stateRoot: input.stateRoot, taskSlug: slug });
      reaped.push(taskId);
      input.logger?.log({
        level: "info",
        module: MODULE,
        event: "workspace_reaped",
        taskId,
        msg: `reaped source-terminal workspace for ${taskId}`,
      });
    } catch (error) {
      if (!(error instanceof DirtyWorktreeError)) {
        throw error;
      }

      input.logger?.log({
        level: "warn",
        module: MODULE,
        event: "reap_skipped_dirty",
        taskId,
        msg: `skipped reaping ${taskId}: dirty worktree (${error.message}); left for a human`,
      });
    }
  }

  return reaped;
}

// --- helpers ---------------------------------------------------------------

function canonicalOf(entry: SourcedTask): string {
  return canonicalTaskId({ sourceName: entry.source.handle.name, localId: entry.task.id });
}

/** Repos designated but not cloned under the base directory (contracts §4.3). */
function missingRepos(input: { config: DispatchDeps["workspaceConfig"]; repos: readonly string[] }): string[] {
  return input.repos.filter((repo) => !isDirectory(clonePath({ config: input.config, repo })));
}

/** Throws `RepoNotOnDiskError` for the first missing repo (the `start` bail, exit 2). */
function assertReposOnDisk(input: {
  config: DispatchDeps["workspaceConfig"];
  repos: readonly string[];
}): void {
  const missing = missingRepos(input);
  const [first] = missing;
  if (first !== undefined) {
    throw new RepoNotOnDiskError({ repo: first, baseDirectory: input.config.baseDirectory });
  }
}

function isDirectory(directory: string): boolean {
  try {
    return fs.statSync(directory).isDirectory();
  } catch {
    return false;
  }
}

async function liveRunExists(input: { stateRoot: string; taskId: string }): Promise<boolean> {
  const records = await listRuns({ stateRoot: input.stateRoot });
  return records.some(
    (record) => record.taskId === input.taskId && LIVE_STATES.has(record.state),
  );
}

async function liveRunCountAtCap(input: DispatchDeps): Promise<boolean> {
  const records = await listRuns({ stateRoot: input.stateRoot });
  const live = records.filter((record) => LIVE_STATES.has(record.state)).length;
  return live >= input.maximumInProgress;
}

async function loadRunRecordIfComplete(input: {
  stateRoot: string;
  taskSlug: string;
}): Promise<RunRecord | undefined> {
  const records = await listRuns({ stateRoot: input.stateRoot });
  const record = records.find((entry) => taskSlug({ taskId: entry.taskId }) === input.taskSlug);
  return record !== undefined && record.state === "complete" ? record : undefined;
}

function findSource(input: {
  taskId: string;
  sources: readonly DispatchSource[];
}): { source: DispatchSource; localId: string } {
  for (const source of input.sources) {
    if (input.taskId.startsWith(`${source.handle.name}:`)) {
      return { source, localId: localIdOf({ taskId: input.taskId, source: source.handle.name }) };
    }
  }

  throw new Error(`no configured source owns task id "${input.taskId}"`);
}

async function rollbackWorkspace(input: {
  config: DispatchDeps["workspaceConfig"];
  taskId: string;
  logger: Logger | undefined;
}): Promise<void> {
  try {
    await removeWorkspace({
      config: input.config,
      taskId: input.taskId,
      force: true,
      ...(input.logger === undefined ? {} : { logger: input.logger }),
    });
  } catch {
    // Rollback is best-effort; the truthful run record already records the failure.
  }
}

function verdict(input: { reason: SkipReason; detail?: string; now: () => Date }): DispatchVerdict {
  return {
    skipReason: input.reason,
    ...(input.detail === undefined ? {} : { detail: input.detail }),
    ts: input.now().toISOString(),
  };
}

function skipReport(input: {
  stateRoot: string;
  taskId: string;
  reason: SkipReason;
  detail?: string;
  now: () => Date;
}): StartTaskReport {
  const built = verdict({
    reason: input.reason,
    now: input.now,
    ...(input.detail === undefined ? {} : { detail: input.detail }),
  });
  upsertVerdict({ stateRoot: input.stateRoot, taskId: input.taskId, verdict: built });
  return { taskId: input.taskId, dispatched: false, verdict: built };
}

function logVerdict(input: {
  logger: Logger | undefined;
  taskId: string;
  reason: SkipReason;
  detail?: string;
}): void {
  input.logger?.log({
    level: input.reason === "repo-not-on-disk" ? "warn" : "info",
    module: MODULE,
    event: "dispatch_skip",
    taskId: input.taskId,
    msg: `skipped ${input.taskId}: ${input.reason}${input.detail === undefined ? "" : ` (${input.detail})`}`,
    fields: {
      skipReason: input.reason,
      ...(input.detail === undefined ? {} : { detail: input.detail }),
    },
  });
}

function logSourceListFailure(input: {
  logger: Logger | undefined;
  source: string;
  error: unknown;
}): void {
  input.logger?.log({
    level: "warn",
    module: MODULE,
    event: "source_list_failed",
    source: input.source,
    msg: `source ${input.source} list failed: ${String(input.error)}`,
  });
}

function logDispatchError(input: {
  logger: Logger | undefined;
  taskId: string;
  event: string;
  error: unknown;
}): void {
  input.logger?.log({
    level: "error",
    module: MODULE,
    event: input.event,
    taskId: input.taskId,
    msg: `${input.event} for ${input.taskId}: ${String(input.error)}`,
  });
}
