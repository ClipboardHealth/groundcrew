import { describe, expect, it } from "vitest";

import { branchFor, canonicalTaskId, sessionFor, taskSlug } from "./identity.js";

describe("identity", () => {
  describe("taskSlug", () => {
    it("lowercases and collapses non-alphanumeric runs to single dashes", () => {
      expect(taskSlug({ taskId: "fixture:TASK-1" })).toBe("fixture-task-1");
      expect(taskSlug({ taskId: "linear:DEVOP-123" })).toBe("linear-devop-123");
    });

    it("handles the pinned tricky id fixture:TASK_1.x", () => {
      expect(taskSlug({ taskId: "fixture:TASK_1.x" })).toBe("fixture-task-1-x");
    });

    it("collapses consecutive separators and trims leading/trailing dashes", () => {
      expect(taskSlug({ taskId: "a__b" })).toBe("a-b");
      expect(taskSlug({ taskId: "::alpha::" })).toBe("alpha");
      expect(taskSlug({ taskId: "fixture:TASK--1" })).toBe("fixture-task-1");
    });
  });

  describe("branchFor", () => {
    it("uses the default crew prefix", () => {
      expect(branchFor({ taskId: "fixture:TASK-1" })).toBe("crew/fixture-task-1");
    });

    it("honors a custom branch prefix", () => {
      expect(branchFor({ taskId: "fixture:TASK-1", branchPrefix: "wip" })).toBe(
        "wip/fixture-task-1",
      );
    });
  });

  describe("sessionFor", () => {
    it("prefixes the slug with crew-", () => {
      expect(sessionFor({ taskId: "fixture:TASK-1" })).toBe("crew-fixture-task-1");
    });
  });

  describe("canonicalTaskId", () => {
    it("joins source name and local id with a colon", () => {
      expect(canonicalTaskId({ sourceName: "fixture", localId: "TASK-1" })).toBe(
        "fixture:TASK-1",
      );
    });
  });
});
