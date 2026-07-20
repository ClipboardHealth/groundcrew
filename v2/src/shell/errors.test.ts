import { describe, expect, it } from "vitest";

import { NoTaskContextError, RepoNotOnDiskError } from "../workspace/index.js";
import { CliError, ConfigError, V1ConfigError, exitCodeFor, messageFor } from "./errors.js";

describe("exitCodeFor", () => {
  it("maps RepoNotOnDiskError to 2", () => {
    expect(exitCodeFor(new RepoNotOnDiskError({ repo: "a", baseDirectory: "/b" }))).toBe(2);
  });

  it("maps NoTaskContextError to 3", () => {
    expect(exitCodeFor(new NoTaskContextError())).toBe(3);
  });

  it("maps every other error to 1", () => {
    expect(exitCodeFor(new CliError("x"))).toBe(1);
    expect(exitCodeFor(new ConfigError("x"))).toBe(1);
    expect(exitCodeFor(new V1ConfigError("/c.ts"))).toBe(1);
    expect(exitCodeFor(new Error("x"))).toBe(1);
    expect(exitCodeFor("plain string")).toBe(1);
  });
});

describe("messageFor", () => {
  it("returns an Error's message and stringifies non-errors", () => {
    expect(messageFor(new Error("boom"))).toBe("boom");
    expect(messageFor("boom")).toBe("boom");
  });
});
