import { exec, spawn, type ExecException } from "node:child_process";

const EXEC_TIMEOUT_MS = 10 * 60_000;
const EXEC_MAX_BUFFER_BYTES = 10 * 1024 * 1024;

type VerifyCheckMode = "parallel" | "exclusive";
type VerifyCheckOutput = "buffered" | "inherited";

export interface VerifyCheck {
  cmd: string;
  mode: VerifyCheckMode;
  name: string;
  outputMode?: VerifyCheckOutput;
  timeoutMs?: number;
}

export interface CheckResult {
  durationMs: number;
  name: string;
  ok: boolean;
  output: string;
}

export interface RunVerifyInput {
  checks: readonly VerifyCheck[];
  now: () => number;
  print: (message: string) => void;
  runCheck: (input: { check: VerifyCheck }) => Promise<CheckResult>;
}

export interface RunVerifyResult {
  ok: boolean;
  results: readonly CheckResult[];
}

interface VerifyCheckGroups {
  exclusiveChecks: VerifyCheck[];
  parallelChecks: VerifyCheck[];
}

// These run a pre-push hook and should not modify files.
export const DEFAULT_VERIFY_CHECKS = [
  { cmd: "node --run architecture:check", mode: "parallel", name: "architecture:check" },
  { cmd: "node --run build", mode: "parallel", name: "build" },
  { cmd: "node --run cpd", mode: "parallel", name: "cpd" },
  { cmd: "node --run format:check", mode: "parallel", name: "format:check" },
  { cmd: "node --run knip", mode: "parallel", name: "knip" },
  { cmd: "node --run lint", mode: "parallel", name: "lint" },
  { cmd: "node --run markdown:lint", mode: "parallel", name: "markdown:lint" },
  { cmd: "node --run spell:check -- .", mode: "parallel", name: "spell:check" },
  { cmd: "node --run syncpack:lint", mode: "parallel", name: "syncpack:lint" },
  { cmd: "node --run test", mode: "exclusive", name: "test", outputMode: "inherited" },
] as const satisfies readonly VerifyCheck[];

export async function runVerify(input: RunVerifyInput): Promise<RunVerifyResult> {
  const { checks, now, print, runCheck } = input;
  const totalStart = now();
  const { exclusiveChecks, parallelChecks } = groupChecks(checks);

  print("▶ Running parallel checks");
  const parallelResults = await Promise.all(
    parallelChecks.map(async (check) => await runCheck({ check })),
  );

  const exclusiveResults: CheckResult[] = [];
  for (const check of exclusiveChecks) {
    print(`▶ Running ${check.name} separately`);
    // oxlint-disable-next-line no-await-in-loop -- exclusive checks intentionally avoid resource contention
    exclusiveResults.push(await runCheck({ check }));
  }

  const results = [...parallelResults, ...exclusiveResults];

  for (const result of results) {
    const icon = result.ok ? "✓" : "✗";
    print(`  ${icon} ${result.name} (${formatDuration(result.durationMs)})`);
  }

  printSummary({ now, print, results, totalStart });

  return { ok: results.every((result) => result.ok), results };
}

export async function runVerifyCheck(input: { check: VerifyCheck }): Promise<CheckResult> {
  const { check } = input;
  const start = performance.now();
  const timeoutMs = check.timeoutMs ?? EXEC_TIMEOUT_MS;
  try {
    const output =
      check.outputMode === "inherited"
        ? await runInheritedCommand(check.cmd, timeoutMs)
        : await execCommand(check.cmd, timeoutMs);
    return { durationMs: performance.now() - start, name: check.name, ok: true, output };
  } catch (error) {
    return {
      durationMs: performance.now() - start,
      name: check.name,
      ok: false,
      output: thrownErrorMessage(error),
    };
  }
}

export function thrownErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function groupChecks(checks: readonly VerifyCheck[]): VerifyCheckGroups {
  const exclusiveChecks: VerifyCheck[] = [];
  const parallelChecks: VerifyCheck[] = [];

  for (const check of checks) {
    if (check.mode === "exclusive") {
      exclusiveChecks.push(check);
    } else {
      parallelChecks.push(check);
    }
  }

  return { exclusiveChecks, parallelChecks };
}

