import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { runCommand } from "./commandRunner.ts";
import { writeCmuxAgentProjectSettings } from "./cmuxProjectSettings.ts";

let worktreeDir: string;

function settingsPath(): string {
  return path.join(worktreeDir, ".claude", "settings.local.json");
}

function readSettingsRaw(): string {
  return readFileSync(settingsPath(), "utf8");
}

function readSettings(): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readSettingsRaw());
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("settings.local.json is not a JSON object");
  }
  return { ...parsed };
}

function excludeFile(): string {
  return runCommand("git", [
    "-C",
    worktreeDir,
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "info/exclude",
  ]);
}

function excludeContents(): string {
  const file = excludeFile();
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

beforeEach(() => {
  // Strip inherited GIT_* env vars so the temp-repo git calls run against the
  // temp worktree, not whatever repo invoked vitest (e.g. a `git push` pre-push
  // hook that exports GIT_DIR, which would override the `git -C <tempdir>` flag).
  // oxlint-disable-next-line unicorn/no-useless-undefined -- undefined is the unset signal here
  vi.stubEnv("GIT_DIR", undefined);
  // oxlint-disable-next-line unicorn/no-useless-undefined
  vi.stubEnv("GIT_WORK_TREE", undefined);
  // oxlint-disable-next-line unicorn/no-useless-undefined
  vi.stubEnv("GIT_INDEX_FILE", undefined);
  worktreeDir = mkdtempSync(path.join(os.tmpdir(), "gc-project-hooks-"));
  runCommand("git", ["-C", worktreeDir, "init", "-q"]);
  runCommand("git", ["-C", worktreeDir, "config", "user.email", "test@example.com"]);
  runCommand("git", ["-C", worktreeDir, "config", "user.name", "Test"]);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(worktreeDir, { recursive: true, force: true });
});

describe(writeCmuxAgentProjectSettings, () => {
  it("writes the Claude activity hooks to .claude/settings.local.json", () => {
    writeCmuxAgentProjectSettings({ worktreeDir, agentCommandName: "claude" });

    expect(readSettings()["hooks"]).toMatchObject({ SessionStart: expect.any(Array) });
    expect(readSettingsRaw()).toContain("set-progress");
  });

  it("git-excludes the settings file so it is never committed", () => {
    writeCmuxAgentProjectSettings({ worktreeDir, agentCommandName: "claude" });

    expect(excludeContents()).toContain("/.claude/settings.local.json");
    const status = runCommand("git", ["-C", worktreeDir, "status", "--porcelain"]);
    expect(status).not.toContain("settings.local.json");
  });

  it("creates the git exclude file when the repo has none", () => {
    rmSync(excludeFile());

    writeCmuxAgentProjectSettings({ worktreeDir, agentCommandName: "claude" });

    expect(excludeContents()).toBe("/.claude/settings.local.json\n");
  });

  it("appends the exclude pattern after content that lacks a trailing newline", () => {
    writeFileSync(excludeFile(), "*.log");

    writeCmuxAgentProjectSettings({ worktreeDir, agentCommandName: "claude" });

    expect(excludeContents()).toBe("*.log\n/.claude/settings.local.json\n");
  });

  it("does not duplicate the git-exclude pattern across launches", () => {
    writeCmuxAgentProjectSettings({ worktreeDir, agentCommandName: "claude" });
    writeCmuxAgentProjectSettings({ worktreeDir, agentCommandName: "claude" });

    expect(countOccurrences(excludeContents(), "/.claude/settings.local.json")).toBe(1);
  });

  it("writes nothing for an agent without a hook integration", () => {
    writeCmuxAgentProjectSettings({ worktreeDir, agentCommandName: "codex" });

    expect(existsSync(settingsPath())).toBe(false);
  });

  it("skips the write when the repo already tracks the settings file", () => {
    mkdirSync(path.dirname(settingsPath()), { recursive: true });
    const tracked = '{ "committed": true }\n';
    writeFileSync(settingsPath(), tracked);
    runCommand("git", ["-C", worktreeDir, "add", "-f", ".claude/settings.local.json"]);
    runCommand("git", ["-C", worktreeDir, "commit", "-q", "-m", "track settings"]);

    writeCmuxAgentProjectSettings({ worktreeDir, agentCommandName: "claude" });

    expect(readSettingsRaw()).toBe(tracked);
  });

  it("merges into a pre-existing file, preserving unrelated user settings", () => {
    mkdirSync(path.dirname(settingsPath()), { recursive: true });
    writeFileSync(
      settingsPath(),
      JSON.stringify({
        permissions: { allow: ["Bash(npm run test)"] },
        hooks: {
          SessionStart: [{ hooks: [{ type: "command", command: "echo user-owned" }] }],
        },
      }),
    );

    writeCmuxAgentProjectSettings({ worktreeDir, agentCommandName: "claude" });

    const settings = readSettings();
    expect(settings["permissions"]).toStrictEqual({ allow: ["Bash(npm run test)"] });
    const serialized = JSON.stringify(settings["hooks"]);
    expect(serialized).toContain("echo user-owned");
    expect(serialized).toContain("set-progress");
  });

  it("preserves prior hook groups it does not recognize as its own", () => {
    mkdirSync(path.dirname(settingsPath()), { recursive: true });
    writeFileSync(
      settingsPath(),
      JSON.stringify({
        hooks: {
          SessionStart: [
            "not-an-object",
            { notHooks: 1 },
            { hooks: [] },
            { hooks: ["bare-string-hook"] },
            { hooks: [{ command: 42 }] },
            { hooks: [{ type: "command", command: "echo user-owned" }] },
          ],
        },
      }),
    );

    writeCmuxAgentProjectSettings({ worktreeDir, agentCommandName: "claude" });

    const serialized = JSON.stringify(readSettings()["hooks"]);
    expect(serialized).toContain("not-an-object");
    expect(serialized).toContain("bare-string-hook");
    expect(serialized).toContain("echo user-owned");
    expect(serialized).toContain("set-progress");
  });

  it("ignores a settings file whose JSON is not an object", () => {
    mkdirSync(path.dirname(settingsPath()), { recursive: true });
    writeFileSync(settingsPath(), "[1, 2, 3]");

    writeCmuxAgentProjectSettings({ worktreeDir, agentCommandName: "claude" });

    expect(readSettings()["hooks"]).toMatchObject({ SessionStart: expect.any(Array) });
  });

  it("propagates a read error that is not a missing file", () => {
    mkdirSync(settingsPath(), { recursive: true });

    expect(() => {
      writeCmuxAgentProjectSettings({ worktreeDir, agentCommandName: "claude" });
    }).toThrow(/EISDIR/);
  });

  it("replaces prior groundcrew hook entries instead of stacking them", () => {
    writeCmuxAgentProjectSettings({ worktreeDir, agentCommandName: "claude" });
    const firstWrite = readSettingsRaw();

    writeCmuxAgentProjectSettings({ worktreeDir, agentCommandName: "claude" });
    const secondWrite = readSettingsRaw();

    expect(secondWrite).toBe(firstWrite);
    expect(countOccurrences(secondWrite, "set-progress")).toBe(5);
  });
});
