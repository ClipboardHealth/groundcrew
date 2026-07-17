import { describe, expect, it } from "vitest";

import { logLineSchema } from "./logSchema.js";
import {
  dispatchVerdictsSchema,
  listDataSchema,
  protocolResultSchema,
  runRecordSchema,
  updateDataSchema,
  workspaceMarkerSchema,
  writebackEventSchema,
} from "./schemas.js";

describe("schemas", () => {
  it("accepts the contract's run record example", () => {
    const record = {
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
      artifacts: [{ kind: "pr", locator: "https://example/pull/1", repo: "alpha" }],
      events: [{ ts: "2026-07-17T00:00:00.000Z", event: "claimed" }],
    };

    expect(runRecordSchema.parse(record).state).toBe("running");
  });

  it("rejects a run record with an unknown state", () => {
    const record = {
      version: 1,
      taskId: "fixture:TASK-1",
      runId: "r_1",
      source: "fixture",
      agentProfile: "scripted",
      state: "bogus",
      resumeCount: 0,
      sessionName: "crew-fixture-task-1",
      workspaceDirectory: "/tmp/x",
      repos: [],
      artifacts: [],
      events: [],
    };

    expect(runRecordSchema.safeParse(record).success).toBe(false);
  });

  it("accepts the dispatch verdicts and workspace marker examples", () => {
    expect(
      dispatchVerdictsSchema.parse({
        version: 1,
        verdicts: {
          "fixture:TASK-2": {
            skipReason: "repo-not-on-disk",
            detail: "gamma",
            ts: "2026-07-17T00:00:00Z",
          },
        },
      }).version,
    ).toBe(1);

    expect(
      workspaceMarkerSchema.parse({
        version: 1,
        taskId: "fixture:TASK-1",
        branch: "crew/fixture-task-1",
        repos: ["alpha"],
      }).branch,
    ).toBe("crew/fixture-task-1");
  });

  it("validates protocol result and writeback shapes", () => {
    const listResult = protocolResultSchema(listDataSchema);
    expect(listResult.parse({ ok: true, data: { tasks: [] } })).toEqual({
      ok: true,
      data: { tasks: [] },
    });
    expect(listResult.parse({ ok: false, error: { message: "boom" } })).toEqual({
      ok: false,
      error: { message: "boom" },
    });

    expect(updateDataSchema.parse({ result: "rejected", reason: "no" }).result).toBe(
      "rejected",
    );
    expect(
      writebackEventSchema.parse({ type: "completed", outcome: "delivered" }).type,
    ).toBe("completed");
  });

  describe("log line", () => {
    const base = {
      ts: "2026-07-17T00:00:00.000Z",
      level: "info",
      module: "dispatch",
      event: "task_claimed",
    };

    it("accepts a valid line with extra flat fields", () => {
      const parsed = logLineSchema.parse({ ...base, taskId: "fixture:TASK-1", custom: 42 });
      expect(parsed.taskId).toBe("fixture:TASK-1");
    });

    it("rejects an unknown module", () => {
      expect(logLineSchema.safeParse({ ...base, module: "orchestrator" }).success).toBe(
        false,
      );
    });

    it("rejects a non-snake_case event name", () => {
      expect(logLineSchema.safeParse({ ...base, event: "taskClaimed" }).success).toBe(false);
    });

    it("rejects a non-UTC timestamp", () => {
      expect(
        logLineSchema.safeParse({ ...base, ts: "2026-07-17T00:00:00+02:00" }).success,
      ).toBe(false);
    });
  });
});
