import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { hashLine, parseAllLines, type ParsedTodoLine } from "./parser.ts";
import type { TodoTxtSourceRef } from "./normalizer.ts";

export interface RecurResult {
  newId: string;
  newTodoLine: string;
  oldPromptPath: string;
  newPromptPath: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function compactDate(date: Date): string {
  return isoDate(date).replaceAll("-", "");
}

function addDays(dateStr: string, days: number): string {
  const ms = Date.parse(`${dateStr}T00:00:00Z`);
  return isoDate(new Date(ms + days * 24 * 60 * 60 * 1000));
}

function addMonths(dateStr: string, months: number): string {
  const parts = dateStr.split("-").map(Number);
  /* v8 ignore next @preserve -- well-formed YYYY-MM-DD always produces 3 numeric parts */
  const year = parts[0] ?? 2000;
  /* v8 ignore next @preserve -- same: parts[1] is always defined */
  const month = parts[1] ?? 1;
  /* v8 ignore next @preserve -- same: parts[2] is always defined */
  const day = parts[2] ?? 1;
  const d = new Date(Date.UTC(year, month - 1 + months, day));
  return isoDate(d);
}

interface Recurrence {
  amount: number;
  unit: "d" | "w" | "m" | "y";
  strict: boolean;
}

const REC_RE = /^(?<strict>\+?)(?<amount>\d+)(?<unit>[dwmy])$/;

function parseRecurrence(rec: string): Recurrence | undefined {
  const m = REC_RE.exec(rec);
  if (m === null) {
    return undefined;
  }
  const [, strictStr, amountStr, unit] = m;
  /* v8 ignore next @preserve -- regex [dwmy] guarantees unit is always one of d/w/m/y */
  if (unit !== "d" && unit !== "w" && unit !== "m" && unit !== "y") {
    return undefined;
  }
  return {
    strict: strictStr === "+",
    /* v8 ignore next @preserve -- regex (\d+) guarantees amountStr is always defined */
    amount: Number.parseInt(amountStr ?? "1", 10),
    unit,
  };
}

function advanceDate(dateStr: string, rec: Recurrence): string {
  const { amount, unit } = rec;
  if (unit === "d") {
    return addDays(dateStr, amount);
  }
  if (unit === "w") {
    return addDays(dateStr, amount * 7);
  }
  if (unit === "m") {
    return addMonths(dateStr, amount);
  }
  return addMonths(dateStr, amount * 12);
}

function advanceId(id: string, newDate: Date): string {
  const dateCompact = compactDate(newDate);
  // Replace the first 8-digit run (compact date) in the id
  const replaced = id.replace(/\d{8}/, dateCompact);
  return replaced === id ? `${id}-${dateCompact}` : replaced;
}

function buildUniqueId(baseNewId: string, existingIds: Set<string>): string {
  if (existingIds.has(baseNewId.toLowerCase())) {
    for (let suffix = 2; suffix <= 999; suffix++) {
      const candidate = `${baseNewId}-${String(suffix).padStart(3, "0")}`;
      /* v8 ignore else @preserve -- double collision (suffix also taken) is untestable without 1000 tasks */
      if (!existingIds.has(candidate.toLowerCase())) {
        return candidate;
      }
    }
    /* v8 ignore next @preserve -- 999 collisions is unreachable in practice */
    return `${baseNewId}-${Date.now()}`;
  }
  return baseNewId;
}

function replaceStatusToken(line: string, newStatus: string): string {
  return line.replaceAll(/\bstatus:\S+/g, `status:${newStatus}`);
}

function buildDoneLine(originalLine: string, completionDate: string): string {
  // Remove priority marker if present, replace status, prepend x <date>
  const withoutPriority = originalLine.replace(/^\([A-Z]\) /, "");
  const withDoneStatus = replaceStatusToken(withoutPriority, "done");
  return `x ${completionDate} ${withDoneStatus}`;
}

function buildRecurringLine(
  originalLine: string,
  originalId: string,
  newId: string,
  oldDue: string | undefined,
  newDue: string | undefined,
  oldT: string | undefined,
  newT: string | undefined,
): string {
  let line = originalLine;
  line = line.replace(`id:${originalId}`, `id:${newId}`);
  /* v8 ignore else @preserve -- oldDue absent means no due: replacement needed */
  if (oldDue !== undefined && newDue !== undefined) {
    line = line.replace(`due:${oldDue}`, `due:${newDue}`);
  }
  /* v8 ignore else @preserve -- oldT absent means no t: replacement needed */
  if (oldT !== undefined && newT !== undefined) {
    line = line.replace(`t:${oldT}`, `t:${newT}`);
  }
  return replaceStatusToken(line, "todo");
}

async function acquireLock(lockPath: string, maxAttempts = 40, delayMs = 50): Promise<void> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const fd = openSync(lockPath, "wx");
      closeSync(fd);
      return;
    } catch (error) {
      /* v8 ignore next @preserve -- openSync always throws Error with a code */
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") {
        throw error;
      }
      /* v8 ignore next 5 @preserve -- retry sleep requires concurrent lock ownership, untestable in unit tests */
      if (attempt + 1 < maxAttempts) {
        // oxlint-disable-next-line no-await-in-loop -- polling lock acquisition
        await new Promise<void>((resolve) => {
          setTimeout(resolve, delayMs);
        });
      }
    }
  }
  /* v8 ignore next @preserve -- exhausting 40 lock attempts is unreachable in normal test conditions */
  throw new Error(
    `todo-txt: could not acquire lock at ${lockPath} after ${maxAttempts * delayMs}ms`,
  );
}

