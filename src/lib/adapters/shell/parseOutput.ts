/**
 * Friendly stdout parsing for the shell adapter. A shell source emits JSON on
 * stdout; both `JSON.parse` and the Zod schema can reject it. A raw `ZodError`
 * stringifies to a JSON array of issues — cryptic, unattributed, and (for a
 * fetch array) repeated once per task. This module collapses that into a
 * single user-facing `TaskSourceOutputError` that names the source, the
 * command, and the offending field(s), with a targeted hint for the common
 * "missing `agent`" mistake.
 */

import type { z } from "zod";

import { TaskSourceOutputError } from "../../taskSource.ts";
import { errorMessage } from "../../util.ts";

export interface ShellParseContext {
  /** The source's configured `name`, surfaced so the user knows which source broke. */
  sourceName: string;
  /** The contract method that produced the output, e.g. `"listTasks"` or `"getTask"`. */
  command: string;
}

/**
 * Parse `stdout` as JSON and validate it against `schema`. On any failure,
 * throws a `TaskSourceOutputError` with a readable, source-attributed message
 * instead of a raw `SyntaxError` / `ZodError`.
 */
export function parseShellJson<T>(
  schema: z.ZodType<T>,
  stdout: string,
  context: ShellParseContext,
): T {
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch (error) {
    throw new TaskSourceOutputError(
      `source "${context.sourceName}": the ${context.command} command did not return valid JSON (${errorMessage(error)}).`,
    );
  }
  const result = schema.safeParse(json);
  if (result.success) {
    return result.data;
  }
  throw new TaskSourceOutputError(formatSchemaError(result.error, context));
}

/** The last string segment of an issue path — the field name, ignoring array indices. */
function fieldName(path: readonly PropertyKey[]): string | undefined {
  for (let index = path.length - 1; index >= 0; index -= 1) {
    const segment = path[index];
    if (typeof segment === "string") {
      return segment;
    }
  }
  return undefined;
}

type ZodIssue = z.ZodError["issues"][number];

/** One human-readable phrase describing what's wrong with a single issue. */
function describeIssue(issue: ZodIssue): string {
  const field = fieldName(issue.path);
  const label = field === undefined ? "field" : `"${field}"`;
  // Zod v4 reports a missing required key as an `invalid_type` whose message
  // ends in "received undefined"; there is no separate `received` property to
  // branch on, so we match the message.
  if (issue.code === "invalid_type" && issue.message.includes("received undefined")) {
    return `are missing the required ${label} field`;
  }
  return `have an invalid ${label} field: ${issue.message}`;
}

function formatSchemaError(error: z.ZodError, context: ShellParseContext): string {
  // A fetch array yields one issue per task (48 tasks missing `agent` → 48
  // identical issues). Collapse identical phrasings into a single counted line,
  // preserving first-seen order via the Map's insertion order.
  const counts = new Map<string, number>();
  for (const issue of error.issues) {
    const description = describeIssue(issue);
    counts.set(description, (counts.get(description) ?? 0) + 1);
  }
  const lines = [...counts].map(([description, count]) => `  • ${count} issue(s) ${description}`);
  return [
    `source "${context.sourceName}": the ${context.command} command returned task JSON that doesn't match the expected shape:`,
    ...lines,
  ].join("\n");
}
