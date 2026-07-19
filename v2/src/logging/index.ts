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

import { LOG_LEVELS, LOG_MODULES } from "./types.js";

export {
  LOG_LEVELS,
  LOG_MODULES,
  type LogLevel,
  type LogModule,
  type LogCorrelation,
  type LogEventInput,
  type Logger,
  type CreateLoggerInput,
} from "./types.js";

export { createLogger } from "./logger.js";

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
