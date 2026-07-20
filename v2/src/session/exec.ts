/**
 * The one process seam the presenter adapters run through. Every adapter takes
 * an `ExecFn` so the cmux and zellij adapters can be driven entirely from
 * composed-argv assertions in unit tests, while the tmux adapter runs the real
 * binary against an isolated socket. The default implementation is a thin,
 * non-throwing wrapper over `execa` (already a dependency): a non-zero exit is
 * data, not an exception, and a binary that cannot be spawned is reported as
 * `spawnFailed` rather than thrown so adapters can map it to `available:false`.
 */

import { execa } from "execa";

export interface ExecInput {
  command: string;
  args: readonly string[];
  /** Working directory; defaults to the parent process cwd. */
  cwd?: string;
  /** Extra environment, layered over the inherited parent environment. */
  env?: Record<string, string>;
  /** Optional stdin payload. */
  stdin?: string;
}

export interface ExecResult {
  /** Process exit code; a sentinel non-zero when the binary could not spawn. */
  exitCode: number;
  stdout: string;
  stderr: string;
  /** True when the binary was missing or not executable (ENOENT / EACCES). */
  spawnFailed: boolean;
}

export type ExecFn = (input: ExecInput) => Promise<ExecResult>;

/** The default `ExecFn`: run a real child process, never throw on exit status. */
export async function runProcess(input: ExecInput): Promise<ExecResult> {
  try {
    const result = await execa(input.command, [...input.args], {
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      ...(input.env === undefined ? {} : { env: input.env }),
      extendEnv: true,
      ...(input.stdin === undefined ? {} : { input: input.stdin }),
      reject: false,
      stripFinalNewline: false,
    });
    return {
      exitCode: result.exitCode ?? (result.failed ? 1 : 0),
      stdout: stringOutput(result.stdout),
      stderr: stringOutput(result.stderr),
      spawnFailed: isSpawnFailure(result.code),
    };
  } catch (error) {
    // `reject:false` suppresses exit-status rejections, but a genuinely
    // unspawnable binary can still reject; treat it as a spawn failure.
    return {
      exitCode: 127,
      stdout: "",
      stderr: errorMessage(error),
      spawnFailed: true,
    };
  }
}

/** Best-effort message extraction without leaning on `instanceof Error`. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function stringOutput(value: unknown): string {
  // With the execa options above stdout/stderr are always strings; anything
  // else (an undefined stream) collapses to empty rather than a stringified
  // object.
  return typeof value === "string" ? value : "";
}

const SPAWN_FAILURE_CODES = new Set(["ENOENT", "EACCES", "ENOTDIR"]);

function isSpawnFailure(code: unknown): boolean {
  return typeof code === "string" && SPAWN_FAILURE_CODES.has(code);
}
