/**
 * Cross-cutting logging lib — deliberately NOT an eighth module (spec §10.2):
 * it appears nowhere in the §9.4 dependency graph, imports nothing from src,
 * and every module may use it. One global JSON-lines file, size-rotated
 * (~10 MB × 3); the console renders humans-only lines (info+, --verbose for
 * debug), never raw JSON (spec §10.1–10.3).
 *
 * SEAM (coordinator-pinned): implementers replace the internals and keep these
 * exported signatures; extending with new exports is fine, changing existing
 * ones needs coordinator approval. The zod line schema exported here is the
 * compatibility surface the e2e suite validates every emitted line against.
 */
import { z } from "zod";

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const LOG_MODULES = [
  "acquisition",
  "dispatch",
  "run",
  "workspace",
  "session",
  "sandbox",
  "shell",
] as const;
export type LogModule = (typeof LOG_MODULES)[number];

/** Reserved correlation ids, flat at top level, present when known (§10.2). */
export interface LogCorrelation {
  taskId?: string;
  runId?: string;
  sessionId?: string;
  source?: string;
  repo?: string;
}

export interface LogEventInput extends LogCorrelation {
  level: LogLevel;
  module: LogModule;
  /** Required snake_case event name, unique per call site, no module prefix. */
  event: string;
  /** Optional human-facing message. */
  msg?: string;
  /** Extra flat fields; must not collide with reserved keys. */
  fields?: Record<string, string | number | boolean>;
}

export interface Logger {
  log(input: LogEventInput): void;
}

export interface CreateLoggerInput {
  /** Absolute path of the JSON-lines file (contracts §2). */
  filePath: string;
  /** Console threshold; "silent" for in-session commands that own stdout. */
  consoleLevel?: LogLevel | "silent";
}

export function createLogger(_input: CreateLoggerInput): Logger {
  throw new Error("not implemented: logging.createLogger");
}

/** The published line format (contracts §6); e2e validates against this shape. */
export const logLineSchema = z
  .looseObject({
    ts: z.iso.datetime(),
    level: z.enum(LOG_LEVELS),
    module: z.enum(LOG_MODULES),
    event: z.string().regex(/^[a-z][a-z0-9_]*$/),
    msg: z.string().optional(),
    taskId: z.string().optional(),
    runId: z.string().optional(),
    sessionId: z.string().optional(),
    source: z.string().optional(),
    repo: z.string().optional(),
  });

export type LogLine = z.infer<typeof logLineSchema>;
