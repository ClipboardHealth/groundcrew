import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RunNotFoundError } from "./errors.js";
import {
  type RunRecord,
  deleteRunRecord,
  listRunRecords,
  readRunRecord,
  runRecordExists,
  runRecordPath,
  runsDirectory,
  writeRunRecord,
} from "./runRecord.js";

function sampleRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    version: 1,
    taskId: "fixture:TASK-1",
    runId: "r_8f3a9c21",
    source: "fixture",
    agentProfile: "scripted",
    state: "running",
    resumeCount: 0,
    sessionName: "crew-fixture-task-1",
    workspaceDirectory: "/tmp/worktrees/fixture-task-1",
    repos: ["alpha"],
    artifacts: [],
    events: [{ ts: "2026-07-17T00:00:00.000Z", event: "claimed" }],
    ...overrides,
  };
}

describe("run record I/O", () => {
  let stateRoot: string;

  beforeEach(() => {
    stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "crew-runrecord-"));
  });

  afterEach(() => {
    fs.rmSync(stateRoot, { recursive: true, force: true });
  });

  it("derives the record path under runs/ from the task slug", () => {
    expect(runsDirectory({ stateRoot })).toBe(path.join(stateRoot, "runs"));
    expect(runRecordPath({ stateRoot, taskSlug: "fixture-task-1" })).toBe(
      path.join(stateRoot, "runs", "fixture-task-1.json"),
    );
  });

  it("round-trips a record through an atomic write, leaving no temp files", async () => {
    const recordPath = runRecordPath({ stateRoot, taskSlug: "fixture-task-1" });
    const record = sampleRecord();

    await writeRunRecord({ path: recordPath, record });

    const actual = await readRunRecord({ path: recordPath });
    expect(actual).toEqual(record);
    const leftovers = (await fsp.readdir(runsDirectory({ stateRoot }))).filter((entry) =>
      entry.endsWith(".tmp"),
    );
    expect(leftovers).toHaveLength(0);
  });

  it("throws RunNotFoundError when reading an absent record", async () => {
    const recordPath = runRecordPath({ stateRoot, taskSlug: "missing" });

    await expect(readRunRecord({ path: recordPath })).rejects.toBeInstanceOf(RunNotFoundError);
  });

  it("rejects a record that violates the schema", async () => {
    const recordPath = runRecordPath({ stateRoot, taskSlug: "bad" });
    await fsp.mkdir(runsDirectory({ stateRoot }), { recursive: true });
    await fsp.writeFile(recordPath, JSON.stringify({ version: 1, taskId: "x" }));

    await expect(readRunRecord({ path: recordPath })).rejects.toThrow(/runId/);
  });

  it("reports existence and deletes idempotently", async () => {
    const recordPath = runRecordPath({ stateRoot, taskSlug: "fixture-task-1" });
    expect(await runRecordExists({ path: recordPath })).toBe(false);

    await writeRunRecord({ path: recordPath, record: sampleRecord() });
    expect(await runRecordExists({ path: recordPath })).toBe(true);

    await deleteRunRecord({ path: recordPath });
    expect(await runRecordExists({ path: recordPath })).toBe(false);
    await expect(deleteRunRecord({ path: recordPath })).resolves.toBeUndefined();
  });

  it("lists readable records sorted by slug and ignores non-json entries", async () => {
    await writeRunRecord({
      path: runRecordPath({ stateRoot, taskSlug: "beta-task" }),
      record: sampleRecord({ taskId: "fixture:beta" }),
    });
    await writeRunRecord({
      path: runRecordPath({ stateRoot, taskSlug: "alpha-task" }),
      record: sampleRecord({ taskId: "fixture:alpha" }),
    });
    await fsp.writeFile(path.join(runsDirectory({ stateRoot }), "notes.txt"), "ignore me");

    const records = await listRunRecords({ stateRoot });

    expect(records.map((record) => record.taskId)).toEqual(["fixture:alpha", "fixture:beta"]);
  });

  it("returns an empty list when the runs directory does not exist", async () => {
    expect(await listRunRecords({ stateRoot: path.join(stateRoot, "nope") })).toEqual([]);
  });
});
