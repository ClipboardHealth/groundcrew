import { mkdirSync, mkdtempSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { ResolvedConfig } from "../lib/config.ts";
import { log } from "../lib/util.ts";
import { captureConsoleLog } from "../testHelpers/consoleCapture.ts";
import {
  acquireLifecycleLock,
  executeLifecycleMutation,
  lifecycleCancellationSuffix,
  lifecycleLockPath,
  withLifecycleCancellation,
} from "./lifecycleCommand.ts";
import type { StartResult } from "./lifecycleResult.ts";

function loggingConfig(directory: string): { logging: { file: string } } {
  return { logging: { file: path.join(directory, "groundcrew.log") } };
}

function requireAcquiredLock(
  lock: ReturnType<typeof acquireLifecycleLock>,
): Extract<ReturnType<typeof acquireLifecycleLock>, { kind: "acquired" }> {
  if (lock.kind !== "acquired") {
    throw new Error("test could not acquire lifecycle lock");
  }
  return lock;
}

function startResult(outcome: StartResult["outcome"] = "started"): StartResult {
  return {
    action: "start",
    task: { id: "team-1" },
    outcome,
    state: outcome === "started" ? "running" : "unknown",
    resources: {},
    problems: [],
  };
}

describe(acquireLifecycleLock, () => {
  it("serializes the same task and permits it again after release", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "groundcrew-lock-test-"));
    const config = loggingConfig(directory);
    const first = requireAcquiredLock(acquireLifecycleLock({ config, task: "TEAM-1" }));

    expect(first.kind).toBe("acquired");
    expect(acquireLifecycleLock({ config, task: "team-1" }).kind).toBe("conflict");

    first.release();
    const afterRelease = requireAcquiredLock(acquireLifecycleLock({ config, task: "team-1" }));
    expect(afterRelease.kind).toBe("acquired");
    afterRelease.release();
  });

  it("recovers a lock whose owning process no longer exists", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "groundcrew-lock-test-"));
    const config = loggingConfig(directory);
    const lockPath = lifecycleLockPath({ config, task: "team-1" });
    mkdirSync(path.dirname(lockPath), { recursive: true });
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: 2_147_483_647, token: "dead", createdAt: new Date().toISOString() }),
    );

    const actual = requireAcquiredLock(acquireLifecycleLock({ config, task: "team-1" }));

    expect(actual.kind).toBe("acquired");
    actual.release();
  });

  it("does not remove a lock that a newer owner replaced", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "groundcrew-lock-test-"));
    const config = loggingConfig(directory);
    const lockPath = lifecycleLockPath({ config, task: "team-1" });
    const lock = requireAcquiredLock(acquireLifecycleLock({ config, task: "team-1" }));
    unlinkSync(lockPath);
    symlinkSync(
      JSON.stringify({ pid: process.pid, token: "newer", createdAt: new Date().toISOString() }),
      lockPath,
    );

    lock.release();
    lock.release();

    expect(acquireLifecycleLock({ config, task: "team-1" }).kind).toBe("conflict");
    unlinkSync(lockPath);
  });

  it("tolerates a lock disappearing before its original owner releases it", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "groundcrew-lock-test-"));
    const config = loggingConfig(directory);
    const lockPath = lifecycleLockPath({ config, task: "team-1" });
    const lock = requireAcquiredLock(acquireLifecycleLock({ config, task: "team-1" }));
    unlinkSync(lockPath);

    expect(lock.release).not.toThrow();
  });

  it("treats a corrupt lock owned by an unknown process as a conflict", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "groundcrew-lock-test-"));
    const config = loggingConfig(directory);
    const lockPath = lifecycleLockPath({ config, task: "team-1" });
    mkdirSync(path.dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, "not-json");

    expect(acquireLifecycleLock({ config, task: "team-1" }).kind).toBe("conflict");
  });

  it.each([
    null,
    "owner",
    [],
    {},
    { pid: 1.5, token: "token", createdAt: "now" },
    { pid: 0, token: "token", createdAt: "now" },
    { pid: 1, token: 2, createdAt: "now" },
    { pid: 1, token: "", createdAt: "now" },
    { pid: 1, token: "token", createdAt: 2 },
    { pid: 1, token: "token", createdAt: "" },
  ])("treats invalid lock owner %# as a conflict", (owner) => {
    const directory = mkdtempSync(path.join(tmpdir(), "groundcrew-lock-test-"));
    const config = loggingConfig(directory);
    const lockPath = lifecycleLockPath({ config, task: "team-1" });
    mkdirSync(path.dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, JSON.stringify(owner));

    expect(acquireLifecycleLock({ config, task: "team-1" }).kind).toBe("conflict");
  });
});

