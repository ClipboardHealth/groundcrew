import { assertPlainTaskId, isPlainTaskId, normalizePlainTaskId } from "./taskId.ts";

describe("plain task ids", () => {
  it("accepts source-neutral lowercase slug ids", () => {
    expect(isPlainTaskId("rrr")).toBe(true);
    expect(isPlainTaskId("team-abc")).toBe(true);
    expect(isPlainTaskId("team-123")).toBe(true);
    expect(isPlainTaskId("gc-20260608-001")).toBe(true);
    expect(() => {
      assertPlainTaskId("rrr");
    }).not.toThrow();
  });

  it("rejects ids that are not plain task ids", () => {
    expect(isPlainTaskId("-rrr")).toBe(false);
    expect(isPlainTaskId("rrr-")).toBe(false);
    expect(() => {
      assertPlainTaskId("../team-1");
    }).toThrow(/plain task id/);
  });

  it("normalizes uppercase ids before validating", () => {
    expect(normalizePlainTaskId("RRR")).toBe("rrr");
    expect(normalizePlainTaskId("TEAM-123")).toBe("team-123");
  });

  it("throws with the original id when normalized input is still invalid", () => {
    expect(() => normalizePlainTaskId("TEAM/ABC")).toThrow('Invalid task "TEAM/ABC"');
  });
});
