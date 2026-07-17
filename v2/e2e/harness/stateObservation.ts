/**
 * Read-only parsers for v2's on-disk state and logs (catalog §1.2).
 *
 * Everything here is black-box: it reads the files whose paths and schemas are
 * fixed by contracts §3 and §6 and validates them against the harness's own
 * zod transcription (never the implementation's). Each helper is total — a
 * missing file or a schema mismatch throws a descriptive error naming the file,
 * so a scenario failure points precisely at the divergence.
 */

import * as fs from "node:fs";

import type { z } from "zod";

import { logLineSchema } from "./logSchema.js";
import type { LogLine } from "./logSchema.js";
import {
  dispatchVerdictsSchema,
  runRecordSchema,
  workspaceMarkerSchema,
} from "./schemas.js";
import type { DispatchVerdicts, RunRecord, WorkspaceMarker } from "./schemas.js";

/** True when a run record file exists at `path`. */
export function runRecordExists(input: { readonly path: string }): boolean {
  return fs.existsSync(input.path);
}

/** Reads and validates a run record (contracts §3.1). */
export function readRunRecord(input: { readonly path: string }): RunRecord {
  return parseJsonFile({ path: input.path, schema: runRecordSchema, label: "run record" });
}

/** Reads and validates the dispatch verdicts map (contracts §3.3). */
export function readDispatchVerdicts(input: { readonly path: string }): DispatchVerdicts {
  return parseJsonFile({
    path: input.path,
    schema: dispatchVerdictsSchema,
    label: "dispatch verdicts",
  });
}

/** Reads and validates a workspace marker (contracts §3.2). */
export function readWorkspaceMarker(input: { readonly path: string }): WorkspaceMarker {
  return parseJsonFile({
    path: input.path,
    schema: workspaceMarkerSchema,
    label: "workspace marker",
  });
}

/**
 * Reads the JSONL log file, parsing and schema-validating every non-empty line
 * (contracts §6). Throws naming the offending line number on the first line
 * that is not valid JSON or does not match the log schema.
 */
export function readLogLines(input: { readonly path: string }): LogLine[] {
  const contents = readFileOrThrow({ path: input.path, label: "log file" });
  const lines = contents.split("\n");
  const parsed: LogLine[] = [];

  for (const [index, line] of lines.entries()) {
    if (line.trim() === "") {
      continue;
    }

    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      throw new Error(
        `Log line ${String(index + 1)} in ${input.path} is not valid JSON: ${line}`,
      );
    }

    const result = logLineSchema.safeParse(json);
    if (!result.success) {
      throw new Error(
        `Log line ${String(index + 1)} in ${input.path} violates the log schema: ${describeIssues(result.error)}`,
      );
    }

    parsed.push(result.data);
  }

  return parsed;
}

function parseJsonFile<Schema extends z.ZodType>(input: {
  readonly path: string;
  readonly schema: Schema;
  readonly label: string;
}): z.infer<Schema> {
  const contents = readFileOrThrow({ path: input.path, label: input.label });

  let json: unknown;
  try {
    json = JSON.parse(contents);
  } catch {
    throw new Error(`${input.label} at ${input.path} is not valid JSON`);
  }

  const result = input.schema.safeParse(json);
  if (!result.success) {
    throw new Error(
      `${input.label} at ${input.path} violates its schema: ${describeIssues(result.error)}`,
    );
  }

  return result.data;
}

function readFileOrThrow(input: { readonly path: string; readonly label: string }): string {
  if (!fs.existsSync(input.path)) {
    throw new Error(`${input.label} not found at ${input.path}`);
  }

  return fs.readFileSync(input.path, "utf8");
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("; ");
}
