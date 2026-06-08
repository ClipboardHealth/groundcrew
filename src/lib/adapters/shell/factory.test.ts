/* eslint-disable no-template-curly-in-string -- this file constructs `${id}`-style placeholders as literal strings for the shell adapter's substitution mechanism; they're NOT JS template literals */

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { AdapterContext } from "../../adapterDefinition.ts";
import type { ResolvedConfig } from "../../config.ts";
import type { Issue as CanonicalIssue } from "../../taskSource.ts";

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
    model: overrides.model ?? null,
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

  it("converts nullable repository and model to undefined for the canonical type", () => {
    const result = toCanonicalIssue(shellIssue({ repository: null, model: null }), "jira");
    expect(result.repository).toBeUndefined();
    expect(result.model).toBeUndefined();
  });

  it("keeps repository/model when populated", () => {
    const result = toCanonicalIssue(
      shellIssue({ repository: "org/repo", model: "claude" }),
      "jira",
    );
    expect(result.repository).toBe("org/repo");
    expect(result.model).toBe("claude");
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
      `echo "{\\"id\\":\\"$1\\",\\"title\\":\\"t\\",\\"description\\":\\"\\",\\"status\\":\\"todo\\",\\"repository\\":null,\\"model\\":null,\\"assignee\\":\\"u\\",\\"updatedAt\\":\\"2026-01-01T00:00:00Z\\",\\"blockers\\":[],\\"sourceRef\\":null}"`,
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
      model: undefined,
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
      model: undefined,
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
      model: undefined,
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
      model: undefined,
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
      model: undefined,
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
      model: undefined,
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
      model: undefined,
      assignee: "",
      updatedAt: "",
      blockers: [],
      hasMoreBlockers: false,
      sourceRef,
    };
    await expect(source.markDone?.(issue)).resolves.toStrictEqual({ outcome: "applied" });
    expect(readFileSync(stdinCapture, "utf8")).toBe(JSON.stringify(sourceRef));
  });
});
