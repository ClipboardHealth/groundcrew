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
  it.each([
    { line: "Active todo id:ACTIVE-1 agent:codex status:todo", active: true },
    { line: "Active progress id:ACTIVE-2 agent:codex status:in-progress", active: true },
    { line: "Active review id:ACTIVE-3 agent:codex status:in-review", active: true },
    { line: "x 2026-06-08 Done id:DONE-1 agent:codex status:done", active: false },
    { line: "No id agent:codex status:todo", active: false },
    { line: "No agent id:NO-AGENT-1 status:todo", active: true },
    { line: "Unknown status id:UNKNOWN-1 agent:codex status:waiting", active: false },
  ])("returns $active for $line", ({ line, active }) => {
    expect(isActiveForFetch(parseOne(line))).toBe(active);
  });
});
