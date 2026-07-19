/**
 * Shell-string helpers shared by profile composition and the presenter
 * adapters. Placeholders are substituted into command templates that are later
 * handed to a shell (tmux runs the string via `sh -c`; cmux via its workspace
 * shell), so every substituted value must be shell-quoted, and the first token
 * of the composed agent command must resolve on PATH before we try to launch it
 * (the launch-failure gate, COMPLETE-03).
 */

import { accessSync, constants } from "node:fs";
import path from "node:path";

/** Single-quote a value for safe inclusion in a shell command string. */
export function shellQuote(value: string): string {
  if (value.length === 0) {
    return "''";
  }
  return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}

/**
 * The first shell token of a command string — the executable name. Handles a
 * leading single- or double-quoted path; returns `undefined` for an empty or
 * whitespace-only command.
 */
export function firstToken(command: string): string | undefined {
  const trimmed = command.trimStart();
  if (trimmed.length === 0) {
    return undefined;
  }
  const quote = trimmed[0];
  if (quote === "'" || quote === '"') {
    const end = trimmed.indexOf(quote, 1);
    return end === -1 ? trimmed.slice(1) : trimmed.slice(1, end);
  }
  const match = /^\S+/.exec(trimmed);
  return match?.[0];
}

export interface LookupExecutableInput {
  /** The executable name or path (may contain a slash). */
  name: string;
  /** Colon-separated PATH to search; defaults to the empty search set. */
  pathValue?: string;
  /** Directory a relative executable path is resolved against. */
  cwd?: string;
}

/**
 * Resolve an executable the way a shell would: an absolute or slash-bearing
 * path is checked directly, otherwise each PATH entry is probed for an
 * executable file. Returns the resolved absolute path, or `undefined` when the
 * command is not runnable. Injectable so `launchSession` can be unit-tested
 * without touching the real filesystem.
 */
export type LookupExecutable = (input: LookupExecutableInput) => string | undefined;

export const lookupExecutable: LookupExecutable = ({ name, pathValue, cwd }) => {
  if (name.length === 0) {
    return undefined;
  }
  if (name.includes("/")) {
    const resolved = path.resolve(cwd ?? process.cwd(), name);
    return isExecutableFile(resolved) ? resolved : undefined;
  }
  for (const directory of (pathValue ?? "").split(path.delimiter)) {
    if (directory.length === 0) {
      continue;
    }
    const candidate = path.join(directory, name);
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }
  return undefined;
};

function isExecutableFile(candidate: string): boolean {
  try {
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
