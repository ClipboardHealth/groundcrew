import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  readDispatchVerdicts,
  readLogLines,
  readRunRecord,
  readWorkspaceMarker,
  runRecordExists,
} from "./stateObservation.js";

describe("stateObservation", () => {
  let directory: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "gc-state-"));
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("reads and validates a run record", () => {
    const target = path.join(directory, "run.json");
    fs.writeFileSync(
      target,
      JSON.stringify({
        version: 1,
        taskId: "fixture:TASK-1",
        runId: "r_1",
        source: "fixture",
        agentProfile: "scripted",
        state: "complete",
        outcome: "delivered",
        resumeCount: 1,
        sessionName: "crew-fixture-task-1",
        workspaceDirectory: "/tmp/x",
        repos: ["alpha"],
        artifacts: [],
        events: [{ ts: "2026-07-17T00:00:00.000Z", event: "writeback_completed" }],
      }),
    );

    expect(runRecordExists({ path: target })).toBe(true);
    expect(readRunRecord({ path: target }).outcome).toBe("delivered");
  });

  it("throws a descriptive error for a missing run record", () => {
    const target = path.join(directory, "absent.json");
    expect(runRecordExists({ path: target })).toBe(false);
    expect(() => readRunRecord({ path: target })).toThrow(/run record not found/u);
  });

  it("throws when a state file violates its schema", () => {
    const target = path.join(directory, "bad.json");
    fs.writeFileSync(target, JSON.stringify({ version: 1, verdicts: { x: { skipReason: "nope" } } }));
    expect(() => readDispatchVerdicts({ path: target })).toThrow(/violates its schema/u);
  });

  it("reads a workspace marker", () => {
    const target = path.join(directory, "task.json");
    fs.writeFileSync(
      target,
      JSON.stringify({ version: 1, taskId: "fixture:TASK-1", branch: "crew/fixture-task-1", repos: [] }),
    );
    expect(readWorkspaceMarker({ path: target }).taskId).toBe("fixture:TASK-1");
  });

  it("parses every non-empty log line and validates it", () => {
    const target = path.join(directory, "log.jsonl");
    const lines = [
      JSON.stringify({ ts: "2026-07-17T00:00:00.000Z", level: "info", module: "dispatch", event: "poll_started" }),
      "",
      JSON.stringify({ ts: "2026-07-17T00:00:01.000Z", level: "warn", module: "workspace", event: "worktree_dirty", taskId: "fixture:TASK-1" }),
    ];
    fs.writeFileSync(target, lines.join("\n") + "\n");

    const parsed = readLogLines({ path: target });
    expect(parsed).toHaveLength(2);
    expect(parsed[1]?.taskId).toBe("fixture:TASK-1");
  });

  it("throws naming the offending line number for a malformed log line", () => {
    const target = path.join(directory, "log.jsonl");
    fs.writeFileSync(
      target,
      [
        JSON.stringify({ ts: "2026-07-17T00:00:00.000Z", level: "info", module: "dispatch", event: "ok" }),
        "{not json",
      ].join("\n"),
    );
    expect(() => readLogLines({ path: target })).toThrow(/line 2/u);
  });
});
