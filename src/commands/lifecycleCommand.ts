import { mkdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { ResolvedConfig } from "../lib/config.ts";
import { naturalIdFromCanonical } from "../lib/taskSource.ts";
import { normalizePlainTaskId } from "../lib/taskId.ts";
import { withConsoleOutputSuppressed } from "../lib/util.ts";
import {
  lifecycleResultExitCode,
  renderLifecycleResult,
  type LifecycleResult,
} from "./lifecycleResult.ts";

type LifecycleSignal = "SIGINT" | "SIGTERM";

interface LifecycleLockOwner {
  pid: number;
  token: string;
  createdAt: string;
}

export type LifecycleLock = { kind: "acquired"; release: () => void } | { kind: "conflict" };

export interface LifecycleCancellationContext {
  signal: AbortSignal;
  requestedSignal: () => LifecycleSignal | undefined;
}

interface ExecuteLifecycleMutationArguments<Result extends LifecycleResult> {
  config: ResolvedConfig;
  task: string;
  json: boolean;
  conflictResult: () => Result;
  operation: (context: LifecycleCancellationContext) => Promise<Result>;
  cancelledResult: (context: LifecycleCancellationContext) => Promise<Result>;
}

export function lifecycleLockPath(arguments_: {
  config: Pick<ResolvedConfig, "logging">;
  task: string;
}): string {
  const task = normalizePlainTaskId(naturalIdFromCanonical(arguments_.task));
  return path.resolve(
    path.dirname(arguments_.config.logging.file),
    "lifecycle-locks",
    `${task}.lock`,
  );
}

export function acquireLifecycleLock(arguments_: {
  config: Pick<ResolvedConfig, "logging">;
  task: string;
}): LifecycleLock {
  const lockPath = lifecycleLockPath(arguments_);
  mkdirSync(path.dirname(lockPath), { recursive: true });
  const owner: LifecycleLockOwner = {
    pid: process.pid,
    token: randomUUID(),
    createdAt: new Date().toISOString(),
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      // A symlink publishes its target atomically, so another process never
      // observes a partially-written owner record between create and write.
      symlinkSync(JSON.stringify(owner), lockPath);
      return {
        kind: "acquired",
        release: createLockRelease({ lockPath, token: owner.token }),
      };
    } catch (error) {
      /* v8 ignore next 3 @preserve -- non-EEXIST symlink failures are host filesystem/configuration failures surfaced unchanged */
      if (errorCode(error) !== "EEXIST") {
        throw error;
      }
      const currentOwner = readLockOwner(lockPath);
      if (currentOwner === undefined || processIsAlive(currentOwner.pid)) {
        return { kind: "conflict" };
      }
      try {
        unlinkSync(lockPath);
      } catch (unlinkError) {
        /* v8 ignore next 3 @preserve -- requires another process replacing the dead lock during this unlink */
        if (errorCode(unlinkError) !== "ENOENT") {
          return { kind: "conflict" };
        }
      }
    }
  }
  /* v8 ignore next @preserve -- two consecutive lock replacement races are not deterministic in a unit test */
  return { kind: "conflict" };
}

export async function withLifecycleCancellation<T>(
  operation: (context: LifecycleCancellationContext) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let receivedSignal: LifecycleSignal | undefined;
  function requestCancellation(signal: LifecycleSignal): void {
    receivedSignal ??= signal;
    if (!controller.signal.aborted) {
      controller.abort(new Error(`Lifecycle command cancelled by ${signal}`));
    }
  }
  function handleSigint(): void {
    requestCancellation("SIGINT");
  }
  function handleSigterm(): void {
    requestCancellation("SIGTERM");
  }
  process.on("SIGINT", handleSigint);
  process.on("SIGTERM", handleSigterm);
  try {
    return await operation({
      signal: controller.signal,
      requestedSignal: () => receivedSignal,
    });
  } finally {
    process.off("SIGINT", handleSigint);
    process.off("SIGTERM", handleSigterm);
  }
}

export function lifecycleCancellationSuffix(context: LifecycleCancellationContext): string {
  const signal = context.requestedSignal();
  return signal === undefined ? "" : ` by ${signal}`;
}

export async function executeLifecycleMutation<Result extends LifecycleResult>(
  arguments_: ExecuteLifecycleMutationArguments<Result>,
): Promise<Result> {
  const { config, task, json } = arguments_;
  return await withLifecycleCancellation(async (context) => {
    const lock = acquireLifecycleLock({ config, task });
    if (lock.kind === "conflict") {
      return finishLifecycleMutation({ result: arguments_.conflictResult(), json });
    }
    try {
      const run = async (): Promise<Result> => {
        try {
          return await arguments_.operation(context);
        } catch (error) {
          if (!context.signal.aborted) {
            throw error;
          }
          return await arguments_.cancelledResult(context);
        }
      };
      const result = json ? await withConsoleOutputSuppressed(run) : await run();
      return finishLifecycleMutation({ result, json });
    } finally {
      lock.release();
    }
  });
}

function finishLifecycleMutation<Result extends LifecycleResult>(arguments_: {
  result: Result;
  json: boolean;
}): Result {
  renderLifecycleResult(arguments_);
  if (lifecycleResultExitCode(arguments_.result) !== 0) {
    process.exitCode = 1;
  }
  return arguments_.result;
}

function createLockRelease(arguments_: { lockPath: string; token: string }): () => void {
  let released = false;
  return function release(): void {
    if (released) {
      return;
    }
    released = true;
    const owner = readLockOwner(arguments_.lockPath);
    if (owner?.token !== arguments_.token) {
      return;
    }
    try {
      unlinkSync(arguments_.lockPath);
    } catch (error) {
      /* v8 ignore next 3 @preserve -- requires another process changing permissions after the owner token was verified */
      if (errorCode(error) !== "ENOENT") {
        throw error;
      }
    }
  };
}

function readLockOwner(lockPath: string): LifecycleLockOwner | undefined {
  let raw: string;
  try {
    raw = readlinkSync(lockPath);
  } catch {
    try {
      raw = readFileSync(lockPath, "utf8");
    } catch {
      return undefined;
    }
  }
  try {
    return parseLockOwner(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

function parseLockOwner(value: unknown): LifecycleLockOwner | undefined {
  if (!isUnknownRecord(value)) {
    return undefined;
  }
  const pid = value["pid"];
  const token = value["token"];
  const createdAt = value["createdAt"];
  if (
    typeof pid !== "number" ||
    !Number.isInteger(pid) ||
    pid <= 0 ||
    typeof token !== "string" ||
    token.length === 0 ||
    typeof createdAt !== "string" ||
    createdAt.length === 0
  ) {
    return undefined;
  }
  return { pid, token, createdAt };
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

function errorCode(error: unknown): string | undefined {
  /* v8 ignore next 3 @preserve -- every internal caller passes a Node system error; guard protects the unknown boundary */
  if (!isUnknownRecord(error)) {
    return undefined;
  }
  const code = error["code"];
  /* v8 ignore next @preserve -- Node system error codes are strings */
  return typeof code === "string" ? code : undefined;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