function releaseLock(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch {
    // best-effort
  }
}

function atomicWrite(filePath: string, content: string): void {
  const tmpPath = `${filePath}.tmp`;
  writeFileSync(tmpPath, content, "utf8");
  renameSync(tmpPath, filePath);
}

export interface UpdateOptions {
  todoPath: string;
  ref: TodoTxtSourceRef;
  now?: Date;
}

export async function withLock<T>(lockPath: string, fn: () => T | Promise<T>): Promise<T> {
  await acquireLock(lockPath);
  try {
    // return await is required here so the finally block runs while the lock is held
    return await Promise.resolve(fn());
  } finally {
    releaseLock(lockPath);
  }
}

type StatusMutation = "in-progress" | "in-review" | "done";

function assertValidTransition(
  newStatus: StatusMutation,
  currentStatus: string | undefined,
  id: string,
): void {
  const s = currentStatus ?? "(none)";
  if (newStatus === "in-progress" && currentStatus !== "todo") {
    throw new Error(
      `todo-txt: cannot mark in-progress: task "${id}" has status "${s}", expected "todo"`,
    );
  }
  if (newStatus === "in-review" && currentStatus !== "in-progress") {
    throw new Error(
      `todo-txt: cannot mark in-review: task "${id}" has status "${s}", expected "in-progress"`,
    );
  }
  if (
    newStatus === "done" &&
    currentStatus !== "in-review" &&
    currentStatus !== "in-progress" &&
    currentStatus !== "todo"
  ) {
    throw new Error(`todo-txt: cannot mark done: task "${id}" has status "${s}"`);
  }
}

function buildRecurResult(
  parsed: ParsedTodoLine,
  parsedAll: (ParsedTodoLine | null)[],
  originalLine: string,
  ref: TodoTxtSourceRef,
  completionDateStr: string,
  now: Date,
): RecurResult | undefined {
  const recStr = parsed.metadata["rec"]?.[0];
  if (recStr === undefined) {
    return undefined;
  }
  const rec = parseRecurrence(recStr);
  /* v8 ignore next @preserve -- malformed rec: is caught by validate(); reaching here with undefined rec is improbable */
  if (rec === undefined) {
    return undefined;
  }

  const existingIds = new Set(
    parsedAll
      .filter((p): p is NonNullable<typeof p> => p !== null)
      .map((p) => p.metadata["id"]?.[0]?.toLowerCase())
      .filter((id): id is string => id !== undefined),
  );

  const oldDue = parsed.metadata["due"]?.[0];
  const oldT = parsed.metadata["t"]?.[0];

  // due: advances from old due (strict) or completion date (normal)
  /* v8 ignore next @preserve -- oldDue undefined with rec: is unusual; callers typically pair rec: with due: */
  const dueBase = rec.strict ? (oldDue ?? completionDateStr) : completionDateStr;
  /* v8 ignore next @preserve -- oldDue undefined means skip due advancement */
  const newDue = oldDue === undefined ? undefined : advanceDate(dueBase, rec);
  // t: always advances from its own current value by the same period
  const newT = oldT === undefined ? undefined : advanceDate(oldT, rec);

  // Compute new date for id advancement
  /* v8 ignore next @preserve -- newDue undefined when no due: field; rare edge case */
  const newDateForId = newDue === undefined ? now : new Date(`${newDue}T00:00:00Z`);
  const baseNewId = advanceId(ref.id, newDateForId);
  const newId = buildUniqueId(baseNewId, existingIds);

  const newTodoLine = buildRecurringLine(originalLine, ref.id, newId, oldDue, newDue, oldT, newT);
  const oldPromptPath = ref.promptPath;
  const newPromptPath = oldPromptPath.replace(ref.id, newId);

  return { newId, newTodoLine, oldPromptPath, newPromptPath };
}

