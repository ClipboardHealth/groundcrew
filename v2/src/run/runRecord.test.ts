import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ForeignRunRecordError, RunNotFoundError } from "./errors.js";
import {
  type RunRecord,
  deleteRunRecord,
  listForeignRunRecords,
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

  it("throws a typed ForeignRunRecordError (clean, no zod issues) for a foreign file", async () => {
    const recordPath = runRecordPath({ stateRoot, taskSlug: "bad" });
    await fsp.mkdir(runsDirectory({ stateRoot }), { recursive: true });
    await fsp.writeFile(recordPath, JSON.stringify({ version: 1, taskId: "x" }));

    const error = await readRunRecord({ path: recordPath }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ForeignRunRecordError);
    expect((error as ForeignRunRecordError).message).toContain("not a v2 run record (v1 state?)");
    // The clean message must not leak raw zod issue text.
    expect((error as ForeignRunRecordError).message).not.toMatch(/runId|invalid_type|expected/i);
  });

  it("throws ForeignRunRecordError for unparseable JSON", async () => {
    const recordPath = runRecordPath({ stateRoot, taskSlug: "junk" });
    await fsp.mkdir(runsDirectory({ stateRoot }), { recursive: true });
    await fsp.writeFile(recordPath, "not json at all");

    await expect(readRunRecord({ path: recordPath })).rejects.toBeInstanceOf(ForeignRunRecordError);
  });

  it("classifies a v1-shape record as foreign with an unknown-version reason", async () => {
    // A live v1 run record: none of the v2 required fields, a different version.
    const v1Record = {
      version: 3,
      task: "DEVOP-1",
      repository: "cbh-core",
      agent: "claude",
      worktreeDir: "/w",
      branchName: "crew/x",
      workspaceName: "x",
      state: "running",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    await fsp.mkdir(runsDirectory({ stateRoot }), { recursive: true });
    await fsp.writeFile(path.join(runsDirectory({ stateRoot }), "devop-1.json"), JSON.stringify(v1Record));

    const foreign = await listForeignRunRecords({ stateRoot });
    expect(foreign).toHaveLength(1);
    expect(foreign[0]?.reason).toBe("unknown version 3");
    // And it never surfaces as a valid record.
    expect(await listRunRecords({ stateRoot })).toEqual([]);
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
