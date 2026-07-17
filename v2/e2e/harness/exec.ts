/**
 * Process spawning for the harness, layered over execa.
 *
 * Every spawn captures stdout/stderr/exitCode without throwing on nonzero exit,
 * because the suite asserts on exit codes as a first-class observation channel
 * (catalog §1.2). Callers pass an explicit environment — usually the scenario's
 * hermetic env — so nothing leaks in from the host.
 */

import { execa } from "execa";

export interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /** True when the process could not be spawned at all (e.g. command not found). */
  readonly spawnFailed: boolean;
}

export interface RunOptions {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  /** Full environment for the child. Not merged with `process.env`. */
  readonly env?: Readonly<Record<string, string>>;
  /** Written to the child's stdin, if provided. */
  readonly input?: string;
  readonly timeoutMilliseconds?: number;
}

/**
 * Runs a command to completion and returns its captured output and exit code.
 * Never throws for a nonzero exit; only rejects if awaiting is cancelled.
 */
export async function run(options: RunOptions): Promise<RunResult> {
  const { command, args = [], cwd, env, input, timeoutMilliseconds } = options;

  const result = await execa(command, [...args], {
    reject: false,
    stripFinalNewline: false,
    extendEnv: env === undefined,
    ...(cwd === undefined ? {} : { cwd }),
    ...(env === undefined ? {} : { env }),
    ...(input === undefined ? {} : { input }),
    ...(timeoutMilliseconds === undefined ? {} : { timeout: timeoutMilliseconds }),
  });

  return {
    exitCode: typeof result.exitCode === "number" ? result.exitCode : 1,
    stdout: asString(result.stdout),
    stderr: asString(result.stderr),
    spawnFailed: result.failed && result.exitCode === undefined,
  };
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}
