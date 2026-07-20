import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  composeAgentPolicy,
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
  });
});
