import { describe, expect, it } from "vitest";

import type { TickReport } from "../../dispatch/index.js";
import { summarizeTick } from "./tick.js";

function report(overrides: Partial<TickReport> = {}): TickReport {
  return { dispatched: [], reaped: [], skipped: {}, ...overrides };
}

describe("summarizeTick", () => {
  it("itemizes dispatches and reaps", () => {
    const lines = summarizeTick(
      report({ dispatched: ["fixture:A", "fixture:B"], reaped: ["fixture:C"] }),
    );
    expect(lines).toEqual(["Dispatched fixture:A.", "Dispatched fixture:B.", "Reaped fixture:C."]);
  });

  it("itemizes interesting skips with their detail", () => {
    const lines = summarizeTick(
      report({
        skipped: {
          "fixture:A": { skipReason: "repo-not-on-disk", detail: "gamma", ts: "t" },
          "fixture:B": { skipReason: "ineligible", detail: "unrouted", ts: "t" },
          "fixture:C": { skipReason: "claim-rejected", ts: "t" },
        },
      }),
    );
    expect(lines).toEqual([
      "Skipped fixture:A: repo-not-on-disk (gamma).",
      "Skipped fixture:B: ineligible (unrouted).",
      "Skipped fixture:C: claim-rejected.",
    ]);
  });

  it("collapses many slots-full verdicts into one line", () => {
    const skipped: TickReport["skipped"] = {};
    for (let index = 0; index < 37; index += 1) {
      skipped[`fixture:T${String(index)}`] = { skipReason: "slots-full", ts: "t" };
    }
    const lines = summarizeTick(report({ skipped }));
    expect(lines).toEqual(["37 queued (slots full)."]);
  });

  it("shows dispatches and the collapsed queue together", () => {
    const lines = summarizeTick(
      report({
        dispatched: ["fixture:A"],
        skipped: {
          "fixture:B": { skipReason: "slots-full", ts: "t" },
          "fixture:C": { skipReason: "slots-full", ts: "t" },
        },
      }),
    );
    expect(lines).toEqual(["Dispatched fixture:A.", "2 queued (slots full)."]);
  });

  it("prints one heartbeat line when there is nothing new", () => {
    expect(summarizeTick(report())).toEqual(["Nothing to dispatch."]);
  });
});
