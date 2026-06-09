import {
  AmbiguousTaskError,
  isGroundcrewIssue,
  type Issue,
  naturalIdFromCanonical,
  RepositoryResolutionError,
  toCanonicalId,
} from "./taskSource.ts";

function fakeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "linear:eng-1",
    source: "linear",
    title: "x",
    description: "",
    status: "todo",
    repository: undefined,
    agent: undefined,
    assignee: "Unassigned",
    updatedAt: "2026-01-01T00:00:00Z",
    blockers: [],
    hasMoreBlockers: false,
    sourceRef: {},
    ...overrides,
  };
}

describe(isGroundcrewIssue, () => {
  it("returns true when both agent and repository are defined", () => {
    expect(isGroundcrewIssue(fakeIssue({ agent: "claude", repository: "org/repo" }))).toBe(true);
  });
  it("returns false when agent is undefined", () => {
    expect(isGroundcrewIssue(fakeIssue({ repository: "org/repo" }))).toBe(false);
  });
  it("returns false when repository is undefined", () => {
    expect(isGroundcrewIssue(fakeIssue({ agent: "claude" }))).toBe(false);
  });
});

describe(RepositoryResolutionError, () => {
  it("formats a message listing the known repositories", () => {
    const error = new RepositoryResolutionError({
      task: "ENG-1",
      repositories: ["org/repo-a", "org/repo-b"],
    });
    expect(error.name).toBe("RepositoryResolutionError");
    expect(error.message).toContain("ENG-1");
    expect(error.message).toContain("org/repo-a");
    expect(error.message).toContain("org/repo-b");
  });
});

describe(AmbiguousTaskError, () => {
  it("formats a message listing the canonical ids that matched", () => {
    const error = new AmbiguousTaskError({
      naturalId: "x",
      matches: ["linear:x", "shell-jira:x"],
    });
    expect(error.name).toBe("AmbiguousTaskError");
    expect(error.message).toContain('"x"');
    expect(error.message).toContain("linear:x");
    expect(error.message).toContain("shell-jira:x");
  });
});

describe(naturalIdFromCanonical, () => {
  it("strips the source prefix from a canonical id", () => {
    expect(naturalIdFromCanonical("linear:eng-220")).toBe("eng-220");
  });

  it("handles ids with multiple colons by only stripping the first segment", () => {
    expect(naturalIdFromCanonical("shell-jira:HRD-1:extra")).toBe("HRD-1:extra");
  });
});

describe(toCanonicalId, () => {
  it("prefixes a lowercased natural id with the source name", () => {
    expect(toCanonicalId("linear", "ENG-220")).toBe("linear:eng-220");
  });

  it("lowercases the natural id even when the source name has uppercase letters", () => {
    // Source names are kebab-case in config but should be applied verbatim;
    // only the natural id is lowercased.
    expect(toCanonicalId("Shell-Jira", "HRD-1")).toBe("Shell-Jira:hrd-1");
  });

  it("is a no-op on already-lowercased natural ids", () => {
    expect(toCanonicalId("linear", "eng-220")).toBe("linear:eng-220");
  });

  it("round-trips with naturalIdFromCanonical when the natural id is already lowercase", () => {
    const canonical = toCanonicalId("shell-test", "test-1");
    expect(naturalIdFromCanonical(canonical)).toBe("test-1");
  });
});
