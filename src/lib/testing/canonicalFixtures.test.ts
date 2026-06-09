import {
  canonicalBlocker,
  canonicalLinearIssue,
  canonicalShellIssue,
} from "./canonicalFixtures.ts";

describe(canonicalLinearIssue, () => {
  it("produces a fully-populated canonical Issue with sensible defaults", () => {
    const issue = canonicalLinearIssue({ naturalId: "eng-220" });
    expect(issue.id).toBe("linear:eng-220");
    expect(issue.source).toBe("linear");
    expect(issue.status).toBe("todo");
    expect(issue.description).toBe("");
    expect(issue.repository).toBeUndefined();
    expect(issue.blockers).toStrictEqual([]);
  });

  it("overrides apply correctly including nested sourceRef fields", () => {
    const issue = canonicalLinearIssue({
      naturalId: "eng-99",
      status: "in-progress",
      repository: "acme/web",
      sourceRef: { uuid: "custom-uuid" } as unknown,
    });
    expect(issue.status).toBe("in-progress");
    expect(issue.repository).toBe("acme/web");
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- sourceRef is opaque unknown in Issue; this test validates the fixture merges partial overrides
    expect((issue.sourceRef as { uuid: string }).uuid).toBe("custom-uuid");
  });

  it("lowercases the natural id in the canonical id so fixtures match runtime construction", () => {
    // Production `toCanonicalId` lowercases the natural part so Board lookups
    // against lower-cased natural-id input always resolve regardless of source
    // casing. Fixtures must follow the same rule or tests can pass against
    // behavior the runtime doesn't actually have.
    const issue = canonicalLinearIssue({ naturalId: "ENG-220" });
    expect(issue.id).toBe("linear:eng-220");
  });
});

describe(canonicalBlocker, () => {
  it("produces a canonical Blocker with status default 'todo'", () => {
    const blocker = canonicalBlocker({ naturalId: "eng-50" });
    expect(blocker.id).toBe("linear:eng-50");
    expect(blocker.status).toBe("todo");
  });

  it("lowercases the natural id in the canonical id so blocker fixtures match runtime construction", () => {
    const blocker = canonicalBlocker({ naturalId: "ENG-50" });
    expect(blocker.id).toBe("linear:eng-50");
  });
});

describe(canonicalShellIssue, () => {
  it("defaults source to 'shell-test' and lowercases the natural id in the canonical id", () => {
    const issue = canonicalShellIssue({ naturalId: "TEST-1" });
    expect(issue.id).toBe("shell-test:test-1");
    expect(issue.source).toBe("shell-test");
    expect(issue.sourceRef).toStrictEqual({});
  });

  it("respects a custom sourceName", () => {
    const issue = canonicalShellIssue({ naturalId: "hrd-1", sourceName: "shell-jira" });
    expect(issue.id).toBe("shell-jira:hrd-1");
    expect(issue.source).toBe("shell-jira");
  });

  it("overrides apply correctly", () => {
    const issue = canonicalShellIssue({
      naturalId: "x-1",
      status: "in-progress",
      repository: "acme/web",
      agent: "claude",
    });
    expect(issue.status).toBe("in-progress");
    expect(issue.repository).toBe("acme/web");
    expect(issue.agent).toBe("claude");
  });
});
