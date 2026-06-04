import { SandboxRuntimeConfigSchema } from "@anthropic-ai/sandbox-runtime";

import { agentConfigRelocation, buildSrtSettings } from "./srtPolicy.ts";

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

    expect(actual.filesystem.allowRead).toContain("/home/dev/.cargo/registry");
    expect(actual.filesystem.allowRead).toContain("/home/dev/.local/bin");
    expect(actual.filesystem.allowRead).not.toContain("/home/dev/.cargo");
    expect(actual.filesystem.allowRead).not.toContain("/home/dev/.local");
  });

  describe("agent state isolation (work item 1)", () => {
    it("gives claude a writable home but denies every fixed-path executable surface (incl .claude.json + chrome)", () => {
      const actual = buildSrtSettings(input({ agent: "claude" }));

      // Writable home so the Bash tool's session-env / scratch state works...
      expect(actual.filesystem.allowRead).toContain("/home/dev/.claude");
      expect(actual.filesystem.allowRead).toContain("/home/dev/.claude.json");
      expect(actual.filesystem.allowWrite).toContain("/home/dev/.claude");
      // ...but every surface that would let a prompted agent persist across host
      // runs is carved back out (denyWrite beats allowWrite).
      for (const denied of [
        "/home/dev/.claude.json",
        "/home/dev/.claude/settings.json",
        "/home/dev/.claude/settings.local.json",
        "/home/dev/.claude/commands",
        "/home/dev/.claude/agents",
        "/home/dev/.claude/plugins",
        "/home/dev/.claude/skills",
        "/home/dev/.claude/hooks",
        "/home/dev/.claude/statusline.sh",
        "/home/dev/.claude/CLAUDE.md",
        "/home/dev/.claude/chrome",
        "/home/dev/.claude/.git/hooks",
        "/home/dev/.claude/.git/config",
      ]) {
        expect(actual.filesystem.denyWrite).toContain(denied);
      }
      // .claude.json is granted read (claude loads its config) but never write.
      expect(actual.filesystem.allowWrite).not.toContain("/home/dev/.claude.json");
    });

    it("keeps codex's real home read-only (relocated) — read but never write", () => {
      const actual = buildSrtSettings(input({ agent: "codex" }));

      expect(actual.filesystem.allowRead).toContain("/home/dev/.codex");
      expect(actual.filesystem.allowWrite).not.toContain("/home/dev/.codex");
      expect(actual.filesystem.denyWrite).toContain("/home/dev/.codex");
    });

    it("denies each agent the home dirs it does not own (cross-agent + srt ~/.claude/debug override)", () => {
      // claude owns its writable ~/.claude, so it is not self-denied, but it
      // can't write ~/.codex.
      const claude = buildSrtSettings(input({ agent: "claude" }));
      expect(claude.filesystem.denyWrite).toContain("/home/dev/.codex");
      expect(claude.filesystem.denyWrite).not.toContain("/home/dev/.claude");

      // codex relocates (no writable real home) + the neutral prepare policy and
      // an unknown agent own neither — all deny both real homes.
      for (const agent of ["codex", "", "mystery"]) {
        const actual = buildSrtSettings(input({ agent }));
        expect(actual.filesystem.denyWrite).toContain("/home/dev/.claude");
        expect(actual.filesystem.denyWrite).toContain("/home/dev/.codex");
      }
    });

    it("grants a relocated, writable config home (read + write) when one is staged, e.g. codex", () => {
      const actual = buildSrtSettings(
        input({ agent: "codex", relocatedConfigDir: "/tmp/groundcrew-srt-team-1/codex-home" }),
      );

      expect(actual.filesystem.allowWrite).toContain("/tmp/groundcrew-srt-team-1/codex-home");
      expect(actual.filesystem.allowRead).toContain("/tmp/groundcrew-srt-team-1/codex-home");
      // The real ~/.codex stays read-only even with a relocated home.
      expect(actual.filesystem.allowWrite).not.toContain("/home/dev/.codex");
    });

    it("omits the relocated-home grant when none is staged (deny-list agents like claude)", () => {
      const actual = buildSrtSettings(input({ agent: "claude" }));

      expect(actual.filesystem.allowWrite).not.toContain("/tmp/groundcrew-srt-team-1/codex-home");
    });
  });

  describe("macOS keychain read for keychain-authenticated agents (work item 1)", () => {
    it("re-opens ~/Library/Keychains for claude on macOS so it can authenticate under the home mask", () => {
      const actual = buildSrtSettings(
        input({ agent: "claude", platform: "darwin", homeDir: "/Users/dev" }),
      );

      expect(actual.filesystem.allowRead).toContain("/Users/dev/Library/Keychains");
    });

    it("does not re-open the keychain on Linux (file-based creds; the path doesn't exist)", () => {
      const actual = buildSrtSettings(input({ agent: "claude", platform: "linux" }));

      expect(actual.filesystem.allowRead).not.toContain("/home/dev/Library/Keychains");
    });

    it("does not re-open the keychain for file-authenticated agents (codex) even on macOS", () => {
      const actual = buildSrtSettings(
        input({ agent: "codex", platform: "darwin", homeDir: "/Users/dev" }),
      );

      expect(actual.filesystem.allowRead).not.toContain("/Users/dev/Library/Keychains");
    });
  });

  describe("git common dir is a narrow write allowlist, never wholesale (work item 2)", () => {
    it("grants exactly the paths the git workflow + gc write, not the whole common dir", () => {
      const actual = buildSrtSettings(input());

      // The whole common dir is readable but NOT writable wholesale.
      expect(actual.filesystem.allowRead).toContain("/work/repo-a/.git");
      expect(actual.filesystem.allowWrite).not.toContain("/work/repo-a/.git");

      for (const granted of [
        "/work/repo-a/.git/objects",
        "/work/repo-a/.git/refs",
        "/work/repo-a/.git/logs",
        "/work/repo-a/.git/info",
        "/work/repo-a/.git/packed-refs",
        "/work/repo-a/.git/packed-refs.lock",
        "/work/repo-a/.git/packed-refs.new",
        "/work/repo-a/.git/gc.pid",
        "/work/repo-a/.git/gc.pid.lock",
        "/work/repo-a/.git/HEAD",
        "/work/repo-a/.git/HEAD.lock",
        "/work/repo-a/.git/ORIG_HEAD",
        "/work/repo-a/.git/FETCH_HEAD",
        "/work/repo-a/.git/worktrees/repo-a-team-1",
      ]) {
        expect(actual.filesystem.allowWrite).toContain(granted);
      }
    });

    it("never write-grants config/hooks/modules or sibling worktree gitdirs (closed by omission)", () => {
      const actual = buildSrtSettings(input());

      for (const closed of [
        "/work/repo-a/.git/config",
        "/work/repo-a/.git/hooks",
        "/work/repo-a/.git/modules",
        "/work/repo-a/.git/worktrees",
      ]) {
        expect(actual.filesystem.allowWrite).not.toContain(closed);
      }
    });

    it("carves the per-worktree redirection + config files back out of the granted gitdir", () => {
      const actual = buildSrtSettings(input());

      expect(actual.filesystem.denyWrite).toContain(
        "/work/repo-a/.git/worktrees/repo-a-team-1/commondir",
      );
      expect(actual.filesystem.denyWrite).toContain(
        "/work/repo-a/.git/worktrees/repo-a-team-1/gitdir",
      );
      expect(actual.filesystem.denyWrite).toContain(
        "/work/repo-a/.git/worktrees/repo-a-team-1/config.worktree",
      );
      // The linked-worktree `.git` pointer file itself — can't be redirected.
      expect(actual.filesystem.denyWrite).toContain("/work/repo-a-team-1/.git");
    });
  });

  it("denies writes to global toolchain bin/module locations", () => {
    const actual = buildSrtSettings(input());

    expect(actual.filesystem.denyWrite).toContain(
      "/home/dev/.nvm/versions/node/v24/lib/node_modules",
    );
    expect(actual.filesystem.denyWrite).toContain("/home/dev/.nvm/versions/node/v24/bin");
    expect(actual.filesystem.denyWrite).toContain("/home/dev/.cargo/bin");
    expect(actual.filesystem.denyWrite).toContain("/home/dev/.npm/_npx");
  });

  it("grants no extra home access for an unknown agent but keeps toolchains", () => {
    const actual = buildSrtSettings(input({ agent: "mystery" }));

    expect(actual.filesystem.allowRead).not.toContain("/home/dev/.claude");
    expect(actual.filesystem.allowWrite).not.toContain("/home/dev/.claude");
    expect(actual.filesystem.allowRead).toContain("/home/dev/.nvm");
  });

  it("grants the prepare policy (empty agent) toolchains + npm cache but no agent config homes", () => {
    const prepare = buildSrtSettings(input({ agent: "" }));

    expect(prepare.filesystem.allowRead).not.toContain("/home/dev/.claude");
    expect(prepare.filesystem.allowRead).not.toContain("/home/dev/.codex");
    expect(prepare.filesystem.allowRead).toContain("/home/dev/.nvm");
    expect(prepare.filesystem.allowWrite).toContain("/home/dev/.npm");
    expect(prepare.filesystem.denyWrite).toContain("/home/dev/.claude");
    expect(prepare.filesystem.denyWrite).toContain("/home/dev/.codex");
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

    expect(actual.filesystem.denyRead.length).toBeGreaterThan(0);
    expect(actual.filesystem.allowRead).toContain("/work/repo-a-team-1");
    expect(() => SandboxRuntimeConfigSchema.parse(actual)).not.toThrow();
  });
});

describe(agentConfigRelocation, () => {
  it("relocates codex to CODEX_HOME, seeding its file creds + config", () => {
    const actual = agentConfigRelocation("codex");

    expect(actual).toStrictEqual({
      configDirEnv: "CODEX_HOME",
      sourceHomeRelativeDir: ".codex",
      seedFiles: ["auth.json", "config.toml"],
    });
  });

  it("is case-insensitive on the agent name", () => {
    expect(agentConfigRelocation("CODEX")?.configDirEnv).toBe("CODEX_HOME");
  });

  it("returns undefined for read-only agents (claude) and unknown agents", () => {
    expect(agentConfigRelocation("claude")).toBeUndefined();
    expect(agentConfigRelocation("mystery")).toBeUndefined();
  });
});
