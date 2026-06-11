import { createHash } from "node:crypto";

type TodoMetadata = Record<string, string[] | undefined>;

export interface ParsedTodoLine {
  readonly raw: string;
  readonly completed: boolean;
  readonly completionDate?: string;
  readonly priority?: string;
  readonly creationDate?: string;
  readonly title: string;
  readonly projects: readonly string[];
  readonly contexts: readonly string[];
  readonly metadata: TodoMetadata;
  /** True when the final meaningful whitespace-delimited token is a `status:X` field. */
  readonly isStatusFinalToken: boolean;
}

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Local datetime threshold form for `t:`, seconds optional. */
export const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/;
const KEY_VALUE_RE = /^(?<key>[a-zA-Z][a-zA-Z0-9-]*):(?<value>\S+)$/;
const PRIORITY_RE = /^\((?<priority>[A-Z])\) /;
const PROJECT_RE = /^\+\S+$/;
const CONTEXT_RE = /^@\S+$/;

export function hashLine(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function extractDatePrefix(rest: string): { date: string | undefined; rest: string } {
  const spaceIdx = rest.indexOf(" ");
  const candidate = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx);
  if (DATE_RE.test(candidate)) {
    return { date: candidate, rest: spaceIdx === -1 ? "" : rest.slice(spaceIdx + 1).trimStart() };
  }
  return { date: undefined, rest };
}

function parseTodoLine(raw: string): ParsedTodoLine {
  let rest = raw.trim();
  let completed = false;
  let completionDate: string | undefined;
  let priority: string | undefined;
  let creationDate: string | undefined;

  if (rest.startsWith("x ")) {
    completed = true;
    rest = rest.slice(2).trimStart();
    ({ date: completionDate, rest } = extractDatePrefix(rest));
  }

  const priorityMatch = PRIORITY_RE.exec(rest);
  if (priorityMatch !== null) {
    priority = priorityMatch.groups?.["priority"];
    rest = rest.slice(priorityMatch[0].length);
  }

  ({ date: creationDate, rest } = extractDatePrefix(rest));

  const tokens = rest.split(/\s+/).filter((t) => t.length > 0);
  const projects: string[] = [];
  const contexts: string[] = [];
  const metadata: TodoMetadata = {};
  const titleParts: string[] = [];

  for (const token of tokens) {
    if (PROJECT_RE.test(token)) {
      projects.push(token.slice(1));
    } else if (CONTEXT_RE.test(token)) {
      contexts.push(token.slice(1));
    } else {
      const kvMatch = KEY_VALUE_RE.exec(token);
      if (kvMatch === null) {
        titleParts.push(token);
      } else {
        /* v8 ignore next @preserve -- named capture groups are always defined when regex matches */
        const { key, value } = kvMatch.groups ?? {};
        /* v8 ignore else @preserve -- named groups always defined when regex matches */
        if (key !== undefined && value !== undefined) {
          const existing = metadata[key] ?? [];
          metadata[key] = [...existing, value];
        }
      }
    }
  }

  const lastToken = tokens.at(-1) ?? "";
  const lastKv = KEY_VALUE_RE.exec(lastToken);
  const isStatusFinalToken = lastKv !== null && lastKv.groups?.["key"] === "status";

  return {
    raw,
    completed,
    ...(completionDate !== undefined && { completionDate }),
    ...(priority !== undefined && { priority }),
    ...(creationDate !== undefined && { creationDate }),
    title: titleParts.join(" "),
    projects,
    contexts,
    metadata,
    isStatusFinalToken,
  };
}

export function parseAllLines(fileContent: string): (ParsedTodoLine | null)[] {
  return fileContent.split("\n").map((line) => {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      return null;
    }
    return parseTodoLine(line);
  });
}

export function getMetadataFirst(parsed: ParsedTodoLine, key: string): string | undefined {
  return parsed.metadata[key]?.[0];
}

export function getMetadataAll(parsed: ParsedTodoLine, key: string): string[] {
  return parsed.metadata[key] ?? [];
}
