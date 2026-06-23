import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { runCommand } from "./commandRunner.ts";
import { writeCursorProjectHooks } from "./cursorProjectHooks.ts";

interface CursorHooksFile {
  version: number;
  hooks: Record<string, Array<{ command: string }>>;
}

function initRepo(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "groundcrew-cursor-hooks-"));
  runCommand("git", ["-C", dir, "init", "-q"]);
  runCommand("git", ["-C", dir, "config", "user.email", "test@example.com"]);
  runCommand("git", ["-C", dir, "config", "user.name", "Test"]);
  return dir;
}

function readHooks(dir: string): CursorHooksFile {
  const parsed: unknown = JSON.parse(readFileSync(path.join(dir, ".cursor", "hooks.json"), "utf8"));
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("hooks.json did not parse to an object");
  }
  return parsed as CursorHooksFile;
}

function eventCommands(file: CursorHooksFile, event: string): Array<{ command: string }> {
  const commands = file.hooks[event];
  if (commands === undefined) {
    throw new Error(`No cursor hooks for event ${event}`);
  }

  return commands;
}

function gitExcludeContents(dir: string): string {
  const excludePath = path.join(dir, ".git", "info", "exclude");
  return existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
}

describe(writeCursorProjectHooks, () => {
  let repo: string;

  beforeEach(() => {
    repo = initRepo();
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("writes the cursor lifecycle hooks into <worktree>/.cursor/hooks.json", () => {
    writeCursorProjectHooks({ workingDir: repo, worktreeDir: repo, agent: "cursor" });

    const hooks = readHooks(repo);
    expect(Object.keys(hooks.hooks)).toContain("stop");
    expect(hooks.hooks["stop"]?.[0]?.command).toContain("set-progress");
    expect(hooks.hooks["sessionStart"]?.[0]?.command).toContain("running · cursor");
  });

  it("git-excludes the staged file so it never lands in a PR", () => {
    writeCursorProjectHooks({ workingDir: repo, worktreeDir: repo, agent: "cursor" });

    expect(gitExcludeContents(repo)).toContain(path.join(".cursor", "hooks.json"));
  });

  it("preserves a repo's own untracked hooks and stays idempotent across resumes", () => {
    const cursorDir = path.join(repo, ".cursor");
    runCommand("mkdir", ["-p", cursorDir]);
    writeFileSync(
      path.join(cursorDir, "hooks.json"),
      JSON.stringify({
        version: 1,
        hooks: { stop: [{ command: "bun run ./hooks/repo-stop.ts" }] },
      }),
    );

    writeCursorProjectHooks({ workingDir: repo, worktreeDir: repo, agent: "cursor" });
    writeCursorProjectHooks({ workingDir: repo, worktreeDir: repo, agent: "cursor" });

    const stop = eventCommands(readHooks(repo), "stop");
    const repoCommands = stop.filter((entry) => entry.command.includes("repo-stop.ts"));
    const ourCommands = stop.filter((entry) => entry.command.includes("set-progress"));
    expect(repoCommands).toHaveLength(1);
    expect(ourCommands).toHaveLength(1);
  });

  it("leaves a repo-tracked hooks file untouched", () => {
    const cursorDir = path.join(repo, ".cursor");
    runCommand("mkdir", ["-p", cursorDir]);
    const original = JSON.stringify({ version: 1, hooks: { stop: [{ command: "repo-owned" }] } });
    writeFileSync(path.join(cursorDir, "hooks.json"), original);
    runCommand("git", ["-C", repo, "add", path.join(".cursor", "hooks.json")]);
    runCommand("git", ["-C", repo, "commit", "-q", "-m", "track cursor hooks"]);

    writeCursorProjectHooks({ workingDir: repo, worktreeDir: repo, agent: "cursor" });

    expect(readFileSync(path.join(cursorDir, "hooks.json"), "utf8")).toBe(original);
  });
});
