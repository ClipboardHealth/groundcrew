import { describe, expect, it } from "vitest";

import { renderHumanLine } from "./consoleRenderer.js";

describe("renderHumanLine", () => {
  it("renders a bare line with padded level and no context", () => {
    const input = {
      ts: "2026-07-17T00:00:00.000Z",
      level: "info",
      module: "dispatch",
      event: "poll_tick",
    };

    const actual = renderHumanLine(input);

    expect(actual).toBe("2026-07-17T00:00:00.000Z info  dispatch poll_tick");
  });

  it("appends the message and correlation ids in reserved order", () => {
    const input = {
      ts: "2026-07-17T00:00:00.000Z",
      level: "warn",
      module: "run",
      event: "run_completed",
      msg: "delivered",
      runId: "r_8f3a9c21",
      taskId: "fixture:TASK-1",
    };

    const actual = renderHumanLine(input);

    expect(actual).toBe(
      "2026-07-17T00:00:00.000Z warn  run run_completed delivered (taskId=fixture:TASK-1 runId=r_8f3a9c21)",
    );
  });

  it("renders extra flat fields after the reserved ids", () => {
    const input = {
      ts: "2026-07-17T00:00:00.000Z",
      level: "error",
      module: "session",
      event: "launch_failed",
      repo: "alpha",
      attempt: 2,
    };

    const actual = renderHumanLine(input);

    expect(actual).toBe(
      "2026-07-17T00:00:00.000Z error session launch_failed (repo=alpha attempt=2)",
    );
  });
});
