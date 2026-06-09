import { buildSources, sourcesFromConfig } from "../lib/buildSources.ts";
import { loadConfig, type ResolvedConfig } from "../lib/config.ts";
import { naturalIdFromCanonical, type TaskSource, type Issue } from "../lib/taskSource.ts";
import { captureConsoleLog } from "../testHelpers/consoleCapture.ts";

import { taskCli } from "./task.ts";

vi.mock(import("../lib/config.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    loadConfig: vi.fn<typeof loadConfig>(),
  };
});

vi.mock(import("../lib/buildSources.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    buildSources: vi.fn<typeof buildSources>(),
    sourcesFromConfig: vi.fn<typeof sourcesFromConfig>(),
  };
});

const loadConfigMock = vi.mocked(loadConfig);
const buildSourcesMock = vi.mocked(buildSources);
const sourcesFromConfigMock = vi.mocked(sourcesFromConfig);

function makeConfig(): ResolvedConfig {
  return {
    sources: [],
    defaults: { hooks: {} },
    git: { remote: "origin", defaultBranch: "main" },
    workspace: { projectDir: "/work", knownRepositories: ["repo-a"] },
    orchestrator: {
      maximumInProgress: 4,
      pollIntervalMilliseconds: 1000,
      sessionLimitPercentage: 85,
    },
    models: {
      default: "claude",
      definitions: {
        claude: { cmd: "safehouse claude --permission-mode auto", color: "#fff" },
      },
    },
    prompts: { initial: "x" },
    workspaceKind: "auto",
    local: { runner: "auto" },
    logging: { file: "/tmp/groundcrew-test.log" },
  };
}

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "todo:gc-1",
    source: "todo",
    title: "Fix retry race",
    description: "Investigate cancellation retries.",
    status: "todo",
    repository: "ClipboardHealth/api",
    model: "codex",
    assignee: "",
    updatedAt: "2026-06-08T12:00:00.000Z",
    blockers: [],
    hasMoreBlockers: false,
    sourceRef: {},
    ...overrides,
  };
}

function stubSource(
  name: string,
  issues: readonly Issue[],
  overrides: Partial<TaskSource> = {},
): TaskSource {
  const getTask = vi.fn<TaskSource["getTask"]>().mockImplementation(async (id) => {
    const match = issues.find(
      (issue) => naturalIdFromCanonical(issue.id).toLowerCase() === id.toLowerCase(),
    );
    return match ?? null;
  });
  return {
    name,
    verify: vi.fn<TaskSource["verify"]>(),
    listTasks: vi.fn<TaskSource["listTasks"]>().mockResolvedValue([...issues]),
    getTask,
    fetch: vi.fn<TaskSource["fetch"]>(),
    resolveOne: vi.fn<TaskSource["resolveOne"]>(),
    markInProgress: vi.fn<TaskSource["markInProgress"]>(),
    markInReview: vi.fn<TaskSource["markInReview"]>(),
    ...overrides,
  };
}

