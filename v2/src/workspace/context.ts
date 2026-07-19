/**
 * In-session task-identity resolution (contracts §3.2/§7). Resolution order,
 * highest priority first: the `--task` flag, then `$GROUNDCREW_WORKSPACE` (a
 * path to the workspace directory whose marker names the task), then a walk up
 * from cwd to the nearest `.groundcrew/task.json`. None resolving throws
 * `NoTaskContextError` (exit 3). This runs BEFORE any other gate.
 */

import path from "node:path";

import { NoTaskContextError } from "./errors.js";
import { readMarker, type WorkspaceMarker } from "./marker.js";
import { workspacePath, type WorkspaceConfig } from "./paths.js";

const WORKSPACE_ENV = "GROUNDCREW_WORKSPACE";

export interface TaskContext {
  readonly taskId: string;
  readonly workspaceDirectory: string;
  /** The workspace marker, when one is already on disk. */
  readonly marker?: WorkspaceMarker;
}

export function resolveTaskContext(input: {
  readonly explicitTaskId?: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly config: WorkspaceConfig;
}): TaskContext {
  const { config } = input;

  if (input.explicitTaskId !== undefined && input.explicitTaskId !== "") {
    const taskId = input.explicitTaskId;
    const workspaceDirectory = workspacePath({ config, taskId });
    const marker = readMarker({ workspaceDirectory });
    return { taskId, workspaceDirectory, ...(marker === undefined ? {} : { marker }) };
  }

  const envWorkspace = input.environment[WORKSPACE_ENV];
  if (envWorkspace !== undefined && envWorkspace !== "") {
    const marker = readMarker({ workspaceDirectory: envWorkspace });
    if (marker !== undefined) {
      return { taskId: marker.taskId, workspaceDirectory: envWorkspace, marker };
    }
  }

  const walked = walkUpForMarker({ start: input.cwd });
  if (walked !== undefined) {
    return {
      taskId: walked.marker.taskId,
      workspaceDirectory: walked.workspaceDirectory,
      marker: walked.marker,
    };
  }

  throw new NoTaskContextError();
}

function walkUpForMarker(input: {
  readonly start: string;
}): { readonly workspaceDirectory: string; readonly marker: WorkspaceMarker } | undefined {
  let directory = path.resolve(input.start);
  for (;;) {
    const marker = readMarker({ workspaceDirectory: directory });
    if (marker !== undefined) {
      return { workspaceDirectory: directory, marker };
    }

    const parent = path.dirname(directory);
    if (parent === directory) {
      return undefined;
    }

    directory = parent;
  }
}