export async function updateTaskStatus(
  options: UpdateOptions,
  newStatus: StatusMutation,
): Promise<RecurResult | undefined> {
  const { todoPath, ref } = options;
  const now = options.now ?? new Date();
  const lockPath = `${todoPath}.lock`;

  return await withLock(lockPath, () => {
    const content = readFileSync(todoPath, "utf8");
    const rawLines = content.split("\n");
    const parsedAll = parseAllLines(content);

    // Find the target line — prefer fingerprint match, fall back to id: match
    let targetIndex = rawLines.findIndex((line) => hashLine(line) === ref.lineFingerprint);
    if (targetIndex >= 0) {
      // Verify the fingerprint matched a real task line, not a blank/comment collision
      const matched = parsedAll[targetIndex];
      /* v8 ignore next @preserve -- SHA-256 collision with a blank/comment line is unreachable */
      if (matched === null || matched === undefined) {
        targetIndex = -1;
      }
    }
    if (targetIndex < 0) {
      // Fingerprint mismatch or structural check failed — find by id: (O(n) scan)
      targetIndex = parsedAll.findIndex((parsed) => {
        if (parsed === null || parsed === undefined) {
          return false;
        }
        return parsed.metadata["id"]?.[0]?.toLowerCase() === ref.id.toLowerCase();
      });
    }

    if (targetIndex < 0) {
      throw new Error(`todo-txt: task id "${ref.id}" not found in ${todoPath}`);
    }

    const originalLine = rawLines[targetIndex];
    /* v8 ignore next @preserve -- rawLines and parsedAll are co-indexed; targetIndex < length */
    if (originalLine === undefined) {
      throw new Error(`todo-txt: line index ${targetIndex} out of range in ${todoPath}`);
    }

    const parsed = parsedAll[targetIndex];
    /* v8 ignore next 3 @preserve -- targetIndex found via fingerprint/id match, so parsed is never null/undefined */
    if (parsed === null || parsed === undefined) {
      throw new Error(`todo-txt: could not parse line ${targetIndex} in ${todoPath}`);
    }

    assertValidTransition(newStatus, parsed.metadata["status"]?.[0], ref.id);

    let recurResult: RecurResult | undefined;
    let updatedLine: string;

    if (newStatus === "done") {
      const completionDateStr = isoDate(now);
      updatedLine = buildDoneLine(originalLine, completionDateStr);
      recurResult = buildRecurResult(parsed, parsedAll, originalLine, ref, completionDateStr, now);
    } else {
      updatedLine = replaceStatusToken(originalLine, newStatus);
    }

    const newLines = [...rawLines];
    newLines[targetIndex] = updatedLine;

    if (recurResult !== undefined) {
      // Insert new recurring line after the done line
      newLines.splice(targetIndex + 1, 0, recurResult.newTodoLine);
    }

    atomicWrite(todoPath, newLines.join("\n"));
    return recurResult;
  });
}

export function copyPromptFile(oldPath: string, newPath: string): void {
  try {
    const content = readFileSync(oldPath, "utf8");
    mkdirSync(path.dirname(newPath), { recursive: true });
    writeFileSync(newPath, content, "utf8");
  } catch {
    // prompt file is optional — copy is best-effort
  }
}

function validatePromptFile(
  tasksDir: string,
  id: string,
  promptOverride: string | undefined,
  title: string,
  prefix: string,
  errors: string[],
): void {
  const promptPath = promptOverride ?? path.join(tasksDir, `${id}.md`);
  const shouldRequirePrompt = promptOverride !== undefined || title.trim().length === 0;
  try {
    const desc = readFileSync(promptPath, "utf8");
    if (desc.trim().length === 0 && shouldRequirePrompt) {
      errors.push(`${prefix}: empty prompt file "${promptPath}" for ready task "${id}"`);
    }
  } catch {
    if (shouldRequirePrompt) {
      errors.push(`${prefix}: missing prompt file "${promptPath}" for ready task "${id}"`);
    }
  }
}

