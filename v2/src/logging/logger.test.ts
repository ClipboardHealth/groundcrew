import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createLogger, logLineSchema } from "./index.js";

const fixedNow = (): Date => new Date("2026-07-17T00:00:00.000Z");

describe("createLogger", () => {
  let directory: string;
  let filePath: string;
  let consoleOutput: string[];

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "crew-logger-"));
    filePath = path.join(directory, "groundcrew.jsonl");
    consoleOutput = [];
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  function fileLines(): unknown[] {
    return fs
      .readFileSync(filePath, "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));
  }

  it("writes every level to the file as a JSON line matching the published schema", () => {
    const logger = createLogger({
      filePath,
      consoleLevel: "silent",
      now: fixedNow,
      writeConsole: (text) => {
        consoleOutput.push(text);
      },
    });

    logger.log({ level: "debug", module: "run", event: "run_created", taskId: "fixture:TASK-1" });
    logger.log({ level: "error", module: "session", event: "launch_failed", runId: "r_1234abcd" });

    const lines = fileLines();
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(() => logLineSchema.parse(line)).not.toThrow();
    }

    expect(logLineSchema.parse(lines[0])).toMatchObject({
      ts: "2026-07-17T00:00:00.000Z",
      level: "debug",
      module: "run",
      event: "run_created",
      taskId: "fixture:TASK-1",
    });
  });

  it("keeps correlation ids flat and preserves extra fields", () => {
    const logger = createLogger({
      filePath,
      consoleLevel: "silent",
      now: fixedNow,
    });

    logger.log({
      level: "info",
      module: "dispatch",
      event: "task_claimed",
      msg: "claimed",
      taskId: "fixture:TASK-1",
      runId: "r_1234abcd",
      source: "fixture",
      fields: { slot: 2, forced: true },
    });

    const [line] = fileLines();
    expect(line).toEqual({
      ts: "2026-07-17T00:00:00.000Z",
      level: "info",
      module: "dispatch",
      event: "task_claimed",
      msg: "claimed",
      slot: 2,
      forced: true,
      taskId: "fixture:TASK-1",
      runId: "r_1234abcd",
      source: "fixture",
    });
  });

  it("lets a reserved correlation id win a collision with a caller field", () => {
    const logger = createLogger({
      filePath,
      consoleLevel: "silent",
      now: fixedNow,
    });

    logger.log({
      level: "info",
      module: "run",
      event: "run_running",
      runId: "r_authoritative",
      fields: { runId: "r_stale" },
    });

    const [line] = fileLines();
    expect((line as { runId: string }).runId).toBe("r_authoritative");
  });

  it("renders human lines to the console at info+ by default, never raw JSON", () => {
    const logger = createLogger({
      filePath,
      now: fixedNow,
      writeConsole: (text) => {
        consoleOutput.push(text);
      },
    });

    logger.log({ level: "debug", module: "run", event: "run_created" });
    logger.log({ level: "info", module: "run", event: "run_running", taskId: "fixture:TASK-1" });

    expect(consoleOutput).toEqual([
      "2026-07-17T00:00:00.000Z info  run run_running (taskId=fixture:TASK-1)\n",
    ]);
  });

  it("lowers the console threshold to debug when consoleLevel is debug", () => {
    const logger = createLogger({
      filePath,
      consoleLevel: "debug",
      now: fixedNow,
      writeConsole: (text) => {
        consoleOutput.push(text);
      },
    });

    logger.log({ level: "debug", module: "run", event: "run_created" });

    expect(consoleOutput).toHaveLength(1);
  });

  it("writes nothing to the console when silent, but still writes the file", () => {
    const logger = createLogger({
      filePath,
      consoleLevel: "silent",
      now: fixedNow,
      writeConsole: (text) => {
        consoleOutput.push(text);
      },
    });

    logger.log({ level: "error", module: "run", event: "run_completed" });

    expect(consoleOutput).toHaveLength(0);
    expect(fileLines()).toHaveLength(1);
  });

  it("defaults the clock and writes human console lines to stderr", () => {
    const written: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        written.push(String(chunk));
        return true;
      });
    const before = Date.now();

    const logger = createLogger({ filePath });
    logger.log({ level: "info", module: "run", event: "run_running" });

    stderrSpy.mockRestore();
    expect(written).toEqual([expect.stringContaining("run run_running")]);
    const [line] = fileLines();
    const loggedAt = Date.parse((line as { ts: string }).ts);
    expect(loggedAt).toBeGreaterThanOrEqual(before);
  });

  it("rotates the file once the injected maxBytes is exceeded", () => {
    const logger = createLogger({
      filePath,
      consoleLevel: "silent",
      now: fixedNow,
      maxBytes: 120,
      maxFiles: 3,
    });

    for (let index = 0; index < 6; index += 1) {
      logger.log({ level: "info", module: "run", event: "run_running", runId: `r_${String(index)}` });
    }

    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.existsSync(`${filePath}.1`)).toBe(true);
  });
});
