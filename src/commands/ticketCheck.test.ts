import { renderTicketCheckResult, type Section } from "./ticketCheck.ts";

function makeOk(name: string, detail?: string): Section["checks"][number] {
  return { name, status: "ok", ...(detail === undefined ? {} : { detail }) };
}
function makeFail(name: string, detail?: string): Section["checks"][number] {
  return { name, status: "fail", ...(detail === undefined ? {} : { detail }) };
}

describe("ticket check renderer", () => {
  it("formats the header with command, argument, and optional title", () => {
    const lines = renderTicketCheckResult({
      command: "status",
      argument: "HRD-1",
      title: "the title",
      sections: [{ name: "Linear", checks: [makeOk("Ticket exists in Linear", '"the title"')] }],
      verdict: "→ pr-open: https://linear.app/foo",
    });

    const expectedHeader = "groundcrew status HRD-1 (the title)";
    expect(lines[0]).toBe(expectedHeader);
    expect(lines[1]).toBe("─".repeat(expectedHeader.length));
  });

  it("passes the argument through verbatim so doctor can include the --ticket flag", () => {
    const lines = renderTicketCheckResult({
      command: "doctor",
      argument: "--ticket HRD-1",
      title: "Doctor title",
      sections: [{ name: "Resolution", checks: [makeOk("Ticket exists in Linear")] }],
      verdict: "→ would be dispatched on next tick",
    });

    expect(lines[0]).toBe("groundcrew doctor --ticket HRD-1 (Doctor title)");
  });

  it("renders an empty section with skipReason as a parenthesized skip message", () => {
    const lines = renderTicketCheckResult({
      command: "status",
      argument: "HRD-1",
      sections: [{ name: "Linear", checks: [], skipReason: "--no-linear" }],
      verdict: "→ in-flight",
    });
    expect(lines).toContain("Linear");
    expect(lines).toContain("  (skipped — --no-linear)");
  });

  it("renders the verdict line as the final entry", () => {
    const lines = renderTicketCheckResult({
      command: "status",
      argument: "HRD-1",
      sections: [{ name: "Linear", checks: [makeFail("Ticket exists in Linear", "boom")] }],
      verdict: "→ unresolvable: boom",
    });
    expect(lines.at(-1)).toBe("→ unresolvable: boom");
  });

  it("uses [ok] / [--] / [? ] tags according to check status", () => {
    const lines = renderTicketCheckResult({
      command: "status",
      argument: "HRD-1",
      sections: [
        {
          name: "Linear",
          checks: [
            makeOk("ok check"),
            makeFail("fail check"),
            { name: "skipped check", status: "skipped" },
          ],
        },
      ],
      verdict: "→ x",
    });
    expect(lines).toContain("  [ok] ok check");
    expect(lines).toContain("  [--] fail check");
    expect(lines).toContain("  [? ] skipped check");
  });
});
