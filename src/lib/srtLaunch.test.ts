import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";

import type { ModelDefinition, ResolvedConfig } from "./config.ts";
import { buildAndStageSrtLaunch } from "./srtLaunch.ts";

function config(projectDir: string, repositoryDirs?: Record<string, string>): ResolvedConfig {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the helper only reads workspace.{projectDir,repositoryDirs} off config
  return {
    workspace: {
      projectDir,
      ...(repositoryDirs === undefined ? {} : { repositoryDirs }),
    },
  } as unknown as ResolvedConfig;
}

function definition(cmd: string): ModelDefinition {
  return { cmd, color: "#fff" };
}

function readSettings(file: string): SandboxRuntimeConfig {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- staged settings are SandboxRuntimeConfig JSON
  return JSON.parse(readFileSync(file, "utf8")) as SandboxRuntimeConfig;
}

describe(buildAndStageSrtLaunch, () => {
  let workspaceRoot: string;
  let fakeHome: string;
  const staged: string[] = [];

  beforeEach(() => {
    workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "srt-launch-ws-"));
    fakeHome = mkdtempSync(path.join(os.tmpdir(), "srt-launch-home-"));
  });

  afterEach(() => {
    for (const dir of [workspaceRoot, fakeHome, ...staged]) {
      rmSync(dir, { recursive: true, force: true });
    }
    staged.length = 0;
  });

  function stage(cmd: string): ReturnType<typeof buildAndStageSrtLaunch> {
    const result = buildAndStageSrtLaunch({
      config: config(workspaceRoot),
      repository: "repo-a",
      task: "team-1",
      worktreeDir: path.join(workspaceRoot, "repo-a-team-1"),
      definition: definition(cmd),
      homeDir: fakeHome,
    });
    staged.push(result.directory);
    return result;
  }

  it("stages distinct prepare + agent settings and no relocated home for a read-only agent (claude)", () => {
    const result = stage("claude --permission-mode auto");

    expect(result.prepareFile).toBe(path.join(result.directory, "prepare-settings.json"));
    expect(result.agentFile).toBe(path.join(result.directory, "agent-settings.json"));
    expect(result.agentConfigDirEnv).toBeUndefined();

    const agent = readSettings(result.agentFile);
    const prepare = readSettings(result.prepareFile);
    // claude gets a writable home with .claude.json (mcpServers) denied; the
    // prepare policy gets neither.
    expect(agent.filesystem.allowRead?.some((p) => p.endsWith("/.claude"))).toBe(true);
    expect(agent.filesystem.allowWrite.some((p) => p.endsWith("/.claude"))).toBe(true);
    expect(agent.filesystem.denyWrite.some((p) => p.endsWith("/.claude.json"))).toBe(true);
    expect(prepare.filesystem.allowRead?.some((p) => p.endsWith("/.claude"))).toBe(false);
  });

  it("relocates a writable config home for codex, seeding its creds + config and exposing CODEX_HOME", () => {
    const realCodex = path.join(fakeHome, ".codex");
    mkdirSync(realCodex, { recursive: true });
    writeFileSync(path.join(realCodex, "auth.json"), '{"token":"x"}');
    writeFileSync(path.join(realCodex, "config.toml"), "model = 'gpt'\n");

    const result = stage("codex --dangerously-bypass-approvals-and-sandbox");

    const relocated = path.join(result.directory, "codex-home");
    expect(result.agentConfigDirEnv).toStrictEqual({ name: "CODEX_HOME", value: relocated });
    expect(readFileSync(path.join(relocated, "auth.json"), "utf8")).toBe('{"token":"x"}');
    expect(readFileSync(path.join(relocated, "config.toml"), "utf8")).toBe("model = 'gpt'\n");
    // The agent policy grants the relocated home write but never the real ~/.codex.
    const agent = readSettings(result.agentFile);
    expect(agent.filesystem.allowWrite).toContain(relocated);
    expect(agent.filesystem.allowWrite.some((p) => p.endsWith("/.codex"))).toBe(false);
  });

  it("defaults to the real home dir when none is injected (read-only agent, no seeding side effects)", () => {
    const result = buildAndStageSrtLaunch({
      config: config(workspaceRoot),
      repository: "repo-a",
      task: "team-1",
      worktreeDir: path.join(workspaceRoot, "repo-a-team-1"),
      definition: definition("claude --permission-mode auto"),
    });
    staged.push(result.directory);

    // claude doesn't relocate, so the real-home default is exercised without
    // copying anything out of it.
    expect(result.agentConfigDirEnv).toBeUndefined();
    expect(readSettings(result.agentFile).allowPty).toBe(true);
  });

  it("resolves gitCommonDir under the repo's per-repo dir override", () => {
    const other = mkdtempSync(path.join(os.tmpdir(), "srt-launch-other-"));
    staged.push(other);
    const result = buildAndStageSrtLaunch({
      config: config(workspaceRoot, { "owner/repo": other }),
      repository: "owner/repo",
      task: "team-9",
      worktreeDir: path.join(workspaceRoot, "owner", "repo-team-9"),
      definition: definition("claude --permission-mode auto"),
      homeDir: fakeHome,
    });
    staged.push(result.directory);

    // gitCommonDir is <repoDir>/.git == <other>/owner/repo/.git, not under projectDir.
    const expectedGitDir = path.join(other, "owner", "repo", ".git");
    expect(JSON.stringify(readSettings(result.agentFile))).toContain(expectedGitDir);
  });

  it("skips missing seed files (best-effort) so a not-logged-in agent still stages", () => {
    const realCodex = path.join(fakeHome, ".codex");
    mkdirSync(realCodex, { recursive: true });
    // Only config.toml present; auth.json absent (user not logged into codex).
    writeFileSync(path.join(realCodex, "config.toml"), "model = 'gpt'\n");

    const result = stage("codex");

    const relocated = path.join(result.directory, "codex-home");
    expect(readFileSync(path.join(relocated, "config.toml"), "utf8")).toBe("model = 'gpt'\n");
    expect(() => readFileSync(path.join(relocated, "auth.json"), "utf8")).toThrow(/ENOENT/);
  });
});
