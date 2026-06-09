import { appendFileSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { styleText } from "node:util";

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

// Gates whether the diagnostic tier — debug() and logEvent() — is echoed to the
// console. Both tiers always tee to the log file regardless of this flag, so the
// full stream is never lost. The CLI arms this from `--verbose` /
// GROUNDCREW_VERBOSE before dispatching a command.
let verboseConsole = false;

export function setVerbose(value: boolean): void {
  verboseConsole = value;
}

export function isVerbose(): boolean {
  return verboseConsole;
}

// styleText returns the text unchanged when stdout has no color support (not a
// TTY, or NO_COLOR set), so callers never branch on TTY detection themselves —
// and test assertions stay plain because vitest runs with a piped stdout.
type StyleFormat = Parameters<typeof styleText>[0];

function paint(format: StyleFormat, text: string): string {
  return styleText(format, text, { stream: process.stdout });
}

export function okMark(): string {
  return paint("green", "✓");
}

export function failMark(): string {
  return paint("red", "✗");
}

export function styleWarning(text: string): string {
  return paint("yellow", text);
}

export function styleDim(text: string): string {
  return paint("dim", text);
}

// Module-scoped sink for tee-ing log()/logEvent() to disk. Unset by default
// so tests don't write to the host filesystem; the CLI arms it after
// loadConfig() resolves `logging.file`.
let logFilePath: string | undefined;
let logRunStartByte = 0;
let suppressedLogDepth = 0;

export function setLogFile(filePath: string | undefined): void {
  logFilePath = filePath;
  // Snapshot the file size at process start so consumers can show only the
  // current run's output (the log is append-mode and shared across runs).
  logRunStartByte = 0;
  if (filePath !== undefined) {
    try {
      logRunStartByte = statSync(filePath).size;
    } catch {
      logRunStartByte = 0;
    }
  }
}

/** The resolved log file path, or undefined before `setLogFile` runs. */
export function getLogFile(): string | undefined {
  return logFilePath;
}

/**
 * Byte offset in the log file where the current run's output begins (the
 * file size when `setLogFile` ran). `tail -c +N` from this offset shows only
 * this run.
 */
export function getLogRunStartByte(): number {
  return logRunStartByte;
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
    mkdirSync(path.dirname(logFilePath), { recursive: true });
    appendFileSync(logFilePath, `${line}\n`);
  } catch {
    // A broken log destination must not crash the CLI. Stdout still has
    // the line; surface the failure once so the user notices.
    const broken = logFilePath;
    logFilePath = undefined;
    writeError(`groundcrew: disabling file logging — could not write to ${broken}`);
  }
}

function timestamped(message: string): { plain: string; timestamp: string } {
  // 24-hour, zero-padded fields so stacked log lines align on the colons
  // (e.g. `13:00:16`, not `1:00:16 PM`).
  const timestamp = new Date().toLocaleTimeString(undefined, {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  return { plain: `[${timestamp}] ${message}`, timestamp };
}

/** Important tier: always on the console (dimmed timestamp) and the log file. */
export function log(message: string): void {
  if (suppressedLogDepth > 0) {
    return;
  }
  const { plain, timestamp } = timestamped(message);
  writeOutput(`${styleDim(`[${timestamp}]`)} ${message}`);
  appendLogLine(plain);
}

/**
 * Diagnostic tier: always tee'd to the log file, but echoed to the console only
 * under --verbose. Use for mechanics (git porcelain brackets, adapter probe
 * failures, "loaded config") that an operator rarely needs while watching.
 */
export function debug(message: string): void {
  if (suppressedLogDepth > 0) {
    return;
  }
  const { plain } = timestamped(message);
  if (verboseConsole) {
    writeOutput(styleDim(plain));
  }
  appendLogLine(plain);
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
  // Structured telemetry is diagnostic: file always, console only under --verbose.
  if (verboseConsole) {
    writeOutput(styleDim(line));
  }
  appendLogLine(line);
}

export function readEnvironmentVariable(name: string): string | undefined {
  // oxlint-disable-next-line node/no-process-env -- Centralized environment accessor.
  return process.env[name];
}

/**
 * Reads the value that follows `--task` at `argv[index + 1]`. Throws a
 * uniform "task id is required" error if the value is missing, empty, or
 * looks like another flag (starts with `-`). Centralizes the validation so
 * each subcommand's arg parser stays DRY.
 */
export function readTaskArgument(argv: string[], index: number, command: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.length === 0 || value.startsWith("-")) {
    throw new Error(`crew ${command} --task: task id is required`);
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

interface SourceFilterArgs {
  targetSource: string | undefined;
  jsonOutput: boolean;
}

/** Parse the `[source] [--json]` argument pattern shared by source-scoped subcommands. */
export function parseSourceFilterArgs(
  argv: string[],
  commandName: string,
  usage: string,
): SourceFilterArgs {
  let jsonOutput = false;
  let targetSource: string | undefined;
  for (const arg of argv) {
    if (arg === "--json") {
      jsonOutput = true;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`${commandName}: unknown option: ${arg}\n${usage}`);
    }
    if (targetSource !== undefined) {
      throw new Error(`${commandName}: too many arguments\n${usage}`);
    }
    targetSource = arg;
  }
  return { targetSource, jsonOutput };
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
