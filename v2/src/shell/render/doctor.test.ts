import { describe, expect, it } from "vitest";

import type { CheckResult } from "../checks.js";
import { renderChecks } from "./doctor.js";

const ok: CheckResult = { label: "git on PATH", ok: true, detail: undefined, source: undefined };
const bad: CheckResult = {
  label: "source \"fixture\" live list round-trip",
  ok: false,
  detail: "stdout was not valid JSON",
  source: "fixture",
};

describe("renderChecks", () => {
  it("reports all passed when nothing fails", () => {
    const out = renderChecks({ title: "crew doctor", checks: [ok] });
    expect(out).toMatch(/All 1 checks passed/);
  });

  it("names each failing check and its cause", () => {
    const out = renderChecks({ title: "crew doctor", checks: [ok, bad] });
    expect(out).toMatch(/1 of 2 checks failed/);
    expect(out).toContain("stdout was not valid JSON");
    expect(out).toContain("fixture");
  });
});
