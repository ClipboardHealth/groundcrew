import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { AdapterContext } from "../../adapterDefinition.ts";
import { AGENT_ANY_MODEL } from "../../config.ts";
import {
  type CreateTaskInput,
  type Issue,
  type MarkDoneResult,
  type MarkInReviewResult,
  type TaskSource,
  toCanonicalId,
} from "../../taskSource.ts";
import { readEnvironmentVariable } from "../../util.ts";
import { isActiveForFetch, normalizeToIssue, type TodoTxtSourceRef } from "./normalizer.ts";
import { getMetadataFirst, parseAllLines, type ParsedTodoLine } from "./parser.ts";
import type { TodoTxtAdapterConfig } from "./schema.ts";
import { copyPromptFile, updateTaskStatus, validateTodoFile, withLock } from "./writeback.ts";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const RECURRENCE_RE = /^\+?\d+[dwmy]$/;

function readPromptFile(promptPath: string): string | undefined {
  try {
    return readFileSync(promptPath, "utf8");
  } catch {
    return undefined;
  }
}

function descriptionFor(parsed: ParsedTodoLine, promptPath: string): string {
  const promptContent = readPromptFile(promptPath);
  if (promptContent !== undefined && promptContent.trim().length > 0) {
    return promptContent;
  }
  if (parsed.title.trim().length > 0) {
    return `${parsed.title}\n`;
  }
  return promptContent ?? "";
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
  parsedAll: ReturnType<typeof parseAllLines>;
} {
  let content: string;
  try {
    content = readFileSync(todoPath, "utf8");
  } catch {
    content = "";
  }
  return {
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
  const description = descriptionFor(parsed, promptPath);

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

function assertToken(label: string, value: string): void {
  if (value.length === 0 || /\s/.test(value)) {
    throw new Error(`todo-txt: ${label} must be a non-empty single token`);
  }
}

function assertCreateId(id: string): void {
  assertToken("id", id);
  if (id === "." || id === ".." || id.includes("/") || id.includes("\\")) {
    throw new Error("todo-txt: id must be a filename-safe token");
  }
}

function normalizeProject(project: string): string {
  return project.startsWith("+") ? project.slice(1) : project;
}

function normalizeContext(context: string): string {
  return context.startsWith("@") ? context.slice(1) : context;
}

function metadataToken(key: string, value: string): string {
  assertToken(`${key}: value`, value);
  return `${key}:${value}`;
}

function datePartFor(timeZone: string, now: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  /* v8 ignore next 3 @preserve -- Intl.DateTimeFormat with year/month/day always returns these parts */
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error(`todo-txt: could not format date in timezone "${timeZone}"`);
  }
  return `${year}${month}${day}`;
}

/* v8 ignore next @preserve -- Covered in source tests; full-suite V8 coverage remaps this helper inconsistently. */
function nextGeneratedId(
  config: TodoTxtAdapterConfig,
  parsedAll: ReturnType<typeof parseAllLines>,
): string {
  const datePart = datePartFor(config.timezone, new Date());
  const prefix = `${config.idPrefix}-${datePart}-`;
  let maximumSequence = 0;
  for (const parsed of parsedAll) {
    if (parsed === null || parsed === undefined) {
      continue;
    }
    const id = getMetadataFirst(parsed, "id");
    if (id === undefined || !id.startsWith(prefix)) {
      continue;
    }
    const sequence = Number.parseInt(id.slice(prefix.length), 10);
    if (Number.isFinite(sequence) && sequence > maximumSequence) {
      maximumSequence = sequence;
    }
  }
  return `${prefix}${String(maximumSequence + 1).padStart(3, "0")}`;
}

function assertNewId(id: string, parsedAll: ReturnType<typeof parseAllLines>): void {
  const existing = parsedAll.some(
    (parsed) =>
      parsed !== null && getMetadataFirst(parsed, "id")?.toLowerCase() === id.toLowerCase(),
  );
  if (existing) {
    throw new Error(`todo-txt: task id "${id}" already exists`);
  }
}

function buildTodoLine(id: string, input: CreateTaskInput): string {
  const title = input.title.trim();
  if (title.length === 0) {
    throw new Error("todo-txt: title is required");
  }
  if (/[\r\n]/.test(title)) {
    throw new Error("todo-txt: title must be a single line");
  }

  const tokens: string[] = [];
  const priority = input.priority ?? "A";
  if (!/^[A-Z]$/.test(priority)) {
    throw new Error("todo-txt: priority must be a single uppercase letter");
  }
  tokens.push(`(${priority})`);
  tokens.push(title);

  for (const rawProject of input.projects) {
    const project = normalizeProject(rawProject);
    assertToken("project", project);
    tokens.push(`+${project}`);
  }
  for (const rawContext of input.contexts) {
    const context = normalizeContext(rawContext);
    assertToken("context", context);
    tokens.push(`@${context}`);
  }

  tokens.push(metadataToken("id", id));
  if (input.repository !== undefined) {
    tokens.push(metadataToken("repo", input.repository));
  }
  tokens.push(metadataToken("agent", input.agent));
  for (const dependency of input.dependencies) {
    tokens.push(metadataToken("dep", dependency));
  }
  if (input.due !== undefined) {
    if (!DATE_RE.test(input.due)) {
      throw new Error("todo-txt: due date must use YYYY-MM-DD");
    }
    tokens.push(metadataToken("due", input.due));
  }
  if (input.recurrence !== undefined) {
    if (!RECURRENCE_RE.test(input.recurrence)) {
      throw new Error("todo-txt: recurrence must look like 1d, 1w, 1m, 1y, or +1m");
    }
    tokens.push(metadataToken("rec", input.recurrence));
  }
  tokens.push("status:todo");
  return tokens.join(" ");
}

function promptContentFor(input: CreateTaskInput): string {
  if (input.promptFile !== undefined && input.description !== undefined) {
    throw new Error("todo-txt: --prompt-file and --description are mutually exclusive");
  }
  if (input.promptFile !== undefined) {
    return readFileSync(input.promptFile, "utf8");
  }
  if (input.description !== undefined) {
    return input.description;
  }
  return `${input.title.trim()}\n`;
}

function appendTodoLine(todoPath: string, line: string): void {
  mkdirSync(path.dirname(todoPath), { recursive: true });
  let separator = "";
  try {
    const current = readFileSync(todoPath, "utf8");
    separator = current.length === 0 || current.endsWith("\n") ? "" : "\n";
  } catch (error: unknown) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
  appendFileSync(todoPath, `${separator}${line}\n`, "utf8");
}

function writePromptFile(promptPath: string, content: string): void {
  mkdirSync(path.dirname(promptPath), { recursive: true });
  writeFileSync(promptPath, content.endsWith("\n") ? content : `${content}\n`, "utf8");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}

function configuredEditor(): string | undefined {
  const visual = readEnvironmentVariable("VISUAL");
  if (visual !== undefined && visual.trim().length > 0) {
    return visual;
  }
  const editor = readEnvironmentVariable("EDITOR");
  if (editor !== undefined && editor.trim().length > 0) {
    return editor;
  }
  return undefined;
}

function openPromptEditor(promptPath: string): void {
  const editor = configuredEditor();
  if (editor === undefined) {
    throw new Error("todo-txt: --edit requires VISUAL or EDITOR to be set");
  }
  const result = spawnSync(`${editor} ${shellQuote(promptPath)}`, {
    shell: true,
    stdio: "inherit",
  });
  /* v8 ignore next 3 @preserve -- with shell:true editor launch failures report a nonzero status */
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`todo-txt: editor exited with status ${result.status}`);
  }
}