describe(withLifecycleCancellation, () => {
  it("shares SIGTERM through an AbortSignal and removes both handlers", async () => {
    const beforeSigint = process.listenerCount("SIGINT");
    const beforeSigterm = process.listenerCount("SIGTERM");
    const observed = vi.fn<(aborted: boolean, signal: NodeJS.Signals | undefined) => void>();

    await withLifecycleCancellation(async ({ signal, requestedSignal }) => {
      process.listeners("SIGTERM").at(-1)?.("SIGTERM");
      observed(signal.aborted, requestedSignal());
    });

    expect(observed).toHaveBeenCalledWith(true, "SIGTERM");
    expect(process.listenerCount("SIGINT")).toBe(beforeSigint);
    expect(process.listenerCount("SIGTERM")).toBe(beforeSigterm);
  });

  it("shares SIGINT through the same AbortSignal", async () => {
    const observed = vi.fn<(aborted: boolean, signal: NodeJS.Signals | undefined) => void>();

    await withLifecycleCancellation(async ({ signal, requestedSignal }) => {
      process.listeners("SIGINT").at(-1)?.("SIGINT");
      process.listeners("SIGTERM").at(-1)?.("SIGTERM");
      observed(signal.aborted, requestedSignal());
    });

    expect(observed).toHaveBeenCalledWith(true, "SIGINT");
  });
});

describe(lifecycleCancellationSuffix, () => {
  it("renders a recorded signal", () => {
    expect(
      lifecycleCancellationSuffix({
        signal: new AbortController().signal,
        requestedSignal: () => "SIGTERM",
      }),
    ).toBe(" by SIGTERM");
  });

  it("renders no suffix before a signal is recorded", () => {
    expect(
      lifecycleCancellationSuffix({
        signal: new AbortController().signal,
        requestedSignal: vi.fn<() => "SIGINT" | "SIGTERM" | undefined>(),
      }),
    ).toBe("");
  });
});

describe(executeLifecycleMutation, () => {
  afterEach(() => {
    process.exitCode = undefined;
  });

  it("returns a typed conflict while another command owns the task", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "groundcrew-lock-test-"));
    const config = loggingConfig(directory) as ResolvedConfig;
    const lock = requireAcquiredLock(acquireLifecycleLock({ config, task: "team-1" }));
    const consoleLog = captureConsoleLog();

    try {
      const actual = await executeLifecycleMutation({
        config,
        task: "team-1",
        json: true,
        conflictResult: () => startResult("conflict"),
        operation: async () => startResult(),
        cancelledResult: async () => startResult("partial"),
      });

      expect(actual.outcome).toBe("conflict");
      expect(JSON.parse(consoleLog.output())).toStrictEqual(actual);
      expect(process.exitCode).toBe(1);
    } finally {
      consoleLog.restore();
      lock.release();
    }
  });

  it("classifies an exception raised after cooperative cancellation", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "groundcrew-lock-test-"));
    const config = loggingConfig(directory) as ResolvedConfig;
    const consoleLog = captureConsoleLog();

    try {
      const actual = await executeLifecycleMutation({
        config,
        task: "team-1",
        json: true,
        conflictResult: () => startResult("conflict"),
        operation: async () => {
          log("suppressed progress");
          process.listeners("SIGTERM").at(-1)?.("SIGTERM");
          throw new Error("cancelled operation");
        },
        cancelledResult: async () => startResult("partial"),
      });

      expect(actual.outcome).toBe("partial");
      expect(consoleLog.calls).toHaveLength(1);
      expect(consoleLog.output()).not.toContain("suppressed progress");
    } finally {
      consoleLog.restore();
    }
  });

  it("releases its lock when an unexpected operation error escapes", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "groundcrew-lock-test-"));
    const config = loggingConfig(directory) as ResolvedConfig;

    await expect(
      executeLifecycleMutation({
        config,
        task: "team-1",
        json: false,
        conflictResult: () => startResult("conflict"),
        operation: async () => {
          throw new Error("fatal");
        },
        cancelledResult: async () => startResult("partial"),
      }),
    ).rejects.toThrow("fatal");

    const next = requireAcquiredLock(acquireLifecycleLock({ config, task: "team-1" }));
    next.release();
  });
});
