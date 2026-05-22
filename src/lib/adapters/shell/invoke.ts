/**
 * Subprocess execution primitive for the shell adapter. Owns the spawn,
 * timeout, stdin/stdout/stderr handling, and placeholder substitution.
 * Factory wires these together into the four TicketSource operations.
 *
 * Placeholders (`${id}`, `${canonicalId}`, `${name}`) are shell-quoted before
 * substitution so a ticket id containing shell metacharacters cannot
 * inject. The host invokes via `sh -c <substituted-command>` so users can
 * use full shell syntax (pipes, redirection, etc.) in their command strings.
 *
 * Exit code 0 = success; exit code 3 = "not found" (caller decides how to
 * interpret); any other nonzero exit throws.
 */

import { type ChildProcess, spawn } from "node:child_process";

import { log } from "../../util.ts";

export const SHELL_COMMAND_MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const TIMEOUT_SIGNAL: NodeJS.Signals = "SIGKILL";

export class ShellAdapterTimeoutError extends Error {
  public constructor(arguments_: { command: string; timeoutMs: number }) {
    super(`Shell command timed out after ${arguments_.timeoutMs}ms: ${arguments_.command}`);
    this.name = "ShellAdapterTimeoutError";
  }
}

export class ShellAdapterOutputLimitError extends Error {
  public constructor(arguments_: { command: string; maxBytes: number }) {
    super(
      `Shell command exceeded combined stdout/stderr maxBuffer of ${arguments_.maxBytes} bytes: ${arguments_.command}`,
    );
    this.name = "ShellAdapterOutputLimitError";
  }
}

interface InvokeArgs {
  command: string;
  timeoutMs: number;
  stdin?: string | undefined;
  cwd?: string | undefined;
  env?: Record<string, string> | undefined;
  substitutions?: Record<string, string> | undefined;
  /** Source name for log prefixing. */
  sourceName: string;
}

interface InvokeResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}

function killChildProcess(
  child: ChildProcess,
  signal: NodeJS.Signals,
  shouldUseProcessGroup: boolean,
): void {
  /* v8 ignore next 4 @preserve -- fallback path is for Windows or a spawn failure before pid assignment */
  if (!shouldUseProcessGroup || child.pid === undefined) {
    child.kill(signal);
    return;
  }
  process.kill(-child.pid, signal);
}

export function applySubstitutions(command: string, subs: Record<string, string>): string {
  let result = command;
  for (const [key, value] of Object.entries(subs)) {
    result = result.replaceAll(`\${${key}}`, shellQuote(value));
  }
  return result;
}

export async function invokeShellCommand(args: InvokeArgs): Promise<InvokeResult> {
  const command =
    args.substitutions === undefined
      ? args.command
      : applySubstitutions(args.command, args.substitutions);
  return await new Promise<InvokeResult>((resolve, reject) => {
    const shouldUseProcessGroup = process.platform !== "win32";
    const child = spawn("sh", ["-c", command], {
      cwd: args.cwd,
      detached: shouldUseProcessGroup,
      // oxlint-disable-next-line node/no-process-env -- subprocess inherits the parent's full env by design; user-supplied vars layer on top
      env: { ...process.env, ...args.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutLength = 0;
    let stderrLength = 0;
    let settled = false;

    function cleanup(): void {
      clearTimeout(timer);
    }

    function killChild(signal: NodeJS.Signals): void {
      try {
        killChildProcess(child, signal, shouldUseProcessGroup);
      } catch {
        // The child may have exited between timeout/output-limit handling and the kill request.
      }
    }

    function failAndKill(error: Error): void {
      /* v8 ignore next 3 @preserve -- timeout/output-limit races can call this after another terminal event; deterministic tests cover the first terminal path */
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      killChild(TIMEOUT_SIGNAL);
      reject(error);
    }

    function appendOutput(input: {
      chunks: Buffer[];
      currentLength: number;
      chunk: Buffer;
    }): number {
      /* v8 ignore next 3 @preserve -- streams may emit after timeout/output-limit settlement; this race guard is intentionally defensive */
      if (settled) {
        return input.currentLength;
      }
      const nextCombinedLength = stdoutLength + stderrLength + input.chunk.length;
      if (nextCombinedLength > SHELL_COMMAND_MAX_BUFFER_BYTES) {
        failAndKill(
          new ShellAdapterOutputLimitError({
            command,
            maxBytes: SHELL_COMMAND_MAX_BUFFER_BYTES,
          }),
        );
        return input.currentLength;
      }
      input.chunks.push(input.chunk);
      return input.currentLength + input.chunk.length;
    }

    const timer = setTimeout(() => {
      failAndKill(new ShellAdapterTimeoutError({ command, timeoutMs: args.timeoutMs }));
    }, args.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutLength = appendOutput({
        chunks: stdoutChunks,
        currentLength: stdoutLength,
        chunk,
      });
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrLength = appendOutput({
        chunks: stderrChunks,
        currentLength: stderrLength,
        chunk,
      });
    });

    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      const stdout = Buffer.concat(stdoutChunks, stdoutLength).toString("utf8");
      const stderr = Buffer.concat(stderrChunks, stderrLength).toString("utf8");
      if (stderr.length > 0) {
        log(`[shell:${args.sourceName}] ${command}\n${stderr.trimEnd()}`);
      }
      /* v8 ignore next @preserve -- `code` is null only when the process was killed by signal; timeout/output-limit paths settle before 'close' */
      const exitCode = code ?? 1;
      if (exitCode === 0 || exitCode === 3) {
        resolve({ stdout, stderr, exitCode });
        return;
      }
      reject(
        new Error(
          `Shell command for source "${args.sourceName}" failed with exit ${exitCode}: ${
            stderr.trim().length > 0 ? stderr.trim() : command
          }`,
        ),
      );
    });

    /* v8 ignore next 8 @preserve -- spawn 'error' event fires only on exec failures (PATH miss, EACCES) which are hard to simulate in tests without polluting host PATH */
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    });

    if (args.stdin !== undefined) {
      child.stdin.write(args.stdin);
    }
    child.stdin.end();
  });
}
