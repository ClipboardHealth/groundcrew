/**
 * `crew done [task]`: report completion (design §5, contracts §7). Sends the
 * `completed { outcome, artifacts, message }` writeback to the task's source
 * (no-op on read-only sources), moving the run to `complete`. Refuses when a
 * worktree is dirty and no artifact was reported for that repo, naming the dirt,
 * unless `--allow-dirty`. Outcome defaults to `delivered`.
 */
import {
  type RunOutcome,
  loadRun,
} from "../../run/index.js";
import { observeWorkspace, resolveTaskContext, taskSlug } from "../../workspace/index.js";
import { CliError } from "../errors.js";
import type { Context } from "../context.js";
import type { Io } from "../io.js";

export interface DoneOptions {
  readonly outcome?: string;
  readonly message?: string;
  readonly allowDirty?: boolean;
  readonly task?: string;
}

const OUTCOMES: readonly RunOutcome[] = ["delivered", "failed", "stopped"];

export async function runDone(input: {
  readonly context: Context;
  readonly options: DoneOptions;
  readonly io: Io;
}): Promise<void> {
  const { context, options } = input;
  const outcome = resolveOutcome(options.outcome);

  const taskContext = resolveTaskContext({
    ...(options.task === undefined ? {} : { explicitTaskId: options.task }),
    environment: context.environment,
    cwd: context.cwd,
    config: context.workspaceConfig(),
  });

  const slug = taskSlug({ taskId: taskContext.taskId });
  const run = await loadRun({
    stateRoot: context.stateRoot,
    taskSlug: slug,
    writeback: context.writebackPortForTask(taskContext.taskId),
    logger: context.logger,
  }).catch(() => {
    throw new CliError(`no run record for ${taskContext.taskId}; nothing to complete`);
  });

  if (options.allowDirty !== true) {
    await assertNoUnreportedDirt({ context, taskId: taskContext.taskId, run });
  }

  await run.complete({
    outcome,
    ...(options.message === undefined ? {} : { message: options.message }),
  });

  input.io.out(`Completed ${taskContext.taskId} (${outcome}).`);
}

function resolveOutcome(value: string | undefined): RunOutcome {
  if (value === undefined) {
    return "delivered";
  }

  const outcome = OUTCOMES.find((candidate) => candidate === value);
  if (outcome !== undefined) {
    return outcome;
  }

  throw new CliError(
    `invalid --outcome "${value}" (expected one of ${OUTCOMES.join(", ")})`,
  );
}

/**
 * The dirty-worktree guard: a repo with uncommitted changes and no reported
 * artifact blocks completion, naming the files (COMPLETE-08).
 */
async function assertNoUnreportedDirt(input: {
  readonly context: Context;
  readonly taskId: string;
  readonly run: Awaited<ReturnType<typeof loadRun>>;
}): Promise<void> {
  const observation = await observeWorkspace({
    config: input.context.workspaceConfig(),
    taskId: input.taskId,
  });
  if (observation === undefined) {
    return;
  }

  const reportedRepos = new Set(
    input.run.snapshot.artifacts
      .map((artifact) => artifact.repo)
      .filter((repo): repo is string => repo !== undefined),
  );

  const offending = observation.repos.filter(
    (repo) => repo.dirtyFiles.length > 0 && !reportedRepos.has(repo.repo),
  );
  if (offending.length === 0) {
    return;
  }

  const detail = offending
    .map((repo) => `${repo.repo} (${repo.dirtyFiles.join(", ")})`)
    .join("; ");
  throw new CliError(
    `refusing to complete: uncommitted changes with no reported artifact in ${detail}. ` +
      "Commit them, run `crew artifact add`, or pass --allow-dirty.",
  );
}
