import path from "node:path";

import { AGENT_ANY } from "../../config.ts";
import { type Blocker, type CanonicalStatus, type Issue, toCanonicalId } from "../../taskSource.ts";
import {
  DATE_RE,
  DATETIME_RE,
  getMetadataAll,
  getMetadataFirst,
  hashLine,
  type ParsedTodoLine,
} from "./parser.ts";

export interface TodoTxtSourceRef {
  sourceName: string;
  todoPath: string;
  id: string;
  lineFingerprint: string;
  promptPath: string;
}

function derivedCanonicalStatus(parsed: ParsedTodoLine): CanonicalStatus {
  if (parsed.completed) {
    return "done";
  }
  const statusValue = getMetadataFirst(parsed, "status");
  if (statusValue === "todo") {
    return parsed.isStatusFinalToken ? "todo" : "other";
  }
  if (statusValue === "in-progress") {
    return "in-progress";
  }
  if (statusValue === "in-review") {
    return "in-review";
  }
  if (statusValue === "done") {
    return "done";
  }
  return "other";
}

function priorityToNumber(priority: string | undefined): number | undefined {
  if (priority === undefined) {
    return undefined;
  }
  /* v8 ignore next @preserve -- codePointAt(0) on non-empty string never returns undefined */
  const code = priority.codePointAt(0) ?? 0;
  /* v8 ignore next @preserve -- same: "A" is a non-empty string literal */
  const baseCode = "A".codePointAt(0) ?? 65;
  return code - baseCode + 1;
}

function resolveBlocker(
  depId: string,
  allParsed: (ParsedTodoLine | null)[],
  sourceName: string,
): Blocker {
  const found = allParsed.find(
    (p): p is ParsedTodoLine =>
      p !== null && getMetadataFirst(p, "id")?.toLowerCase() === depId.toLowerCase(),
  );

  const id = toCanonicalId(sourceName, depId);

  if (found === undefined) {
    return {
      id,
      title: depId,
      status: "other",
      statusReason: "missing",
    };
  }

  const status = derivedCanonicalStatus(found);
  const nativeStatus = found.completed ? "x" : (getMetadataFirst(found, "status") ?? "(no status)");

  return {
    id,
    title: found.title || depId,
    status,
    ...(status === "other" && { statusReason: "unmapped" as const }),
    nativeStatus,
  };
}

export interface NormalizeOptions {
  parsed: ParsedTodoLine;
  allParsed: (ParsedTodoLine | null)[];
  sourceName: string;
  todoPath: string;
  tasksDir: string;
  defaultRepository: string | undefined;
  description: string;
  updatedAt: string;
}

export function normalizeToIssue(options: NormalizeOptions): Issue | undefined {
  const {
    parsed,
    allParsed,
    sourceName,
    todoPath,
    tasksDir,
    defaultRepository,
    description,
    updatedAt,
  } = options;

  const id = getMetadataFirst(parsed, "id");
  /* v8 ignore next @preserve -- callers always pre-filter for id: before invoking */
  if (id === undefined) {
    return undefined;
  }

  const agent = getMetadataFirst(parsed, "agent") ?? AGENT_ANY;
  const status = derivedCanonicalStatus(parsed);
  const repository = getMetadataFirst(parsed, "repo") ?? defaultRepository;

  const depIds = getMetadataAll(parsed, "dep");
  const blockers: Blocker[] = depIds.map((depId) => resolveBlocker(depId, allParsed, sourceName));

  const promptOverride = getMetadataFirst(parsed, "prompt");
  const promptPath = promptOverride ?? path.join(tasksDir, `${id}.md`);

  const sourceRef: TodoTxtSourceRef = {
    sourceName,
    todoPath,
    id,
    lineFingerprint: hashLine(parsed.raw),
    promptPath,
  };

  const priority = priorityToNumber(parsed.priority);

  return {
    id: toCanonicalId(sourceName, id),
    source: sourceName,
    title: parsed.title,
    description,
    status,
    repository,
    agent,
    assignee: "",
    updatedAt,
    blockers,
    hasMoreBlockers: false,
    ...(priority !== undefined && { priority }),
    sourceRef,
  };
}

// `nowIsoLocal` is either `YYYY-MM-DD` (treated as that day's midnight) or
// `YYYY-MM-DDTHH:MM:SS`, both in the source's configured timezone.
export function isActiveForFetch(parsed: ParsedTodoLine, nowIsoLocal: string): boolean {
  if (parsed.completed) {
    return false;
  }
  if (getMetadataFirst(parsed, "id") === undefined) {
    return false;
  }
  const statusValue = getMetadataFirst(parsed, "status");
  if (statusValue === "todo") {
    return !isDeferredByThreshold(parsed, nowIsoLocal);
  }
  return statusValue === "in-progress" || statusValue === "in-review";
}

// Per todo.txt convention, t: (threshold) hides a task until that date — or,
// with a `YYYY-MM-DDTHH:MM[:SS]` value, until that instant, enabling sub-day
// cadences for self-rearming recurring tasks. Only not-yet-started tasks
// defer; in-progress/in-review work must stay visible so the orchestrator
// keeps tracking it. Malformed t: values are surfaced by validate() and do
// not block dispatch.
function isDeferredByThreshold(parsed: ParsedTodoLine, nowIsoLocal: string): boolean {
  const threshold = getMetadataFirst(parsed, "t");
  if (threshold === undefined) {
    return false;
  }
  if (DATE_RE.test(threshold) && isCalendarDate(threshold)) {
    // ISO YYYY-MM-DD dates order lexicographically
    return threshold > nowIsoLocal.slice(0, 10);
  }
  if (
    DATETIME_RE.test(threshold) &&
    isCalendarDate(threshold.slice(0, 10)) &&
    isClockTime(threshold.slice(11))
  ) {
    const nowDateTime = nowIsoLocal.length > 10 ? nowIsoLocal : `${nowIsoLocal}T00:00:00`;
    // Equal-length ISO datetime strings order lexicographically
    return padSeconds(threshold) > padSeconds(nowDateTime);
  }
  return false;
}

function padSeconds(dateTime: string): string {
  return dateTime.length === 16 ? `${dateTime}:00` : dateTime;
}

// Format + calendar (+ clock) validity for both threshold forms. Shared with
// writeback's validate() so verify() flags what fetch would ignore — and what
// would otherwise crash rec: advancement (a non-calendar date survives the
// format-only regex but produces an Invalid Date in advanceDate).
export function isValidThresholdValue(value: string): boolean {
  if (DATE_RE.test(value)) {
    return isCalendarDate(value);
  }
  return (
    DATETIME_RE.test(value) && isCalendarDate(value.slice(0, 10)) && isClockTime(value.slice(11))
  );
}

// DATETIME_RE is format-only; reject impossible clock values like 25:00 so
// they surface as malformed (visible) instead of deferring forever.
function isClockTime(value: string): boolean {
  const [hours, minutes, seconds = "00"] = value.split(":");
  return Number(hours) <= 23 && Number(minutes) <= 59 && Number(seconds) <= 59;
}

// DATE_RE is format-only; non-calendar values like 2026-99-99 would compare
// greater than any real date and defer the task forever.
function isCalendarDate(value: string): boolean {
  const monthIndex = Number(value.slice(5, 7)) - 1;
  const day = Number(value.slice(8, 10));
  const date = new Date(Date.UTC(Number(value.slice(0, 4)), monthIndex, day));
  return date.getUTCMonth() === monthIndex && date.getUTCDate() === day;
}
