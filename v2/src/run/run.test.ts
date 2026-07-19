import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InvalidTransitionError, RunNotFoundError } from "./errors.js";
import { runRecordPath, type RunRecord } from "./runRecord.js";
import {
  createRun,
  deleteRun,
  generateRunId,
  listRuns,
  loadRun,
  runExists,
  type CreateRunInput,
} from "./run.js";
import type { WritebackCompletion, WritebackPort } from "./writeback.js";

function recordingWriteback(): { port: WritebackPort; calls: WritebackCompletion[] } {
  const calls: WritebackCompletion[] = [];
  return {
    calls,
    port: {
      async completed(completion): Promise<void> {
        calls.push(completion);
      },
    },
  };
}

describe("run lifecycle", () => {
  let stateRoot: string;
  const taskSlug = "fixture-task-1";
  const fixedNow = (): Date => new Date("2026-07-17T00:00:00.000Z");

  function baseInput(overrides: Partial<CreateRunInput> = {}): CreateRunInput {
    return {
      stateRoot,
      taskSlug,
      taskId: "fixture:TASK-1",
      source: "fixture",
      agentProfile: "scripted",
      sessionName: "crew-fixture-task-1",
      workspaceDirectory: "/tmp/worktrees/fixture-task-1",
      now: fixedNow,
      ...overrides,
    };
  }

  function diskRecord(): RunRecord {
    return JSON.parse(
      fs.readFileSync(runRecordPath({ stateRoot, taskSlug }), "utf8"),
    ) as RunRecord;
  }

  beforeEach(() => {
    stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "crew-run-"));
  });

  afterEach(() => {
    fs.rmSync(stateRoot, { recursive: true, force: true });
  });

  describe("generateRunId", () => {
    it("produces a fresh `r_`+8-hex id each call", () => {
      const first = generateRunId();
      const second = generateRunId();

      expect(first).toMatch(/^r_[0-9a-f]{8}$/);
      expect(second).not.toBe(first);
    });
  });

  describe("createRun", () => {
    it("writes a provisioning record with a claimed event and empty reported layer", async () => {
      const run = await createRun(baseInput({ repos: ["alpha"] }));

      expect(run.state).toBe("provisioning");
      expect(run.runId).toMatch(/^r_[0-9a-f]{8}$/);
      const record = diskRecord();
      expect(record).toMatchObject({
        version: 1,
        taskId: "fixture:TASK-1",
        state: "provisioning",
        resumeCount: 0,
        repos: ["alpha"],
        artifacts: [],
      });
      expect(record.events).toEqual([{ ts: "2026-07-17T00:00:00.000Z", event: "claimed" }]);
    });

    it("honors an injected runId and replaces any prior record for the slug", async () => {
      await createRun(baseInput({ runId: "r_00000000" }));
      const replacement = await createRun(baseInput({ runId: "r_11111111" }));

      expect(replacement.runId).toBe("r_11111111");
      expect(diskRecord().runId).toBe("r_11111111");
      expect(diskRecord().state).toBe("provisioning");
    });
  });

  describe("state machine", () => {
    it("advances provisioning -> running -> paused -> running (resumeCount++)", async () => {
      const run = await createRun(baseInput());

      await run.markRunning();
      expect(run.state).toBe("running");

      await run.pause();
      expect(run.state).toBe("paused");
      expect(diskRecord().resumeCount).toBe(0);

      await run.resume();
      expect(run.state).toBe("running");

      const record = diskRecord();
      expect(record.resumeCount).toBe(1);
      expect(record.events.map((event) => event.event)).toEqual([
        "claimed",
        "state_running",
        "state_paused",
        "state_resumed",
      ]);
    });

    it("rejects illegal transitions with InvalidTransitionError", async () => {
      const run = await createRun(baseInput());

      await expect(run.pause()).rejects.toBeInstanceOf(InvalidTransitionError);
      await expect(run.resume()).rejects.toBeInstanceOf(InvalidTransitionError);

      await run.markRunning();
      await expect(run.markRunning()).rejects.toBeInstanceOf(InvalidTransitionError);
      await expect(run.resume()).rejects.toBeInstanceOf(InvalidTransitionError);
    });
  });

  describe("reported layer", () => {
    it("records a session id and dedupes runtime-acquired repos", async () => {
      const run = await createRun(baseInput({ repos: ["alpha"] }));

      await run.recordSessionId("harness-123");
      await run.addRepo("beta");
      await run.addRepo("beta");

      const record = diskRecord();
      expect(record.sessionId).toBe("harness-123");
      expect(record.repos).toEqual(["alpha", "beta"]);
    });

    it("appends artifacts with an artifact_reported event per report", async () => {
      const run = await createRun(baseInput());

      await run.addArtifact({ kind: "pr", locator: "https://example/pr/1", repo: "alpha" });
      await run.addArtifact({ kind: "branch", locator: "crew/fixture-task-1" });

      const record = diskRecord();
      expect(record.artifacts).toEqual([
        { kind: "pr", locator: "https://example/pr/1", repo: "alpha" },
        { kind: "branch", locator: "crew/fixture-task-1" },
      ]);
      expect(record.events.filter((event) => event.event === "artifact_reported")).toEqual([
        { ts: "2026-07-17T00:00:00.000Z", event: "artifact_reported", detail: "pr https://example/pr/1" },
        {
          ts: "2026-07-17T00:00:00.000Z",
          event: "artifact_reported",
          detail: "branch crew/fixture-task-1",
        },
      ]);
    });
  });

  describe("complete", () => {
    it("drives the writeback port exactly once with the reported artifacts", async () => {
      const writeback = recordingWriteback();
      const run = await createRun(baseInput({ writeback: writeback.port }));
      await run.markRunning();
      await run.addArtifact({ kind: "pr", locator: "https://example/pr/1", repo: "alpha" });

      await run.complete({ outcome: "delivered", message: "done" });

      expect(writeback.calls).toEqual([
        {
          outcome: "delivered",
          message: "done",
          artifacts: [{ kind: "pr", locator: "https://example/pr/1", repo: "alpha" }],
        },
      ]);
      const record = diskRecord();
      expect(record.state).toBe("complete");
      expect(record.outcome).toBe("delivered");
      expect(record.events.map((event) => event.event)).toEqual([
        "claimed",
        "state_running",
        "artifact_reported",
        "state_complete",
        "writeback_completed",
      ]);
    });

    it("completes from provisioning as complete{failed, reason: launch}", async () => {
      const run = await createRun(baseInput());

      await run.complete({ outcome: "failed", reason: "launch" });

      const record = diskRecord();
      expect(record.state).toBe("complete");
      expect(record.outcome).toBe("failed");
      expect(record.reason).toBe("launch");
    });

    it("treats a no-op writeback port as first-class and silent", async () => {
      const run = await createRun(baseInput());

      await expect(run.complete({ outcome: "stopped" })).resolves.toBeUndefined();
      expect(diskRecord().outcome).toBe("stopped");
    });

    it("is terminal: re-completing or mutating a completed run throws", async () => {
      const run = await createRun(baseInput());
      await run.complete({ outcome: "delivered" });

      await expect(run.complete({ outcome: "failed" })).rejects.toBeInstanceOf(
        InvalidTransitionError,
      );
      await expect(
        run.addArtifact({ kind: "pr", locator: "https://example/pr/2" }),
      ).rejects.toBeInstanceOf(InvalidTransitionError);
      await expect(run.addRepo("beta")).rejects.toBeInstanceOf(InvalidTransitionError);
      await expect(run.recordSessionId("late")).rejects.toBeInstanceOf(InvalidTransitionError);
    });
  });

  describe("read accessors", () => {
    it("exposes the record path and a defensive snapshot copy", async () => {
      const run = await createRun(baseInput({ repos: ["alpha"] }));

      expect(run.path).toBe(runRecordPath({ stateRoot, taskSlug }));

      const snapshot = run.snapshot;
      snapshot.repos.push("mutated");
      await run.markRunning();
      expect(run.snapshot.repos).toEqual(["alpha"]);
      expect(run.snapshot.state).toBe("running");
    });
  });

  describe("loadRun and store helpers", () => {
    it("loads an existing run and continues its lifecycle", async () => {
      const created = await createRun(baseInput());
      await created.markRunning();

      const loaded = await loadRun({ stateRoot, taskSlug, now: fixedNow });
      expect(loaded.state).toBe("running");
      await loaded.pause();

      expect(diskRecord().state).toBe("paused");
    });

    it("throws RunNotFoundError loading an absent run", async () => {
      await expect(loadRun({ stateRoot, taskSlug: "missing" })).rejects.toBeInstanceOf(
        RunNotFoundError,
      );
    });

    it("reports existence, lists, and deletes runs", async () => {
      expect(await runExists({ stateRoot, taskSlug })).toBe(false);
      await createRun(baseInput());
      expect(await runExists({ stateRoot, taskSlug })).toBe(true);

      const records = await listRuns({ stateRoot });
      expect(records.map((record) => record.taskId)).toEqual(["fixture:TASK-1"]);

      await deleteRun({ stateRoot, taskSlug });
      expect(await runExists({ stateRoot, taskSlug })).toBe(false);
    });
  });

  describe("logging integration", () => {
    it("emits run-module log lines on transitions when a logger is injected", async () => {
      const log = vi.fn();
      const run = await createRun(baseInput({ logger: { log } }));

      await run.markRunning();
      await run.recordSessionId("harness-123");
      await run.addArtifact({ kind: "pr", locator: "https://example/pr/1", repo: "alpha" });
      await run.complete({ outcome: "delivered" });

      const events = log.mock.calls.map(([entry]) => entry.event);
      expect(events).toEqual([
        "run_created",
        "run_running",
        "artifact_reported",
        "run_completed",
        "writeback_completed",
      ]);
      for (const [entry] of log.mock.calls) {
        expect(entry.module).toBe("run");
        expect(entry.runId).toBe(run.runId);
        expect(entry.taskId).toBe("fixture:TASK-1");
      }

      const artifactLine = log.mock.calls
        .map(([entry]) => entry)
        .find((entry) => entry.event === "artifact_reported");
      expect(artifactLine).toMatchObject({ repo: "alpha", sessionId: "harness-123" });
    });

    it("uses a real clock by default, stamping events with a valid ISO-8601 UTC ts", async () => {
      const before = Date.now();
      const { now: _omitNow, ...withoutClock } = baseInput();
      const run = await createRun(withoutClock);

      const [claimed] = run.snapshot.events;
      expect(claimed?.ts).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
      expect(Date.parse(claimed?.ts ?? "")).toBeGreaterThanOrEqual(before);
    });
  });
});
