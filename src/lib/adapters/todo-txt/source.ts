import { readFileSync, statSync } from "node:fs";

import type { AdapterContext } from "../../adapterDefinition.ts";
import {
  type Issue,
  type MarkDoneResult,
  type MarkInReviewResult,
  type TaskSource,
  toCanonicalId,
} from "../../taskSource.ts";
import { isActiveForFetch, normalizeToIssue, type TodoTxtSourceRef } from "./normalizer.ts";
import { getMetadataFirst, parseAllLines } from "./parser.ts";
import type { TodoTxtAdapterConfig } from "./schema.ts";
import { copyPromptFile, updateTaskStatus, validateTodoFile } from "./writeback.ts";

function readDescription(promptPath: string): string {
  try {
    return readFileSync(promptPath, "utf8");
  } catch {
    return "";
  }
}

function fileUpdatedAt(filePath: string): string {
  try {
    return new Date(statSync(filePath).mtimeMs).toISOString();
  } catch {
    /* v8 ignore next @preserve -- statSync failing means file missing; covered by empty-file tests */
    return new Date().toISOString();
  }
}

function readAndParseTodo(todoPath: string): {
  rawLines: string[];
  parsedAll: ReturnType<typeof parseAllLines>;
} {
  let content: string;
  try {
    content = readFileSync(todoPath, "utf8");
  } catch {
    content = "";
  }
  return {
    rawLines: content.split("\n"),
    parsedAll: parseAllLines(content),
  };
}

function buildIssue(options: {
  parsedIndex: number;
  parsedAll: ReturnType<typeof parseAllLines>;
  sourceName: string;
  todoPath: string;
  tasksDir: string;
  defaultRepository: string | undefined;
  updatedAt: string;
}): Issue | undefined {
  const { parsedIndex, parsedAll, sourceName, todoPath, tasksDir, defaultRepository, updatedAt } =
    options;
  const parsed = parsedAll[parsedIndex];
  /* v8 ignore next @preserve -- callers always validate parsedIndex before calling buildIssue */
  if (parsed === null || parsed === undefined) {
    return undefined;
  }

  const id = getMetadataFirst(parsed, "id");
  /* v8 ignore next @preserve -- callers pre-filter by isActiveForFetch which requires id: */
  if (id === undefined) {
    return undefined;
  }

  const promptOverride = getMetadataFirst(parsed, "prompt");
  const promptPath = promptOverride ?? `${tasksDir}/${id}.md`;
  const description = readDescription(promptPath);

  return normalizeToIssue({
    parsed,
    allParsed: parsedAll,
    sourceName,
    todoPath,
    tasksDir,
    defaultRepository,
    description,
    updatedAt,
  });
}

export function createTodoTxtTaskSource(
  config: TodoTxtAdapterConfig,
  _context: AdapterContext,
): TaskSource {
  const sourceName = config.name;
  const { todoPath, tasksDir } = config;

  function buildIssueList(): Issue[] {
    const updatedAt = fileUpdatedAt(todoPath);
    const { parsedAll } = readAndParseTodo(todoPath);
    const issues: Issue[] = [];

    for (let i = 0; i < parsedAll.length; i++) {
      const parsed = parsedAll[i];
      if (parsed === null || parsed === undefined) {
        continue;
      }
      if (!isActiveForFetch(parsed)) {
        continue;
      }

      const issue = buildIssue({
        parsedIndex: i,
        parsedAll,
        sourceName,
        todoPath,
        tasksDir,
        defaultRepository: config.defaultRepository,
        updatedAt,
      });
      /* v8 ignore else @preserve -- isActiveForFetch guarantees id: present, so buildIssue always returns an Issue */
      if (issue !== undefined) {
        issues.push(issue);
      }
    }
    return issues;
  }

  return {
    name: sourceName,

    async verify(): Promise<void> {
      const errors = validateTodoFile(todoPath, tasksDir);
      if (errors.length > 0) {
        throw new Error(
          `todo-txt source "${sourceName}" verification failed:\n${errors.map((e) => `  - ${e}`).join("\n")}`,
        );
      }
    },

    async fetch(): Promise<Issue[]> {
      return buildIssueList();
    },

    async resolveOne(naturalId: string): Promise<Issue | undefined> {
      const canonicalId = toCanonicalId(sourceName, naturalId);
      const updatedAt = fileUpdatedAt(todoPath);
      const { parsedAll } = readAndParseTodo(todoPath);

      const index = parsedAll.findIndex(
        (p) =>
          p !== null && toCanonicalId(sourceName, getMetadataFirst(p, "id") ?? "") === canonicalId,
      );
      if (index === -1) {
        return undefined;
      }

      return buildIssue({
        parsedIndex: index,
        parsedAll,
        sourceName,
        todoPath,
        tasksDir,
        defaultRepository: config.defaultRepository,
        updatedAt,
      });
    },

    async markInProgress(issue: Issue): Promise<void> {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- TodoTxtTaskSource always writes TodoTxtSourceRef
      const ref = issue.sourceRef as TodoTxtSourceRef;
      await updateTaskStatus({ todoPath, ref }, "in-progress");
    },

    async markInReview(issue: Issue): Promise<MarkInReviewResult> {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- TodoTxtTaskSource always writes TodoTxtSourceRef
      const ref = issue.sourceRef as TodoTxtSourceRef;
      await updateTaskStatus({ todoPath, ref }, "in-review");
      return { outcome: "applied" };
    },

    async markDone(issue: Issue): Promise<MarkDoneResult> {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- TodoTxtTaskSource always writes TodoTxtSourceRef
      const ref = issue.sourceRef as TodoTxtSourceRef;
      const recurResult = await updateTaskStatus({ todoPath, ref }, "done");
      if (recurResult !== undefined) {
        copyPromptFile(recurResult.oldPromptPath, recurResult.newPromptPath);
      }
      return { outcome: "applied" };
    },
  };
}
