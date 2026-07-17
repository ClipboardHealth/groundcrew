/**
 * Zod schema for the JSON-lines log format (contracts §6, design doc §10.2).
 *
 * The implementation's logging library also exports a schema; this is the
 * suite's independent copy. SURFACE-04 validates every emitted line against it,
 * black-box. Correlation ids are flat at the top level and optional; extra
 * fields are allowed (the format is open beyond the reserved keys).
 */

import { z } from "zod";

import { isoUtcTimestamp } from "./schemas.js";

export const logLevelSchema = z.enum(["debug", "info", "warn", "error"]);

/** The seven ratified module names that may appear in `module` (design doc §9). */
export const logModuleSchema = z.enum([
  "acquisition",
  "dispatch",
  "run",
  "workspace",
  "session",
  "sandbox",
  "shell",
]);

/**
 * A single structured log line. `ts`, `level`, and `module` are required on
 * every line; `event` is a required snake_case name unique per call site;
 * correlation ids are optional and flat. Unknown extra fields pass through.
 */
export const logLineSchema = z
  .object({
    ts: isoUtcTimestamp,
    level: logLevelSchema,
    module: logModuleSchema,
    event: z
      .string()
      .regex(/^[a-z0-9]+(?:_[a-z0-9]+)*$/u, "expected a snake_case event name"),
    msg: z.string().optional(),
    taskId: z.string().optional(),
    runId: z.string().optional(),
    sessionId: z.string().optional(),
    source: z.string().optional(),
    repo: z.string().optional(),
  })
  .loose();

export type LogLine = z.infer<typeof logLineSchema>;
