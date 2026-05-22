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

import { spawn } from "node:child_process";

import { log } from "../../util.ts";

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
}

interface InvokeResult {
  stdout: string;
  stderr: string;
  exitCode: number;
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
  return await new Promise<InvokeResult>((resolve, reject) => {
    const child = spawn("sh", ["-c", command], {
      cwd: args.cwd,
      // oxlint-disable-next-line node/no-process-env -- subprocess inherits the parent's full env by design; user-supplied vars layer on top
      env: { ...process.env, ...args.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
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

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (stderr.length > 0) {
        log(`[shell:${args.sourceName}] ${command}\n${stderr.trimEnd()}`);
      }
      /* v8 ignore next @preserve -- `code` is null only when the process was killed by signal; the timeout path SIGKILLs but settles via the timer rather than 'close' */
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
      clearTimeout(timer);
      reject(error);
    });

    if (args.stdin !== undefined) {
      child.stdin.write(args.stdin);
    }
    child.stdin.end();
  });
}
