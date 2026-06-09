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

  it("accepts blockers with optional statusReason and nativeStatus fields", () => {
    const issue = {
      id: "x",
      title: "t",
      description: "",
      status: "todo",
      repository: null,
      model: null,
      assignee: "u",
      updatedAt: "2026-01-01T00:00:00Z",
      blockers: [
        { id: "b1", title: "missing", status: "other", statusReason: "missing" },
        {
          id: "b2",
          title: "unmapped",
          status: "other",
          statusReason: "unmapped",
          nativeStatus: "Triage",
        },
        { id: "b3", title: "mapped", status: "done", nativeStatus: "Done" },
      ],
      sourceRef: null,
    };
    const parsed = shellIssueSchema.parse(issue);
    expect(parsed.blockers[0]?.statusReason).toBe("missing");
    expect(parsed.blockers[0]?.nativeStatus).toBeUndefined();
    expect(parsed.blockers[1]?.statusReason).toBe("unmapped");
    expect(parsed.blockers[1]?.nativeStatus).toBe("Triage");
    expect(parsed.blockers[2]?.statusReason).toBeUndefined();
    expect(parsed.blockers[2]?.nativeStatus).toBe("Done");
  });

  it("defaults blocker statusReason and nativeStatus to undefined when omitted", () => {
    const issue = {
      id: "x",
      title: "t",
      description: "",
      status: "todo",
      repository: null,
      model: null,
      assignee: "u",
      updatedAt: "2026-01-01T00:00:00Z",
      blockers: [{ id: "b1", title: "plain", status: "in-progress" }],
      sourceRef: null,
    };
    const parsed = shellIssueSchema.parse(issue);
    expect(parsed.blockers[0]?.statusReason).toBeUndefined();
    expect(parsed.blockers[0]?.nativeStatus).toBeUndefined();
  });

  it("rejects an invalid statusReason value on a blocker", () => {
    const issue = {
      id: "x",
      title: "t",
      description: "",
      status: "todo",
      repository: null,
      model: null,
      assignee: "u",
      updatedAt: "2026-01-01T00:00:00Z",
      blockers: [{ id: "b1", title: "bad", status: "other", statusReason: "invalid-reason" }],
      sourceRef: null,
    };
    expect(() => shellIssueSchema.parse(issue)).toThrow(/.+/);
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

  it("accepts commands.listTasks as the preferred name for fetch", () => {
    const config = {
      kind: "shell",
      name: "jira",
      commands: { listTasks: "echo '[]'" },
    };
    expect(() => shellAdapterConfigSchema.parse(config)).not.toThrow();
  });

  it("accepts commands.getTask as the preferred name for resolveOne", () => {
    const config = {
      kind: "shell",
      name: "jira",
      commands: { fetch: "echo '[]'", getTask: "./get.sh ${id}" },
    };
    expect(() => shellAdapterConfigSchema.parse(config)).not.toThrow();
  });

  it("rejects config with neither fetch nor listTasks", () => {
    const config = {
      kind: "shell",
      name: "jira",
      commands: { verify: "echo ok" },
    };
    expect(() => shellAdapterConfigSchema.parse(config)).toThrow(/listTasks.*required/i);
  });

  it("accepts timeouts.listTasks and timeouts.getTask", () => {
    const config = {
      kind: "shell",
      name: "jira",
      commands: { listTasks: "echo '[]'" },
      timeouts: { listTasks: 60_000, getTask: 15_000 },
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
        markInReview: "jira move ${id} 'In Review'",
      },
      cwd: "/work",
      timeouts: { fetch: 60_000, markInReview: 15_000 },
      env: { JIRA_TOKEN: "abc" },
    };
    expect(() => shellAdapterConfigSchema.parse(config)).not.toThrow();
  });

  it("rejects a negative timeout", () => {
    const config = {
      kind: "shell",
      name: "jira",
      commands: { fetch: "./fetch.sh" },
      timeouts: { fetch: -1 },
    };
    expect(() => shellAdapterConfigSchema.parse(config)).toThrow(/too small|>0/i);
  });

  it("rejects a zero timeout", () => {
    const config = {
      kind: "shell",
      name: "jira",
      commands: { fetch: "./fetch.sh" },
      timeouts: { fetch: 0 },
    };
    expect(() => shellAdapterConfigSchema.parse(config)).toThrow(/too small|>0/i);
  });

  it("rejects a non-integer timeout", () => {
    const config = {
      kind: "shell",
      name: "jira",
      commands: { fetch: "./fetch.sh" },
      timeouts: { fetch: 1500.5 },
    };
    expect(() => shellAdapterConfigSchema.parse(config)).toThrow(/expected int|integer/i);
  });

  it("accepts commands.markDone and timeouts.markDone", () => {
    const config = {
      kind: "shell",
      name: "jira",
      commands: { fetch: "./fetch.sh", markDone: "jira move ${id} 'Done'" },
      timeouts: { markDone: 15_000 },
    };
    expect(() => shellAdapterConfigSchema.parse(config)).not.toThrow();
  });

  it("rejects a zero markDone timeout", () => {
    const config = {
      kind: "shell",
      name: "jira",
      commands: { fetch: "./fetch.sh" },
      timeouts: { markDone: 0 },
    };
    expect(() => shellAdapterConfigSchema.parse(config)).toThrow(/too small|>0/i);
  });
});
