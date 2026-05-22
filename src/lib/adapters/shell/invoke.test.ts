/* eslint-disable no-template-curly-in-string -- this file constructs `${id}`-style placeholders as literal strings for the shell adapter's substitution mechanism; they're NOT JS template literals */

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applySubstitutions, invokeShellCommand, ShellAdapterTimeoutError } from "./invoke.ts";

interface TempDir {
  path: string;
  writeScript: (name: string, body: string) => string;
  cleanup: () => void;
}

function makeTempDir(): TempDir {
  const path = mkdtempSync(join(tmpdir(), "shell-invoke-test-"));
  return {
    path,
    writeScript(name: string, body: string): string {
      const scriptPath = join(path, name);
      writeFileSync(scriptPath, `#!/usr/bin/env bash\n${body}\n`);
      chmodSync(scriptPath, 0o755);
      return scriptPath;
    },
    cleanup(): void {
      rmSync(path, { recursive: true, force: true });
    },
  };
}

describe(applySubstitutions, () => {
  it("replaces ${id} with a shell-quoted value", () => {
    const result = applySubstitutions("./show.sh ${id}", { id: "abc" });
    expect(result).toBe("./show.sh 'abc'");
  });

  it("shell-quotes single quotes inside the substituted value", () => {
    const result = applySubstitutions("./show.sh ${id}", { id: "it's tricky" });
    expect(result).toBe(String.raw`./show.sh 'it'\''s tricky'`);
  });

  it("replaces multiple placeholders", () => {
    const result = applySubstitutions("./run.sh ${name} ${id}", {
      name: "jira",
      id: "ENG-1",
    });
    expect(result).toBe("./run.sh 'jira' 'ENG-1'");
  });

  it("leaves the command unchanged when no placeholders match", () => {
    const result = applySubstitutions("echo hello", { id: "x" });
    expect(result).toBe("echo hello");
  });
});

describe(invokeShellCommand, () => {
  let dir: TempDir;
  beforeEach(() => {
    dir = makeTempDir();
  });
  afterEach(() => {
    dir.cleanup();
  });

  it("returns stdout on exit 0", async () => {
    const script = dir.writeScript("ok.sh", 'echo "hello"');
    const result = await invokeShellCommand({
      command: script,
      timeoutMs: 5000,
      sourceName: "test",
    });
    expect(result.stdout.trim()).toBe("hello");
    expect(result.exitCode).toBe(0);
  });

  it("throws on nonzero exit with stderr content in the error message", async () => {
    const script = dir.writeScript("bad.sh", 'echo "err message" >&2; exit 1');
    await expect(
      invokeShellCommand({ command: script, timeoutMs: 5000, sourceName: "test" }),
    ).rejects.toThrow(/err message/);
  });

  it("falls back to the command when stderr is empty on nonzero exit", async () => {
    const script = dir.writeScript("silent.sh", "exit 2");
    await expect(
      invokeShellCommand({ command: script, timeoutMs: 5000, sourceName: "test" }),
    ).rejects.toThrow(/exit 2/);
  });

  it("returns exit 3 as a structured 'not found' code (no throw)", async () => {
    const script = dir.writeScript("nf.sh", "exit 3");
    const result = await invokeShellCommand({
      command: script,
      timeoutMs: 5000,
      sourceName: "test",
    });
    expect(result.exitCode).toBe(3);
  });

  it("kills the subprocess on timeout", async () => {
    const script = dir.writeScript("slow.sh", "sleep 5; echo done");
    await expect(
      invokeShellCommand({ command: script, timeoutMs: 200, sourceName: "test" }),
    ).rejects.toThrow(ShellAdapterTimeoutError);
  });

  it("pipes stdin to the subprocess", async () => {
    const script = dir.writeScript("stdin.sh", "cat");
    const result = await invokeShellCommand({
      command: script,
      timeoutMs: 5000,
      stdin: "hello stdin",
      sourceName: "test",
    });
    expect(result.stdout).toContain("hello stdin");
  });

  it("applies ${id} substitution and shell-quotes the value", async () => {
    const script = dir.writeScript("show.sh", 'echo "$1"');
    const result = await invokeShellCommand({
      command: `${script} \${id}`,
      timeoutMs: 5000,
      substitutions: { id: "'; rm -rf /; echo '" },
      sourceName: "test",
    });
    // The literal value made it through as a single argument; the injection
    // attempt was contained by single-quoting.
    expect(result.stdout).toContain("'; rm -rf /; echo '");
  });

  it("forwards user-supplied env vars to the subprocess", async () => {
    const script = dir.writeScript("env.sh", 'echo "$MY_VAR"');
    const result = await invokeShellCommand({
      command: script,
      timeoutMs: 5000,
      env: { MY_VAR: "passed through" },
      sourceName: "test",
    });
    expect(result.stdout.trim()).toBe("passed through");
  });

  it("captures stderr to stderr field and surfaces it in logs on close", async () => {
    const script = dir.writeScript("warn.sh", 'echo "warning text" >&2; echo "ok"');
    const result = await invokeShellCommand({
      command: script,
      timeoutMs: 5000,
      sourceName: "test",
    });
    expect(result.stderr).toContain("warning text");
    expect(result.stdout.trim()).toBe("ok");
  });
});
