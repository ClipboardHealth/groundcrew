import { taskSourceWritePathsForCompletion } from "./taskSourceFilesystem.ts";
import type { ShellAdapterConfig } from "./adapters/shell/schema.ts";
import type { TodoTxtAdapterConfig } from "./adapters/todo-txt/schema.ts";
import type { ResolvedConfig } from "./config.ts";

function configWithSources(sources: ResolvedConfig["sources"]): Pick<ResolvedConfig, "sources"> {
  return { sources };
}

function todoSource(overrides: Partial<TodoTxtAdapterConfig> = {}): TodoTxtAdapterConfig {
  return {
    kind: "todo-txt",
    name: "todo",
    todoPath: "todo.txt",
    tasksDir: ".tasks",
    idPrefix: "GC",
    timezone: "UTC",
    ...overrides,
  };
}

function shellSource(overrides: Partial<ShellAdapterConfig> = {}): ShellAdapterConfig {
  return {
    kind: "shell",
    name: "plankeeper",
    commands: { listTasks: "./list.sh" },
    sandboxWritePaths: ["/Users/rocky/plans"],
    ...overrides,
  };
}

describe(taskSourceWritePathsForCompletion, () => {
  it("grants the todo file directory and tasks dir for the matching canonical todo source", () => {
    const actual = taskSourceWritePathsForCompletion({
      config: configWithSources([
        todoSource({
          name: "todo",
          todoPath: "/Users/rocky/v/todo.md",
          tasksDir: "/Users/rocky/v/.tasks",
        }),
        todoSource({
          name: "later",
          todoPath: "/Users/rocky/later/todo.md",
          tasksDir: "/Users/rocky/later/.tasks",
        }),
      ]),
      taskId: "todo:gc-1",
      workingDir: "/work/repo-a-team-1",
    });

    expect(actual).toStrictEqual(["/Users/rocky/v", "/Users/rocky/v/.tasks"]);
  });

  it("resolves relative todo paths against the worker cwd", () => {
    const actual = taskSourceWritePathsForCompletion({
      config: configWithSources([todoSource({ name: "todo" })]),
      taskId: "todo:gc-1",
      workingDir: "/work/repo-a-team-1",
    });

    expect(actual).toStrictEqual(["/work/repo-a-team-1", "/work/repo-a-team-1/.tasks"]);
  });

  it("uses the default todo source name when filtering before full parsing", () => {
    const source = todoSource({
      todoPath: "/Users/rocky/v/todo.md",
      tasksDir: "/Users/rocky/v/.tasks",
    });
    Reflect.deleteProperty(source, "name");

    const actual = taskSourceWritePathsForCompletion({
      config: configWithSources([source]),
      taskId: "todo:gc-1",
      workingDir: "/work/repo-a-team-1",
    });

    expect(actual).toStrictEqual(["/Users/rocky/v", "/Users/rocky/v/.tasks"]);
  });

  it("grants all todo sources when the completion task id is not source-qualified", () => {
    const actual = taskSourceWritePathsForCompletion({
      config: configWithSources([
        todoSource({ name: "todo", todoPath: "/tasks/a/todo.txt", tasksDir: "/tasks/a" }),
        todoSource({ name: "other", todoPath: "/tasks/b/todo.txt", tasksDir: "/tasks/b" }),
      ]),
      taskId: "gc-1",
      workingDir: "/work/repo-a-team-1",
    });

    expect(actual).toStrictEqual(["/tasks/a", "/tasks/b"]);
  });

  it("ignores disabled and non-todo sources", () => {
    const actual = taskSourceWritePathsForCompletion({
      config: configWithSources([{ kind: "linear", enabled: false }]),
      taskId: "gc-1",
      workingDir: "/work/repo-a-team-1",
    });

    expect(actual).toStrictEqual([]);
  });
});

describe("taskSourceWritePathsForCompletion (shell sources)", () => {
  it("grants a shell source's sandboxWritePaths for a matching task id", () => {
    const actual = taskSourceWritePathsForCompletion({
      config: configWithSources([shellSource()]),
      taskId: "plankeeper:PLN-1",
      workingDir: "/work/repo-a-team-1",
    });

    expect(actual).toStrictEqual(["/Users/rocky/plans"]);
  });

  it("resolves relative sandboxWritePaths against the worker cwd", () => {
    const actual = taskSourceWritePathsForCompletion({
      config: configWithSources([shellSource({ sandboxWritePaths: ["plans"] })]),
      taskId: "plankeeper:PLN-1",
      workingDir: "/work/repo-a-team-1",
    });

    expect(actual).toStrictEqual(["/work/repo-a-team-1/plans"]);
  });

  it("returns nothing for a shell source with no sandboxWritePaths", () => {
    const source = shellSource();
    Reflect.deleteProperty(source, "sandboxWritePaths");

    const actual = taskSourceWritePathsForCompletion({
      config: configWithSources([source]),
      taskId: "plankeeper:PLN-1",
      workingDir: "/work/repo-a-team-1",
    });

    expect(actual).toStrictEqual([]);
  });

  it("does not grant a shell source's paths to a different source's task", () => {
    const actual = taskSourceWritePathsForCompletion({
      config: configWithSources([shellSource({ name: "plankeeper" })]),
      taskId: "todo:gc-1",
      workingDir: "/work/repo-a-team-1",
    });

    expect(actual).toStrictEqual([]);
  });

  it("grants every shell source's paths when the task id is not source-qualified", () => {
    const actual = taskSourceWritePathsForCompletion({
      config: configWithSources([
        shellSource({ name: "plankeeper", sandboxWritePaths: ["/plans/a"] }),
        shellSource({ name: "jira", sandboxWritePaths: ["/plans/b"] }),
      ]),
      taskId: "gc-1",
      workingDir: "/work/repo-a-team-1",
    });

    expect(actual).toStrictEqual(["/plans/a", "/plans/b"]);
  });
});
