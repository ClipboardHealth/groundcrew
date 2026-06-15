import path from "node:path";

import { z } from "zod";

import { shellAdapterConfigSchema } from "./adapters/shell/schema.ts";
import { todoTxtAdapterConfigSchema } from "./adapters/todo-txt/schema.ts";
import type { ResolvedConfig } from "./config.ts";

const sourceSelectorShape = z.looseObject({
  kind: z.string().optional(),
  name: z.string().optional(),
  enabled: z.boolean().optional(),
});

const DEFAULT_TODO_SOURCE_NAME = "todo";

/**
 * Local directories the sandbox must open (read + write) for a task. Covers two
 * source kinds: a `todo-txt` source's completion-writeback target (the todo
 * file's parent dir plus its tasks dir) and a `shell` source's declared
 * `sandboxWritePaths`. Scoped to the source that owns the task by the task-id
 * prefix; an un-prefixed id grants every eligible source's paths.
 */
export function taskSourceWritePathsForCompletion(input: {
  config: Pick<ResolvedConfig, "sources">;
  taskId: string;
  workingDir: string;
}): readonly string[] {
  const targetSourceName = sourceNameFromTaskId(input.taskId);
  const paths: string[] = [];

  for (const rawSource of input.config.sources) {
    const selector = sourceSelectorShape.parse(rawSource);
    if (selector.enabled === false) {
      continue;
    }
    if (selector.kind !== "todo-txt" && selector.kind !== "shell") {
      continue;
    }

    // Only the canonical task-list source has an implicit default name; shell
    // sources carry a schema-required name, so the fallback never applies there.
    const sourceName = selector.name ?? DEFAULT_TODO_SOURCE_NAME;
    if (targetSourceName !== undefined && sourceName !== targetSourceName) {
      continue;
    }

    if (selector.kind === "todo-txt") {
      const source = todoTxtAdapterConfigSchema.parse(rawSource);

      // Completion writeback writes the todo file plus lock/tmp siblings, so the
      // sandbox grant must cover the todo file's parent directory.
      paths.push(resolveForWorker(input.workingDir, path.dirname(source.todoPath)));
      paths.push(resolveForWorker(input.workingDir, source.tasksDir));
    } else {
      // shell: open the directories the source declares it reads/writes in place
      // (e.g. an external plan store) for read + write under the sandbox.
      const source = shellAdapterConfigSchema.parse(rawSource);
      for (const writePath of source.sandboxWritePaths ?? []) {
        paths.push(resolveForWorker(input.workingDir, writePath));
      }
    }
  }

  return [...new Set(paths)];
}

function sourceNameFromTaskId(taskId: string): string | undefined {
  const colonIndex = taskId.indexOf(":");
  if (colonIndex <= 0) {
    return undefined;
  }
  return taskId.slice(0, colonIndex);
}

function resolveForWorker(workingDir: string, filePath: string): string {
  return path.resolve(workingDir, filePath);
}
