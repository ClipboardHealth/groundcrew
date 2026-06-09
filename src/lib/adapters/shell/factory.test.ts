/* eslint-disable no-template-curly-in-string -- this file constructs `${id}`-style placeholders as literal strings for the shell adapter's substitution mechanism; they're NOT JS template literals */

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { captureConsoleError } from "../../../testHelpers/consoleCapture.ts";

import type { AdapterContext } from "../../adapterDefinition.ts";
import type { ResolvedConfig } from "../../config.ts";
import type { CreateTaskInput, Issue as CanonicalIssue } from "../../taskSource.ts";

import { createShellTaskSource, toCanonicalIssue } from "./factory.ts";
import type { ShellIssue } from "./schema.ts";

interface TempDir {
  path: string;
  writeScript: (name: string, body: string) => string;
  cleanup: () => void;
}

function makeTempDir(): TempDir {
  const dirPath = mkdtempSync(path.join(tmpdir(), "shell-factory-test-"));
  return {
    path: dirPath,
    writeScript(name: string, body: string): string {
      const scriptPath = path.join(dirPath, name);
      writeFileSync(scriptPath, `#!/usr/bin/env bash\n${body}\n`);
      chmodSync(scriptPath, 0o755);
      return scriptPath;
    },
    cleanup(): void {
      rmSync(dirPath, { recursive: true, force: true });
    },
  };
}

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- shell adapter doesn't read globalConfig
const fakeContext: AdapterContext = { globalConfig: {} as ResolvedConfig };

function shellIssue(overrides: Partial<ShellIssue> = {}): ShellIssue {
  return {
    id: overrides.id ?? "X-1",
    title: overrides.title ?? "Title",
    description: overrides.description ?? "",
    status: overrides.status ?? "todo",
    repository: overrides.repository ?? null,
    agent: overrides.agent ?? null,
    assignee: overrides.assignee ?? "u",
    updatedAt: overrides.updatedAt ?? "2026-01-01T00:00:00Z",
    blockers: overrides.blockers ?? [],
    hasMoreBlockers: overrides.hasMoreBlockers ?? false,
    sourceRef: "sourceRef" in overrides ? overrides.sourceRef : { path: "/tmp/p.md" },
    ...("url" in overrides ? { url: overrides.url } : {}),
  };
}