async function runInheritedCommand(cmd: string, timeoutMs: number): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    const child = spawn(cmd, {
      shell: true,
      stdio: "inherit",
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    function settle(settleResult: () => void): void {
      /* v8 ignore next @preserve -- defensive against child_process reporting both error and close */
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      settleResult();
    }

    /* v8 ignore next 5 @preserve -- with shell:true, command failures report through close */
    child.once("error", (error) => {
      settle(() => {
        reject(error);
      });
    });

    child.once("close", (code, signal) => {
      settle(() => {
        if (timedOut) {
          reject(new Error(`Command timed out after ${formatDuration(timeoutMs)}: ${cmd}`));
          return;
        }
        if (code === 0) {
          resolve("");
          return;
        }
        reject(createInheritedCheckFailureError({ cmd, code, signal }));
      });
    });
  });
}

async function execCommand(cmd: string, timeoutMs: number): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    exec(
      cmd,
      {
        maxBuffer: EXEC_MAX_BUFFER_BYTES,
        timeout: timeoutMs,
      },
      (error: ExecException | null, stdout: string, stderr: string) => {
        const combinedOutput = combineProcessOutput(stdout, stderr);

        if (error !== null) {
          reject(createCheckFailureError(error, combinedOutput));
          return;
        }

        resolve(combinedOutput);
      },
    );
  });
}

function createInheritedCheckFailureError(input: {
  cmd: string;
  code: number | null;
  signal: NodeJS.Signals | null;
}): Error {
  const { cmd, code, signal } = input;
  const status = signal === null ? `Exited with code ${code}` : `Terminated by signal ${signal}`;

  return new Error(`Command failed: ${cmd}\n${status}`);
}

function printSummary(input: {
  now: () => number;
  print: (message: string) => void;
  results: readonly CheckResult[];
  totalStart: number;
}): void {
  const { now, print, results, totalStart } = input;
  const failures = results.filter((result) => !result.ok);
  const totalMs = now() - totalStart;

  print("\n─── Summary ───");
  print(`Total: ${formatDuration(totalMs)}`);

  const successesWithOutput = results.filter((result) => result.ok && hasOutput(result.output));

  if (failures.length === 0) {
    print("All checks passed.");
    printCheckOutputs({
      print,
      results: successesWithOutput,
      title: `Passed with output (${successesWithOutput.length}):`,
    });
    return;
  }

  printCheckOutputs({ print, results: failures, title: `Failed (${failures.length}):` });
  printCheckOutputs({
    print,
    results: successesWithOutput,
    title: `Passed with output (${successesWithOutput.length}):`,
  });
}

function combineProcessOutput(stdout: string, stderr: string): string {
  return [stdout, stderr]
    .map((output) => output.trim())
    .filter((output) => output.length > 0)
    .join("\n");
}

function createCheckFailureError(error: ExecException, output: string): Error {
  const message = [error.message, output]
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join("\n");

  return new Error(message, { cause: error });
}

function printCheckOutputs(input: {
  print: (message: string) => void;
  results: readonly CheckResult[];
  title: string;
}): void {
  const { print, results, title } = input;
  if (results.length === 0) {
    return;
  }

  print(`\n${title}`);
  for (const result of results) {
    const icon = result.ok ? "✓" : "✗";
    print(`\n  ${icon} ${result.name}`);
    printIndentedOutput({ output: result.output, print });
  }
}

function printIndentedOutput(input: { output: string; print: (message: string) => void }): void {
  const { output, print } = input;
  if (!hasOutput(output)) {
    return;
  }

  const indented = output
    .trim()
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
  print(indented);
}

function hasOutput(output: string): boolean {
  return output.trim().length > 0;
}

function formatDuration(milliseconds: number): string {
  if (milliseconds >= 1000) {
    return `${(milliseconds / 1000).toFixed(1)}s`;
  }
  return `${Math.round(milliseconds)}ms`;
}
