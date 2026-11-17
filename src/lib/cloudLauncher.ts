import { spawn } from "node:child_process";

import { runCommandAsync } from "./commandRunner.ts";
import { shellSingleQuote } from "./shell.ts";

const CLOUD_LAUNCH_TIMEOUT_MS = 90_000;
const CLOUD_ERROR_OUTPUT_MAX_CHARS = 2000;

const ESCAPE_CHARACTER = String.fromCodePoint(27);
const BELL_CHARACTER = String.fromCodePoint(7);
const ANSI_ESCAPE_PATTERN = new RegExp(
  [
    `${ESCAPE_CHARACTER}\\[[0-?]*[ -/]*[@-~]`,
    `${ESCAPE_CHARACTER}\\][^${BELL_CHARACTER}${ESCAPE_CHARACTER}]*(?:${BELL_CHARACTER}|${ESCAPE_CHARACTER}\\\\)`,
  ].join("|"),
  "g",
);
const VIEW_LINE_PATTERN = /^View:\s+(https:\/\/claude\.ai\/code\/(session_[A-Za-z0-9]+)\S*)$/;

export interface CloudSession {
  sessionId: string;
  url: string;
}

export class CloudLaunchError extends Error {
  public readonly output: string;

  public constructor(input: { message: string; output: string }) {
    super(input.message);
    this.name = "CloudLaunchError";
    this.output = input.output;
  }
}

export interface CloudProcessResult {
  exitCode: number;
  output: string;
}

export interface CloudProcessInput {
  command: string;
  args: readonly string[];
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
}

export type CloudProcessRunner = (input: CloudProcessInput) => Promise<CloudProcessResult>;

export function stripTerminalNoise(raw: string): string {
  return raw.replaceAll(ANSI_ESCAPE_PATTERN, "").replaceAll("\r", "");
}

export function parseCloudLaunchOutput(raw: string): CloudSession | undefined {
  for (const line of stripTerminalNoise(raw).split("\n")) {
    const match = VIEW_LINE_PATTERN.exec(line.trim());
    if (match !== null) {
      const [, url, sessionId] = match;
      /* v8 ignore else @preserve -- both capture groups always participate once the pattern matches */
      if (url !== undefined && sessionId !== undefined) {
        return { sessionId, url };
      }
    }
  }
  return undefined;
}

export function scriptInvocation(
  platform: NodeJS.Platform,
  argv: readonly string[],
): { command: "script"; args: string[] } {
  if (platform === "darwin") {
    return { command: "script", args: ["-q", "/dev/null", ...argv] };
  }
  return { command: "script", args: ["-qec", argv.map(shellSingleQuote).join(" "), "/dev/null"] };
}

export async function runCloudProcess(input: CloudProcessInput): Promise<CloudProcessResult> {
  return await new Promise((resolve, reject) => {
    if (input.signal?.aborted === true) {
      reject(cloudLaunchFailure({ message: "claude --cloud was aborted", output: "" }));
      return;
    }

    const child = spawn(input.command, [...input.args], {
      cwd: input.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const outputChunks: Buffer[] = [];
    let settled = false;

    function finish(settle: () => void): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutTimer);
      input.signal?.removeEventListener("abort", handleAbort);
      settle();
    }

    function terminate(reason: string): void {
      child.kill("SIGTERM");
      finish(() => {
        reject(
          cloudLaunchFailure({
            message: `claude --cloud ${reason}`,
            output: Buffer.concat(outputChunks).toString("utf8"),
          }),
        );
      });
    }

    function handleAbort(): void {
      terminate("was aborted");
    }

    const timeoutTimer = setTimeout(() => {
      terminate(`timed out after ${input.timeoutMs}ms`);
    }, input.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => outputChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => outputChunks.push(chunk));
    child.once("error", (error) => {
      finish(() => {
        reject(
          cloudLaunchFailure({
            message: `failed to start ${input.command}: ${error.message}`,
            output: "",
          }),
        );
      });
    });
    child.once("close", (exitCode) => {
      finish(() => {
        resolve({
          exitCode: exitCode ?? 1,
          output: Buffer.concat(outputChunks).toString("utf8"),
        });
      });
    });
    input.signal?.addEventListener("abort", handleAbort, { once: true });
  });
}

export async function launchCloudSession(input: {
  cwd: string;
  prompt: string;
  signal?: AbortSignal | undefined;
  run?: CloudProcessRunner;
  platform?: NodeJS.Platform;
}): Promise<CloudSession> {
  const invocation = scriptInvocation(input.platform ?? process.platform, [
    "claude",
    "--cloud",
    input.prompt,
  ]);
  const result = await (input.run ?? runCloudProcess)({
    ...invocation,
    cwd: input.cwd,
    timeoutMs: CLOUD_LAUNCH_TIMEOUT_MS,
    signal: input.signal,
  });

  if (result.exitCode !== 0) {
    throw cloudLaunchFailure({
      message: `claude --cloud exited with code ${result.exitCode}`,
      output: result.output,
    });
  }
  const session = parseCloudLaunchOutput(result.output);
  if (session === undefined) {
    throw cloudLaunchFailure({
      message: "claude --cloud did not print a session URL",
      output: result.output,
    });
  }
  return session;
}

export async function queueCloudMessage(input: {
  sessionId: string;
  message: string;
  cwd?: string;
  run?: (command: string, args: readonly string[], cwd?: string) => Promise<string>;
}): Promise<void> {
  const args = ["-p", input.message, "--cloud", input.sessionId, "--output-format", "json"];
  const output = await (input.run ?? runQueueCommand)("claude", args, input.cwd);

  const response = parseQueueResponse(output);
  if (!isQueueConfirmation(response)) {
    throw new Error(`claude --cloud did not confirm the queued message:\n${output}`);
  }
}

async function runQueueCommand(
  command: string,
  args: readonly string[],
  cwd?: string,
): Promise<string> {
  return await runCommandAsync(command, args, { cwd: cwd ?? process.cwd() });
}

function parseQueueResponse(output: string): unknown {
  try {
    return JSON.parse(output);
  } catch (error) {
    throw new Error("claude --cloud queue response was unparsable JSON", { cause: error });
  }
}

function isQueueConfirmation(value: unknown): boolean {
  return typeof value === "object" && value !== null && "ok" in value && value.ok === true;
}

function cloudLaunchFailure(input: { message: string; output: string }): CloudLaunchError {
  const output = stripTerminalNoise(input.output).slice(-CLOUD_ERROR_OUTPUT_MAX_CHARS);
  return new CloudLaunchError({
    message: output.length === 0 ? input.message : `${input.message}:\n${output}`,
    output,
  });
}
