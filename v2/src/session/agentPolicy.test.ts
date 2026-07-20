import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  composeAgentPolicy,
  composeHookPolicy,
  createPrepareHookSandbox,
  DEFAULT_AGENT_EGRESS,
  type ComposeAgentPolicyInput,
} from "./agentPolicy.js";

const HOME = "/home/dev";

function compose(overrides: Partial<ComposeAgentPolicyInput> = {}): ReturnType<typeof composeAgentPolicy> {
  return composeAgentPolicy({
    configPolicy: { readOnlyPaths: [] },
    workspaceDirectory: "/work/ws",
    stateRoot: "/state/root",
    repoCloneGitDirectories: [],
    environment: { HOME },
    platform: "linux",
    homeDir: HOME,
    ...overrides,
  });
}

const under = (relative: string): string => path.join(HOME, relative);

/** The policy's deny-write list, defaulted outside the test body (lint: no conditionals in tests). */
const deniesOf = (policy: { denyWritePaths?: string[] }): string[] => policy.denyWritePaths ?? [];

describe("composeAgentPolicy", () => {
  describe("writable grants", () => {
    it("grants the workspace and state root read-write", () => {
      const policy = compose();
      expect(policy.writablePaths).toContain("/work/ws");
      expect(policy.writablePaths).toContain("/state/root");
    });

    it("grants each provisioned repo clone's .git directory (so commits land in the object store)", () => {
      const policy = compose({
        repoCloneGitDirectories: ["/dev/alpha/.git", "/dev/beta/.git"],
      });
      expect(policy.writablePaths).toContain("/dev/alpha/.git");
      expect(policy.writablePaths).toContain("/dev/beta/.git");
    });

    it("grants the agent state dir and npm cache, but not the mcpServers config file", () => {
      const policy = compose({ agentKinds: ["claude"] });
      expect(policy.writablePaths).toContain(under(".claude"));
      expect(policy.writablePaths).toContain(under(".npm"));
      // ~/.claude.json (mcpServers persistence surface) is read-only by omission.
      expect(policy.writablePaths).not.toContain(under(".claude.json"));
      expect(policy.readOnlyPaths).toContain(under(".claude.json"));
    });

    it("grants the system temp dir write (agent shell tools scratch there)", () => {
      expect(compose({ platform: "linux" }).writablePaths).toContain("/tmp");
      const darwin = compose({ platform: "darwin" }).writablePaths;
      expect(darwin).toContain("/tmp");
      expect(darwin).toContain("/private/tmp");
    });

    it("grants $TMPDIR write when set, and omits it when unset or blank", () => {
      expect(compose({ environment: { HOME, TMPDIR: "/tmp/x" } }).writablePaths).toContain("/tmp/x");
      expect(compose({ environment: { HOME, TMPDIR: "" } }).writablePaths).not.toContain("");
      expect(compose({ environment: { HOME } }).writablePaths.some((p) => p === "")).toBe(false);
    });
  });

  describe("read grants", () => {
    it("re-opens git identity, gh, and toolchain dirs under the home mask", () => {
      const policy = compose();
      expect(policy.readOnlyPaths).toContain(under(".gitconfig"));
      expect(policy.readOnlyPaths).toContain(under(".config/git"));
      expect(policy.readOnlyPaths).toContain(under(".config/gh"));
      expect(policy.readOnlyPaths).toContain(under(".nvm"));
      expect(policy.readOnlyPaths).toContain(under(".npm-global"));
      expect(policy.readOnlyPaths).toContain(under(".local/share/mise"));
    });

    it("preserves config readOnlyDirectories", () => {
      const policy = compose({ configPolicy: { readOnlyPaths: ["/opt/tfenv"] } });
      expect(policy.readOnlyPaths).toContain("/opt/tfenv");
    });

    it("expands HOME-relative paths against the injected home / environment HOME", () => {
      const policy = composeAgentPolicy({
        configPolicy: { readOnlyPaths: [] },
        workspaceDirectory: "/w",
        stateRoot: "/s",
        repoCloneGitDirectories: [],
        environment: { HOME: "/custom/home" },
        platform: "linux",
      });
      expect(policy.readOnlyPaths).toContain(path.join("/custom/home", ".gitconfig"));
    });
  });

  describe("agent-kind scoping", () => {
    it("scopes agent home grants to the kinds in play", () => {
      const policy = compose({ agentKinds: ["claude"] });
      expect(policy.readOnlyPaths).toContain(under(".claude"));
      // codex/cursor homes are not exposed to a claude-only session.
      expect(policy.readOnlyPaths).not.toContain(under(".codex"));
      expect(policy.readOnlyPaths).not.toContain(under(".cursor"));
    });

    it("grants the full known-agent set when no kinds are passed", () => {
      const policy = compose();
      expect(policy.readOnlyPaths).toContain(under(".claude"));
      expect(policy.readOnlyPaths).toContain(under(".codex"));
      expect(policy.readOnlyPaths).toContain(under(".cursor"));
    });

    it("ignores unknown kinds (custom profiles) for home grants", () => {
      const policy = compose({ agentKinds: ["scripted"] });
      expect(policy.readOnlyPaths).not.toContain(under(".claude"));
      // Toolchain + identity reads are still granted (every agent needs them).
      expect(policy.readOnlyPaths).toContain(under(".gitconfig"));
    });
  });

  describe("macOS keychain", () => {
    it("re-opens the user keychain dir for keychain-authenticated agents on macOS", () => {
      const policy = compose({ platform: "darwin", agentKinds: ["claude"] });
      expect(policy.readOnlyPaths).toContain(under("Library/Keychains"));
    });

    it("does not grant the keychain on linux", () => {
      const policy = compose({ platform: "linux", agentKinds: ["claude"] });
      expect(policy.readOnlyPaths).not.toContain(under("Library/Keychains"));
    });

    it("does not grant the keychain for a non-keychain agent (codex)", () => {
      const policy = compose({ platform: "darwin", agentKinds: ["codex"] });
      expect(policy.readOnlyPaths).not.toContain(under("Library/Keychains"));
    });
  });

  describe("deny-write carve-outs", () => {
    it("denies claude's executable/persistence surfaces inside the writable ~/.claude", () => {
      const policy = compose({ agentKinds: ["claude"] });
      expect(policy.writablePaths).toContain(under(".claude"));
      const denied = deniesOf(policy);
      expect(denied).toContain(under(".claude/settings.json"));
      expect(denied).toContain(under(".claude/commands"));
      expect(denied).toContain(under(".claude/hooks"));
      expect(denied).toContain(under(".claude/plugins"));
      expect(denied).toContain(under(".claude/chrome"));
      expect(denied).toContain(under(".claude/.git/hooks"));
      expect(denied).toContain(under(".claude/.git/config"));
    });

    it("denies cursor's mcp.json/hooks/rules under the writable ~/.cursor", () => {
      const denied = deniesOf(compose({ agentKinds: ["cursor"] }));
      expect(denied).toContain(under(".cursor/mcp.json"));
      expect(denied).toContain(under(".cursor/hooks"));
      expect(denied).toContain(under(".cursor/rules"));
    });

    it("keeps ~/.codex writable for session state but denies its config.toml MCP surface", () => {
      const policy = compose({ agentKinds: ["codex"] });
      expect(policy.writablePaths).toContain(under(".codex"));
      expect(deniesOf(policy)).toContain(under(".codex/config.toml"));
    });

    it("denies agent homes the launch does not own (closes srt's default ~/.claude/debug write)", () => {
      const denied = deniesOf(compose({ agentKinds: ["codex"] }));
      expect(denied).toContain(under(".claude"));
      expect(denied).toContain(under(".cursor"));
      // The owned home is not denied wholesale (only its surfaces are).
      expect(denied).not.toContain(under(".codex"));
    });

    it("denies ~/.npm/_npx even though ~/.npm is writable (npx cache poison)", () => {
      const policy = compose({ agentKinds: ["claude"] });
      expect(policy.writablePaths).toContain(under(".npm"));
      expect(deniesOf(policy)).toContain(under(".npm/_npx"));
    });

    it("denies each repo clone's .git/{hooks,config} while the .git stays writable", () => {
      const policy = compose({ repoCloneGitDirectories: ["/dev/alpha/.git"] });
      expect(policy.writablePaths).toContain("/dev/alpha/.git");
      const denied = deniesOf(policy);
      expect(denied).toContain("/dev/alpha/.git/hooks");
      expect(denied).toContain("/dev/alpha/.git/config");
    });
  });

  describe("network baseline vs configured", () => {
    it("applies the default egress baseline when config omits network", () => {
      const policy = compose({ configPolicy: { readOnlyPaths: [] } });
      expect(policy.network).toEqual([...DEFAULT_AGENT_EGRESS]);
      expect(policy.network).toContain("api.anthropic.com");
    });

    it("replaces the baseline wholesale when config specifies network", () => {
      const policy = compose({ configPolicy: { readOnlyPaths: [], network: ["api.github.com"] } });
      expect(policy.network).toEqual(["api.github.com"]);
      expect(policy.network).not.toContain("api.anthropic.com");
    });

    it("treats an explicit empty network as deny-all (not the baseline)", () => {
      const policy = compose({ configPolicy: { readOnlyPaths: [], network: [] } });
      expect(policy.network).toEqual([]);
    });

    it("appends additionalNetwork to the baseline when network is omitted", () => {
      const policy = compose({
        configPolicy: { readOnlyPaths: [], additionalNetwork: ["staging.internal"] },
      });
      expect(policy.network).toEqual([...DEFAULT_AGENT_EGRESS, "staging.internal"]);
      expect(policy.network).toContain("api.anthropic.com");
    });

    it("appends additionalNetwork on top of an explicit network", () => {
      const policy = compose({
        configPolicy: {
          readOnlyPaths: [],
          network: ["api.github.com"],
          additionalNetwork: ["staging.internal"],
        },
      });
      expect(policy.network).toEqual(["api.github.com", "staging.internal"]);
    });

    it("de-duplicates hosts already present in the base list", () => {
      const policy = compose({
        configPolicy: {
          readOnlyPaths: [],
          network: ["api.github.com"],
          additionalNetwork: ["api.github.com", "staging.internal"],
        },
      });
      expect(policy.network).toEqual(["api.github.com", "staging.internal"]);
    });
  });
});

