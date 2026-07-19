import { describe, expect, it } from "vitest";

import { canonicalTaskId, DEFAULT_BRANCH_PREFIX, taskBranch, taskSlug } from "./identity.js";

describe("identity", () => {
  it("builds the canonical task id from source and local id", () => {
    const actual = canonicalTaskId({ sourceName: "fixture", localId: "TASK-1" });

    expect(actual).toBe("fixture:TASK-1");
  });

  it("slugs by lowercasing and collapsing runs of non-alphanumerics", () => {
    expect(taskSlug({ taskId: "fixture:TASK-1" })).toBe("fixture-task-1");
    expect(taskSlug({ taskId: "fixture:TASK_1.x" })).toBe("fixture-task-1-x");
    expect(taskSlug({ taskId: "linear:DEVOP-123" })).toBe("linear-devop-123");
  });

  it("trims leading and trailing separators", () => {
    expect(taskSlug({ taskId: "::TASK::" })).toBe("task");
  });

  it("builds the uniform task branch with the default and an override prefix", () => {
    expect(taskBranch({ taskId: "fixture:TASK-1" })).toBe("crew/fixture-task-1");
    expect(taskBranch({ taskId: "fixture:TASK-1", branchPrefix: "bot" })).toBe("bot/fixture-task-1");
  });

  it("exposes the default branch prefix", () => {
    expect(DEFAULT_BRANCH_PREFIX).toBe("crew");
  });
});