describe(toCanonicalIssue, () => {
  it("prefixes the canonical id with the source name and lowercases the natural part", () => {
    // The natural id is lowercased via the shared toCanonicalId helper so the
    // same task always produces the same canonical id regardless of which
    // casing the source emitted — Board.resolveOne lowercases its input
    // before comparing, so adapters MUST lowercase on the storage side too.
    const result = toCanonicalIssue(shellIssue({ id: "X-1" }), "jira");
    expect(result.id).toBe("jira:x-1");
    expect(result.source).toBe("jira");
  });

  it("preserves description and status from the shell payload", () => {
    const result = toCanonicalIssue(
      shellIssue({ description: "Body text", status: "in-progress" }),
      "jira",
    );
    expect(result.description).toBe("Body text");
    expect(result.status).toBe("in-progress");
  });

  it("converts nullable repository and agent to undefined for the canonical type", () => {
    const result = toCanonicalIssue(shellIssue({ repository: null, agent: null }), "jira");
    expect(result.repository).toBeUndefined();
    expect(result.agent).toBeUndefined();
  });

  it("keeps repository/agent when populated", () => {
    const result = toCanonicalIssue(
      shellIssue({ repository: "org/repo", agent: "claude" }),
      "jira",
    );
    expect(result.repository).toBe("org/repo");
    expect(result.agent).toBe("claude");
  });

  it("passes a url through to the canonical Issue when the script provides one", () => {
    const result = toCanonicalIssue(
      shellIssue({ url: "https://jira.example.com/browse/X-1" }),
      "jira",
    );
    expect(result.url).toBe("https://jira.example.com/browse/X-1");
  });

  it("omits the canonical url when the script's payload has none", () => {
    const result = toCanonicalIssue(shellIssue(), "jira");
    expect(result).not.toHaveProperty("url");
  });

  it("source-prefixes blocker ids", () => {
    const result = toCanonicalIssue(
      shellIssue({
        blockers: [
          { id: "B-1", title: "Block A", status: "done" },
          { id: "B-2", title: "Block B", status: "in-progress" },
        ],
      }),
      "jira",
    );
    expect(result.blockers[0]).toMatchObject({ id: "jira:b-1", title: "Block A", status: "done" });
    expect(result.blockers[0]).not.toHaveProperty("statusReason");
    expect(result.blockers[0]).not.toHaveProperty("nativeStatus");
    expect(result.blockers[1]).toMatchObject({
      id: "jira:b-2",
      title: "Block B",
      status: "in-progress",
    });
    expect(result.blockers[1]).not.toHaveProperty("statusReason");
    expect(result.blockers[1]).not.toHaveProperty("nativeStatus");
  });

  it("passes through statusReason and nativeStatus from the shell blocker payload", () => {
    const result = toCanonicalIssue(
      shellIssue({
        blockers: [
          { id: "B-3", title: "Missing status", status: "other", statusReason: "missing" },
          {
            id: "B-4",
            title: "Unmapped status",
            status: "other",
            statusReason: "unmapped",
            nativeStatus: "Triage",
          },
          { id: "B-5", title: "Mapped with native", status: "done", nativeStatus: "Done" },
        ],
      }),
      "jira",
    );
    expect(result.blockers[0]).toMatchObject({
      id: "jira:b-3",
      status: "other",
      statusReason: "missing",
    });
    expect(result.blockers[0]).not.toHaveProperty("nativeStatus");
    expect(result.blockers[1]).toMatchObject({
      id: "jira:b-4",
      status: "other",
      statusReason: "unmapped",
      nativeStatus: "Triage",
    });
    expect(result.blockers[2]).toMatchObject({
      id: "jira:b-5",
      status: "done",
      nativeStatus: "Done",
    });
    expect(result.blockers[2]).not.toHaveProperty("statusReason");
  });

  it("round-trips sourceRef as opaque data", () => {
    const ref = { custom: "data", nested: { x: 1 } };
    const result = toCanonicalIssue(shellIssue({ sourceRef: ref }), "jira");
    expect(result.sourceRef).toStrictEqual(ref);
  });
});

function payload(issue: ShellIssue): string {
  return JSON.stringify([issue]);
}

function createInput(overrides: Partial<CreateTaskInput> = {}): CreateTaskInput {
  return {
    title: "Title",
    agent: "any",
    projects: [],
    contexts: [],
    dependencies: [],
    edit: false,
    ...overrides,
  };
}

