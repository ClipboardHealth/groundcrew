import { describe, expect, it } from "vitest";

import type { DispatchPlan } from "../../dispatch/index.js";
import { summarizePlan } from "./plan.js";

function verdict(skipReason: DispatchPlan["skipped"][string]["skipReason"], detail?: string) {
  return { skipReason, ts: "2026-01-01T00:00:00.000Z", ...(detail === undefined ? {} : { detail }) };
}

describe("summarizePlan", () => {
  it("lists would-dispatch tasks and itemizes skips with reasons", () => {
    const plan: DispatchPlan = {
      wouldDispatch: ["fixture:TASK-1", "fixture:TASK-2"],
      skipped: {
        "fixture:TASK-3": verdict("ineligible", "blocked"),
        "fixture:TASK-4": verdict("slots-full"),
      },
    };

    expect(summarizePlan(plan)).toEqual([
      "Dry run: no tasks are dispatched.",
      "Would dispatch (2):",
      "  fixture:TASK-1",
      "  fixture:TASK-2",
      "Would skip (2):",
      "  fixture:TASK-3: ineligible (blocked)",
      "  fixture:TASK-4: slots-full",
    ]);
  });

  it("says nothing would dispatch when the plan is empty", () => {
    expect(summarizePlan({ wouldDispatch: [], skipped: {} })).toEqual([
      "Dry run: no tasks are dispatched.",
      "Would dispatch: nothing.",
    ]);
  });
});
