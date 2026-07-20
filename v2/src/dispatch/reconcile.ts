/**
 * Reconcile (design doc §10.5): the idempotent library that makes on-disk
 * git/tmux state the source of truth and compares it against the run records.
 * Two callers — Shell on startup and the dispatcher tick — share this one
 * routine. It auto-GCs ONLY the provably dead and never kills a live agent.
 *
 * Provably-dead matrix (each GC action logs its reserved event, contracts §6):
 *   - a live-state (`provisioning`) run whose session never came up after a
 *     crash → GC its worktree (`reconcile_gc_worktree`), confirm the session is
 *     gone (`reconcile_gc_session`), delete the record (`reconcile_gc_run_record`);
 *   - a `complete` run whose workspace is already gone → delete the stale record
 *     (`reconcile_gc_run_record`);
 *   - an orphaned workspace directory with no run record and no live session →
 *     GC the worktree (`reconcile_gc_worktree`);
 *   - a dead managed presenter surface (exited, `alive: false`) → close it
 *     (`reconcile_gc_session`).
 *
 * NEVER destructive when the probe is unavailable (CRASH-04): "could not ask" is
 * not "no sessions". A `running`/`paused` run whose session is merely gone is NOT
 * auto-GC'd — a live-then-dead agent may hold real work; it is reported loudly
 * (orphaned-but-running) and left for a human. A live managed session with no
 * record behind it is likewise reported, never closed (SESSION-03).
 */

import * as fs from "node:fs";
import path from "node:path";

import { deleteRun, listRuns, type RunRecord } from "../run/index.js";
import { closeSession, isManagedSessionName, sessionNameFor } from "../session/index.js";
import { readMarker, removeWorkspace, taskSlug, worktreesRoot } from "../workspace/index.js";
import type { ReconcileInput, ReconcileReport } from "./types.js";

const MODULE = "dispatch";

/** One idempotent reconcile pass. Safe to call repeatedly; only the dead is GC'd. */
export async function reconcile(input: ReconcileInput): Promise<ReconcileReport> {
  const now = input.now ?? ((): Date => new Date());
  const report: ReconcileReport = {
    available: true,
    gc: { worktrees: [], sessions: [], runRecords: [], sandboxes: [] },
    orphanedRunning: [],
    straySessions: [],
  };

  const probe = await input.presenter.probe();
  if (!probe.available) {
    // The one hard rule: an unavailable probe is never read as "no sessions".
    report.available = false;
    input.logger?.log({
      level: "warn",
      module: MODULE,
      event: "reconcile_probe_unavailable",
      msg: "presenter probe unavailable; reconcile did nothing destructive",
    });
    return report;
  }

  const aliveSessions = new Set(
    probe.sessions.filter((session) => session.alive).map((session) => session.name),
  );
  const records = await listRuns({ stateRoot: input.stateRoot });
  const recordedSessionNames = new Set<string>();

  for (const record of records) {
    const sessionName = sessionNameFor({ taskId: record.taskId });
    recordedSessionNames.add(sessionName);
    // eslint-disable-next-line no-await-in-loop -- reconcile is an ordered, disk-bound sweep
    await reconcileRecord({ input, record, sessionName, alive: aliveSessions, report, now });
  }

  await reconcileOrphanWorkspaces({ input, records, alive: aliveSessions, report });
  reconcileStraySessions({ input, probe: probe.sessions, recordedSessionNames, report });

  return report;
}

async function reconcileRecord(context: {
  input: ReconcileInput;
  record: RunRecord;
  sessionName: string;
  alive: Set<string>;
  report: ReconcileReport;
  now: () => Date;
}): Promise<void> {
  const { input, record, sessionName, alive, report } = context;
  const sessionAlive = alive.has(sessionName);
  const workspaceOnDisk = fs.existsSync(record.workspaceDirectory);

  if (record.state === "complete") {
    // A completed run lingers with its workspace; GC only the record left with no
    // disk behind it (the cleaner already reaped the worktree, or it never existed).
    if (!workspaceOnDisk) {
      await gcRunRecord({ input, record, report, reason: "stale complete record, no workspace on disk" });
    }

    return;
  }

  if (sessionAlive) {
    // Live agent — leave it entirely, whatever the record's live state.
    return;
  }

  if (record.state === "paused") {
    // A paused run legitimately has no session; nothing to reconcile.
    return;
  }

  if (record.state === "provisioning") {
    // Crashed before or during launch: provably dead, GC the whole footprint.
    await gcProvisioningRun({ input, record, sessionName, report });
    return;
  }

  // running / dead session: may hold real work. Report loudly, never auto-GC.
  report.orphanedRunning.push(record.taskId);
  input.logger?.log({
    level: "warn",
    module: MODULE,
    event: "reconcile_orphaned_running",
    taskId: record.taskId,
    runId: record.runId,
    msg: `run ${record.runId} is running but its session is gone; left for a human`,
  });
}

