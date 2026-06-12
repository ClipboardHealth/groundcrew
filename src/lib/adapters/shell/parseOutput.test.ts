import { TaskSourceOutputError } from "../../taskSource.ts";
import { errorMessage } from "../../util.ts";

import { parseShellJson, type ShellParseContext } from "./parseOutput.ts";
import { shellFetchOutputSchema, type ShellIssue, shellIssueSchema } from "./schema.ts";

const context: ShellParseContext = { sourceName: "plankeeper", command: "listTasks" };

function wellFormed(overrides: Partial<ShellIssue> = {}): ShellIssue {
  return {
    id: "P-1",
    title: "Title",
    description: "",
    status: "todo",
    repository: null,
    agent: null,
    assignee: "u",
    updatedAt: "2026-01-01T00:00:00Z",
    blockers: [],
    hasMoreBlockers: false,
    sourceRef: { path: "/tmp/p.md" },
    ...overrides,
  };
}

/** Like plan-keeper's output: a `model` field where `agent` should be, so `agent` is absent. */
function issueWithModelNotAgent(id: string): Record<string, unknown> {
  const { agent: _agent, ...rest } = wellFormed({ id });
  return { ...rest, model: "claude" };
}

/** Capture the thrown error's message without an in-test conditional. */
function messageFromThrow(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return errorMessage(error);
  }
  throw new Error("expected the call to throw, but it returned");
}

describe(parseShellJson, () => {
  it("returns the validated value for well-formed JSON", () => {
    const parsed = parseShellJson(shellFetchOutputSchema, JSON.stringify([wellFormed()]), context);

    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.id).toBe("P-1");
  });

  it("throws a source-attributed error when stdout is not JSON", () => {
    const run = (): unknown => parseShellJson(shellFetchOutputSchema, "not json", context);

    expect(run).toThrow(TaskSourceOutputError);
    expect(run).toThrow(/source "plankeeper": the listTasks command did not return valid JSON/);
  });

  it("collapses N issues missing `agent` into one counted line", () => {
    const withoutAgent = [issueWithModelNotAgent("P-1"), issueWithModelNotAgent("P-2")];
    const message = messageFromThrow(() =>
      parseShellJson(shellFetchOutputSchema, JSON.stringify(withoutAgent), context),
    );

    expect(message).toContain('source "plankeeper"');
    expect(message).toContain('2 issue(s) are missing the required "agent" field');
    // The collapse means the field name appears once, not once per issue.
    expect(message.match(/missing the required "agent"/g)).toHaveLength(1);
  });

  it("describes a top-level shape mismatch (no field path) without crashing", () => {
    // A non-array payload fails `shellFetchOutputSchema` at the root, so the
    // issue path is empty and there is no field name to report.
    const message = messageFromThrow(() => parseShellJson(shellFetchOutputSchema, "{}", context));

    expect(message).toContain('source "plankeeper"');
    expect(message).toContain("have an invalid field");
    expect(message).not.toContain("rename it to");
  });

  it("names the nearest field when the failure is inside a nested array", () => {
    // A bad blocker element makes the issue path end in an array index
    // (`[0, "blockers", 0]`); the reported field is the nearest named one.
    const payload = JSON.stringify([{ ...wellFormed(), blockers: ["not-an-object"] }]);
    const message = messageFromThrow(() =>
      parseShellJson(shellFetchOutputSchema, payload, context),
    );

    expect(message).toContain('"blockers"');
  });

  it("names the invalid field for a wrong-value (non-missing) failure", () => {
    const payload = JSON.stringify({ ...wellFormed(), status: "nope" });
    const message = messageFromThrow(() => parseShellJson(shellIssueSchema, payload, context));

    expect(message).toContain('source "plankeeper"');
    expect(message).toContain('"status"');
  });
});