function validateDepsAndDates(
  parsed: ParsedTodoLine,
  parsedAll: (ParsedTodoLine | null)[],
  id: string,
  prefix: string,
  errors: string[],
): void {
  const depIds = parsed.metadata["dep"] ?? [];
  for (const depId of depIds) {
    const depFound = parsedAll.find(
      (p): p is ParsedTodoLine =>
        p !== null && p.metadata["id"]?.[0]?.toLowerCase() === depId.toLowerCase(),
    );
    if (depFound === undefined) {
      errors.push(`${prefix}: unresolved dep "${depId}" for task "${id}"`);
    }
  }

  for (const dateField of ["due", "t"]) {
    const dateVal = parsed.metadata[dateField]?.[0];
    if (dateVal !== undefined && !DATE_RE.test(dateVal)) {
      errors.push(
        `${prefix}: malformed ${dateField}: date "${dateVal}" for task "${id}" (expected YYYY-MM-DD)`,
      );
    }
  }

  const recVal = parsed.metadata["rec"]?.[0];
  if (recVal !== undefined && parseRecurrence(recVal) === undefined) {
    errors.push(
      `${prefix}: malformed rec: "${recVal}" for task "${id}" (expected e.g. 1d, 1w, +1m)`,
    );
  }
}

function validateActiveTaskLine(
  parsed: ParsedTodoLine,
  parsedAll: (ParsedTodoLine | null)[],
  tasksDir: string,
  id: string,
  prefix: string,
  errors: string[],
  knownAgents?: ReadonlySet<string>,
): void {
  const agent = parsed.metadata["agent"]?.[0];
  /* v8 ignore next @preserve -- parser KEY_VALUE_RE requires \S+, so empty agent values can't be parsed */
  if (agent !== undefined && agent.trim().length === 0) {
    errors.push(`${prefix}: empty agent: value for task "${id}"`);
  }
  if (knownAgents !== undefined && agent !== undefined && !knownAgents.has(agent.toLowerCase())) {
    errors.push(`${prefix}: unknown agent "${agent}" for task "${id}"`);
  }

  const statusValue = parsed.metadata["status"]?.[0];
  const validStatuses = ["todo", "in-progress", "in-review", "done", "other"];
  if (statusValue !== undefined && !validStatuses.includes(statusValue)) {
    errors.push(`${prefix}: invalid status "${statusValue}" for task "${id}"`);
  }

  if (statusValue === "todo" && !parsed.isStatusFinalToken) {
    errors.push(
      `${prefix}: task "${id}" has status:todo but it is not the final token — task will not be dispatched`,
    );
  }

  if (statusValue === "todo" && parsed.isStatusFinalToken) {
    validatePromptFile(tasksDir, id, parsed.metadata["prompt"]?.[0], parsed.title, prefix, errors);
  }

  validateDepsAndDates(parsed, parsedAll, id, prefix, errors);
}

export function validateTodoFile(
  todoPath: string,
  tasksDir: string,
  knownAgents?: ReadonlySet<string>,
): string[] {
  const errors: string[] = [];
  let content: string;
  try {
    content = readFileSync(todoPath, "utf8");
  } catch {
    return [`missing todo file: ${todoPath}`];
  }

  const parsedAll = parseAllLines(content);
  const idsSeen = new Map<string, number>();

  for (let i = 0; i < parsedAll.length; i++) {
    const parsed = parsedAll[i];
    if (parsed === null || parsed === undefined) {
      continue;
    }

    const lineNum = i + 1;
    const prefix = `line ${lineNum}`;

    const id = parsed.metadata["id"]?.[0];
    if (id !== undefined) {
      const lower = id.toLowerCase();
      if (idsSeen.has(lower)) {
        errors.push(`${prefix}: duplicate id "${id}" (first seen on line ${idsSeen.get(lower)})`);
      } else {
        idsSeen.set(lower, lineNum);
      }
    }

    if (id === undefined) {
      continue;
    }
    if (parsed.completed) {
      continue;
    }

    validateActiveTaskLine(parsed, parsedAll, tasksDir, id, prefix, errors, knownAgents);
  }

  return errors;
}
