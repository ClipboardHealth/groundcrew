import { parseAllLines, type ParsedTodoLine } from "./parser.ts";
import { isActiveForFetch, normalizeToIssue } from "./normalizer.ts";

function parseOne(line: string): ParsedTodoLine {
  const [parsed] = parseAllLines(`${line}\n`);
  if (parsed === null || parsed === undefined) {
    throw new Error("expected parsed todo line");
  }
  return parsed;
}

function normalize(line: string, defaultRepository?: string) {
  const parsed = parseOne(line);
  return normalizeToIssue({
    parsed,
    allParsed: [parsed],
    sourceName: "todo",
    todoPath: "todo.txt",
    tasksDir: ".tasks",
    defaultRepository,
    description: "Prompt",
    updatedAt: "2026-06-08T00:00:00.000Z",
  });
}

describe(normalizeToIssue, () => {
  it.each([
    { line: "Todo final id:TODO-1 agent:codex status:todo", status: "todo" },
    { line: "Todo draft id:TODO-2 agent:codex status:todo extra", status: "other" },
    { line: "Doing id:DOING-1 agent:codex status:in-progress", status: "in-progress" },
    { line: "Review id:REVIEW-1 agent:codex status:in-review", status: "in-review" },
    { line: "Done metadata id:DONE-1 agent:codex status:done", status: "done" },
    { line: "Unknown id:UNKNOWN-1 agent:codex status:waiting", status: "other" },
    { line: "x 2026-06-08 Completed id:DONE-2 agent:codex status:done", status: "done" },
  ])("maps $line to $status", ({ line, status }) => {
    expect(normalize(line)?.status).toBe(status);
  });

  it("uses repo metadata and prompt override when present", () => {
    const issue = normalize(
      "Prompted id:PROMPT-1 agent:codex repo:Org/repo prompt:custom.md status:todo",
    );

    expect(issue?.repository).toBe("Org/repo");
    expect(issue?.sourceRef).toMatchObject({ promptPath: "custom.md" });
  });

  it("falls back to the default repository when repo metadata is absent", () => {
    expect(
      normalize("Default repo id:DEFAULT-1 agent:codex status:todo", "Org/default")?.repository,
    ).toBe("Org/default");
  });

  it("leaves repository undefined when neither task nor source provides one", () => {
    expect(normalize("No repo id:NO-REPO-1 agent:codex status:todo")?.repository).toBeUndefined();
  });

  it("defaults missing agent metadata to agent-any", () => {
    expect(normalize("No agent id:NO-AGENT-1 status:todo")?.agent).toBe("any");
  });
});

describe(isActiveForFetch, () => {
  const today = "2026-06-08";

  it.each([
    { line: "Active todo id:ACTIVE-1 agent:codex status:todo", active: true },
    { line: "Active progress id:ACTIVE-2 agent:codex status:in-progress", active: true },
    { line: "Active review id:ACTIVE-3 agent:codex status:in-review", active: true },
    { line: "x 2026-06-08 Done id:DONE-1 agent:codex status:done", active: false },
    { line: "No id agent:codex status:todo", active: false },
    { line: "No agent id:NO-AGENT-1 status:todo", active: true },
    { line: "Unknown status id:UNKNOWN-1 agent:codex status:waiting", active: false },
  ])("returns $active for $line", ({ line, active }) => {
    expect(isActiveForFetch(parseOne(line), today)).toBe(active);
  });

  it.each([
    { name: "future threshold", line: "Deferred id:T-1 t:2026-06-09 status:todo", active: false },
    { name: "threshold today", line: "Ready id:T-2 t:2026-06-08 status:todo", active: true },
    { name: "past threshold", line: "Ready id:T-3 t:2026-06-01 status:todo", active: true },
    { name: "malformed threshold", line: "Ready id:T-4 t:next-week status:todo", active: true },
    {
      name: "non-calendar threshold matching the date format",
      line: "Ready id:T-7 t:2026-99-99 status:todo",
      active: true,
    },
    {
      name: "non-calendar day overflow threshold",
      line: "Ready id:T-8 t:2026-12-32 status:todo",
      active: true,
    },
    {
      name: "future threshold but already in-progress",
      line: "Started early id:T-5 t:2026-06-09 status:in-progress",
      active: true,
    },
    {
      name: "future threshold but already in-review",
      line: "Reviewed early id:T-6 t:2026-06-09 status:in-review",
      active: true,
    },
  ])("returns $active for $name", ({ line, active }) => {
    expect(isActiveForFetch(parseOne(line), today)).toBe(active);
  });

  describe("datetime thresholds", () => {
    const now = "2026-06-08T12:00:00";

    it.each([
      {
        name: "future same-day time",
        line: "Deferred id:DT-1 t:2026-06-08T13:00 status:todo",
        active: false,
      },
      {
        name: "past same-day time",
        line: "Ready id:DT-2 t:2026-06-08T11:30 status:todo",
        active: true,
      },
      {
        name: "time equal to now",
        line: "Ready id:DT-3 t:2026-06-08T12:00:00 status:todo",
        active: true,
      },
      {
        name: "future time with seconds",
        line: "Deferred id:DT-4 t:2026-06-08T12:00:01 status:todo",
        active: false,
      },
      {
        name: "future date with time",
        line: "Deferred id:DT-5 t:2026-06-09T00:00 status:todo",
        active: false,
      },
      { name: "invalid hour", line: "Ready id:DT-6 t:2026-06-08T25:00 status:todo", active: true },
      {
        name: "invalid minute",
        line: "Ready id:DT-7 t:2026-06-08T12:61 status:todo",
        active: true,
      },
      {
        name: "non-calendar date with time",
        line: "Ready id:DT-8 t:2026-99-99T13:00 status:todo",
        active: true,
      },
      {
        name: "future time but already in-progress",
        line: "Started id:DT-9 t:2026-06-08T13:00 status:in-progress",
        active: true,
      },
      {
        name: "date-only future still defers",
        line: "Deferred id:DT-10 t:2026-06-09 status:todo",
        active: false,
      },
      {
        name: "date-only today still active",
        line: "Ready id:DT-11 t:2026-06-08 status:todo",
        active: true,
      },
    ])("returns $active for $name", ({ line, active }) => {
      expect(isActiveForFetch(parseOne(line), now)).toBe(active);
    });

    it("treats a date-only now as midnight for datetime thresholds", () => {
      expect(
        isActiveForFetch(parseOne("Deferred id:DT-12 t:2026-06-08T00:01 status:todo"), today),
      ).toBe(false);
    });
  });
});
