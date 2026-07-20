/**
 * `crew pause <task>`: suspend a running task, ending its session process but
 * keeping the workspace and worktrees intact (design §9.2, contracts §7). Run
 * state: running → paused; `crew resume` reopens the same session name.
 */
import { pauseSession } from "../../session/index.js";
import { resolveTaskContext, taskSlug } from "../../workspace/index.js";
import { loadRun } from "../../run/index.js";
import { CliError } from "../errors.js";
import type { Context } from "../context.js";
import type { Io } from "../io.js";

export async function runPause(input: {
  readonly context: Context;
  readonly task: string;
  readonly reason?: string;
  readonly io: Io;
}): Promise<void> {
  const { context } = input;

  const taskContext = resolveTaskContext({
    explicitTaskId: input.task,
    environment: context.environment,
    cwd: context.cwd,
    config: context.workspaceConfig(),
  });

  const run = await loadRun({
    stateRoot: context.stateRoot,
    taskSlug: taskSlug({ taskId: taskContext.taskId }),
    logger: context.logger,
  }).catch(() => {
    throw new CliError(`no run record for ${taskContext.taskId}; nothing to pause`);
  });

  if (run.state !== "running") {
    throw new CliError(`cannot pause ${taskContext.taskId}: run is ${run.state}, not running`);
  }

  await pauseSession({ taskId: taskContext.taskId, presenter: context.presenter() });
  await run.pause(input.reason === undefined ? {} : { reason: input.reason });

  input.io.out(`Paused ${taskContext.taskId}. Resume with \`crew resume ${taskContext.taskId}\`.`);
}
