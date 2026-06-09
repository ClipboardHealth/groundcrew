import { linearAdapterConfigSchema } from "./schema.ts";

describe("Linear adapter config schema", () => {
  it("accepts configured Linear status names", () => {
    const actual = linearAdapterConfigSchema.parse({
      kind: "linear",
      statuses: {
        inProgress: ["Doing"],
        inReview: ["Code Review", "Review"],
      },
    });

    expect(actual).toStrictEqual({
      kind: "linear",
      statuses: {
        inProgress: ["Doing"],
        inReview: ["Code Review", "Review"],
      },
    });
  });

  it("rejects an empty configured status-name list", () => {
    const actual = linearAdapterConfigSchema.safeParse({
      kind: "linear",
      statuses: { inReview: [] },
    });

    expect(actual.success).toBe(false);
  });

  it("accepts a configured Linear task creation team", () => {
    const actual = linearAdapterConfigSchema.parse({ kind: "linear", team: " ENG " });

    expect(actual).toStrictEqual({ kind: "linear", team: "ENG" });
  });

  it("rejects an empty configured Linear task creation team", () => {
    const actual = linearAdapterConfigSchema.safeParse({ kind: "linear", team: " " });

    expect(actual.success).toBe(false);
  });

  it("accepts the explicit opt-out sentinel enabled: false", () => {
    const actual = linearAdapterConfigSchema.parse({ kind: "linear", enabled: false });

    expect(actual).toStrictEqual({ kind: "linear", enabled: false });
  });

  it("accepts enabled: true", () => {
    const actual = linearAdapterConfigSchema.parse({ kind: "linear", enabled: true });

    expect(actual).toStrictEqual({ kind: "linear", enabled: true });
  });

  it("rejects a non-boolean enabled", () => {
    const actual = linearAdapterConfigSchema.safeParse({ kind: "linear", enabled: "no" });

    expect(actual.success).toBe(false);
  });
});