describe("crew task list", () => {
  beforeEach(() => {
    loadConfigMock.mockResolvedValue(makeConfig());
    sourcesFromConfigMock.mockReturnValue([{ kind: "todo-txt", name: "todo" }]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("lists tasks from only the named source when --source is provided", async () => {
    const todo = stubSource("todo", [makeIssue()]);
    const linear = stubSource("linear", [makeIssue({ id: "linear:eng-1", source: "linear" })]);
    buildSourcesMock.mockResolvedValue([todo, linear]);

    const log = captureConsoleLog();
    try {
      await taskCli(["list", "--source", "todo"]);
    } finally {
      log.restore();
    }

    expect(todo.listTasks).toHaveBeenCalledTimes(1);
    expect(linear.listTasks).not.toHaveBeenCalled();
    expect(log.output()).toContain("todo:gc-1");
    expect(log.output()).toContain("Fix retry race");
    expect(log.output()).not.toContain("linear:eng-1");
  });

  it("applies list filters and prints normalized JSON without sourceRef", async () => {
    const todo = stubSource("todo", [
      makeIssue({ id: "todo:gc-1" }),
      makeIssue({
        id: "todo:gc-2",
        blockers: [{ id: "todo:dep-1", title: "Dependency", status: "todo" }],
      }),
      makeIssue({ id: "todo:gc-3", status: "in-progress" }),
    ]);
    buildSourcesMock.mockResolvedValue([todo]);

    const log = captureConsoleLog();
    try {
      await taskCli([
        "list",
        "--status",
        "todo",
        "--agent",
        "codex",
        "--repo",
        "ClipboardHealth/api",
        "--unblocked",
        "--limit",
        "1",
        "--json",
      ]);
    } finally {
      log.restore();
    }

    expect(log.output()).toContain('"id": "todo:gc-1"');
    expect(log.output()).not.toContain("todo:gc-2");
    expect(log.output()).not.toContain("sourceRef");
  });

  it("filters blocked tasks and renders table fallbacks for missing agent and repository", async () => {
    const todo = stubSource("todo", [
      makeIssue({
        id: "todo:gc-2",
        model: undefined,
        repository: undefined,
        blockers: [{ id: "todo:dep-1", title: "Dependency", status: "todo" }],
      }),
      makeIssue({ id: "todo:gc-3" }),
    ]);
    buildSourcesMock.mockResolvedValue([todo]);

    const log = captureConsoleLog();
    try {
      await taskCli(["list", "--blocked"]);
    } finally {
      log.restore();
    }

    expect(log.output()).toContain("todo:gc-2");
    expect(log.output()).toContain("yes");
    expect(log.output()).toContain("-");
    expect(log.output()).not.toContain("todo:gc-3");
  });

  it("prints no tasks when filters remove every task", async () => {
    const todo = stubSource("todo", [makeIssue()]);
    buildSourcesMock.mockResolvedValue([todo]);

    const log = captureConsoleLog();
    try {
      await taskCli(["list", "--status", "done"]);
    } finally {
      log.restore();
    }

    expect(log.output()).toBe("(no tasks)");
  });

  it("fails when a named list source is not configured", async () => {
    buildSourcesMock.mockResolvedValue([stubSource("todo", [])]);

    await expect(taskCli(["list", "--source", "missing"])).rejects.toThrow(/no source named/);
  });

  it.each([
    { argv: ["list", "--limit", "0"], message: "--limit must be a positive integer" },
    { argv: ["list", "--status", "bogus"], message: "unknown status" },
    { argv: ["list", "--blocked", "--unblocked"], message: "mutually exclusive" },
    { argv: ["list", "--source"], message: "requires a value" },
    { argv: ["list", "--bogus"], message: "unknown argument" },
  ])("rejects invalid list arguments: $argv", async ({ argv, message }) => {
    await expect(taskCli(argv)).rejects.toThrow(message);
  });
});

describe("crew task get", () => {
  beforeEach(() => {
    loadConfigMock.mockResolvedValue(makeConfig());
    sourcesFromConfigMock.mockReturnValue([{ kind: "todo-txt", name: "todo" }]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("routes a canonical id directly to its source and prints only the prompt with --prompt", async () => {
    const todo = stubSource("todo", [makeIssue({ description: "Prompt body\n" })]);
    const linear = stubSource("linear", [makeIssue({ id: "linear:gc-1", source: "linear" })]);
    buildSourcesMock.mockResolvedValue([todo, linear]);

    const log = captureConsoleLog();
    try {
      await taskCli(["get", "todo:GC-1", "--prompt"]);
    } finally {
      log.restore();
    }

    expect(todo.getTask).toHaveBeenCalledWith("GC-1");
    expect(linear.getTask).not.toHaveBeenCalled();
    expect(log.output()).toBe("Prompt body\n");
  });

  it("resolves a source-native id with --source and prints task details by default", async () => {
    const todo = stubSource("todo", [
      makeIssue({
        url: "https://example.test/task/gc-1",
        blockers: [{ id: "todo:dep-1", title: "Dependency", status: "todo" }],
      }),
    ]);
    buildSourcesMock.mockResolvedValue([todo]);

    const log = captureConsoleLog();
    try {
      await taskCli(["get", "GC-1", "--source", "todo"]);
    } finally {
      log.restore();
    }

    expect(log.output()).toContain("todo:gc-1");
    expect(log.output()).toContain("repo: ClipboardHealth/api");
    expect(log.output()).toContain("agent: codex");
    expect(log.output()).toContain("url: https://example.test/task/gc-1");
    expect(log.output()).toContain("blockers: dep-1(todo)");
    expect(log.output()).toContain("Investigate cancellation retries.");
  });

  it("omits optional task details when the source does not provide them", async () => {
    const todo = stubSource("todo", [
      makeIssue({
        repository: undefined,
        model: undefined,
        description: "",
      }),
    ]);
    buildSourcesMock.mockResolvedValue([todo]);

    const log = captureConsoleLog();
    try {
      await taskCli(["get", "GC-1", "--source", "todo"]);
    } finally {
      log.restore();
    }

    expect(log.output()).toContain("todo:gc-1");
    expect(log.output()).not.toContain("repo:");
    expect(log.output()).not.toContain("agent:");
    expect(log.output()).not.toContain("url:");
    expect(log.output()).not.toContain("blockers:");
    expect(log.output()).not.toContain("Investigate cancellation retries.");
  });

  it("prints one task as normalized JSON", async () => {
    const todo = stubSource("todo", [makeIssue({ priority: 1 })]);
    buildSourcesMock.mockResolvedValue([todo]);

    const log = captureConsoleLog();
    try {
      await taskCli(["get", "GC-1", "--source", "todo", "--json"]);
    } finally {
      log.restore();
    }

    expect(log.output()).toContain('"priority": 1');
    expect(log.output()).not.toContain("sourceRef");
  });

  it("resolves a natural id when exactly one source matches", async () => {
    const todo = stubSource("todo", []);
    const linear = stubSource("linear", [makeIssue({ id: "linear:gc-1", source: "linear" })]);
    buildSourcesMock.mockResolvedValue([todo, linear]);

    const log = captureConsoleLog();
    try {
      await taskCli(["get", "GC-1", "--prompt"]);
    } finally {
      log.restore();
    }

    expect(todo.getTask).toHaveBeenCalledWith("GC-1");
    expect(linear.getTask).toHaveBeenCalledWith("GC-1");
    expect(log.output()).toBe("Investigate cancellation retries.");
  });

  it("fails natural id lookup when multiple sources match", async () => {
    const todo = stubSource("todo", [makeIssue()]);
    const linear = stubSource("linear", [makeIssue({ id: "linear:gc-1", source: "linear" })]);
    buildSourcesMock.mockResolvedValue([todo, linear]);

    await expect(taskCli(["get", "GC-1"])).rejects.toThrow(/matched multiple sources/);
  });

  it("fails natural id lookup when no source matches", async () => {
    buildSourcesMock.mockResolvedValue([stubSource("todo", [])]);

    await expect(taskCli(["get", "GC-404"])).rejects.toThrow(/not found across configured sources/);
  });

  it("surfaces source lookup errors when no source matches", async () => {
    const todo = stubSource("todo", [], {
      getTask: vi.fn<TaskSource["getTask"]>().mockRejectedValue(new Error("source offline")),
    });
    buildSourcesMock.mockResolvedValue([todo]);

    await expect(taskCli(["get", "GC-1"])).rejects.toThrow("source offline");
  });

  it.each([
    { argv: ["get"], message: "Usage: crew task get" },
    { argv: ["get", "GC-1", "--json", "--prompt"], message: "mutually exclusive" },
    { argv: ["get", "GC-1", "--bogus"], message: "unknown option" },
    { argv: ["get", "todo:"], message: "invalid canonical" },
    { argv: ["get", "todo:GC-1", "--source", "linear"], message: "already names source" },
  ])("rejects invalid get arguments: $argv", async ({ argv, message }) => {
    buildSourcesMock.mockResolvedValue([stubSource("todo", [makeIssue()])]);

    await expect(taskCli(argv)).rejects.toThrow(message);
  });

  it("fails source-specific lookup when the source does not have the task", async () => {
    buildSourcesMock.mockResolvedValue([stubSource("todo", [])]);

    await expect(taskCli(["get", "GC-1", "--source", "todo"])).rejects.toThrow(
      /not found in source/,
    );
  });

  it("fails canonical lookup when the source does not have the task", async () => {
    buildSourcesMock.mockResolvedValue([stubSource("todo", [])]);

    await expect(taskCli(["get", "todo:GC-1"])).rejects.toThrow(/not found in source/);
  });
});

describe("crew task create", () => {
  beforeEach(() => {
    loadConfigMock.mockResolvedValue(makeConfig());
    sourcesFromConfigMock.mockReturnValue([{ kind: "todo-txt", name: "todo" }]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("creates in the named source and prints the canonical id", async () => {
    const created = makeIssue({ id: "todo:gc-20260608-001" });
    const createTask = vi.fn<NonNullable<TaskSource["createTask"]>>().mockResolvedValue(created);
    const todo = stubSource("todo", [], { createTask });
    buildSourcesMock.mockResolvedValue([todo]);

    const log = captureConsoleLog();
    try {
      await taskCli([
        "create",
        "Fix cancellation retry race",
        "--source",
        "todo",
        "--agent",
        "codex",
        "--repo",
        "ClipboardHealth/api",
        "--team",
        "ENG",
        "--project",
        "marketplace",
        "--context",
        "backend",
        "--description",
        "Prompt body",
      ]);
    } finally {
      log.restore();
    }

    expect(createTask).toHaveBeenCalledWith({
      title: "Fix cancellation retry race",
      agent: "codex",
      repository: "ClipboardHealth/api",
      team: "ENG",
      projects: ["marketplace"],
      contexts: ["backend"],
      dependencies: [],
      description: "Prompt body",
      edit: false,
    });
    expect(log.output()).toBe("todo:gc-20260608-001");
  });

  it("forwards every create option and prints created task JSON", async () => {
    const created = makeIssue({ id: "todo:custom-1", priority: 2, url: "https://example.test/t" });
    const createTask = vi.fn<NonNullable<TaskSource["createTask"]>>().mockResolvedValue(created);
    const todo = stubSource("todo", [], { createTask });
    buildSourcesMock.mockResolvedValue([todo]);

    const log = captureConsoleLog();
    try {
      await taskCli([
        "create",
        "Full option task",
        "--source",
        "todo",
        "--agent",
        "claude",
        "--id",
        "CUSTOM-1",
        "--priority",
        "B",
        "--dep",
        "DEP-1",
        "--due",
        "2026-06-09",
        "--rec",
        "+1w",
        "--prompt-file",
        "/tmp/prompt.md",
        "--edit",
        "--json",
      ]);
    } finally {
      log.restore();
    }

    expect(createTask).toHaveBeenCalledWith({
      title: "Full option task",
      agent: "claude",
      id: "CUSTOM-1",
      priority: "B",
      projects: [],
      contexts: [],
      dependencies: ["DEP-1"],
      due: "2026-06-09",
      recurrence: "+1w",
      promptFile: "/tmp/prompt.md",
      edit: true,
    });
    expect(log.output()).toContain('"id": "todo:custom-1"');
    expect(log.output()).toContain('"url": "https://example.test/t"');
    expect(log.output()).not.toContain("sourceRef");
  });

  it("defaults omitted create agent to any", async () => {
    const created = makeIssue({ id: "todo:any-1" });
    const createTask = vi.fn<NonNullable<TaskSource["createTask"]>>().mockResolvedValue(created);
    const todo = stubSource("todo", [], { createTask });
    buildSourcesMock.mockResolvedValue([todo]);

    const log = captureConsoleLog();
    try {
      await taskCli(["create", "Default agent", "--source", "todo"]);
    } finally {
      log.restore();
    }

    expect(createTask).toHaveBeenCalledWith({
      title: "Default agent",
      agent: "any",
      projects: [],
      contexts: [],
      dependencies: [],
      edit: false,
    });
    expect(log.output()).toBe("todo:any-1");
  });

  it("fails when the source does not support creation", async () => {
    buildSourcesMock.mockResolvedValue([stubSource("todo", [])]);

    await expect(
      taskCli(["create", "No support", "--source", "todo", "--agent", "codex"]),
    ).rejects.toThrow(/does not support task creation/);
  });

  it.each([
    { argv: ["create"], message: "Quote multi-word titles" },
    { argv: ["create", "Missing source", "--agent", "codex"], message: "--source is required" },
    {
      argv: ["create", "Unknown option", "--source", "todo", "--agent", "codex", "--bogus"],
      message: "unknown option",
    },
    {
      argv: ["create", "Missing value", "--source", "todo", "--agent"],
      message: "requires a value",
    },
  ])("rejects invalid create arguments: $argv", async ({ argv, message }) => {
    await expect(taskCli(argv)).rejects.toThrow(message);
  });
});

describe("crew task dispatch", () => {
  it("throws usage for unknown task subcommands", async () => {
    await expect(taskCli(["ready"])).rejects.toThrow("Usage: crew task");
  });
});

describe("crew task validate", () => {
  beforeEach(() => {
    process.exitCode = undefined;
    loadConfigMock.mockResolvedValue(makeConfig());
    sourcesFromConfigMock.mockReturnValue([{ kind: "todo-txt", name: "todo" }]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shows ok when validate returns no errors", async () => {
    const validate = vi.fn<NonNullable<TaskSource["validate"]>>().mockResolvedValue([]);
    buildSourcesMock.mockResolvedValue([stubSource("todo", [], { validate })]);

    const log = captureConsoleLog();
    try {
      await taskCli(["validate"]);
    } finally {
      log.restore();
    }

    expect(log.output()).toContain("ok");
    expect(process.exitCode).not.toBe(1);
  });

  it("shows errors and sets exit code 1 when validate returns errors", async () => {
    const validate = vi
      .fn<NonNullable<TaskSource["validate"]>>()
      .mockResolvedValue(['line 1: duplicate id "GC-1"', 'line 5: malformed due: date "bad"']);
    buildSourcesMock.mockResolvedValue([stubSource("todo", [], { validate })]);

    const log = captureConsoleLog();
    try {
      await taskCli(["validate"]);
    } finally {
      log.restore();
    }

    expect(log.output()).toContain("2 error(s)");
    expect(log.output()).toContain('duplicate id "GC-1"');
    expect(log.output()).toContain('malformed due: date "bad"');
    expect(process.exitCode).toBe(1);
  });

  it("shows not supported for sources without validate()", async () => {
    buildSourcesMock.mockResolvedValue([stubSource("todo", [])]);

    const log = captureConsoleLog();
    try {
      await taskCli(["validate"]);
    } finally {
      log.restore();
    }

    expect(log.output()).toContain("not supported");
    expect(process.exitCode).not.toBe(1);
  });

  it("outputs JSON with supported:true and empty errors when validate passes", async () => {
    const validate = vi.fn<NonNullable<TaskSource["validate"]>>().mockResolvedValue([]);
    buildSourcesMock.mockResolvedValue([stubSource("todo", [], { validate })]);

    const log = captureConsoleLog();
    try {
      await taskCli(["validate", "--json"]);
    } finally {
      log.restore();
    }

    const output = log.output();
    expect(output).toContain('"source": "todo"');
    expect(output).toContain('"supported": true');
    expect(output).toContain('"errors": []');
    expect(process.exitCode).not.toBe(1);
  });

  it("outputs JSON with supported:false for sources without validate()", async () => {
    buildSourcesMock.mockResolvedValue([stubSource("todo", [])]);

    const log = captureConsoleLog();
    try {
      await taskCli(["validate", "--json"]);
    } finally {
      log.restore();
    }

    const output = log.output();
    expect(output).toContain('"source": "todo"');
    expect(output).toContain('"supported": false');
    expect(output).toContain('"errors": []');
    expect(process.exitCode).not.toBe(1);
  });

  it("outputs JSON with --json flag and sets exit code 1 when errors present", async () => {
    const validate = vi
      .fn<NonNullable<TaskSource["validate"]>>()
      .mockResolvedValue(['line 1: duplicate id "X"']);
    buildSourcesMock.mockResolvedValue([stubSource("todo", [], { validate })]);

    const log = captureConsoleLog();
    try {
      await taskCli(["validate", "--json"]);
    } finally {
      log.restore();
    }

    const output = log.output();
    expect(output).toContain('"source": "todo"');
    expect(output).toContain('"supported": true');
    expect(output).toContain("duplicate id");
    expect(process.exitCode).toBe(1);
  });

  it("filters to the named source only", async () => {
    const validateTodo = vi.fn<NonNullable<TaskSource["validate"]>>().mockResolvedValue([]);
    const validateLinear = vi.fn<NonNullable<TaskSource["validate"]>>().mockResolvedValue([]);
    buildSourcesMock.mockResolvedValue([
      stubSource("todo", [], { validate: validateTodo }),
      stubSource("linear", [], { validate: validateLinear }),
    ]);

    const log = captureConsoleLog();
    try {
      await taskCli(["validate", "todo"]);
    } finally {
      log.restore();
    }

    expect(validateTodo).toHaveBeenCalledTimes(1);
    expect(validateLinear).not.toHaveBeenCalled();
    expect(log.output()).toContain("todo");
    expect(log.output()).not.toContain("linear");
  });

  it("throws when the named source is not found", async () => {
    buildSourcesMock.mockResolvedValue([stubSource("todo", [])]);

    await expect(taskCli(["validate", "missing"])).rejects.toThrow('no source named "missing"');
  });

  it.each([
    { argv: ["validate", "--bogus"], message: "unknown option: --bogus" },
    { argv: ["validate", "a", "b"], message: "too many arguments" },
  ])("rejects invalid validate arguments: $argv", async ({ argv, message }) => {
    await expect(taskCli(argv)).rejects.toThrow(message);
  });
});