/** GC a crashed provisioning run: worktree, session confirmation, run record. */
async function gcProvisioningRun(context: {
  input: ReconcileInput;
  record: RunRecord;
  sessionName: string;
  report: ReconcileReport;
}): Promise<void> {
  const { input, record, sessionName, report } = context;

  if (fs.existsSync(record.workspaceDirectory)) {
    await safeRemoveWorkspace({ input, taskId: record.taskId });
    report.gc.worktrees.push(record.taskId);
    input.logger?.log({
      level: "info",
      module: MODULE,
      event: "reconcile_gc_worktree",
      taskId: record.taskId,
      runId: record.runId,
      msg: `removed half-provisioned worktree for ${record.taskId} (crashed provisioning)`,
    });
  }

  // Confirm the session is gone (it never came up); close defensively if a dead
  // surface lingers. Logged so the sweep's session leg is auditable (§10.5).
  await closeSession({ taskId: record.taskId, presenter: input.presenter }).catch(() => {
    // A missing surface is the expected case; closing is best-effort.
  });
  report.gc.sessions.push(record.taskId);
  input.logger?.log({
    level: "info",
    module: MODULE,
    event: "reconcile_gc_session",
    taskId: record.taskId,
    sessionId: sessionName,
    msg: `confirmed no live session ${sessionName} for crashed provisioning run`,
  });

  await gcRunRecord({ input, record, report, reason: "provisioning run crashed before launch" });
}

async function gcRunRecord(context: {
  input: ReconcileInput;
  record: RunRecord;
  report: ReconcileReport;
  reason: string;
}): Promise<void> {
  const { input, record, report } = context;
  await deleteRun({ stateRoot: input.stateRoot, taskSlug: taskSlug({ taskId: record.taskId }) });
  report.gc.runRecords.push(record.taskId);
  input.logger?.log({
    level: "info",
    module: MODULE,
    event: "reconcile_gc_run_record",
    taskId: record.taskId,
    runId: record.runId,
    msg: `deleted run record (${context.reason})`,
  });
}

/**
 * Orphaned workspace directories: a worktree on disk with no run record and no
 * live session. Identified by the workspace marker's task id (contracts §3.2).
 */
async function reconcileOrphanWorkspaces(context: {
  input: ReconcileInput;
  records: readonly RunRecord[];
  alive: Set<string>;
  report: ReconcileReport;
}): Promise<void> {
  const { input, records, alive, report } = context;
  const recordedSlugs = new Set(records.map((record) => taskSlug({ taskId: record.taskId })));
  const root = worktreesRoot({ config: input.workspaceConfig });

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || recordedSlugs.has(entry.name)) {
      continue;
    }

    const workspaceDirectory = path.join(root, entry.name);
    const marker = readMarker({ workspaceDirectory });
    if (marker === undefined) {
      // No marker: not a recognizable groundcrew workspace; leave for a human.
      continue;
    }

    const sessionName = sessionNameFor({ taskId: marker.taskId });
    if (alive.has(sessionName)) {
      // A live session with no record is a stray, handled separately — never GC'd.
      continue;
    }

    // eslint-disable-next-line no-await-in-loop -- ordered, disk-bound teardown
    await safeRemoveWorkspace({ input, taskId: marker.taskId });
    report.gc.worktrees.push(marker.taskId);
    input.logger?.log({
      level: "info",
      module: MODULE,
      event: "reconcile_gc_worktree",
      taskId: marker.taskId,
      msg: `removed orphaned workspace ${workspaceDirectory} with no run record`,
    });
  }
}

/** Dead managed surfaces are closed; live surfaces with no record are reported. */
function reconcileStraySessions(context: {
  input: ReconcileInput;
  probe: ReadonlyArray<{ name: string; alive: boolean }>;
  recordedSessionNames: Set<string>;
  report: ReconcileReport;
}): void {
  const { input, probe, recordedSessionNames, report } = context;

  for (const session of probe) {
    if (!isManagedSessionName(session.name) || recordedSessionNames.has(session.name)) {
      continue;
    }

    if (session.alive) {
      // Orphaned-but-running: never auto-killed (design doc §10.5, SESSION-03).
      report.straySessions.push(session.name);
      input.logger?.log({
        level: "warn",
        module: MODULE,
        event: "reconcile_stray_session",
        sessionId: session.name,
        msg: `live session ${session.name} has no run record; left for a human`,
      });
      continue;
    }

    // A dead managed surface with no record: provably dead, close it.
    void input.presenter.close(session.name).catch(() => {
      // best-effort
    });
    report.gc.sessions.push(session.name);
    input.logger?.log({
      level: "info",
      module: MODULE,
      event: "reconcile_gc_session",
      sessionId: session.name,
      msg: `closed dead presenter surface ${session.name}`,
    });
  }
}

async function safeRemoveWorkspace(context: {
  input: ReconcileInput;
  taskId: string;
}): Promise<void> {
  try {
    await removeWorkspace({
      config: context.input.workspaceConfig,
      taskId: context.taskId,
      force: true,
      ...(context.input.logger === undefined ? {} : { logger: context.input.logger }),
    });
  } catch (error) {
    context.input.logger?.log({
      level: "warn",
      module: MODULE,
      event: "reconcile_gc_worktree_failed",
      taskId: context.taskId,
      msg: `failed to remove workspace for ${context.taskId}: ${String(error)}`,
    });
  }
}
