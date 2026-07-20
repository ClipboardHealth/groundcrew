import { describe, expect, it } from "vitest";

import type { RunRecord } from "../../run/index.js";
import { renderStatusHuman, renderStatusJson } from "./status.js";
import type { StatusModel } from "./statusModel.js";

function record(over: Partial<RunRecord> = {}): RunRecord {
  return {
    version: 1,
    taskId: "fixture:TASK-1",
    runId: "r_8f3a9c21",
    source: "fixture",
    agentProfile: "scripted",
    state: "running",
    resumeCount: 0,
    sessionName: "crew-fixture-task-1",
    workspaceDirectory: "/ws",
    repos: ["alpha"],
    artifacts: [],
    events: [],
    ...over,
  };
}

const baseModel: StatusModel = {
  scope: "all",
  probeAvailable: true,
  runs: [],
  queue: [],
  sources: [],
  strays: [],
  deadRuns: [],
  logFile: "/x.jsonl",
  sandboxDisabled: false,
  missingTaskId: undefined,
};

describe("renderStatusHuman (task scope)", () => {
  const model: StatusModel = {
    ...baseModel,
    scope: "task",
    runs: [
      {
        record: record({
          state: "complete",
          outcome: "delivered",
          artifacts: [{ kind: "pr", locator: "https://github.com/o/r/pull/7", repo: "alpha" }],
        }),
        observation: {
          taskId: "fixture:TASK-1",
          branch: "crew/fixture-task-1",
          repos: [
            {
              repo: "alpha",
              worktreePath: "/ws/alpha",
              branch: "crew/fixture-task-1",
              commitsAhead: ["feat: wire up the widget"],
              dirtyFiles: [],
            },
          ],
        },
        sessionAlive: false,
      },
    ],
  };

  it("labels the observed and reported layers", () => {
    const out = renderStatusHuman(model);
    expect(out).toMatch(/observed/i);
    expect(out).toMatch(/reported/i);
  });

  it("shows the observed commit subject and the reported artifact locator", () => {
    const out = renderStatusHuman(model);
    expect(out).toContain("wire up the widget");
    expect(out).toContain("pull/7");
  });

  it("includes a log pointer with a jq filter on the run id", () => {
    expect(renderStatusHuman(model)).toContain('r_8f3a9c21');
  });
});

describe("renderStatusHuman (overview flags)", () => {
  const model: StatusModel = {
    ...baseModel,
    runs: [{ record: record(), observation: undefined, sessionAlive: false }],
    queue: [
      { taskId: "fixture:TASK-2", title: "Blocked one", blocked: true, verdict: { skipReason: "repo-not-on-disk", detail: "gamma" } },
    ],
    sources: [
      {
        name: "fixture",
        origin: "user",
        status: "ok",
        readOnly: true,
        sandboxOff: true,
        shadows: "package",
        protocolVersion: 1,
        supportedVersions: undefined,
        queueUnavailable: "list failed",
        message: undefined,
      },
      {
        name: "legacy",
        origin: "package",
        status: "unsupported",
        readOnly: false,
        sandboxOff: false,
        shadows: undefined,
        protocolVersion: 99,
        supportedVersions: [1],
        queueUnavailable: undefined,
        message: "unsupported",
      },
    ],
    strays: [{ name: "crew-orphan", alive: true }],
    deadRuns: [{ record: record({ taskId: "fixture:TASK-9" }), observation: undefined, sessionAlive: false }],
  };

  it("renders the skip reason for a queued task", () => {
    expect(renderStatusHuman(model)).toContain("repo-not-on-disk");
  });

  it("flags read-only and sandbox-off sources and the user override", () => {
    const out = renderStatusHuman(model);
    expect(out).toMatch(/read-only/i);
    expect(out).toMatch(/sandbox.?off/i);
    expect(out).toMatch(/overrides/i);
  });

  it("names the unsupported protocol and its supported set", () => {
    const out = renderStatusHuman(model);
    expect(out).toContain("99");
    expect(out).toContain("supported: 1");
  });

  it("marks the queue unavailable with a reason", () => {
    expect(renderStatusHuman(model)).toMatch(/unavailable/i);
  });

  it("reports stray and dead sessions", () => {
    const out = renderStatusHuman(model);
    expect(out).toMatch(/stray/i);
    expect(out).toMatch(/dead/i);
  });
});

describe("renderStatusHuman (sandbox kill-switch)", () => {
  it("surfaces the GROUNDCREW_SANDBOX=off flag loudly", () => {
    const out = renderStatusHuman({ ...baseModel, sandboxDisabled: true });
    expect(out).toMatch(/sandbox/i);
    expect(out).toMatch(/off|disabled/i);
  });
});

describe("renderStatusJson", () => {
  it("emits a machine shape with runs, queue, and sources", () => {
    const parsed = JSON.parse(renderStatusJson(baseModel)) as Record<string, unknown>;
    expect(parsed["scope"]).toBe("all");
    expect(parsed).toHaveProperty("runs");
    expect(parsed).toHaveProperty("queue");
    expect(parsed).toHaveProperty("sources");
  });
});