describe(createShellTaskSource, () => {
  let dir: TempDir;
  beforeEach(() => {
    dir = makeTempDir();
  });
  afterEach(() => {
    dir.cleanup();
  });

  it("name comes from the config (no default)", () => {
    const source = createShellTaskSource(
      { kind: "shell", name: "jira", commands: { fetch: "echo '[]'" } },
      fakeContext,
    );
    expect(source.name).toBe("jira");
  });

  it("fetch() parses well-formed JSON and prefixes ids with the source name", async () => {
    const script = dir.writeScript(
      "fetch.sh",
      `cat <<'JSON'\n${payload(shellIssue({ id: "X-1" }))}\nJSON`,
    );
    const source = createShellTaskSource(
      { kind: "shell", name: "test", commands: { fetch: script } },
      fakeContext,
    );
    const issues = await source.fetch();
    expect(issues).toHaveLength(1);
    expect(issues[0]?.id).toBe("test:x-1");
    expect(issues[0]?.source).toBe("test");
  });

  it("listTasks() parses well-formed JSON and prefixes ids with the source name", async () => {
    const script = dir.writeScript(
      "list.sh",
      `cat <<'JSON'\n${payload(shellIssue({ id: "X-1" }))}\nJSON`,
    );
    const source = createShellTaskSource(
      { kind: "shell", name: "test", commands: { listTasks: script } },
      fakeContext,
    );

    const issues = await source.listTasks();

    expect(issues[0]?.id).toBe("test:x-1");
  });

  it("fetch() throws when the script emits malformed JSON", async () => {
    const script = dir.writeScript("bad.sh", 'echo "not json"');
    const source = createShellTaskSource(
      { kind: "shell", name: "test", commands: { fetch: script } },
      fakeContext,
    );
    await expect(source.fetch()).rejects.toThrow(/json/i);
  });

  it("fetch() throws when JSON doesn't match the ShellIssue schema", async () => {
    const script = dir.writeScript("bad-shape.sh", `echo '[{"id": 123}]'`);
    const source = createShellTaskSource(
      { kind: "shell", name: "test", commands: { fetch: script } },
      fakeContext,
    );
    await expect(source.fetch()).rejects.toThrow(/.+/);
  });

  it("verify() is a silent no-op when not configured", async () => {
    const source = createShellTaskSource(
      { kind: "shell", name: "test", commands: { fetch: "echo '[]'" } },
      fakeContext,
    );
    await expect(source.verify()).resolves.toBeUndefined();
  });

  it("verify() runs the configured command", async () => {
    const verifyScript = dir.writeScript("verify.sh", "exit 0");
    const source = createShellTaskSource(
      {
        kind: "shell",
        name: "test",
        commands: { fetch: "echo '[]'", verify: verifyScript },
      },
      fakeContext,
    );
    await expect(source.verify()).resolves.toBeUndefined();
  });

  it("verify() surfaces failures from the configured command", async () => {
    const verifyScript = dir.writeScript("fail-verify.sh", 'echo "auth failed" >&2; exit 1');
    const source = createShellTaskSource(
      {
        kind: "shell",
        name: "test",
        commands: { fetch: "echo '[]'", verify: verifyScript },
      },
      fakeContext,
    );
    await expect(source.verify()).rejects.toThrow(/auth failed/);
  });

  it("resolveOne() falls back to scanning fetch when no resolveOne command is set", async () => {
    const script = dir.writeScript(
      "fetch.sh",
      `cat <<'JSON'\n${payload(shellIssue({ id: "X-1" }))}\nJSON`,
    );
    const source = createShellTaskSource(
      { kind: "shell", name: "test", commands: { fetch: script } },
      fakeContext,
    );
    const issue = await source.resolveOne("X-1");
    expect(issue?.id).toBe("test:x-1");
  });

  // Regression: a fetch.sh that emits an uppercase id must still be findable
  // via resolveOne(lowercased natural id), because Board.resolveOne lowercases
  // its input before delegating. Pre-fix this returned undefined because the
  // adapter compared `i.id === "test:TEST-1"` against a lowercased lookup
  // key `"test:test-1"`.
  it("resolveOne() fallback finds an issue whose fetch payload emitted an uppercase id", async () => {
    const script = dir.writeScript(
      "fetch.sh",
      `cat <<'JSON'\n${payload(shellIssue({ id: "TEST-1" }))}\nJSON`,
    );
    const source = createShellTaskSource(
      { kind: "shell", name: "test", commands: { fetch: script } },
      fakeContext,
    );
    const issue = await source.resolveOne("test-1");
    expect(issue?.id).toBe("test:test-1");
  });

  it("resolveOne() fallback returns undefined when fetch has no matching id", async () => {
    const script = dir.writeScript("fetch.sh", "echo '[]'");
    const source = createShellTaskSource(
      { kind: "shell", name: "test", commands: { fetch: script } },
      fakeContext,
    );
    const issue = await source.resolveOne("missing");
    expect(issue).toBeUndefined();
  });

  it("resolveOne() runs the configured command and applies ${id} substitution", async () => {
    const resolveScript = dir.writeScript(
      "resolve.sh",
      `echo "{\\"id\\":\\"$1\\",\\"title\\":\\"t\\",\\"description\\":\\"\\",\\"status\\":\\"todo\\",\\"repository\\":null,\\"agent\\":null,\\"assignee\\":\\"u\\",\\"updatedAt\\":\\"2026-01-01T00:00:00Z\\",\\"blockers\\":[],\\"sourceRef\\":null}"`,
    );
    const source = createShellTaskSource(
      {
        kind: "shell",
        name: "test",
        commands: { fetch: "echo '[]'", resolveOne: `${resolveScript} \${id}` },
      },
      fakeContext,
    );
    const issue = await source.resolveOne("X-1");
    expect(issue?.id).toBe("test:x-1");
  });

  it("getTask() runs the configured command and applies ${id} substitution", async () => {
    const getTaskScript = dir.writeScript(
      "get.sh",
      `echo "{\\"id\\":\\"$1\\",\\"title\\":\\"t\\",\\"description\\":\\"\\",\\"status\\":\\"todo\\",\\"repository\\":null,\\"agent\\":null,\\"assignee\\":\\"u\\",\\"updatedAt\\":\\"2026-01-01T00:00:00Z\\",\\"blockers\\":[],\\"sourceRef\\":null}"`,
    );
    const source = createShellTaskSource(
      {
        kind: "shell",
        name: "test",
        commands: { fetch: "echo '[]'", getTask: `${getTaskScript} \${id}` },
      },
      fakeContext,
    );

    const issue = await source.getTask("X-1");

    expect(issue?.id).toBe("test:x-1");
  });

  it("resolveOne() returns undefined on exit code 3", async () => {
    const resolveScript = dir.writeScript("nf.sh", "exit 3");
    const source = createShellTaskSource(
      {
        kind: "shell",
        name: "test",
        commands: { fetch: "echo '[]'", resolveOne: `${resolveScript} \${id}` },
      },
      fakeContext,
    );
    const issue = await source.resolveOne("X-1");
    expect(issue).toBeUndefined();
  });

  it("resolveOne() returns undefined when the script's stdout is empty", async () => {
    const resolveScript = dir.writeScript("empty.sh", "exit 0");
    const source = createShellTaskSource(
      {
        kind: "shell",
        name: "test",
        commands: { fetch: "echo '[]'", resolveOne: `${resolveScript} \${id}` },
      },
      fakeContext,
    );
    const issue = await source.resolveOne("X-1");
    expect(issue).toBeUndefined();
  });

  it("markInProgress() is a silent no-op when not configured", async () => {
    const source = createShellTaskSource(
      { kind: "shell", name: "test", commands: { fetch: "echo '[]'" } },
      fakeContext,
    );
    const issue: CanonicalIssue = {
      id: "test:x-1",
      source: "test",
      title: "",
      description: "",
      status: "todo",
      repository: undefined,
      agent: undefined,
      assignee: "",
      updatedAt: "",
      blockers: [],
      hasMoreBlockers: false,
      sourceRef: {},
    };
    await expect(source.markInProgress(issue)).resolves.toBeUndefined();
  });

  it("markInProgress() runs the configured command with substituted id and piped sourceRef on stdin", async () => {
    const stdinCapture = path.join(dir.path, "stdin-capture.txt");
    const markScript = dir.writeScript("mark.sh", `cat > "${stdinCapture}"; echo "marked $1"`);
    const source = createShellTaskSource(
      {
        kind: "shell",
        name: "test",
        commands: { fetch: "echo '[]'", markInProgress: `${markScript} \${id}` },
      },
      fakeContext,
    );
    const sourceRef = { path: "/tmp/p.md", extra: { nested: 42 } };
    const issue: CanonicalIssue = {
      id: "test:x-1",
      source: "test",
      title: "",
      description: "",
      status: "todo",
      repository: undefined,
      agent: undefined,
      assignee: "",
      updatedAt: "",
      blockers: [],
      hasMoreBlockers: false,
      sourceRef,
    };
    await source.markInProgress(issue);
    // The captured stdin should be exactly JSON.stringify(sourceRef) — verifies
    // the round-trip from canonical Issue back through the script's stdin pipe.
    expect(readFileSync(stdinCapture, "utf8")).toBe(JSON.stringify(sourceRef));
  });

  it("markInProgress() handles an id that does not have the source prefix", async () => {
    const markScript = dir.writeScript("mark.sh", "exit 0");
    const source = createShellTaskSource(
      {
        kind: "shell",
        name: "test",
        commands: { fetch: "echo '[]'", markInProgress: `${markScript} \${id}` },
      },
      fakeContext,
    );
    const issue: CanonicalIssue = {
      id: "no-prefix",
      source: "test",
      title: "",
      description: "",
      status: "todo",
      repository: undefined,
      agent: undefined,
      assignee: "",
      updatedAt: "",
      blockers: [],
      hasMoreBlockers: false,
      sourceRef: null,
    };
    await expect(source.markInProgress(issue)).resolves.toBeUndefined();
  });

  it("markInReview() reports unsupported when not configured", async () => {
    const source = createShellTaskSource(
      { kind: "shell", name: "test", commands: { fetch: "echo '[]'" } },
      fakeContext,
    );
    const issue: CanonicalIssue = {
      id: "test:x-1",
      source: "test",
      title: "",
      description: "",
      status: "in-progress",
      repository: undefined,
      agent: undefined,
      assignee: "",
      updatedAt: "",
      blockers: [],
      hasMoreBlockers: false,
      sourceRef: {},
    };
    await expect(source.markInReview(issue)).resolves.toStrictEqual({
      outcome: "unsupported",
      reason: 'shell source "test" has no commands.markInReview configured',
    });
  });

  it("markInReview() runs the configured command with substituted id and piped sourceRef on stdin", async () => {
    const stdinCapture = path.join(dir.path, "review-stdin-capture.txt");
    const reviewScript = dir.writeScript("review.sh", `cat > "${stdinCapture}"; echo "review $1"`);
    const source = createShellTaskSource(
      {
        kind: "shell",
        name: "test",
        commands: { fetch: "echo '[]'", markInReview: `${reviewScript} \${id}` },
      },
      fakeContext,
    );
    const sourceRef = { path: "/tmp/p.md", extra: { nested: 7 } };
    const issue: CanonicalIssue = {
      id: "test:x-1",
      source: "test",
      title: "",
      description: "",
      status: "in-progress",
      repository: undefined,
      agent: undefined,
      assignee: "",
      updatedAt: "",
      blockers: [],
      hasMoreBlockers: false,
      sourceRef,
    };
    await expect(source.markInReview(issue)).resolves.toStrictEqual({ outcome: "applied" });
    expect(readFileSync(stdinCapture, "utf8")).toBe(JSON.stringify(sourceRef));
  });

  it("markDone() reports unsupported when not configured", async () => {
    const source = createShellTaskSource(
      { kind: "shell", name: "test", commands: { fetch: "echo '[]'" } },
      fakeContext,
    );
    const issue: CanonicalIssue = {
      id: "test:x-1",
      source: "test",
      title: "",
      description: "",
      status: "in-review",
      repository: undefined,
      agent: undefined,
      assignee: "",
      updatedAt: "",
      blockers: [],
      hasMoreBlockers: false,
      sourceRef: {},
    };
    await expect(source.markDone?.(issue)).resolves.toStrictEqual({
      outcome: "unsupported",
      reason: 'shell source "test" has no commands.markDone configured',
    });
  });

  it("markDone() runs the configured command with substituted id and piped sourceRef on stdin", async () => {
    const stdinCapture = path.join(dir.path, "done-stdin-capture.txt");
    const doneScript = dir.writeScript("done.sh", `cat > "${stdinCapture}"; echo "done $1"`);
    const source = createShellTaskSource(
      {
        kind: "shell",
        name: "test",
        commands: { fetch: "echo '[]'", markDone: `${doneScript} \${id}` },
      },
      fakeContext,
    );
    const sourceRef = { path: "/tmp/p.md", extra: { nested: 9 } };
    const issue: CanonicalIssue = {
      id: "test:x-1",
      source: "test",
      title: "",
      description: "",
      status: "in-review",
      repository: undefined,
      agent: undefined,
      assignee: "",
      updatedAt: "",
      blockers: [],
      hasMoreBlockers: false,
      sourceRef,
    };
    await expect(source.markDone?.(issue)).resolves.toStrictEqual({ outcome: "applied" });
    expect(readFileSync(stdinCapture, "utf8")).toBe(JSON.stringify(sourceRef));
  });

  it("fetch() works when commands.listTasks is used instead of commands.fetch", async () => {
    const script = dir.writeScript(
      "list.sh",
      `cat <<'JSON'\n${payload(shellIssue({ id: "X-2" }))}\nJSON`,
    );
    const source = createShellTaskSource(
      { kind: "shell", name: "test", commands: { listTasks: script } },
      fakeContext,
    );
    const issues = await source.fetch();
    expect(issues).toHaveLength(1);
    expect(issues[0]?.id).toBe("test:x-2");
  });

  it("resolveOne() uses commands.getTask when set instead of commands.resolveOne", async () => {
    const getTaskScript = dir.writeScript(
      "get.sh",
      `echo "{\\"id\\":\\"$1\\",\\"title\\":\\"t\\",\\"description\\":\\"\\",\\"status\\":\\"todo\\",\\"repository\\":null,\\"agent\\":null,\\"assignee\\":\\"u\\",\\"updatedAt\\":\\"2026-01-01T00:00:00Z\\",\\"blockers\\":[],\\"sourceRef\\":null}"`,
    );
    const source = createShellTaskSource(
      {
        kind: "shell",
        name: "test",
        commands: { fetch: "echo '[]'", getTask: `${getTaskScript} \${id}` },
      },
      fakeContext,
    );
    const issue = await source.resolveOne("X-2");
    expect(issue?.id).toBe("test:x-2");
  });

  it("warns to stderr when both commands.listTasks and commands.fetch are set", () => {
    const err = captureConsoleError();
    try {
      createShellTaskSource(
        { kind: "shell", name: "test", commands: { listTasks: "echo '[]'", fetch: "echo '[]'" } },
        fakeContext,
      );
    } finally {
      err.restore();
    }
    expect(err.output()).toContain("commands.fetch is ignored");
  });

  it("warns to stderr when both commands.getTask and commands.resolveOne are set", () => {
    const err = captureConsoleError();
    try {
      createShellTaskSource(
        {
          kind: "shell",
          name: "test",
          commands: {
            fetch: "echo '[]'",
            getTask: "./get.sh",
            resolveOne: "./resolve.sh",
          },
        },
        fakeContext,
      );
    } finally {
      err.restore();
    }
    expect(err.output()).toContain("commands.resolveOne is ignored");
  });

  it("createTask is absent on the source when commands.createTask is unset", () => {
    const source = createShellTaskSource(
      { kind: "shell", name: "test", commands: { fetch: "echo '[]'" } },
      fakeContext,
    );
    expect(source.createTask).toBeUndefined();
  });

  it("createTask is present on the source when commands.createTask is set", () => {
    const source = createShellTaskSource(
      { kind: "shell", name: "test", commands: { fetch: "echo '[]'", createTask: "echo '{}'" } },
      fakeContext,
    );
    expect(source.createTask).toBeDefined();
  });

  it("createTask expands every scalar (empty string for absent optionals), comma-joins list fields, and shell-quotes args", async () => {
    const capture = path.join(dir.path, "create-args.txt");
    // printf '%s\n' "$@" writes each received positional arg on its own line —
    // empty args become blank lines, proving the empty-string substitutions and
    // the shell-quoting (a spaced title arrives as ONE arg, not two).
    const createScript = dir.writeScript(
      "create.sh",
      `printf '%s\\n' "$@" > "${capture}"\ncat <<'JSON'\n${JSON.stringify(
        shellIssue({ id: "NEW-1" }),
      )}\nJSON`,
    );
    const source = createShellTaskSource(
      {
        kind: "shell",
        name: "test",
        commands: {
          fetch: "echo '[]'",
          createTask: `${createScript} \${title} \${agent} \${repo} \${team} \${id} \${priority} \${due} \${recurrence} \${promptFile} \${description} \${edit} \${projects} \${contexts} \${dependencies}`,
        },
      },
      fakeContext,
    );

    const created = await source.createTask?.(
      createInput({
        title: "My Task",
        agent: "claude",
        repository: "org/repo",
        priority: "A",
        projects: ["proj1", "proj2"],
        contexts: ["ctx1"],
        dependencies: ["dep1", "dep2"],
      }),
    );

    const expectedArgs = [
      "My Task",
      "claude",
      "org/repo",
      "",
      "",
      "A",
      "",
      "",
      "",
      "",
      "",
      "proj1,proj2",
      "ctx1",
      "dep1,dep2",
    ];
    expect(readFileSync(capture, "utf8")).toBe(`${expectedArgs.join("\n")}\n`);
    // The returned ShellIssue is parsed and converted to a canonical issue.
    expect(created?.id).toBe("test:new-1");
    expect(created?.source).toBe("test");
  });

  it("createTask exposes input.repository under both ${repo} and ${repository}", async () => {
    const capture = path.join(dir.path, "create-repo.txt");
    const createScript = dir.writeScript(
      "create-repo.sh",
      `printf '%s\\n' "$1" "$2" > "${capture}"\ncat <<'JSON'\n${JSON.stringify(
        shellIssue({ id: "NEW-3" }),
      )}\nJSON`,
    );
    const source = createShellTaskSource(
      {
        kind: "shell",
        name: "test",
        commands: { fetch: "echo '[]'", createTask: `${createScript} \${repo} \${repository}` },
      },
      fakeContext,
    );

    await source.createTask?.(createInput({ repository: "org/repo" }));

    expect(readFileSync(capture, "utf8")).toBe("org/repo\norg/repo\n");
  });

  it('createTask substitutes edit as the string "true" when input.edit is true', async () => {
    const capture = path.join(dir.path, "create-edit.txt");
    const createScript = dir.writeScript(
      "create-edit.sh",
      `printf '%s' "$1" > "${capture}"\ncat <<'JSON'\n${JSON.stringify(
        shellIssue({ id: "NEW-2" }),
      )}\nJSON`,
    );
    const source = createShellTaskSource(
      {
        kind: "shell",
        name: "test",
        commands: { fetch: "echo '[]'", createTask: `${createScript} \${edit}` },
      },
      fakeContext,
    );

    await source.createTask?.(createInput({ edit: true }));

    expect(readFileSync(capture, "utf8")).toBe("true");
  });

  it("createTask throws on a nonzero exit", async () => {
    const createScript = dir.writeScript("create-fail.sh", 'echo "boom" >&2; exit 1');
    const source = createShellTaskSource(
      {
        kind: "shell",
        name: "test",
        commands: { fetch: "echo '[]'", createTask: createScript },
      },
      fakeContext,
    );
    await expect(source.createTask?.(createInput())).rejects.toThrow(/boom/);
  });

  it("createTask throws when the script produces no output", async () => {
    const createScript = dir.writeScript("create-empty.sh", "exit 0");
    const source = createShellTaskSource(
      {
        kind: "shell",
        name: "test",
        commands: { fetch: "echo '[]'", createTask: createScript },
      },
      fakeContext,
    );
    await expect(source.createTask?.(createInput())).rejects.toThrow(/no output/i);
  });

  // invokeShellCommand resolves (does not throw) on exit 3 — its lookup
  // "not found" sentinel. Creation has no not-found concept, so exit 3 must
  // be a hard failure rather than a silently-parsed (or empty) result.
  it("createTask throws on exit 3 (the lookup not-found sentinel)", async () => {
    const createScript = dir.writeScript("create-nf.sh", "exit 3");
    const source = createShellTaskSource(
      {
        kind: "shell",
        name: "test",
        commands: { fetch: "echo '[]'", createTask: createScript },
      },
      fakeContext,
    );
    await expect(source.createTask?.(createInput())).rejects.toThrow(/exited 3/);
  });

  it("validate is absent on the source when commands.validate is unset", () => {
    const source = createShellTaskSource(
      { kind: "shell", name: "test", commands: { fetch: "echo '[]'" } },
      fakeContext,
    );
    expect(source.validate).toBeUndefined();
  });

  it("validate is present on the source when commands.validate is set", () => {
    const source = createShellTaskSource(
      { kind: "shell", name: "test", commands: { fetch: "echo '[]'", validate: "echo '[]'" } },
      fakeContext,
    );
    expect(source.validate).toBeDefined();
  });

  it("validate returns [] for empty stdout", async () => {
    const validateScript = dir.writeScript("validate-empty.sh", "exit 0");
    const source = createShellTaskSource(
      {
        kind: "shell",
        name: "test",
        commands: { fetch: "echo '[]'", validate: validateScript },
      },
      fakeContext,
    );
    await expect(source.validate?.()).resolves.toStrictEqual([]);
  });

  it("validate returns [] for a JSON empty array", async () => {
    const source = createShellTaskSource(
      { kind: "shell", name: "test", commands: { fetch: "echo '[]'", validate: "echo '[]'" } },
      fakeContext,
    );
    await expect(source.validate?.()).resolves.toStrictEqual([]);
  });

  it("validate returns the parsed error array", async () => {
    const validateScript = dir.writeScript(
      "validate-errors.sh",
      `cat <<'JSON'\n["error one","error two"]\nJSON`,
    );
    const source = createShellTaskSource(
      {
        kind: "shell",
        name: "test",
        commands: { fetch: "echo '[]'", validate: validateScript },
      },
      fakeContext,
    );
    await expect(source.validate?.()).resolves.toStrictEqual(["error one", "error two"]);
  });

  it("validate returns a one-element error array (does not throw) on a nonzero exit", async () => {
    const validateScript = dir.writeScript(
      "validate-fail.sh",
      'echo "validator crashed" >&2; exit 1',
    );
    const source = createShellTaskSource(
      {
        kind: "shell",
        name: "test",
        commands: { fetch: "echo '[]'", validate: validateScript },
      },
      fakeContext,
    );
    const errors = await source.validate?.();
    expect(errors).toHaveLength(1);
    expect(errors?.[0]).toMatch(/validate command failed/);
    expect(errors?.[0]).toMatch(/validator crashed/);
  });

  it("validate returns a one-element error array (does not throw) on exit 3", async () => {
    const validateScript = dir.writeScript("validate-nf.sh", "exit 3");
    const source = createShellTaskSource(
      {
        kind: "shell",
        name: "test",
        commands: { fetch: "echo '[]'", validate: validateScript },
      },
      fakeContext,
    );
    const errors = await source.validate?.();
    expect(errors).toHaveLength(1);
    expect(errors?.[0]).toMatch(/exited 3/);
  });

  it("validate returns a one-element error array (does not throw) on malformed stdout", async () => {
    const validateScript = dir.writeScript("validate-bad.sh", 'echo "not json"');
    const source = createShellTaskSource(
      {
        kind: "shell",
        name: "test",
        commands: { fetch: "echo '[]'", validate: validateScript },
      },
      fakeContext,
    );
    const errors = await source.validate?.();
    expect(errors).toHaveLength(1);
    expect(errors?.[0]).toMatch(/validate command failed/);
  });

  it("validate returns a one-element error array when stdout is a non-string-array JSON payload", async () => {
    const validateScript = dir.writeScript("validate-shape.sh", `echo '[1, 2, 3]'`);
    const source = createShellTaskSource(
      {
        kind: "shell",
        name: "test",
        commands: { fetch: "echo '[]'", validate: validateScript },
      },
      fakeContext,
    );
    const errors = await source.validate?.();
    expect(errors).toHaveLength(1);
    expect(errors?.[0]).toMatch(/validate command failed/);
  });
});
