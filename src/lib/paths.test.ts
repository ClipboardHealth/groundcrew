import { homedir } from "node:os";
import path from "node:path";

import { expandHome } from "./paths.ts";

describe("tilde expansion", () => {
  it("expands bare ~", () => {
    expect(expandHome("~")).toBe(homedir());
  });

  it("expands ~/path to absolute path", () => {
    expect(expandHome("~/foo/bar")).toBe(path.resolve(homedir(), "foo/bar"));
  });

  it("leaves absolute path unchanged", () => {
    expect(expandHome("/absolute/path")).toBe("/absolute/path");
  });

  it("leaves relative path unchanged", () => {
    expect(expandHome("relative/path")).toBe("relative/path");
  });
});
