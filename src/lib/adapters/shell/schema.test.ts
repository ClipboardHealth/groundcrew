/* eslint-disable no-template-curly-in-string -- ${id}-style placeholders appear in config command strings for the shell adapter's substitution mechanism */

import { shellAdapterConfigSchema, shellFetchOutputSchema, shellIssueSchema } from "./schema.ts";

describe("shell issue schema", () => {
  it("accepts a fully-formed shell issue", () => {
    const valid = {
      id: "PLN-001",
      title: "Test",
      description: "Body",
      status: "todo",
      repository: "org/repo",
      model: "claude",
      assignee: "paul",
      updatedAt: "2026-05-21T13:00:00Z",
      blockers: [],
      sourceRef: { path: "/tmp/p.md" },
    };
    expect(() => shellIssueSchema.parse(valid)).not.toThrow();
  });

  it("rejects an unknown status value", () => {
    const invalid = {
      id: "x",
      title: "t",
      description: "",
      status: "wrong",
      repository: null,
      model: null,
      assignee: "u",
      updatedAt: "2026-01-01T00:00:00Z",
      blockers: [],
      sourceRef: null,
    };
    expect(() => shellIssueSchema.parse(invalid)).toThrow(/status/i);
  });

  it("defaults hasMoreBlockers to false when omitted", () => {
    const minimal = {
      id: "x",
      title: "t",
      description: "",
      status: "todo",
      repository: null,
      model: null,
      assignee: "u",
      updatedAt: "2026-01-01T00:00:00Z",
      blockers: [],
      sourceRef: null,
    };
    const parsed = shellIssueSchema.parse(minimal);
    expect(parsed.hasMoreBlockers).toBe(false);
  });

  it("validates blockers' canonical status field", () => {
    const issueWithBadBlocker = {
      id: "x",
      title: "t",
      description: "",
      status: "todo",
      repository: null,
      model: null,
      assignee: "u",
      updatedAt: "2026-01-01T00:00:00Z",
      blockers: [{ id: "b1", title: "blocker", status: "invalid-status" }],
      sourceRef: null,
    };
    expect(() => shellIssueSchema.parse(issueWithBadBlocker)).toThrow(/status/i);
  });
});

describe("shell fetch output schema", () => {
  it("accepts an array of well-formed shell issues", () => {
    const valid = [
      {
        id: "PLN-001",
        title: "t",
        description: "",
        status: "todo",
        repository: null,
        model: null,
        assignee: "u",
        updatedAt: "2026-01-01T00:00:00Z",
        blockers: [],
        sourceRef: null,
      },
    ];
    expect(() => shellFetchOutputSchema.parse(valid)).not.toThrow();
  });

  it("rejects a non-array", () => {
    expect(() => shellFetchOutputSchema.parse({ id: "x" })).toThrow(/.+/);
  });
});

describe("shell adapter config schema", () => {
  it("accepts a minimal config (just kind + name + commands.fetch)", () => {
    const config = {
      kind: "shell",
      name: "jira",
      commands: { fetch: "echo '[]'" },
    };
    expect(() => shellAdapterConfigSchema.parse(config)).not.toThrow();
  });

  it("requires kebab-case names", () => {
    const config = {
      kind: "shell",
      name: "JIRA",
      commands: { fetch: "echo '[]'" },
    };
    expect(() => shellAdapterConfigSchema.parse(config)).toThrow(/kebab-case/i);
  });

  it("accepts optional commands and timeouts", () => {
    const config = {
      kind: "shell",
      name: "jira",
      commands: {
        verify: "jira me",
        fetch: "./fetch.sh",
        resolveOne: "./resolve.sh ${id}",
        markInProgress: "jira move ${id} 'In Progress'",
      },
      cwd: "/work",
      timeouts: { fetch: 60_000 },
      env: { JIRA_TOKEN: "abc" },
    };
    expect(() => shellAdapterConfigSchema.parse(config)).not.toThrow();
  });

  it.each([
    ["verify", 0],
    ["fetch", -1],
    ["resolveOne", 1.5],
    ["markInProgress", 0],
  ] as const)("rejects invalid %s timeout override %s", (field, value) => {
    const config = {
      kind: "shell",
      name: "jira",
      commands: { fetch: "echo '[]'" },
      timeouts: { [field]: value },
    };

    expect(() => shellAdapterConfigSchema.parse(config)).toThrow(/.+/);
  });
});