export function createTodoTxtTaskSource(
  config: TodoTxtAdapterConfig,
  context: AdapterContext,
): TaskSource {
  const sourceName = config.name;
  /* v8 ignore next @preserve -- Covered in source tests; full-suite V8 coverage remaps this line inconsistently. */
  const { todoPath, tasksDir } = config;

  const knownAgents =
    context.globalConfig.models === undefined
      ? undefined
      : new Set([
          AGENT_ANY_MODEL,
          ...Object.keys(context.globalConfig.models.definitions).map((k) => k.toLowerCase()),
        ]);

  function listTasks(): Issue[] {
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

  function getTask(naturalId: string): Issue | null {
    const canonicalId = toCanonicalId(sourceName, naturalId);
    const updatedAt = fileUpdatedAt(todoPath);
    const { parsedAll } = readAndParseTodo(todoPath);

    const index = parsedAll.findIndex(
      (parsed) =>
        parsed !== null &&
        toCanonicalId(sourceName, getMetadataFirst(parsed, "id") ?? "") === canonicalId,
    );
    if (index === -1) {
      return null;
    }

    return (
      buildIssue({
        parsedIndex: index,
        parsedAll,
        sourceName,
        todoPath,
        tasksDir,
        defaultRepository: config.defaultRepository,
        updatedAt,
      }) ?? null
    );
  }

  return {
    name: sourceName,

    async verify(): Promise<void> {
      const errors = validateTodoFile(todoPath, tasksDir, knownAgents);
      if (errors.length > 0) {
        throw new Error(
          `todo-txt source "${sourceName}" verification failed:\n${errors.map((e) => `  - ${e}`).join("\n")}`,
        );
      }
    },

    async validate(): Promise<string[]> {
      return validateTodoFile(todoPath, tasksDir, knownAgents);
    },

    async listTasks(): Promise<Issue[]> {
      return listTasks();
    },

    async getTask(naturalId: string): Promise<Issue | null> {
      return getTask(naturalId);
    },

    async createTask(input: CreateTaskInput): Promise<Issue> {
      return await withLock(`${todoPath}.lock`, () => {
        const { parsedAll } = readAndParseTodo(todoPath);
        const id = input.id ?? nextGeneratedId(config, parsedAll);
        assertCreateId(id);
        assertNewId(id, parsedAll);

        const promptPath = path.join(tasksDir, `${id}.md`);
        const promptContent = promptContentFor(input);
        const line = buildTodoLine(id, input);

        writePromptFile(promptPath, promptContent);
        appendTodoLine(todoPath, line);
        if (input.edit) {
          openPromptEditor(promptPath);
        }

        const task = getTask(id);
        /* v8 ignore next 3 @preserve -- createTask just appended this id and getTask reads the same file */
        if (task === null) {
          throw new Error(`todo-txt: created task "${id}" could not be read back`);
        }
        return task;
      });
    },

    async fetch(): Promise<Issue[]> {
      return listTasks();
    },

    async resolveOne(naturalId: string): Promise<Issue | undefined> {
      return getTask(naturalId) ?? undefined;
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
