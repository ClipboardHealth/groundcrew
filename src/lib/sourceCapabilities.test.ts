import { sourceSupportsMarkDone, taskSupportsCompletionCommand } from "./sourceCapabilities.ts";

describe(sourceSupportsMarkDone, () => {
  it("continues past non-matching sources before returning the markDone capability", () => {
    const rawSources = [
      { kind: "linear" },
      {
        kind: "todo-txt",
        name: "todo",
        todoPath: "todo.txt",
        tasksDir: ".tasks",
        idPrefix: "GC",
        timezone: "UTC",
      },
    ];

    const actual = sourceSupportsMarkDone({ rawSources, sourceName: "todo" });

    expect(actual).toBe(true);
  });
});

describe(taskSupportsCompletionCommand, () => {
  it("returns false for unprefixed task ids when the source is ambiguous", () => {
    const rawSources = [
      { kind: "linear" },
      {
        kind: "todo-txt",
        name: "todo",
        todoPath: "todo.txt",
        tasksDir: ".tasks",
        idPrefix: "GC",
        timezone: "UTC",
      },
    ];

    expect(taskSupportsCompletionCommand({ rawSources: [], taskId: "team-1" })).toBe(false);
    expect(taskSupportsCompletionCommand({ rawSources, taskId: "team-1" })).toBe(false);
  });
});
