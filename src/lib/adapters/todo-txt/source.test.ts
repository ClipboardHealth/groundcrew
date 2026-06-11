import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { AdapterContext } from "../../adapterDefinition.ts";
import type { ResolvedConfig } from "../../config.ts";
import type { Issue } from "../../taskSource.ts";
import { createTodoTxtTaskSource } from "./source.ts";
import type { TodoTxtSourceRef } from "./normalizer.ts";

function makeAdapterContext(options: {
  defaultAgent: string;
  definitions: ResolvedConfig["agents"]["definitions"];
}): AdapterContext {
  const { defaultAgent, definitions } = options;
  return {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- partial config sufficient for source tests
    globalConfig: {
      agents: { default: defaultAgent, definitions },
    } as unknown as ResolvedConfig,
  };
}

const fakeContext = makeAdapterContext({
  defaultAgent: "codex",
  definitions: {
    claude: { cmd: "claude", color: "#fff" },
    codex: { cmd: "codex", color: "#3267e3" },
  },
});

const contextWithAgents = makeAdapterContext({
  defaultAgent: "claude",
  definitions: { claude: { cmd: "claude", color: "#fff" } },
});

function makeSourceWithAgents(tmp: TempDir): ReturnType<typeof createTodoTxtTaskSource> {
  return createTodoTxtTaskSource(
    {
      kind: "todo-txt",
      name: "todo",
      todoPath: tmp.todoPath,
      tasksDir: tmp.tasksDir,
      idPrefix: "GC",
      timezone: "UTC",
    },
    contextWithAgents,
  );
}

interface TempDir {
  dir: string;
  todoPath: string;
  tasksDir: string;
  writeTodo: (content: string) => void;
  writeTask: (id: string, content: string) => void;
  cleanup: () => void;
}

