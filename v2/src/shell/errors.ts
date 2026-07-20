/**
 * Shell's error vocabulary and the error → exit-code mapping (contracts §7).
 * Modules raise typed errors (Workspace owns the 2/3 classes); Shell maps them
 * at the boundary: `RepoNotOnDiskError` → 2, `NoTaskContextError` → 3, every
 * other error → 1 with a clean one-line message (no stack unless `--verbose`).
 */
import { ZodError } from "zod";

import { NoTaskContextError, RepoNotOnDiskError } from "../workspace/index.js";

/** A config that could not be located, parsed, or validated (exit 1). */
export class ConfigError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * Only a v1 config was found (design §11): fail loudly with a migration pointer,
 * never a silent fallback to defaults.
 */
export class V1ConfigError extends Error {
  public readonly v1Path: string;

  public constructor(v1Path: string) {
    super(
      [
        `found a groundcrew v1 config (${v1Path}) but no v2 config.`,
        "groundcrew v2 uses crew.config.jsonc (data, not code) — it will not fall back to v1.",
        "Run `crew init` to convert it: init detects the v1 config and writes the v2 equivalent,",
        "printing every dropped or renamed key.",
      ].join("\n"),
    );
    this.name = "V1ConfigError";
    this.v1Path = v1Path;
  }
}

/** A generic, already-actionable CLI failure (exit 1) with no stack to show. */
export class CliError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}

/** The exit code a thrown error maps to (contracts §7). */
export function exitCodeFor(error: unknown): number {
  if (error instanceof RepoNotOnDiskError) {
    return 2;
  }

  if (error instanceof NoTaskContextError) {
    return 3;
  }

  return 1;
}

/** The clean one-line-or-more message to print to stderr for a failure. */
export function messageFor(error: unknown): string {
  // A ZodError's own `.message` is the raw JSON issue dump; never let that reach
  // the console. Render a concise, human `path: message` list instead. (Config
  // and run-record parsing already map to typed errors upstream; this is the
  // backstop so any stray zod error still renders cleanly.)
  if (error instanceof ZodError) {
    return `validation failed:\n${formatZodIssues(error)}`;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function formatZodIssues(error: ZodError): string {
  return error.issues
    .map((issue) => {
      const location = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `  - ${location}: ${issue.message}`;
    })
    .join("\n");
}
