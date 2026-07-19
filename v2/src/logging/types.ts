/**
 * Logging types and level/module vocabularies, factored out of the pinned seam
 * so the internal `logger.ts` can consume them without importing `index.ts`
 * (which re-exports `createLogger` from `logger.ts` — keeping the module graph
 * acyclic). The seam re-exports everything here unchanged.
 */
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
  /**
   * Rotation threshold in bytes for the active file; default ~10 MB.
   * Additive test seam — omitted in production callers (spec §10.1).
   */
  maxBytes?: number;
  /** Total files kept (active + archives); default 3. Additive test seam. */
  maxFiles?: number;
  /** Clock injection for deterministic timestamps; default `() => new Date()`. */
  now?: () => Date;
  /** Console writer; default writes to stderr. Additive test seam. */
  writeConsole?: (text: string) => void;
}
