import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) {
    return;
  }
  await new Promise<void>((resolve) => {
    // Both paths funnel through `settle`, which clears the timer and
    // removes the listener before resolving. Once settle runs, neither
    // caller can fire again — but the lint plugin can't see that, so the
    // disable below is necessary. Without the explicit listener removal,
    // reusing one signal across many sleeps (the watch loop pattern)
    // leaks a listener per call.
    const settle = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", settle);
      // oxlint-disable-next-line promise/no-multiple-resolved -- settle is callable from two sources but disarms both before resolving
      resolve();
    };
    const timer = setTimeout(settle, ms);
    signal?.addEventListener("abort", settle);
  });
}

export function writeOutput(message?: string): void {
  const arguments_ = message === undefined ? [] : [message];
  // oxlint-disable-next-line no-console -- Centralized CLI stdout writer.
  console.log(...arguments_);
}

export function writeError(message: string): void {
  // oxlint-disable-next-line no-console -- Centralized CLI stderr writer.
  console.error(message);
}

// Module-scoped sink for tee-ing log()/logEvent() to disk. Unset by default
// so tests don't write to the host filesystem; the CLI arms it after
// loadConfig() resolves `logging.file`.
let logFilePath: string | undefined;
let suppressedLogDepth = 0;

export function setLogFile(path: string | undefined): void {
  logFilePath = path;
}

export async function withLogOutputSuppressed<T>(operation: () => Promise<T>): Promise<T> {
  suppressedLogDepth += 1;
  try {
    return await operation();
  } finally {
    suppressedLogDepth -= 1;
  }
}

function appendLogLine(line: string): void {
  if (logFilePath === undefined) {
    return;
  }
  try {
    mkdirSync(dirname(logFilePath), { recursive: true });
    appendFileSync(logFilePath, `${line}\n`);
  } catch {
    // A broken log destination must not crash the CLI. Stdout still has
    // the line; surface the failure once so the user notices.
    const broken = logFilePath;
    logFilePath = undefined;
    writeError(`groundcrew: disabling file logging — could not write to ${broken}`);
  }
}

export function log(message: string): void {
  if (suppressedLogDepth > 0) {
    return;
  }
  const timestamp = new Date().toLocaleTimeString();
  const line = `[${timestamp}] ${message}`;
  writeOutput(line);
  appendLogLine(line);
}

type LogEventFieldValue = boolean | number | string | readonly string[] | undefined;

function formatLogEventFieldValue(value: Exclude<LogEventFieldValue, undefined>): string {
  const raw = Array.isArray(value) ? value.join(",") : String(value);
  if (/^[\w./:-]+$/.test(raw)) {
    return raw;
  }
  return JSON.stringify(raw);
}

export function logEvent(event: string, fields: Record<string, LogEventFieldValue>): void {
  if (suppressedLogDepth > 0) {
    return;
  }
  const parts = [`event=${formatLogEventFieldValue(event)}`];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) {
      continue;
    }
    parts.push(`${key}=${formatLogEventFieldValue(value)}`);
  }
  const line = parts.join(" ");
  writeOutput(line);
  appendLogLine(line);
}

export function readEnvironmentVariable(name: string): string | undefined {
  // oxlint-disable-next-line node/no-process-env -- Centralized environment accessor.
  return process.env[name];
}

/**
 * Reads the value that follows `--ticket` at `argv[index + 1]`. Throws a
 * uniform "ticket id is required" error if the value is missing, empty, or
 * looks like another flag (starts with `-`). Centralizes the validation so
 * each subcommand's arg parser stays DRY.
 */
export function readTicketArgument(argv: string[], index: number, command: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.length === 0 || value.startsWith("-")) {
    throw new Error(`crew ${command} --ticket: ticket id is required`);
  }
  return value;
}

export interface DryRunPositionals {
  dryRun: boolean;
  positionals: string[];
}

/**
 * Parses an argv that accepts an optional `--dry-run` flag plus free
 * positionals, rejecting any other dash-prefixed token. Shared by the
 * subcommands whose only flag is `--dry-run` so each parser stays DRY; pass the
 * command's `usage` string for the "Unknown option" error.
 */
export function parseDryRunPositionals(argv: string[], usage: string): DryRunPositionals {
  let dryRun = false;
  const positionals: string[] = [];
  for (const argument of argv) {
    if (argument === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (argument.startsWith("-")) {
      throw new Error(`Unknown option: ${argument}\nUsage: ${usage}`);
    }
    positionals.push(argument);
  }
  return { dryRun, positionals };
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  // Fall back to JSON for object throws — `String({})` collapses to
  // `[object Object]` and loses every useful detail.
  try {
    return JSON.stringify(error);
  } catch {
    return Object.prototype.toString.call(error);
  }
}
