import path from "node:path";

import { z } from "zod";

import { todoTxtAdapterConfigSchema } from "./adapters/todo-txt/schema.ts";
import type { ResolvedConfig } from "./config.ts";

const sourceSelectorShape = z.looseObject({
  kind: z.string().optional(),
  name: z.string().optional(),
  enabled: z.boolean().optional(),
});

const DEFAULT_TODO_SOURCE_NAME = "todo";

export function taskSourceWritePathsForCompletion(input: {
  config: Pick<ResolvedConfig, "sources">;
  taskId: string;
  workingDir: string;
}): readonly string[] {
  const targetSourceName = sourceNameFromTaskId(input.taskId);
  const paths: string[] = [];

  for (const rawSource of input.config.sources) {
    const selector = sourceSelectorShape.parse(rawSource);
    if (selector.enabled === false || selector.kind !== "todo-txt") {
      continue;
    }

    const sourceName = selector.name ?? DEFAULT_TODO_SOURCE_NAME;
    if (targetSourceName !== undefined && sourceName !== targetSourceName) {
      continue;
    }

    const source = todoTxtAdapterConfigSchema.parse(rawSource);

    // Completion writeback writes the todo file plus lock/tmp siblings, so the
    // sandbox grant must cover the todo file's parent directory.
    paths.push(resolveForWorker(input.workingDir, path.dirname(source.todoPath)));
    paths.push(resolveForWorker(input.workingDir, source.tasksDir));
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
