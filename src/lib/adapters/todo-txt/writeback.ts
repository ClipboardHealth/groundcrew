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

import { DATE_RE, hashLine, parseAllLines, type ParsedTodoLine } from "./parser.ts";
import { isValidThresholdValue, type TodoTxtSourceRef } from "./normalizer.ts";

export interface RecurResult {
  newId: string;
  newTodoLine: string;
  oldPromptPath: string;
  newPromptPath: string;
}

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
  unit: "d" | "w" | "m" | "y" | "h";
  strict: boolean;
}

const REC_RE = /^(?<strict>\+?)(?<amount>\d+)(?<unit>[dwmyh])$/;

function parseRecurrence(rec: string): Recurrence | undefined {
  const m = REC_RE.exec(rec);
  if (m === null) {
    return undefined;
  }
  const [, strictStr, amountStr, unit] = m;
  /* v8 ignore next @preserve -- regex [dwmyh] guarantees unit is always one of d/w/m/y/h */
  if (unit !== "d" && unit !== "w" && unit !== "m" && unit !== "y" && unit !== "h") {
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

// Add hours to a (timezone-naive wall-clock) datetime, minute precision.
function addHours(dateTime: string, hours: number): string {
  const padded = dateTime.length === 16 ? `${dateTime}:00` : dateTime;
  const ms = Date.parse(`${padded}Z`);
  return new Date(ms + hours * 60 * 60 * 1000).toISOString().slice(0, 16);
}

// t: may carry a datetime threshold; advance its date part and keep the time
// component so a recurring task stays scheduled at the same instant of day.
//
// Hour units advance differently: non-strict rec:Nh advances from the
// completion instant (the source-timezone wall clock), so a task that sat
// through daemon downtime re-arms N hours from now instead of stampeding
// through every missed slot. Strict rec:+Nh keeps schedule-aligned
// advancement from the previous threshold, matching due:'s strict semantics.
function advanceThreshold(threshold: string, rec: Recurrence, completionWall: string): string {
  if (rec.unit === "h") {
    let base = completionWall;
    if (rec.strict) {
      base = threshold.length === 10 ? `${threshold}T00:00` : threshold;
    }
    return addHours(base, rec.amount);
  }
  const [datePart, timePart] = threshold.split("T");
  /* v8 ignore next @preserve -- split always yields a first element */
  const nextDate = advanceDate(datePart ?? threshold, rec);
  return timePart === undefined ? nextDate : `${nextDate}T${timePart}`;
}

// "YYYY-MM-DDTHH:MM" wall-clock time for `now` in the given timezone.
function wallClockDateTime(timeZone: string, now: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string): string | undefined => parts.find((part) => part.type === type)?.value;
  const year = get("year");
  const month = get("month");
  const day = get("day");
  const hour = get("hour");
  const minute = get("minute");
  /* v8 ignore next 3 @preserve -- Intl.DateTimeFormat with these options always returns the parts */
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined
  ) {
    throw new Error(`todo-txt: could not format datetime in timezone "${timeZone}"`);
  }
  return `${year}-${month}-${day}T${hour}:${minute}`;
}

function advanceId(id: string, newDate: Date): string {
  const dateCompact = compactDate(newDate);
  // Replace the first 8-digit run (compact date) in the id
  const replaced = id.replace(/\d{8}/, dateCompact);
  if (replaced !== id) {
    return replaced;
  }
  // Unchanged: either the id has no date run (append one), or the date run
  // already equals the new date — same-day hourly recurrence. For the latter,
  // strip any prior collision suffixes and let buildUniqueId number this
  // cycle (-002, -003, …) instead of growing a suffix chain.
  const base = id.replace(/(?:-\d{3})+$/, "");
  return base.includes(dateCompact) ? base : `${id}-${dateCompact}`;
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
  /** Source timezone for hour-unit recurrence wall-clock math. Defaults to UTC. */
  timezone?: string;
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
  completionWallStr: string,
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

  // due: advances from old due (strict) or completion date (normal). Hour
  // units never advance due: — validate() rejects the combination, and a line
  // that bypassed verify carries its due forward unchanged rather than
  // feeding an hour recurrence into date-only math.
  /* v8 ignore next @preserve -- oldDue undefined with rec: is unusual; callers typically pair rec: with due: */
  const dueBase = rec.strict ? (oldDue ?? completionDateStr) : completionDateStr;
  let newDue: string | undefined;
  if (oldDue !== undefined) {
    newDue = rec.unit === "h" ? oldDue : advanceDate(dueBase, rec);
  }
  // t: advances from its own current value by the same period (hour units:
  // see advanceThreshold for strict vs non-strict base)
  const newT = oldT === undefined ? undefined : advanceThreshold(oldT, rec, completionWallStr);

  // Compute new date for id advancement: prefer due:, then t:, so ids stay
  // schedule-aligned for t:-only recurring tasks. Slice to the date part —
  // t: may carry a datetime.
  const newScheduleDate = newDue ?? newT;
  /* v8 ignore next @preserve -- rec: without due: or t: is unusual; id falls back to completion date */
  const newDateForId =
    newScheduleDate === undefined ? now : new Date(`${newScheduleDate.slice(0, 10)}T00:00:00Z`);
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
      const completionWallStr = wallClockDateTime(options.timezone ?? "UTC", now);
      updatedLine = buildDoneLine(originalLine, completionDateStr);
      recurResult = buildRecurResult(
        parsed,
        parsedAll,
        originalLine,
        ref,
        completionDateStr,
        completionWallStr,
        now,
      );
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

  const dueVal = parsed.metadata["due"]?.[0];
  if (dueVal !== undefined && !DATE_RE.test(dueVal)) {
    errors.push(
      `${prefix}: malformed due: date "${dueVal}" for task "${id}" (expected YYYY-MM-DD)`,
    );
  }

  // t: also accepts a datetime threshold for sub-day recurring tasks.
  // Calendar/clock validity is enforced for both forms — a non-calendar value
  // would otherwise crash rec: advancement during markDone.
  const tVal = parsed.metadata["t"]?.[0];
  if (tVal !== undefined && !isValidThresholdValue(tVal)) {
    errors.push(
      `${prefix}: malformed t: date "${tVal}" for task "${id}" (expected YYYY-MM-DD or YYYY-MM-DDTHH:MM[:SS])`,
    );
  }

  const recVal = parsed.metadata["rec"]?.[0];
  const recParsed = recVal === undefined ? undefined : parseRecurrence(recVal);
  if (recParsed?.unit === "h" && (tVal === undefined || dueVal !== undefined)) {
    errors.push(
      `${prefix}: hourly rec: "${recVal}" for task "${id}" requires a t: threshold and is incompatible with due:`,
    );
  }
  if (recVal !== undefined && recParsed === undefined) {
    errors.push(
      `${prefix}: malformed rec: "${recVal}" for task "${id}" (expected e.g. 1d, 1w, +1m, 2h)`,
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
