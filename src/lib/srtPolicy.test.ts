import { SandboxRuntimeConfigSchema } from "@anthropic-ai/sandbox-runtime";

import { buildSrtSettings } from "./srtPolicy.ts";

function input(
  overrides: Partial<Parameters<typeof buildSrtSettings>[0]> = {},
): Parameters<typeof buildSrtSettings>[0] {
  return {
    worktreeDir: "/work/repo-a-team-1",
    gitCommonDir: "/work/repo-a/.git",
    agent: "claude",
    allowedDomains: ["api.anthropic.com", "*.npmjs.org"],
    platform: "linux",
    homeDir: "/home/dev",
    nodeExecPath: "/home/dev/.nvm/versions/node/v24/bin/node",
    ...overrides,
  };
}

describe(buildSrtSettings, () => {
  it("masks the whole home region and WSL Windows mounts on Linux, re-opening the workspace", () => {
    const actual = buildSrtSettings(input());

    expect(actual.filesystem.denyRead).toStrictEqual(["/home", "/root", "/mnt"]);
    expect(actual.filesystem.allowRead).toContain("/work/repo-a-team-1");
    expect(actual.filesystem.allowRead).toContain("/work/repo-a/.git");
    expect(actual.filesystem.allowWrite).toContain("/work/repo-a-team-1");
    expect(actual.filesystem.allowWrite).toContain("/work/repo-a/.git");
  });

  it("masks /Users (not /home) on macOS", () => {
    const actual = buildSrtSettings(input({ platform: "darwin", homeDir: "/Users/dev" }));

    expect(actual.filesystem.denyRead).toStrictEqual(["/Users"]);
  });

  it("re-opens the node runtime and toolchains read-only so the agent can execute", () => {
    const actual = buildSrtSettings(input());

    expect(actual.filesystem.allowRead).toContain("/home/dev/.nvm/versions/node/v24");
    expect(actual.filesystem.allowRead).toContain("/home/dev/.nvm");
    expect(actual.filesystem.allowRead).toContain("/home/dev/.cargo/bin");
    expect(actual.filesystem.allowRead).toContain("/home/dev/.gitconfig");
  });

  it("narrows credential-bearing toolchain homes to runtime subpaths (allowRead wins over denyRead)", () => {
    const actual = buildSrtSettings(input());

    // Re-opened: the runtime/cache subpaths needed to execute toolchains...
    expect(actual.filesystem.allowRead).toContain("/home/dev/.cargo/registry");
    expect(actual.filesystem.allowRead).toContain("/home/dev/.local/bin");
    // ...but NOT the whole homes, which hold credentials/app state that the
    // home mask must keep hidden (`~/.cargo/credentials.toml`, `~/.local/share`).
    expect(actual.filesystem.allowRead).not.toContain("/home/dev/.cargo");
    expect(actual.filesystem.allowRead).not.toContain("/home/dev/.local");
  });

  it("re-opens the agent's own credential dirs per profile", () => {
    const claude = buildSrtSettings(input({ agent: "claude" }));
    expect(claude.filesystem.allowRead).toContain("/home/dev/.claude");
    expect(claude.filesystem.allowWrite).toContain("/home/dev/.claude.json");

    const codex = buildSrtSettings(input({ agent: "codex" }));
    expect(codex.filesystem.allowRead).toContain("/home/dev/.codex");
    expect(codex.filesystem.allowWrite).toContain("/home/dev/.codex");
  });

  it("denies the agent's executable/instruction surfaces within its writable state dir", () => {
    const claude = buildSrtSettings(input({ agent: "claude" }));
    // The state dir stays writable, but every surface that would let a prompted
    // agent persist across host runs is carved back out (validated against the
    // real ~/.claude layout: hooks, statusline script, global instructions, …).
    expect(claude.filesystem.allowWrite).toContain("/home/dev/.claude");
    for (const denied of [
      "/home/dev/.claude/settings.json",
      "/home/dev/.claude/settings.local.json",
      "/home/dev/.claude/plugins",
      "/home/dev/.claude/skills",
      "/home/dev/.claude/hooks",
      "/home/dev/.claude/statusline.sh",
      "/home/dev/.claude/CLAUDE.md",
      "/home/dev/.claude/.git/hooks",
      "/home/dev/.claude/.git/config",
    ]) {
      expect(claude.filesystem.denyWrite).toContain(denied);
    }

    const codex = buildSrtSettings(input({ agent: "codex" }));
    for (const denied of [
      "/home/dev/.codex/config.toml",
      "/home/dev/.codex/hooks.json",
      "/home/dev/.codex/AGENTS.md",
      "/home/dev/.codex/plugins",
      "/home/dev/.codex/skills",
      "/home/dev/.codex/rules",
      "/home/dev/.codex/.git/hooks",
      "/home/dev/.codex/.git/config",
    ]) {
      expect(codex.filesystem.denyWrite).toContain(denied);
    }

    // Cross-agent: a profile denies the home dirs it does not own (this also
    // overrides srt's hardcoded `~/.claude/debug` default write path).
    expect(claude.filesystem.denyWrite).toContain("/home/dev/.codex");
    expect(claude.filesystem.denyWrite).not.toContain("/home/dev/.claude");
    expect(codex.filesystem.denyWrite).toContain("/home/dev/.claude");
    expect(codex.filesystem.denyWrite).not.toContain("/home/dev/.codex");
  });

  it("grants no agent credential access for a profile-neutral (empty) agent — the prepare policy", () => {
    const prepare = buildSrtSettings(input({ agent: "" }));

    // The repo-controlled prepareWorktree hook gets toolchains + worktree + npm
    // cache, but never the agent's credential dirs...
    expect(prepare.filesystem.allowRead).not.toContain("/home/dev/.claude");
    expect(prepare.filesystem.allowWrite).not.toContain("/home/dev/.claude");
    expect(prepare.filesystem.allowRead).not.toContain("/home/dev/.codex");
    expect(prepare.filesystem.allowRead).toContain("/home/dev/.nvm");
    expect(prepare.filesystem.allowWrite).toContain("/home/dev/.npm");
    // ...and both are denied write, so srt's default `~/.claude/debug` write
    // path can't re-open Claude state under the neutral policy.
    expect(prepare.filesystem.denyWrite).toContain("/home/dev/.claude");
    expect(prepare.filesystem.denyWrite).toContain("/home/dev/.codex");
  });

  it("grants no extra home access for an unknown agent but keeps toolchains", () => {
    const actual = buildSrtSettings(input({ agent: "mystery" }));

    expect(actual.filesystem.allowRead).not.toContain("/home/dev/.claude");
    expect(actual.filesystem.allowWrite).not.toContain("/home/dev/.claude");
    expect(actual.filesystem.allowRead).toContain("/home/dev/.nvm");
  });

  it("denies writes to global toolchain locations, git config/hooks, and the worktree .git pointer", () => {
    const actual = buildSrtSettings(input());

    expect(actual.filesystem.denyWrite).toContain(
      "/home/dev/.nvm/versions/node/v24/lib/node_modules",
    );
    expect(actual.filesystem.denyWrite).toContain("/home/dev/.nvm/versions/node/v24/bin");
    expect(actual.filesystem.denyWrite).toContain("/home/dev/.cargo/bin");
    expect(actual.filesystem.denyWrite).toContain("/home/dev/.npm/_npx");
    expect(actual.filesystem.denyWrite).toContain("/work/repo-a/.git/config");
    expect(actual.filesystem.denyWrite).toContain("/work/repo-a/.git/hooks");
    // Nested git persistence surfaces: submodule gitdirs and per-worktree config.
    expect(actual.filesystem.denyWrite).toContain("/work/repo-a/.git/modules");
    expect(actual.filesystem.denyWrite).toContain(
      "/work/repo-a/.git/worktrees/repo-a-team-1/config.worktree",
    );
    // The linked-worktree `.git` pointer file itself — can't be redirected.
    expect(actual.filesystem.denyWrite).toContain("/work/repo-a-team-1/.git");
  });

  it("never emits glob patterns in filesystem rules (bubblewrap ignores them on Linux)", () => {
    const actual = buildSrtSettings(input());

    // Network allowedDomains legitimately use `*.` wildcards, so scope this to
    // the filesystem block, which must stay literal for bubblewrap on Linux.
    expect(JSON.stringify(actual.filesystem)).not.toContain("*");
  });

  it("builds an allow-only network policy from the clearance allowlist with sockets and local binding off", () => {
    const actual = buildSrtSettings(input());

    expect(actual.network.allowedDomains).toStrictEqual(["api.anthropic.com", "*.npmjs.org"]);
    expect(actual.network.deniedDomains).toStrictEqual([]);
    expect(actual.network.allowLocalBinding).toBe(false);
    expect(actual.network.allowAllUnixSockets).toBe(false);
    expect(actual.network.allowUnixSockets).toStrictEqual([]);
  });

  it("enables pty for the interactive agent and keeps git config writes locked", () => {
    const actual = buildSrtSettings(input());

    expect(actual.allowPty).toBe(true);
    expect(actual.filesystem.allowGitConfig).toBe(false);
  });

  it("produces a config that satisfies srt's own runtime schema", () => {
    const actual = buildSrtSettings(input());

    expect(() => SandboxRuntimeConfigSchema.parse(actual)).not.toThrow();
  });

  it("throws (fails closed) rather than emitting settings srt would reject and run unsandboxed", () => {
    // A malformed domain (scheme/port/path) makes srt's loadConfig return null,
    // which silently disables the read mask — so we refuse to stage it.
    expect(() => buildSrtSettings(input({ allowedDomains: ["https://api.github.com"] }))).toThrow(
      /failed validation.*refusing to launch unsandboxed/i,
    );
  });

  it("falls back to the current process platform/home/node when not injected", () => {
    const actual = buildSrtSettings({
      worktreeDir: "/work/repo-a-team-1",
      gitCommonDir: "/work/repo-a/.git",
      agent: "claude",
      allowedDomains: [],
    });

    // No injected platform/homeDir/nodeExecPath: the defaults must still yield a
    // valid, non-empty policy that re-opens the workspace.
    expect(actual.filesystem.denyRead.length).toBeGreaterThan(0);
    expect(actual.filesystem.allowRead).toContain("/work/repo-a-team-1");
    expect(() => SandboxRuntimeConfigSchema.parse(actual)).not.toThrow();
  });
});
