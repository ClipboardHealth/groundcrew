import { linearAdapterConfigSchema } from "./schema.ts";

describe("linearAdapterConfigSchema schema", () => {
  it("parses project-mode config (no view)", () => {
    const parsed = linearAdapterConfigSchema.parse({ kind: "linear" });
    expect(parsed).toStrictEqual({ kind: "linear" });
  });

  it("parses view-mode config with a URL", () => {
    const parsed = linearAdapterConfigSchema.parse({
      kind: "linear",
      view: { url: "https://linear.app/cbh/view/foo-61e51e3730dd" },
    });
    expect(parsed.view?.url).toBe("https://linear.app/cbh/view/foo-61e51e3730dd");
  });

  it("rejects view.url that is not a URL", () => {
    expect(() =>
      linearAdapterConfigSchema.parse({
        kind: "linear",
        view: { url: "not-a-url" },
      }),
    ).toThrow(/url|invalid/i);
  });

  it("rejects view object without url", () => {
    expect(() =>
      linearAdapterConfigSchema.parse({
        kind: "linear",
        view: {},
      }),
    ).toThrow(/required|url/i);
  });
});
