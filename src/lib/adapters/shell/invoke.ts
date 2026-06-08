/**
 * Subprocess execution primitive for the shell adapter. Owns the spawn,
 * timeout, stdin/stdout/stderr handling, and placeholder substitution.
 * Factory wires these together into the four TaskSource operations.
 *
 * Placeholders (`${id}`, `${canonicalId}`, `${name}`) are shell-quoted before
 * substitution so a task id containing shell metacharacters cannot
 * inject. The host invokes via `sh -c <substituted-command>` so users can
 * use full shell syntax (pipes, redirection, etc.) in their command strings.
 *
 * Exit code 0 = success; exit code 3 = "not found" (caller decides how to
 * interpret); any other nonzero exit throws.
 */

import { spawn } from "node:child_process";

import { debug } from "../../util.ts";

/**
 * Hard cap on captured stdout/stderr per stream. Misbehaving scripts that
 * `yes | head -c <huge>` would otherwise exhaust memory. 10 MB is enough for
 * any realistic JSON task payload; tests can override via InvokeArgs.maxOutputBytes
 * to exercise the truncation path with a smaller fixture.
 */
const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

export class ShellAdapterTimeoutError extends Error {
  public constructor(arguments_: { command: string; timeoutMs: number }) {
    super(`Shell command timed out after ${arguments_.timeoutMs}ms: ${arguments_.command}`);
    this.name = "ShellAdapterTimeoutError";
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
  /** Override the default per-stream stdout/stderr cap (10 MB). Used by tests. */
  maxOutputBytes?: number;
}

interface InvokeResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** True if either stream hit the byte cap and the rest was discarded. */
  truncated: boolean;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", String.raw`'\''`)}'`;
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
  const maxBytes = args.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  return await new Promise<InvokeResult>((resolve, reject) => {
    const child = spawn("sh", ["-c", command], {
      cwd: args.cwd,
      // oxlint-disable-next-line node/no-process-env -- subprocess inherits the parent's full env by design; user-supplied vars layer on top
      env: { ...process.env, ...args.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout: Buffer = Buffer.alloc(0);
    let stderr: Buffer = Buffer.alloc(0);
    let truncated = false;
    let settled = false;

    const timer = setTimeout(() => {
      /* v8 ignore next 3 @preserve -- timer/close race: clearTimeout in the close handler should prevent this branch, but the guard is kept as defense-in-depth */
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGKILL");
      reject(new ShellAdapterTimeoutError({ command, timeoutMs: args.timeoutMs }));
    }, args.timeoutMs);

    // Buffer accumulators so the byte cap matches its name. A string-based
    // comparison would measure UTF-16 code units against a byte budget,
    // letting multibyte UTF-8 sneak past the cap and risking a mid-
    // surrogate-pair slice on truncation.
    const appendCapped = (current: Buffer, chunk: Buffer): Buffer => {
      if (current.byteLength >= maxBytes) {
        truncated = true;
        return current;
      }
      const next = Buffer.concat([current, chunk]);
      if (next.byteLength <= maxBytes) {
        return next;
      }
      truncated = true;
      const clipped = next.subarray(0, maxBytes);
      return Buffer.concat([
        clipped,
        Buffer.from(`\n[truncated: stream exceeded ${maxBytes} bytes]`),
      ]);
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendCapped(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendCapped(stderr, chunk);
    });

    child.on("close", (code) => {
      /* v8 ignore next 3 @preserve -- timer/close race: when the timeout fires first it SIGKILLs and sets settled=true; the 'close' event still arrives and must no-op. No deterministic test exists — an orphaned grandchild (`sh -c "sleep N; ..."`) keeps the stdout pipe open, so 'close' doesn't arrive until the real timeout elapses; mirrors the ignored timer/error settle guards above. */
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      const stderrText = stderr.toString("utf8");
      if (stderrText.length > 0) {
        debug(`[shell:${args.sourceName}] ${command}\n${stderrText.trimEnd()}`);
      }
      /* v8 ignore next @preserve -- `code` is null only when the process was killed by signal; the timeout path SIGKILLs but settles via the timer rather than 'close' */
      const exitCode = code ?? 1;
      const stdoutText = stdout.toString("utf8");
      if (exitCode === 0 || exitCode === 3) {
        resolve({ stdout: stdoutText, stderr: stderrText, exitCode, truncated });
        return;
      }
      reject(
        new Error(
          `Shell command for source "${args.sourceName}" failed with exit ${exitCode}: ${
            stderrText.trim().length > 0 ? stderrText.trim() : command
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
      clearTimeout(timer);
      reject(error);
    });

    if (args.stdin !== undefined) {
      child.stdin.write(args.stdin);
    }
    child.stdin.end();
  });
}
