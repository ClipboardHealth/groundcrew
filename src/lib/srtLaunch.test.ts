import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";

import { runCommand } from "./commandRunner.ts";
import type { AgentDefinition } from "./config.ts";
import { buildAndStageSrtLaunch } from "./srtLaunch.ts";

function definition(cmd: string): AgentDefinition {
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

  // A real git worktree dir — buildAndStageSrtLaunch reads its git common dir
  // off the checkout itself, so the staged dir must be an actual repo.
  function initWorktree(name: string): string {
    const dir = path.join(workspaceRoot, name);
    mkdirSync(dir, { recursive: true });
    runCommand("git", ["-C", dir, "init", "-q"]);
    return dir;
  }

  function stage(cmd: string): ReturnType<typeof buildAndStageSrtLaunch> {
    const result = buildAndStageSrtLaunch({
      task: "team-1",
      worktreeDir: initWorktree("repo-a-team-1"),
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
      task: "team-1",
      worktreeDir: initWorktree("repo-a-team-1"),
      definition: definition("claude --permission-mode auto"),
    });
    staged.push(result.directory);

    // claude doesn't relocate, so the real-home default is exercised without
    // copying anything out of it.
    expect(result.agentConfigDirEnv).toBeUndefined();
    expect(readSettings(result.agentFile).allowPty).toBe(true);
  });

  it("derives the sandbox gitCommonDir from the worktree, not a <projectDir>/<repo> clone", () => {
    // A scripted/sparse-checkout worktree: an external provisioner owns the
    // checkout, it lives at <worktreeDir>/<alias>-<task>, and there is no
    // <projectDir>/<alias> clone — `name` is just an alias. The sandbox must
    // fence off the worktree's real git common dir, not a phantom path built
    // from the alias.
    const worktreeDir = initWorktree("billing-team-1");
    const realCommonDir = runCommand("git", [
      "-C",
      worktreeDir,
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);

    const result = buildAndStageSrtLaunch({
      task: "team-1",
      worktreeDir,
      definition: definition("claude --permission-mode auto"),
      homeDir: fakeHome,
    });
    staged.push(result.directory);

    const reads = readSettings(result.agentFile).filesystem.allowRead;
    expect(reads).toContain(realCommonDir);
    // The old behavior granted <projectDir>/billing/.git — a path that doesn't
    // exist for a scripted worktree. It must never appear.
    expect(reads).not.toContain(path.join(workspaceRoot, "billing", ".git"));
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