describe("composeHookPolicy", () => {
  function hookPolicy(
    overrides: Partial<Parameters<typeof composeHookPolicy>[0]> = {},
  ): ReturnType<typeof composeHookPolicy> {
    return composeHookPolicy({
      configPolicy: { readOnlyPaths: [] },
      worktreeDirectory: "/work/ws/alpha",
      cloneGitDirectory: "/dev/alpha/.git",
      environment: { HOME },
      platform: "linux",
      homeDir: HOME,
      ...overrides,
    });
  }

  it("grants only the worktree and its clone .git write (no state root, no agent homes)", () => {
    const policy = hookPolicy();
    expect(policy.writablePaths).toContain("/work/ws/alpha");
    expect(policy.writablePaths).toContain("/dev/alpha/.git");
    expect(policy.writablePaths).toContain(under(".npm"));
    // Credential-free: no agent config/state homes are writable or readable.
    expect(policy.writablePaths).not.toContain(under(".claude"));
    expect(policy.readOnlyPaths).not.toContain(under(".claude"));
    expect(policy.readOnlyPaths).not.toContain(under("Library/Keychains"));
  });

  it("denies every agent home and the git hooks/config under the .git grant", () => {
    const denied = deniesOf(hookPolicy());
    expect(denied).toContain(under(".claude"));
    expect(denied).toContain(under(".codex"));
    expect(denied).toContain(under(".cursor"));
    expect(denied).toContain(under(".npm/_npx"));
    expect(denied).toContain("/dev/alpha/.git/hooks");
    expect(denied).toContain("/dev/alpha/.git/config");
  });

  it("still re-opens the toolchains and git identity the hook needs to read", () => {
    const policy = hookPolicy();
    expect(policy.readOnlyPaths).toContain(under(".nvm"));
    expect(policy.readOnlyPaths).toContain(under(".gitconfig"));
  });

  it("uses the same egress baseline (and additionalNetwork) as agents", () => {
    expect(hookPolicy().network).toEqual([...DEFAULT_AGENT_EGRESS]);
    const extended = hookPolicy({
      configPolicy: { readOnlyPaths: [], additionalNetwork: ["registry.internal"] },
    });
    expect(extended.network).toContain("registry.internal");
    expect(extended.network).toContain("registry.npmjs.org");
  });
});

describe("createPrepareHookSandbox", () => {
  it("wraps the hook command with the composed hook policy per worktree", async () => {
    const seen: Array<{ command: string; policy: unknown }> = [];
    const runner = createPrepareHookSandbox({
      wrapCommand: async (wrap) => {
        seen.push(wrap);
        return { command: `srt -c '${wrap.command}'` };
      },
      configPolicy: { readOnlyPaths: [] },
      environment: { HOME },
      platform: "linux",
      homeDir: HOME,
    });

    const wrapped = await runner({
      command: "npm ci",
      worktreeDirectory: "/work/ws/alpha",
      cloneGitDirectory: "/dev/alpha/.git",
    });

    expect(wrapped).toBe("srt -c 'npm ci'");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.command).toBe("npm ci");
    // The policy handed to the wrap is the credential-free hook policy.
    const policy = seen[0]?.policy as ReturnType<typeof composeHookPolicy>;
    expect(policy.writablePaths).toContain("/dev/alpha/.git");
    expect(policy.denyWritePaths).toContain(under(".claude"));
  });
});
