import { generateSessionId, SESSION_ID_PLACEHOLDER } from "./sessionId.ts";

describe(generateSessionId, () => {
  it("prefixes a compact UTC timestamp with the normalized task id", () => {
    const actual = generateSessionId("TEAM-220");

    expect(actual).toMatch(/^team-220-\d{8}t\d{6}z$/);
  });

  it("lowercases and validates the task id like other plain task ids", () => {
    expect(generateSessionId("RRR")).toMatch(/^rrr-\d{8}t\d{6}z$/);
    expect(() => generateSessionId("TEAM/ABC")).toThrow('Invalid task "TEAM/ABC"');
  });

  it("produces a shell- and filename-safe id (no colons, dots, or slashes)", () => {
    const actual = generateSessionId("team-1");

    expect(actual).not.toMatch(/[.:/]/);
  });

  it("exposes the {{session}} template placeholder", () => {
    expect(SESSION_ID_PLACEHOLDER).toBe("{{session}}");
  });
});
