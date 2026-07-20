import { describe, expect, it } from "vitest";

import { guessKind } from "./artifactAdd.js";

describe("guessKind", () => {
  it("recognises pull-request URLs across forges", () => {
    expect(guessKind("https://github.com/o/r/pull/7")).toBe("pr");
    expect(guessKind("https://gitlab.com/o/r/-/merge_requests/3")).toBe("pr");
    expect(guessKind("https://bitbucket.org/o/r/pull-requests/9")).toBe("pr");
  });

  it("treats other URLs as documents", () => {
    expect(guessKind("https://docs.example.com/spec")).toBe("document");
  });

  it("treats paths as files and bare ids as tickets", () => {
    expect(guessKind("/tmp/out.txt")).toBe("file");
    expect(guessKind("./notes.md")).toBe("file");
    expect(guessKind("DEVOP-123")).toBe("ticket");
  });
});
