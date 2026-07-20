/**
 * `crew resume <task>`: reopen a paused task's workspace and resume the same
 * agent conversation (design §9.2, contracts §7). Run state: paused → running.
 * Resuming a task whose workspace is gone is a hard error — nothing is created.
 * `--fresh` starts a new session within the same run.
 */
import { resumeSession } from "../../session/index.js";
import { readMarker, resolveTaskContext, taskSlug, workspacePath } from "../../workspace/index.js";
import { loadRun } from "../../run/index.js";
import { CliError } from "../errors.js";
import type { Context } from "../context.js";
import type { Io } from "../io.js";

export async function runResume(input: {
  readonly context: Context;
  readonly task: string;
  readonly fresh: boolean;
  readonly io: Io;
}): Promise<void> {
  const { context } = input;
  const workspaceConfig = context.workspaceConfig();

  const taskContext = resolveTaskContext({
    explicitTaskId: input.task,
    environment: context.environment,
    cwd: context.cwd,
    config: workspaceConfig,
  });

  const run = await loadRun({
    stateRoot: context.stateRoot,
    taskSlug: taskSlug({ taskId: taskContext.taskId }),
    logger: context.logger,
  }).catch(() => {
    throw new CliError(`no run record for ${taskContext.taskId}; nothing to resume`);
  });

  if (run.state !== "paused") {
    throw new CliError(`cannot resume ${taskContext.taskId}: run is ${run.state}, not paused`);
  }

  // Resume never creates a workspace: a missing one is a hard error.
  const workspaceDirectory = workspacePath({ config: workspaceConfig, taskId: taskContext.taskId });
  if (readMarker({ workspaceDirectory }) === undefined) {
    throw new CliError(
      `cannot resume ${taskContext.taskId}: its workspace is gone (${workspaceDirectory}). ` +
        "Nothing was created; dispatch it again to start fresh.",
    );
  }

  const profileName = run.snapshot.agentProfile;
  const sessionEnvironment = context.sessionEnvironment();
  await resumeSession({
    taskId: taskContext.taskId,
    workspaceDirectory,
    profileName,
    profile: context.agentProfile(profileName),
    fresh: input.fresh,
    ...(run.snapshot.sessionId === undefined ? {} : { sessionId: run.snapshot.sessionId }),
    environment: context.ambientEnvironment(),
    ...(sessionEnvironment === undefined ? {} : { sessionEnvironment }),
    presenter: context.presenter(),
  });

  await run.resume();

  input.io.out(
    `Resumed ${taskContext.taskId}${input.fresh ? " (fresh session)" : ""}.`,
  );
}
