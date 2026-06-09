import path from "node:path";

import { AGENT_ANY } from "../../config.ts";
import { type Blocker, type CanonicalStatus, type Issue, toCanonicalId } from "../../taskSource.ts";
import { getMetadataAll, getMetadataFirst, hashLine, type ParsedTodoLine } from "./parser.ts";

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

export function isActiveForFetch(parsed: ParsedTodoLine): boolean {
  if (parsed.completed) {
    return false;
  }
  if (getMetadataFirst(parsed, "id") === undefined) {
    return false;
  }
  const statusValue = getMetadataFirst(parsed, "status");
  return statusValue === "todo" || statusValue === "in-progress" || statusValue === "in-review";
}
