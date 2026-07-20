/**
 * `crew cleanup [task|--all]`: tear down task workspaces (design §5/§10.5,
 * contracts §7). A task that never completed is completed as `stopped` (writeback
 * fires if the source supports it). `--all` removes every idle workspace (no live
 * session) plus reconcile-flagged orphans; a live agent session is never killed.
 * A dirty worktree is refused by name unless `--force`.
 */
import { closeSession, probeSessions } from "../../session/index.js";
import { removeWorkspace, resolveTaskContext, taskSlug } from "../../workspace/index.js";
import { deleteRun, listRuns, loadRun, runExists } from "../../run/index.js";
import { dispatchReconcile } from "../dispatchAdapter.js";
import type { Context } from "../context.js";
import type { Io } from "../io.js";

export interface CleanupOptions {
  readonly all?: boolean;
  readonly force?: boolean;
  readonly task?: string;
}

export async function runCleanup(input: {
  readonly context: Context;
  readonly options: CleanupOptions;
  readonly io: Io;
}): Promise<void> {
  if (input.options.all === true) {
    await cleanupAll({ context: input.context, force: input.options.force ?? false, io: input.io });
    return;
  }

  await cleanupOne({
    context: input.context,
    ...(input.options.task === undefined ? {} : { task: input.options.task }),
    force: input.options.force ?? false,
    io: input.io,
  });
}

async function cleanupOne(input: {
  readonly context: Context;
  readonly task?: string;
  readonly force: boolean;
  readonly io: Io;
}): Promise<void> {
  const { context } = input;
  const taskContext = resolveTaskContext({
    ...(input.task === undefined ? {} : { explicitTaskId: input.task }),
    environment: context.environment,
    cwd: context.cwd,
    config: context.workspaceConfig(),
  });

  // An unavailable presenter probe is never "no sessions" (contracts §8): we
  // cannot prove the session is dead, so we refuse to clear the record (CRASH-04).
  const probePromise = probeSessions({ presenter: context.presenter() });
  let probe;
  try {
    probe = await probePromise;
  } catch {
    // A failed probe is handled as unknown liveness below.
  }
  if (probe?.available === false) {
    input.io.out(
      `Left ${taskContext.taskId} untouched: the presenter probe is unavailable, so its ` +
        "session liveness cannot be verified. Re-run once the presenter is reachable.",
    );
    return;
  }

  await tearDown({ context, taskId: taskContext.taskId, force: input.force });
  input.io.out(`Cleaned up ${taskContext.taskId}.`);
}

async function cleanupAll(input: {
  readonly context: Context;
  readonly force: boolean;
  readonly io: Io;
}): Promise<void> {
  const { context } = input;
  await dispatchReconcile({ context });

  const probePromise = probeSessions({ presenter: context.presenter() });
  let probe;
  try {
    probe = await probePromise;
  } catch {
    // A failed probe means there are no verified live sessions.
  }
  const liveSessions = new Set(
    probe?.available === true
      ? probe.sessions.filter((session) => session.alive).map((session) => session.name)
      : [],
  );

  const runs = await listRuns({ stateRoot: context.stateRoot });
  const removed: string[] = [];
  for (const record of runs) {
    if (liveSessions.has(record.sessionName)) {
      continue;
    }

    // eslint-disable-next-line no-await-in-loop -- teardown is ordered per task
    await tearDown({ context, taskId: record.taskId, force: input.force });
    removed.push(record.taskId);
  }

  input.io.out(
    removed.length === 0
      ? "Nothing to clean up."
      : `Cleaned up ${String(removed.length)} workspace(s): ${removed.join(", ")}.`,
  );
}

/** Complete an uncompleted run as `stopped`, close its session, remove its workspace. */
async function tearDown(input: {
  readonly context: Context;
  readonly taskId: string;
  readonly force: boolean;
}): Promise<void> {
  const { context, taskId } = input;
  const slug = taskSlug({ taskId });
  const hasRun = await runExists({ stateRoot: context.stateRoot, taskSlug: slug });
  const run = hasRun
    ? await loadRun({
        stateRoot: context.stateRoot,
        taskSlug: slug,
        writeback: context.writebackPortForTask(taskId),
        logger: context.logger,
      })
    : undefined;

  // Dirty guard fires here (before any state change) unless --force.
  await removeWorkspace({
    config: context.workspaceConfig(),
    taskId,
    force: input.force,
    logger: context.logger,
  });

  const closePromise = closeSession({ taskId, presenter: context.presenter() });
  try {
    await closePromise;
  } catch {
    // Closing an already unavailable session is best-effort.
  }

  if (run !== undefined && run.state !== "complete") {
    await run.complete({ outcome: "stopped" });
  }

  if (hasRun) {
    await deleteRun({ stateRoot: context.stateRoot, taskSlug: slug });
  }
}