function makeTempDir(): TempDir {
  const dir = mkdtempSync(path.join(tmpdir(), "todo-txt-test-"));
  const todoPath = path.join(dir, "todo.txt");
  const tasksDir = path.join(dir, ".tasks");
  mkdirSync(tasksDir, { recursive: true });

  return {
    dir,
    todoPath,
    tasksDir,
    writeTodo(content: string): void {
      writeFileSync(todoPath, content, "utf8");
    },
    writeTask(id: string, content: string): void {
      writeFileSync(path.join(tasksDir, `${id}.md`), content, "utf8");
    },
    cleanup(): void {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function makeSource(tmp: TempDir, defaultRepository?: string) {
  return createTodoTxtTaskSource(
    {
      kind: "todo-txt",
      name: "todo",
      todoPath: tmp.todoPath,
      tasksDir: tmp.tasksDir,
      defaultRepository,
      idPrefix: "GC",
      timezone: "UTC",
    },
    fakeContext,
  );
}

function sourceRef(issue: Issue): TodoTxtSourceRef {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- tests read the sourceRef shape
  return issue.sourceRef as TodoTxtSourceRef;
}

function assertDefined<T>(v: T | undefined | null, label = "value"): T {
  if (v === null || v === undefined) {
    throw new TypeError(`Expected ${label} to be defined`);
  }
  return v;
}

describe("TodoTxtTaskSource", () => {
  let tmp: TempDir;

  beforeEach(() => {
    process.exitCode = undefined;
    tmp = makeTempDir();
  });

  afterEach(() => {
    tmp.cleanup();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  // Test 1: Parse minimal ready task
  it("parses a minimal ready task", async () => {
    tmp.writeTodo(
      "(A) Fix cancellation retry race +marketplace @backend id:GC-001 agent:codex status:todo\n",
    );
    tmp.writeTask("GC-001", "Fix the retry race condition.");

    const source = makeSource(tmp);
    const issues = await source.fetch();

    expect(issues).toHaveLength(1);
    const [issue] = issues;
    expect(issue?.id).toBe("todo:gc-001");
    expect(issue?.title).toBe("Fix cancellation retry race");
    expect(issue?.status).toBe("todo");
    expect(issue?.agent).toBe("codex");
  });

  it("creates a ready todo task with a prompt file", async () => {
    tmp.writeTodo("");

    const source = makeSource(tmp);
    const created = await source.createTask?.({
      title: "Fix cancellation retry race",
      agent: "codex",
      repository: "ClipboardHealth/api",
      id: "GC-20260608-001",
      projects: ["marketplace"],
      contexts: ["backend"],
      dependencies: [],
      description: "Investigate retry handling.",
      edit: false,
    });

    expect(created?.id).toBe("todo:gc-20260608-001");
    expect(readFileSync(tmp.todoPath, "utf8")).toBe(
      "(A) Fix cancellation retry race +marketplace @backend id:GC-20260608-001 repo:ClipboardHealth/api agent:codex status:todo\n",
    );
    expect(readFileSync(path.join(tmp.tasksDir, "GC-20260608-001.md"), "utf8")).toBe(
      "Investigate retry handling.\n",
    );
  });

  it("generates the next dated id and separates from an unterminated todo file", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-08T12:00:00.000Z"));
    tmp.writeTodo(
      "\nTask outside sequence id:OTHER-1 agent:codex status:todo\nNo id task agent:codex status:todo\nNonnumeric sequence id:GC-20260608-ABC agent:codex status:todo\nExisting task id:GC-20260608-001 agent:codex status:todo\nLower sequence id:GC-20260608-000 agent:codex status:todo",
    );

    const source = makeSource(tmp);
    const created = await source.createTask?.({
      title: "Generated task",
      agent: "codex",
      projects: [],
      contexts: [],
      dependencies: [],
      edit: false,
    });

    expect(created?.id).toBe("todo:gc-20260608-002");
    expect(readFileSync(tmp.todoPath, "utf8")).toContain(
      "\n(A) Generated task id:GC-20260608-002 agent:codex status:todo\n",
    );
    expect(readFileSync(path.join(tmp.tasksDir, "GC-20260608-002.md"), "utf8")).toBe(
      "Generated task\n",
    );
  });

  it("copies prompt-file content and accepts prefixed project/context names", async () => {
    const promptFile = path.join(tmp.dir, "prompt.md");
    writeFileSync(promptFile, "Existing prompt.\n", "utf8");
    tmp.writeTodo("");

    const source = makeSource(tmp);
    await source.createTask?.({
      title: "Prompt file task",
      agent: "claude",
      id: "PROMPT-1",
      priority: "C",
      projects: ["+marketplace"],
      contexts: ["@backend"],
      dependencies: ["DEP-1"],
      due: "2026-06-09",
      recurrence: "+1w",
      promptFile,
      edit: false,
    });

    expect(readFileSync(tmp.todoPath, "utf8")).toBe(
      "(C) Prompt file task +marketplace @backend id:PROMPT-1 agent:claude dep:DEP-1 due:2026-06-09 rec:+1w status:todo\n",
    );
    expect(readFileSync(path.join(tmp.tasksDir, "PROMPT-1.md"), "utf8")).toBe("Existing prompt.\n");
  });

  it("createTask accepts hourly recurrence", async () => {
    tmp.writeTodo("");

    const source = makeSource(tmp);
    await source.createTask?.({
      title: "Hourly sweep",
      agent: "claude",
      id: "SWEEP-1",
      projects: [],
      contexts: [],
      dependencies: [],
      edit: false,
      recurrence: "2h",
    });

    expect(readFileSync(tmp.todoPath, "utf8")).toContain("rec:2h status:todo");
  });

  it("creates the todo file when it does not exist", async () => {
    const source = makeSource(tmp);

    await source.createTask?.({
      title: "No existing todo",
      agent: "codex",
      id: "NO-FILE-1",
      projects: [],
      contexts: [],
      dependencies: [],
      edit: false,
    });

    expect(readFileSync(tmp.todoPath, "utf8")).toBe(
      "(A) No existing todo id:NO-FILE-1 agent:codex status:todo\n",
    );
    expect(readFileSync(path.join(tmp.tasksDir, "NO-FILE-1.md"), "utf8")).toBe(
      "No existing todo\n",
    );
  });

  it("rethrows unexpected todo file read errors while creating a task", async () => {
    mkdirSync(tmp.todoPath);
    const source = makeSource(tmp);

    await expect(
      source.createTask?.({
        title: "Directory todo path",
        agent: "codex",
        id: "DIR-TODO",
        projects: [],
        contexts: [],
        dependencies: [],
        edit: false,
      }),
    ).rejects.toThrow(/EISDIR|illegal operation|is a directory/);
  });

  it.each([
    {
      name: "duplicate id",
      existing: "id:DUP-1 agent:codex status:todo Existing\n",
      input: { title: "Duplicate", agent: "codex", id: "DUP-1" },
      message: "already exists",
    },
    {
      name: "empty title",
      existing: "",
      input: { title: "   ", agent: "codex", id: "EMPTY-TITLE" },
      message: "title is required",
    },
    {
      name: "multiline title",
      existing: "",
      input: { title: "Line one\nLine two", agent: "codex", id: "MULTILINE-TITLE" },
      message: "single line",
    },
    {
      name: "path-like id",
      existing: "",
      input: { title: "Bad id", agent: "codex", id: "../outside" },
      message: "filename-safe",
    },
    {
      name: "bad priority",
      existing: "",
      input: { title: "Bad priority", agent: "codex", id: "BAD-PRI", priority: "AA" },
      message: "priority",
    },
    {
      name: "bad project token",
      existing: "",
      input: { title: "Bad project", agent: "codex", id: "BAD-PROJ", projects: ["bad token"] },
      message: "project",
    },
    {
      name: "bad due date",
      existing: "",
      input: { title: "Bad due", agent: "codex", id: "BAD-DUE", due: "tomorrow" },
      message: "due date",
    },
    {
      name: "bad recurrence",
      existing: "",
      input: { title: "Bad rec", agent: "codex", id: "BAD-REC", recurrence: "weekly" },
      message: "recurrence",
    },
    {
      name: "prompt file and description",
      existing: "",
      input: {
        title: "Too many prompts",
        agent: "codex",
        id: "PROMPT-CONFLICT",
        promptFile: "prompt.md",
        description: "Prompt",
      },
      message: "mutually exclusive",
    },
  ])("rejects invalid create input: $name", async ({ existing, input, message }) => {
    tmp.writeTodo(existing);
    const source = makeSource(tmp);

    await expect(
      source.createTask?.({
        projects: [],
        contexts: [],
        dependencies: [],
        edit: false,
        ...input,
      }),
    ).rejects.toThrow(message);
  });

  it("opens the editor when edit is requested", async () => {
    vi.stubEnv("VISUAL", "true");
    vi.stubEnv("EDITOR", "true");
    tmp.writeTodo("");

    const source = makeSource(tmp);
    await expect(
      source.createTask?.({
        title: "Edit task",
        agent: "codex",
        id: "EDIT-1",
        projects: [],
        contexts: [],
        dependencies: [],
        edit: true,
      }),
    ).resolves.toMatchObject({ id: "todo:edit-1" });
  });

  it("falls back to EDITOR when VISUAL is unset", async () => {
    vi.stubEnv("VISUAL", "");
    vi.stubEnv("EDITOR", "true");
    tmp.writeTodo("");

    const source = makeSource(tmp);
    await expect(
      source.createTask?.({
        title: "Editor fallback",
        agent: "codex",
        id: "EDITOR-FALLBACK",
        projects: [],
        contexts: [],
        dependencies: [],
        edit: true,
      }),
    ).resolves.toMatchObject({ id: "todo:editor-fallback" });
  });

  it("fails edit when no editor is configured", async () => {
    vi.stubEnv("VISUAL", "");
    vi.stubEnv("EDITOR", "");
    tmp.writeTodo("");

    const source = makeSource(tmp);
    await expect(
      source.createTask?.({
        title: "No editor",
        agent: "codex",
        id: "NO-EDITOR",
        projects: [],
        contexts: [],
        dependencies: [],
        edit: true,
      }),
    ).rejects.toThrow("requires VISUAL or EDITOR");
  });

  it("fails edit when the editor exits nonzero", async () => {
    vi.stubEnv("VISUAL", "false");
    vi.stubEnv("EDITOR", "false");
    tmp.writeTodo("");

    const source = makeSource(tmp);
    await expect(
      source.createTask?.({
        title: "Editor fails",
        agent: "codex",
        id: "EDITOR-FAIL",
        projects: [],
        contexts: [],
        dependencies: [],
        edit: true,
      }),
    ).rejects.toThrow("editor exited");
  });

  it("exposes listTasks and getTask task methods", async () => {
    tmp.writeTodo("Alias task id:ALIAS-1 agent:codex status:todo\n");
    tmp.writeTask("ALIAS-1", "Alias prompt.");

    const source = makeSource(tmp);
    const listed = await source.listTasks();
    const fetched = await source.getTask("ALIAS-1");

    expect(listed[0]?.id).toBe("todo:alias-1");
    expect(fetched?.description).toBe("Alias prompt.");
  });

  it("getTask returns null when a no-id line matches an empty natural id defensively", async () => {
    tmp.writeTodo("No id line agent:codex status:todo\n");

    const source = makeSource(tmp);

    await expect(source.getTask("")).resolves.toBeNull();
  });

  // Test 2: Ignore draft task with no status:todo
  it("ignores draft task with no status field", async () => {
    tmp.writeTodo("(A) Draft task +foo id:GC-002 agent:codex\n");

    const source = makeSource(tmp);
    const issues = await source.fetch();

    expect(issues).toHaveLength(0);
  });

  // Test 3: Do not dispatch task where status:todo is not final token
  it("maps status:todo (not final token) to status other", async () => {
    tmp.writeTodo("(A) Task with extra token id:GC-003 agent:codex status:todo extra-token\n");

    const source = makeSource(tmp);
    const issues = await source.fetch();

    expect(issues).toHaveLength(1);
    expect(issues[0]?.status).toBe("other");
  });

  // Test 4: Read .tasks/<id>.md into description
  it("reads .tasks/<id>.md into task description", async () => {
    tmp.writeTodo("(A) My task id:GC-004 agent:claude status:todo\n");
    tmp.writeTask("GC-004", "# Detailed description\n\nDo the thing.\n");

    const source = makeSource(tmp);
    const issues = await source.fetch();

    expect(issues[0]?.description).toBe("# Detailed description\n\nDo the thing.\n");
  });

  // Test 5: Map agent:codex → agent:"codex"
  it("maps agent:codex to agent codex", async () => {
    tmp.writeTodo("id:GC-005 agent:codex status:todo Task five\n");

    const source = makeSource(tmp);
    const issues = await source.fetch();

    expect(issues[0]?.agent).toBe("codex");
  });

  // Test 6: Map agent:claude → agent:"claude"
  it("maps agent:claude to agent claude", async () => {
    tmp.writeTodo("id:GC-006 agent:claude status:todo Task six\n");

    const source = makeSource(tmp);
    const issues = await source.fetch();

    expect(issues[0]?.agent).toBe("claude");
  });

  // Test 7: Handle agent:any
  it("handles agent:any", async () => {
    tmp.writeTodo("id:GC-007 agent:any status:todo Task seven\n");

    const source = makeSource(tmp);
    const issues = await source.fetch();

    expect(issues[0]?.agent).toBe("any");
  });

  it("defaults missing agent metadata to agent-any", async () => {
    tmp.writeTodo("Task seven id:GC-007 status:todo\n");

    const source = makeSource(tmp);
    const issues = await source.fetch();

    expect(issues[0]?.agent).toBe("any");
  });

  // Test 8: Default repository from config when no repo:
  it("defaults repository from config when no repo: field", async () => {
    tmp.writeTodo("id:GC-008 agent:codex status:todo Task eight\n");

    const source = makeSource(tmp, "OrgA/repo-default");
    const issues = await source.fetch();

    expect(issues[0]?.repository).toBe("OrgA/repo-default");
  });

  // Test 9: Use repo: override when present
  it("uses repo: override from task metadata", async () => {
    tmp.writeTodo("id:GC-009 agent:codex repo:OrgB/repo-override status:todo Task nine\n");

    const source = makeSource(tmp, "OrgA/repo-default");
    const issues = await source.fetch();

    expect(issues[0]?.repository).toBe("OrgB/repo-override");
  });

  // Test 10: Emit blockers from dep:
  it("emits blockers from dep: fields", async () => {
    tmp.writeTodo(
      // title text must come before metadata so status:todo remains the final token
      "Task ten A id:GC-010a agent:codex status:todo\nTask ten B id:GC-010b agent:codex dep:GC-010a status:todo\n",
    );

    const source = makeSource(tmp);
    const issues = await source.fetch();

    const taskB = issues.find((i) => i.id === "todo:gc-010b");
    expect(taskB?.blockers).toHaveLength(1);
    expect(taskB?.blockers[0]?.id).toBe("todo:gc-010a");
    expect(taskB?.blockers[0]?.status).toBe("todo");
  });

  // Test 11: Do not dispatch task with unresolved or unfinished blocker
  it("marks task with unresolved dep as having other-status blocker", async () => {
    tmp.writeTodo("id:GC-011 agent:codex dep:MISSING-001 status:todo Task eleven\n");

    const source = makeSource(tmp);
    const issues = await source.fetch();

    const task = issues.find((i) => i.id === "todo:gc-011");
    expect(task?.blockers).toHaveLength(1);
    expect(task?.blockers[0]?.status).toBe("other");
    expect(task?.blockers[0]?.statusReason).toBe("missing");
  });

  // Test 12: markInProgress rewrites status
  it("markInProgress rewrites status:todo to status:in-progress", async () => {
    tmp.writeTodo("# comment\nid:GC-012 agent:codex status:todo Task twelve\n# end\n");

    const source = makeSource(tmp);
    const issues = await source.fetch();
    const [task] = issues;
    expect(task).toBeDefined();

    await source.markInProgress(assertDefined(task, "task"));

    const updated = readFileSync(tmp.todoPath, "utf8");
    expect(updated).toContain("status:in-progress");
    expect(updated).not.toContain("status:todo");
    // unrelated lines preserved
    expect(updated).toContain("# comment");
    expect(updated).toContain("# end");
  });

  // Test 13: markInReview rewrites status
  it("markInReview rewrites status:in-progress to status:in-review", async () => {
    tmp.writeTodo("id:GC-013 agent:codex status:in-progress Task thirteen\n");

    // Build a fake in-progress issue to pass to markInReview
    const source = makeSource(tmp);
    // Use resolveOne to get the issue regardless of fetch filter
    const task = await source.resolveOne("GC-013");
    expect(task).toBeDefined();

    const result = await source.markInReview(assertDefined(task, "task"));
    expect(result.outcome).toBe("applied");

    const updated = readFileSync(tmp.todoPath, "utf8");
    expect(updated).toContain("status:in-review");
  });

  // Test 14: markDone marks task complete
  it("markDone marks task complete with x prefix and status:done", async () => {
    const now = new Date("2026-06-08T12:00:00Z");
    tmp.writeTodo("id:GC-014 agent:codex status:in-review Task fourteen\n");

    const source = makeSource(tmp);
    const task = await source.resolveOne("GC-014");
    expect(task).toBeDefined();

    const ref = sourceRef(assertDefined(task, "task"));
    const { updateTaskStatus } = await import("./writeback.ts");
    await updateTaskStatus({ todoPath: tmp.todoPath, ref, now }, "done");

    const updated = readFileSync(tmp.todoPath, "utf8");
    expect(updated).toContain("x 2026-06-08");
    expect(updated).toContain("status:done");
  });

  // Test 15: markDone on rec:+1w creates next task with new ID/date
  it("markDone on rec:+1w creates next recurring task", async () => {
    // Use rec:+1w (strict): new due = original due + 1w = 2026-06-08
    tmp.writeTodo(
      "(A) Weekly cleanup id:cleanup-20260601 agent:any due:2026-06-01 rec:+1w status:in-review\n",
    );
    tmp.writeTask("cleanup-20260601", "Cleanup prompt.");

    const source = makeSource(tmp);
    const task = await source.resolveOne("cleanup-20260601");
    expect(task).toBeDefined();

    const markDone = assertDefined(source.markDone?.bind(source), "markDone");
    await markDone(assertDefined(task, "task"));

    const updated = readFileSync(tmp.todoPath, "utf8");
    // Original task marked done
    expect(updated).toMatch(/^x \d{4}-\d{2}-\d{2} /m);
    expect(updated).toContain("status:done");
    // New recurring task with advanced due (strict: original due + 1w = 2026-06-08)
    expect(updated).toContain("id:cleanup-20260608");
    expect(updated).toContain("due:2026-06-08");
    expect(updated).toMatch(/.*id:cleanup-20260608.*status:todo/);

    // Prompt file copied to new id
    const newPromptPath = path.join(tmp.tasksDir, "cleanup-20260608.md");
    const newPromptContent = readFileSync(newPromptPath, "utf8");
    expect(newPromptContent).toBe("Cleanup prompt.");
  });

  // Test 16: Atomic rewrite preserves unrelated lines/comments
  it("atomic rewrite preserves unrelated lines and comments", async () => {
    tmp.writeTodo(
      "# My todo list\n(A) Other task id:OTHER-001 agent:codex status:todo\nid:GC-016 agent:codex status:todo Task sixteen\n# trailing comment\n",
    );
    tmp.writeTask("GC-016", "Prompt.");
    tmp.writeTask("OTHER-001", "Other prompt.");

    const source = makeSource(tmp);
    const issues = await source.fetch();
    const task = issues.find((i) => i.id === "todo:gc-016");
    expect(task).toBeDefined();

    await source.markInProgress(assertDefined(task, "task"));

    const updated = readFileSync(tmp.todoPath, "utf8");
    expect(updated).toContain("# My todo list");
    expect(updated).toContain("OTHER-001");
    expect(updated).toContain("status:todo"); // OTHER-001 still todo
    expect(updated).toContain("# trailing comment");
    expect(updated).toMatch(/GC-016.*status:in-progress/);
  });

  // Test 17: Conflicting line fingerprint handled safely
  it("falls back to id: lookup when line fingerprint does not match", async () => {
    tmp.writeTodo("id:GC-017 agent:codex status:todo Task seventeen\n");

    const source = makeSource(tmp);
    const task = await source.fetch().then((issues) => issues[0]);
    expect(task).toBeDefined();

    // Simulate user editing the line between fetch and writeback
    tmp.writeTodo("id:GC-017 agent:codex status:todo Task seventeen (edited)\n");

    // Should still succeed (falls back to id: lookup)
    await source.markInProgress(assertDefined(task, "task"));

    const updated = readFileSync(tmp.todoPath, "utf8");
    expect(updated).toContain("status:in-progress");
  });

  // Test 18: getTask (resolveOne) and listTasks (fetch) use same normalization
  it("resolveOne and fetch return same normalized shape for same task", async () => {
    tmp.writeTodo("(A) Same task id:GC-018 agent:codex repo:OrgA/repo status:todo\n");
    tmp.writeTask("GC-018", "Prompt content.");

    const source = makeSource(tmp, "OrgA/default");
    const [fetchedIssue] = await source.fetch();
    const resolvedIssue = await source.resolveOne("GC-018");

    expect(resolvedIssue).toBeDefined();
    // All normalizable fields should match
    expect(resolvedIssue?.id).toBe(fetchedIssue?.id);
    expect(resolvedIssue?.title).toBe(fetchedIssue?.title);
    expect(resolvedIssue?.description).toBe(fetchedIssue?.description);
    expect(resolvedIssue?.status).toBe(fetchedIssue?.status);
    expect(resolvedIssue?.agent).toBe(fetchedIssue?.agent);
    expect(resolvedIssue?.repository).toBe(fetchedIssue?.repository);
    expect(resolvedIssue?.priority).toBe(fetchedIssue?.priority);
    expect(resolvedIssue?.blockers).toStrictEqual(fetchedIssue?.blockers);
  });

  // Test 19: resolveOne returns undefined for missing id
  it("resolveOne returns undefined when task id is not found", async () => {
    tmp.writeTodo("id:GC-019 agent:codex status:todo Task\n");

    const source = makeSource(tmp);
    const result = await source.resolveOne("NONEXISTENT");

    expect(result).toBeUndefined();
  });

  it("includes in-progress and in-review tasks in fetch", async () => {
    tmp.writeTodo(
      "id:IP-001 agent:codex status:in-progress In progress\nid:IR-001 agent:codex status:in-review In review\n",
    );

    const source = makeSource(tmp);
    const issues = await source.fetch();

    expect(issues).toHaveLength(2);
    expect(issues.find((i) => i.id === "todo:ip-001")?.status).toBe("in-progress");
    expect(issues.find((i) => i.id === "todo:ir-001")?.status).toBe("in-review");
  });

  it("excludes completed (x prefix) tasks from fetch", async () => {
    tmp.writeTodo("x 2026-06-01 id:DONE-001 agent:codex status:done Done task\n");

    const source = makeSource(tmp);
    const issues = await source.fetch();

    expect(issues).toHaveLength(0);
  });

  it("maps priority (A) to priority 1", async () => {
    tmp.writeTodo("(A) High priority task id:PRI-001 agent:codex status:todo\n");

    const source = makeSource(tmp);
    const issues = await source.fetch();

    expect(issues[0]?.priority).toBe(1);
  });

  it("uses title as description when no prompt file exists", async () => {
    tmp.writeTodo("No prompt task id:NO-PROMPT agent:codex status:todo\n");

    const source = makeSource(tmp);
    const issues = await source.fetch();

    expect(issues[0]?.description).toBe("No prompt task\n");
  });

  it("canonicalId is todo:<lowercased-id>", async () => {
    tmp.writeTodo("id:GC-UPPER-001 agent:codex status:todo Uppercase id\n");

    const source = makeSource(tmp);
    const issues = await source.fetch();

    expect(issues[0]?.id).toBe("todo:gc-upper-001");
  });

  it("sourceRef carries the todo path and fingerprint", async () => {
    tmp.writeTodo("id:GC-REF-001 agent:codex status:todo Ref task\n");

    const source = makeSource(tmp);
    const issues = await source.fetch();
    const ref = sourceRef(assertDefined(issues[0], "issue"));

    expect(ref.sourceName).toBe("todo");
    expect(ref.todoPath).toBe(tmp.todoPath);
    expect(ref.id).toBe("GC-REF-001");
    expect(ref.lineFingerprint).toHaveLength(64); // sha256 hex
  });

  it("emits multiple blockers from repeated dep: fields", async () => {
    tmp.writeTodo(
      "id:DEP-A agent:codex status:todo Dep A\nid:DEP-B agent:codex status:done Dep B\nid:MAIN-001 agent:codex dep:DEP-A dep:DEP-B status:todo Main\n",
    );

    const source = makeSource(tmp);
    const issues = await source.fetch();
    const main = issues.find((i) => i.id === "todo:main-001");

    expect(main?.blockers).toHaveLength(2);
  });

  it("markInProgress fails when task not found", async () => {
    tmp.writeTodo("id:GC-NF agent:codex status:todo Task\n");
    const source = makeSource(tmp);
    const issues = await source.fetch();

    // Remove the file to simulate disappearance
    writeFileSync(tmp.todoPath, "# empty\n");

    await expect(source.markInProgress(assertDefined(issues[0], "issue"))).rejects.toThrow(
      /not found/,
    );
  });

  it("verify() passes when todo file is valid", async () => {
    tmp.writeTodo("(A) Good task id:GC-V1 agent:codex status:in-progress\n");
    const source = makeSource(tmp);
    await expect(source.verify()).resolves.not.toThrow();
  });

  it("verify() throws when todo file is missing", async () => {
    const source = makeSource(tmp); // todoPath does not exist
    await expect(source.verify()).rejects.toThrow(/missing todo file/);
  });

  it("verify() catches duplicate id:", async () => {
    tmp.writeTodo("id:DUP agent:codex status:todo Task A\nid:DUP agent:codex status:todo Task B\n");
    tmp.writeTask("DUP", "Prompt.");
    const source = makeSource(tmp);
    await expect(source.verify()).rejects.toThrow(/duplicate id/);
  });

  it("verify() catches status:todo not final token", async () => {
    tmp.writeTodo("id:GC-V3 agent:codex status:todo extra-token\n");
    tmp.writeTask("GC-V3", "Prompt.");
    const source = makeSource(tmp);
    await expect(source.verify()).rejects.toThrow(/not the final token/);
  });

  it("verify() catches malformed due: date", async () => {
    tmp.writeTodo("id:GC-V4 agent:codex due:not-a-date status:in-progress\n");
    const source = makeSource(tmp);
    await expect(source.verify()).rejects.toThrow(/malformed due/);
  });

  it("verify() rejects datetime due: (due stays date-only)", async () => {
    tmp.writeTodo("id:GC-V4B agent:codex due:2026-06-09T10:00 status:in-progress\n");
    const source = makeSource(tmp);
    await expect(source.verify()).rejects.toThrow(/malformed due/);
  });

  it("verify() accepts datetime t: thresholds", async () => {
    tmp.writeTodo("id:GC-V4C agent:codex t:2026-06-09T10:00 status:in-progress\n");
    const source = makeSource(tmp);
    await expect(source.verify()).resolves.toBeUndefined();
  });

  it("verify() catches malformed datetime t:", async () => {
    tmp.writeTodo("id:GC-V4D agent:codex t:2026-06-09T25:00 status:in-progress\n");
    const source = makeSource(tmp);
    await expect(source.verify()).rejects.toThrow(/malformed t/);
  });

  it("verify() catches non-calendar date-only t:", async () => {
    tmp.writeTodo("id:GC-V4E agent:codex t:2026-99-99 status:in-progress\n");
    const source = makeSource(tmp);
    await expect(source.verify()).rejects.toThrow(/malformed t/);
  });

  it("verify() catches malformed rec:", async () => {
    tmp.writeTodo("id:GC-V5 agent:codex rec:bad-recurrence status:in-progress\n");
    const source = makeSource(tmp);
    await expect(source.verify()).rejects.toThrow(/malformed rec/);
  });

  it("parses creation date in task line", async () => {
    tmp.writeTodo("(A) 2026-01-01 Task with creation date id:CD-001 agent:codex status:todo\n");

    const source = makeSource(tmp);
    const issues = await source.fetch();

    expect(issues).toHaveLength(1);
    expect(issues[0]?.title).toBe("Task with creation date");
  });

  it("normalizes status:done from metadata to done status", async () => {
    tmp.writeTodo("id:DONE-META agent:codex status:done Task done\n");

    const source = makeSource(tmp);
    const task = await source.resolveOne("DONE-META");

    expect(task?.status).toBe("done");
  });

  it("markDone with rec:1m advances month", async () => {
    tmp.writeTodo(
      "id:monthly-20260601 agent:any due:2026-06-01 rec:1m status:in-progress Monthly task\n",
    );
    tmp.writeTask("monthly-20260601", "Monthly prompt.");

    const source = makeSource(tmp);
    const task = await source.resolveOne("monthly-20260601");
    expect(task).toBeDefined();

    const { updateTaskStatus } = await import("./writeback.ts");
    const now = new Date("2026-06-15T00:00:00Z");
    const recurResult = await updateTaskStatus(
      { todoPath: tmp.todoPath, ref: sourceRef(assertDefined(task, "task")), now },
      "done",
    );

    expect(recurResult?.newId).toBe("monthly-20260715");
    const updated = readFileSync(tmp.todoPath, "utf8");
    expect(updated).toContain("due:2026-07-15");
  });

  it("fetch returns empty array when todo file does not exist", async () => {
    const source = makeSource(tmp); // no todo.txt created
    const issues = await source.fetch();
    expect(issues).toHaveLength(0);
  });

  it("normalizes unknown status value to other", async () => {
    tmp.writeTodo("id:WIP-001 agent:codex status:wip Task with custom status\n");

    const source = makeSource(tmp);
    const task = await source.resolveOne("WIP-001");

    expect(task?.status).toBe("other");
  });

  it("markInReview throws when task is not in-progress", async () => {
    tmp.writeTodo("id:GC-ERR1 agent:codex status:todo Task\n");

    const source = makeSource(tmp);
    const task = await source.resolveOne("GC-ERR1");

    const { updateTaskStatus } = await import("./writeback.ts");
    const ref = sourceRef(assertDefined(task, "task"));
    await expect(updateTaskStatus({ todoPath: tmp.todoPath, ref }, "in-review")).rejects.toThrow(
      /expected "in-progress"/,
    );
  });

  it("markDone throws when task has unexpected status", async () => {
    tmp.writeTodo("id:GC-ERR2 agent:codex status:other Task\n");

    const source = makeSource(tmp);
    const task = await source.resolveOne("GC-ERR2");

    const { updateTaskStatus } = await import("./writeback.ts");
    const ref = sourceRef(assertDefined(task, "task"));
    await expect(updateTaskStatus({ todoPath: tmp.todoPath, ref }, "done")).rejects.toThrow(
      /cannot mark done/,
    );
  });

  it("verify() allows a title-only ready task without a prompt file", async () => {
    tmp.writeTodo("Say goodbye repo:groundcrew id:rrr agent:any status:todo\n");
    const source = makeSource(tmp);
    await expect(source.verify()).resolves.toBeUndefined();
  });

  it("verify() catches missing prompt file for ready task without a title", async () => {
    tmp.writeTodo("id:GC-MP agent:codex status:todo\n"); // no task file created
    const source = makeSource(tmp);
    await expect(source.verify()).rejects.toThrow(/missing prompt file/);
  });

  it("verify() catches empty prompt file for ready task", async () => {
    tmp.writeTodo("id:GC-EP agent:codex status:todo\n");
    tmp.writeTask("GC-EP", "   "); // whitespace-only
    const source = makeSource(tmp);
    await expect(source.verify()).rejects.toThrow(/empty prompt file/);
  });

  it("verify() catches unresolved dep", async () => {
    tmp.writeTodo("id:GC-UD agent:codex dep:GHOST-001 status:in-progress Task\n");
    const source = makeSource(tmp);
    await expect(source.verify()).rejects.toThrow(/unresolved dep/);
  });

  it("verify() catches invalid status value", async () => {
    tmp.writeTodo("id:GC-IS agent:codex status:wip Task\n");
    const source = makeSource(tmp);
    await expect(source.verify()).rejects.toThrow(/invalid status/);
  });

  it("validate() returns empty array for a valid file", async () => {
    tmp.writeTodo("(A) Good task id:GC-V1 agent:any status:todo\n");
    tmp.writeTask("GC-V1", "Prompt.");
    const source = makeSource(tmp);
    await expect(source.validate?.()).resolves.toStrictEqual([]);
  });

  it("validate() returns errors as an array without throwing", async () => {
    tmp.writeTodo(
      "Task A id:DUP agent:any status:in-progress\nTask B id:DUP agent:any status:in-progress\n",
    );
    const source = makeSource(tmp);
    const errors = await source.validate?.();
    expect(errors).toHaveLength(1);
    expect(errors?.[0]).toMatch(/duplicate id/);
  });

  it("validate() flags unknown agent when knownAgents are derived from config", async () => {
    tmp.writeTodo("Task id:GC-AG1 agent:unknown-bot status:in-progress\n");
    const source = makeSourceWithAgents(tmp);
    const errors = await source.validate?.();
    expect(errors).toContainEqual(expect.stringContaining('unknown agent "unknown-bot"'));
  });

  it("validate() does not flag agent matching a configured agent", async () => {
    tmp.writeTodo("Task id:GC-AG2 agent:claude status:in-progress\n");
    const source = makeSourceWithAgents(tmp);
    await expect(source.validate?.()).resolves.toStrictEqual([]);
  });

  it("validate() does not flag agent:any", async () => {
    tmp.writeTodo("Task id:GC-AG3 agent:any status:in-progress\n");
    const source = makeSourceWithAgents(tmp);
    await expect(source.validate?.()).resolves.toStrictEqual([]);
  });

  it("verify() catches unknown agent when knownAgents are derived from config", async () => {
    tmp.writeTodo("Task id:GC-AV agent:unknown-bot status:in-progress\n");
    const source = makeSourceWithAgents(tmp);
    await expect(source.verify()).rejects.toThrow(/unknown agent "unknown-bot"/);
  });

  it("validate() flags unknown agent from the default resolved config context", async () => {
    tmp.writeTodo("Task id:GC-AG4 agent:anything-goes status:in-progress\n");
    const source = makeSource(tmp);
    const errors = await source.validate?.();
    expect(errors).toContainEqual(expect.stringContaining('unknown agent "anything-goes"'));
  });

  it("markInProgress throws when task status is already in-progress", async () => {
    tmp.writeTodo("id:GC-IP2 agent:codex status:in-progress Task\n");

    const source = makeSource(tmp);
    const task = await source.resolveOne("GC-IP2");

    const { updateTaskStatus } = await import("./writeback.ts");
    const ref = sourceRef(assertDefined(task, "task"));
    await expect(updateTaskStatus({ todoPath: tmp.todoPath, ref }, "in-progress")).rejects.toThrow(
      /expected "todo"/,
    );
  });

  it("markInProgress throws with (none) message for task with no status field", async () => {
    tmp.writeTodo("id:GC-NS1 agent:codex No status task\n");

    const source = makeSource(tmp);
    const task = await source.resolveOne("GC-NS1");

    const { updateTaskStatus } = await import("./writeback.ts");
    const ref = sourceRef(assertDefined(task, "task"));
    await expect(updateTaskStatus({ todoPath: tmp.todoPath, ref }, "in-progress")).rejects.toThrow(
      /\(none\)/,
    );
  });

  it("markInReview throws with (none) message for task with no status field", async () => {
    tmp.writeTodo("id:GC-NS2 agent:codex No status task\n");

    const source = makeSource(tmp);
    const task = await source.resolveOne("GC-NS2");

    const { updateTaskStatus } = await import("./writeback.ts");
    const ref = sourceRef(assertDefined(task, "task"));
    await expect(updateTaskStatus({ todoPath: tmp.todoPath, ref }, "in-review")).rejects.toThrow(
      /\(none\)/,
    );
  });

  it("markDone throws with (none) message for task with no status field", async () => {
    tmp.writeTodo("id:GC-NS3 agent:codex No status task\n");

    const source = makeSource(tmp);
    const task = await source.resolveOne("GC-NS3");

    const { updateTaskStatus } = await import("./writeback.ts");
    const ref = sourceRef(assertDefined(task, "task"));
    await expect(updateTaskStatus({ todoPath: tmp.todoPath, ref }, "done")).rejects.toThrow(
      /\(none\)/,
    );
  });

  it("blocker with x-completed status resolves to done", async () => {
    tmp.writeTodo(
      "x 2026-06-01 id:DONE-DEP agent:codex status:done Completed dep\nid:WAITER agent:codex dep:DONE-DEP status:todo Waiter\n",
    );

    const source = makeSource(tmp);
    const issues = await source.fetch();

    const waiter = issues.find((i) => i.id === "todo:waiter");
    expect(waiter?.blockers[0]?.status).toBe("done");
    expect(waiter?.blockers[0]?.nativeStatus).toBe("x");
  });

  it("blocker with empty title falls back to dep id as title", async () => {
    // A dep task with only metadata (no descriptive text) has an empty title
    tmp.writeTodo(
      "id:NO-TITLE-DEP agent:codex status:todo\nid:HAS-DEP agent:codex dep:NO-TITLE-DEP status:todo Has dep\n",
    );

    const source = makeSource(tmp);
    const issues = await source.fetch();

    const hasDep = issues.find((i) => i.id === "todo:has-dep");
    expect(hasDep?.blockers[0]?.title).toBe("NO-TITLE-DEP");
  });

  it("fetch defaults a task with id but no agent to agent-any", async () => {
    tmp.writeTodo("Task with no agent id:NO-AGENT-001 status:todo\n");

    const source = makeSource(tmp);
    const issues = await source.fetch();

    expect(issues.find((i) => i.id === "todo:no-agent-001")?.agent).toBe("any");
  });

  it("blocker resolution skips null and no-id lines in file", async () => {
    // File has a comment line and a no-id line before the dep task
    // — find() must skip null entries (p !== null) and non-id lines (?.)
    tmp.writeTodo(
      "# a comment\nagent:codex status:todo No id\nid:COMMENT-DEP agent:codex status:todo\nid:COMMENT-MAIN agent:codex dep:COMMENT-DEP status:todo Main\n",
    );

    const source = makeSource(tmp);
    const issues = await source.fetch();
    const main = issues.find((i) => i.id === "todo:comment-main");

    expect(main?.blockers).toHaveLength(1);
    expect(main?.blockers[0]?.status).toBe("todo");
  });

  it("blocker with no status field uses (no status) as native status", async () => {
    tmp.writeTodo(
      // no status: field on first dep line
      "id:NOSTATUS-DEP agent:codex\nid:MAIN-NS agent:codex dep:NOSTATUS-DEP status:todo Main\n",
    );

    const source = makeSource(tmp);
    const issues = await source.fetch();

    const main = issues.find((i) => i.id === "todo:main-ns");
    expect(main?.blockers[0]?.nativeStatus).toBe("(no status)");
  });

  it("markDone on recurring task creates suffix id when new id already exists", async () => {
    // Both the original task and the "next" id already exist
    tmp.writeTodo(
      "(A) Weekly cleanup id:cleanup-20260601 agent:any due:2026-06-01 rec:+1w status:in-review\n(A) Weekly cleanup id:cleanup-20260608 agent:any due:2026-06-08 rec:+1w status:todo\n",
    );
    tmp.writeTask("cleanup-20260601", "Prompt.");
    tmp.writeTask("cleanup-20260608", "Existing next prompt.");

    const source = makeSource(tmp);
    const task = await source.resolveOne("cleanup-20260601");

    const { updateTaskStatus } = await import("./writeback.ts");
    const now = new Date("2026-06-05T00:00:00Z");
    const recurResult = await updateTaskStatus(
      { todoPath: tmp.todoPath, ref: sourceRef(assertDefined(task, "task")), now },
      "done",
    );

    // New id gets -002 suffix since cleanup-20260608 already exists
    expect(recurResult?.newId).toBe("cleanup-20260608-002");
  });

  it("fetch defers status:todo tasks whose t: threshold is in the future", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-08T12:00:00.000Z"));
    tmp.writeTodo(
      "Deferred task id:DEFER-1 agent:codex t:2026-06-09 status:todo\nReady task id:READY-1 agent:codex t:2026-06-08 status:todo\nPast threshold id:READY-2 agent:codex t:2026-06-01 status:todo\n",
    );
    tmp.writeTask("DEFER-1", "Deferred prompt.");
    tmp.writeTask("READY-1", "Ready prompt.");
    tmp.writeTask("READY-2", "Past prompt.");

    const source = makeSource(tmp);
    const issues = await source.fetch();

    expect(issues.map((issue) => issue.id)).toStrictEqual(["todo:ready-1", "todo:ready-2"]);
  });

  it("fetch computes today in the configured timezone when deferring on t:", async () => {
    // 2026-06-09T03:00Z is still 2026-06-08 in America/Chicago (UTC-5),
    // so a t:2026-06-09 task is deferred there but ready in UTC.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-09T03:00:00.000Z"));
    tmp.writeTodo("Deferred task id:TZ-1 agent:codex t:2026-06-09 status:todo\n");
    tmp.writeTask("TZ-1", "Timezone prompt.");

    const chicagoSource = createTodoTxtTaskSource(
      {
        kind: "todo-txt",
        name: "todo",
        todoPath: tmp.todoPath,
        tasksDir: tmp.tasksDir,
        idPrefix: "GC",
        timezone: "America/Chicago",
      },
      fakeContext,
    );
    const utcSource = makeSource(tmp);

    await expect(chicagoSource.fetch()).resolves.toHaveLength(0);
    await expect(utcSource.fetch()).resolves.toHaveLength(1);
  });

  it("markDone with rec:+1w and t: but no due: advances the id using the new t:", async () => {
    tmp.writeTodo(
      "Weekly status id:status-20260601 agent:any t:2026-06-01 rec:+1w status:in-progress\n",
    );
    tmp.writeTask("status-20260601", "Status prompt.");

    const source = makeSource(tmp);
    const task = await source.resolveOne("status-20260601");

    const { updateTaskStatus } = await import("./writeback.ts");
    const now = new Date("2026-06-01T00:00:00Z");
    const recurResult = await updateTaskStatus(
      { todoPath: tmp.todoPath, ref: sourceRef(assertDefined(task, "task")), now },
      "done",
    );

    const updated = readFileSync(tmp.todoPath, "utf8");
    expect(updated).toContain("t:2026-06-08"); // t: advanced 1w from 2026-06-01
    expect(recurResult?.newId).toBe("status-20260608");
  });

  it("markDone with rec: task having t: threshold date advances it too", async () => {
    // rec:+1w strict: due advances from 2026-06-01 → 2026-06-08; t: advances from 2026-05-25 → 2026-06-01
    tmp.writeTodo(
      "id:threshold-001 agent:any due:2026-06-01 t:2026-05-25 rec:+1w status:in-progress\n",
    );
    tmp.writeTask("threshold-001", "Threshold task.");

    const source = makeSource(tmp);
    const task = await source.resolveOne("threshold-001");

    const { updateTaskStatus } = await import("./writeback.ts");
    const now = new Date("2026-06-01T00:00:00Z");
    const recurResult = await updateTaskStatus(
      { todoPath: tmp.todoPath, ref: sourceRef(assertDefined(task, "task")), now },
      "done",
    );

    const updated = readFileSync(tmp.todoPath, "utf8");
    expect(updated).toContain("t:2026-06-01"); // t: advanced 1w from 2026-05-25
    expect(updated).toContain("due:2026-06-08");
    // id has no 8-digit date component, so date is appended
    expect(recurResult?.newId).toBe("threshold-001-20260608");
  });

  it("parses a completed line with no text after the date", async () => {
    // Bare completed line: "x YYYY-MM-DD" with no description
    tmp.writeTodo("x 2026-06-01\n");

    const source = makeSource(tmp);
    const issues = await source.fetch();

    expect(issues).toHaveLength(0); // no id, so filtered
  });

  it("isActiveForFetch returns false for line with no id: field", async () => {
    // A line with agent and status but no id
    tmp.writeTodo("agent:codex status:todo No id line\n");

    const source = makeSource(tmp);
    const issues = await source.fetch();

    expect(issues).toHaveLength(0);
  });

  it("resolveOne skips lines with no id when searching", async () => {
    // File has a no-id line and a task line; resolveOne should find the task line
    tmp.writeTodo("agent:codex status:todo No id\nid:GC-FIND1 agent:codex status:todo Task\n");

    const source = makeSource(tmp);
    const task = await source.resolveOne("GC-FIND1");

    expect(task?.id).toBe("todo:gc-find1");
  });

  it("markDone on task with no recurrence returns undefined recurResult", async () => {
    tmp.writeTodo("id:NOREC-001 agent:codex status:in-progress Task\n");
    const source = makeSource(tmp);
    const task = await source.resolveOne("NOREC-001");

    const { updateTaskStatus } = await import("./writeback.ts");
    const ref = sourceRef(assertDefined(task, "task"));
    const recurResult = await updateTaskStatus({ todoPath: tmp.todoPath, ref }, "done");

    expect(recurResult).toBeUndefined();
    const updated = readFileSync(tmp.todoPath, "utf8");
    expect(updated).toContain("status:done");
  });

  it("source.markDone on non-recurring task does not copy prompt file", async () => {
    tmp.writeTodo("id:NODONE-REC agent:codex status:in-review Non-recurring task\n");
    const source = makeSource(tmp);
    const task = await source.resolveOne("NODONE-REC");

    const markDone = assertDefined(source.markDone?.bind(source), "markDone");
    const result = await markDone(assertDefined(task, "task"));

    expect(result.outcome).toBe("applied");
    const updated = readFileSync(tmp.todoPath, "utf8");
    expect(updated).toContain("status:done");
  });

  it("parses x-completed line with no date prefix", async () => {
    // "x Some task" without a date after x
    tmp.writeTodo("x Some task id:NO-DATE-X agent:codex status:done\n");

    const source = makeSource(tmp);
    const issues = await source.fetch();

    // Completed tasks are excluded from fetch
    expect(issues).toHaveLength(0);
    // But resolveOne can find it
    const task = await source.resolveOne("NO-DATE-X");
    expect(task?.status).toBe("done");
  });

  it("parses a line with priority and creation date but no description", async () => {
    // "(A) 2026-01-01" with no tokens after the creation date
    tmp.writeTodo("(A) 2026-01-01\n");

    const source = makeSource(tmp);
    const issues = await source.fetch();

    expect(issues).toHaveLength(0); // no id/agent/status
  });

  it("markDone with rec:1d creates next daily task", async () => {
    tmp.writeTodo(
      "id:daily-20260608 agent:any due:2026-06-08 rec:1d status:in-progress Daily task\n",
    );
    tmp.writeTask("daily-20260608", "Daily prompt.");

    const source = makeSource(tmp);
    const task = await source.resolveOne("daily-20260608");

    const { updateTaskStatus } = await import("./writeback.ts");
    const now = new Date("2026-06-08T00:00:00Z");
    const recurResult = await updateTaskStatus(
      { todoPath: tmp.todoPath, ref: sourceRef(assertDefined(task, "task")), now },
      "done",
    );

    // Normal (non-strict) rec:1d: advance from completion date 2026-06-08 + 1d = 2026-06-09
    expect(recurResult?.newId).toBe("daily-20260609");
    const updated = readFileSync(tmp.todoPath, "utf8");
    expect(updated).toContain("due:2026-06-09");
  });

  it("markDone with rec:2h advances t: from the completion instant (non-strict)", async () => {
    tmp.writeTodo(
      "id:sweep-20260608 agent:any t:2026-06-08T10:30 rec:2h status:in-progress Hourly sweep\n",
    );
    tmp.writeTask("sweep-20260608", "Sweep prompt.");

    const source = makeSource(tmp);
    const task = await source.resolveOne("sweep-20260608");

    const { updateTaskStatus } = await import("./writeback.ts");
    const now = new Date("2026-06-08T15:47:00Z");
    const recurResult = await updateTaskStatus(
      { todoPath: tmp.todoPath, ref: sourceRef(assertDefined(task, "task")), now },
      "done",
    );

    // Non-strict hourly recurrence advances from completion, not the stale
    // t:10:30, so daemon downtime cannot cause a catch-up stampede.
    expect(recurResult?.newId).toBe("sweep-20260608-002");
    const updated = readFileSync(tmp.todoPath, "utf8");
    expect(updated).toContain("t:2026-06-08T17:47");
  });

  it("markDone with strict rec:+2h accepts a seconds-bearing t:", async () => {
    tmp.writeTodo(
      "id:sweep-20260608 agent:any t:2026-06-08T10:30:15 rec:+2h status:in-progress Hourly sweep\n",
    );
    tmp.writeTask("sweep-20260608", "Sweep prompt.");

    const source = makeSource(tmp);
    const task = await source.resolveOne("sweep-20260608");

    const { updateTaskStatus } = await import("./writeback.ts");
    const now = new Date("2026-06-08T15:47:00Z");
    await updateTaskStatus(
      { todoPath: tmp.todoPath, ref: sourceRef(assertDefined(task, "task")), now },
      "done",
    );

    const updated = readFileSync(tmp.todoPath, "utf8");
    expect(updated).toContain("t:2026-06-08T12:30");
  });

  it("markDone with strict rec:+2h treats a date-only t: as midnight", async () => {
    tmp.writeTodo(
      "id:sweep-20260608 agent:any t:2026-06-08 rec:+2h status:in-progress Hourly sweep\n",
    );
    tmp.writeTask("sweep-20260608", "Sweep prompt.");

    const source = makeSource(tmp);
    const task = await source.resolveOne("sweep-20260608");

    const { updateTaskStatus } = await import("./writeback.ts");
    const now = new Date("2026-06-08T15:47:00Z");
    await updateTaskStatus(
      { todoPath: tmp.todoPath, ref: sourceRef(assertDefined(task, "task")), now },
      "done",
    );

    const updated = readFileSync(tmp.todoPath, "utf8");
    expect(updated).toContain("t:2026-06-08T02:00");
  });

  it("markDone with rec:2h carries a verify-rejected due: forward unchanged", async () => {
    tmp.writeTodo(
      "id:sweep-20260608 agent:any t:2026-06-08T10:30 due:2026-06-20 rec:2h status:in-progress Hourly sweep\n",
    );
    tmp.writeTask("sweep-20260608", "Sweep prompt.");

    const source = makeSource(tmp);
    const task = await source.resolveOne("sweep-20260608");

    const { updateTaskStatus } = await import("./writeback.ts");
    const now = new Date("2026-06-08T15:47:00Z");
    await updateTaskStatus(
      { todoPath: tmp.todoPath, ref: sourceRef(assertDefined(task, "task")), now },
      "done",
    );

    // Hour units never feed due: into date-only advancement; the (verify-
    // rejected) combination degrades to carrying due: forward unchanged.
    const updated = readFileSync(tmp.todoPath, "utf8");
    expect(updated).toContain("t:2026-06-08T17:47");
    expect(updated.match(/due:2026-06-20/g)).toHaveLength(2);
  });

  it("markDone with strict rec:+2h advances t: from its previous value", async () => {
    tmp.writeTodo(
      "id:sweep-20260608 agent:any t:2026-06-08T10:30 rec:+2h status:in-progress Hourly sweep\n",
    );
    tmp.writeTask("sweep-20260608", "Sweep prompt.");

    const source = makeSource(tmp);
    const task = await source.resolveOne("sweep-20260608");

    const { updateTaskStatus } = await import("./writeback.ts");
    const now = new Date("2026-06-08T15:47:00Z");
    await updateTaskStatus(
      { todoPath: tmp.todoPath, ref: sourceRef(assertDefined(task, "task")), now },
      "done",
    );

    const updated = readFileSync(tmp.todoPath, "utf8");
    expect(updated).toContain("t:2026-06-08T12:30");
  });

  it("markDone with rec:2h crossing midnight advances the id date", async () => {
    tmp.writeTodo(
      "id:sweep-20260608 agent:any t:2026-06-08T21:00 rec:2h status:in-progress Hourly sweep\n",
    );
    tmp.writeTask("sweep-20260608", "Sweep prompt.");

    const source = makeSource(tmp);
    const task = await source.resolveOne("sweep-20260608");

    const { updateTaskStatus } = await import("./writeback.ts");
    const now = new Date("2026-06-08T23:30:00Z");
    const recurResult = await updateTaskStatus(
      { todoPath: tmp.todoPath, ref: sourceRef(assertDefined(task, "task")), now },
      "done",
    );

    expect(recurResult?.newId).toBe("sweep-20260609");
    const updated = readFileSync(tmp.todoPath, "utf8");
    expect(updated).toContain("t:2026-06-09T01:30");
  });

  it("markDone with rec:2h computes the completion instant in the source timezone", async () => {
    tmp.writeTodo(
      "id:sweep-20260608 agent:any t:2026-06-08T05:00 rec:2h status:in-progress Hourly sweep\n",
    );
    tmp.writeTask("sweep-20260608", "Sweep prompt.");

    const source = makeSource(tmp);
    const task = await source.resolveOne("sweep-20260608");

    const { updateTaskStatus } = await import("./writeback.ts");
    const now = new Date("2026-06-08T15:47:00Z"); // 10:47 in Chicago (CDT)
    await updateTaskStatus(
      {
        todoPath: tmp.todoPath,
        ref: sourceRef(assertDefined(task, "task")),
        now,
        timezone: "America/Chicago",
      },
      "done",
    );

    const updated = readFileSync(tmp.todoPath, "utf8");
    expect(updated).toContain("t:2026-06-08T12:47");
  });

  it("verify() accepts hourly rec: with a t: threshold", async () => {
    tmp.writeTodo("id:GC-H1 agent:codex t:2026-06-09T10:00 rec:2h status:in-progress\n");
    const source = makeSource(tmp);
    await expect(source.verify()).resolves.toBeUndefined();
  });

  it("verify() rejects hourly rec: without t:", async () => {
    tmp.writeTodo("id:GC-H2 agent:codex rec:2h status:in-progress\n");
    const source = makeSource(tmp);
    await expect(source.verify()).rejects.toThrow(/hourly rec/);
  });

  it("verify() rejects hourly rec: combined with due:", async () => {
    tmp.writeTodo(
      "id:GC-H3 agent:codex t:2026-06-09T10:00 due:2026-06-09 rec:2h status:in-progress\n",
    );
    const source = makeSource(tmp);
    await expect(source.verify()).rejects.toThrow(/hourly rec/);
  });

  it("markDone with rec:1d advances a datetime t: preserving the time component", async () => {
    tmp.writeTodo(
      "id:sweep-20260608 agent:any t:2026-06-08T10:30 rec:1d status:in-progress Recurring sweep\n",
    );
    tmp.writeTask("sweep-20260608", "Sweep prompt.");

    const source = makeSource(tmp);
    const task = await source.resolveOne("sweep-20260608");

    const { updateTaskStatus } = await import("./writeback.ts");
    const now = new Date("2026-06-08T15:00:00Z");
    const recurResult = await updateTaskStatus(
      { todoPath: tmp.todoPath, ref: sourceRef(assertDefined(task, "task")), now },
      "done",
    );

    expect(recurResult?.newId).toBe("sweep-20260609");
    const updated = readFileSync(tmp.todoPath, "utf8");
    expect(updated).toContain("t:2026-06-09T10:30");
  });

  it("verify() passes on file with resolved dep", async () => {
    tmp.writeTodo(
      "id:DEP-V1 agent:codex status:in-progress\nid:WAITER-V1 agent:codex dep:DEP-V1 status:todo\n",
    );
    tmp.writeTask("WAITER-V1", "Prompt.");
    const source = makeSource(tmp);
    // verify should not throw — the dep IS resolved
    await expect(source.verify()).resolves.not.toThrow();
  });

  it("verify() handles completed tasks with id and agent", async () => {
    tmp.writeTodo("x 2026-06-01 id:DONE-V1 agent:codex status:done Completed\n");
    const source = makeSource(tmp);
    // completed tasks are skipped in verify (not checked for prompt/dep)
    await expect(source.verify()).resolves.not.toThrow();
  });

  it("verify() catches id-less agent line", async () => {
    // No id: field but has agent — should not be validated (skipped by id check)
    // Also has a valid ready task to prevent "no tasks" condition
    tmp.writeTodo(
      "agent:codex status:todo No id here\nid:VALID-V1 agent:codex status:in-progress\n",
    );
    const source = makeSource(tmp);
    // Should pass — id-less lines are skipped
    await expect(source.verify()).resolves.not.toThrow();
  });

  it("markDone with rec:1y creates next annual task", async () => {
    tmp.writeTodo(
      "id:annual-20260101 agent:any due:2026-01-01 rec:+1y status:in-progress Annual task\n",
    );
    tmp.writeTask("annual-20260101", "Annual prompt.");

    const source = makeSource(tmp);
    const task = await source.resolveOne("annual-20260101");

    const { updateTaskStatus } = await import("./writeback.ts");
    const now = new Date("2026-06-15T00:00:00Z");
    const recurResult = await updateTaskStatus(
      { todoPath: tmp.todoPath, ref: sourceRef(assertDefined(task, "task")), now },
      "done",
    );

    expect(recurResult?.newId).toBe("annual-20270101");
    const updated = readFileSync(tmp.todoPath, "utf8");
    expect(updated).toContain("due:2027-01-01");
  });
});
