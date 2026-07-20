/**
 * `crew artifact add <locator>`: record an agent-reported artifact on the task's
 * run record (design §3, contracts §7). Groundcrew records the claim without
 * checking it — status renders it as "reported". The kind defaults to a guess
 * from the locator shape.
 */
import { resolveTaskContext, taskSlug } from "../../workspace/index.js";
import { type Artifact, loadRun } from "../../run/index.js";
import { CliError } from "../errors.js";
import type { Context } from "../context.js";
import type { Io } from "../io.js";

export interface ArtifactAddOptions {
  readonly kind?: string;
  readonly title?: string;
  readonly repo?: string;
  readonly task?: string;
}

export async function runArtifactAdd(input: {
  readonly context: Context;
  readonly locator: string;
  readonly options: ArtifactAddOptions;
  readonly io: Io;
}): Promise<void> {
  const { context, options } = input;

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
    logger: context.logger,
  }).catch(() => {
    throw new CliError(
      `no run record for ${taskContext.taskId}; artifacts attach to a started task`,
    );
  });

  const artifact: Artifact = {
    kind: options.kind ?? guessKind(input.locator),
    locator: input.locator,
    ...(options.title === undefined ? {} : { title: options.title }),
    ...(options.repo === undefined ? {} : { repo: options.repo }),
  };
  await run.addArtifact(artifact);

  input.io.out(`Reported ${artifact.kind}: ${artifact.locator}`);
}

/** Guess an artifact kind from the locator shape (open set; contracts §4.3). */
export function guessKind(locator: string): string {
  if (/\/pull\/\d+|\/pull-requests\/\d+|\/merge_requests\/\d+/u.test(locator)) {
    return "pr";
  }

  if (/^https?:\/\//u.test(locator)) {
    return "document";
  }

  if (locator.startsWith("/") || locator.startsWith("./") || locator.includes("/")) {
    return "file";
  }

  return "ticket";
}
