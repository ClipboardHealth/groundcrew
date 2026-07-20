/**
 * `crew repo add <repo>`: acquire a worktree for <repo> into the current task's
 * workspace (design §4, contracts §7). Task identity resolves BEFORE the repo
 * gate — no task context is exit 3 even when the repo is also absent; a repo not
 * cloned under baseDirectory is exit 2 (both raised by Workspace).
 */
import {
  acquireWorktree,
  resolveTaskContext,
  taskSlug,
} from "../../workspace/index.js";
import { loadRun, runExists } from "../../run/index.js";
import type { Context } from "../context.js";
import type { Io } from "../io.js";

export async function runRepoAdd(input: {
  readonly context: Context;
  readonly repo: string;
  readonly task?: string;
  readonly io: Io;
}): Promise<void> {
  const { context } = input;
  const workspaceConfig = context.workspaceConfig();

  // Identity BEFORE the repo gate (contracts §3.2): NoTaskContextError → exit 3.
  const taskContext = resolveTaskContext({
    ...(input.task === undefined ? {} : { explicitTaskId: input.task }),
    environment: context.environment,
    cwd: context.cwd,
    config: workspaceConfig,
  });

  // RepoNotOnDiskError → exit 2.
  const result = await acquireWorktree({
    config: workspaceConfig,
    taskId: taskContext.taskId,
    repo: input.repo,
    logger: context.logger,
  });

  const slug = taskSlug({ taskId: taskContext.taskId });
  if (await runExists({ stateRoot: context.stateRoot, taskSlug: slug })) {
    const run = await loadRun({ stateRoot: context.stateRoot, taskSlug: slug, logger: context.logger });
    await run.addRepo(input.repo);
  }

  input.io.out(
    `Acquired worktree for ${input.repo} on ${result.branch} at ${result.worktreePath}` +
      (result.reused ? " (reused)" : ""),
  );
}
