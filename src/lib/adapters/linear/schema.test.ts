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
});
