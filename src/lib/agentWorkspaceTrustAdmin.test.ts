import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { codexProjectTableHeader, cursorProjectSlug } from "./agentWorkspaceTrust.ts";
import {
  deleteAgentWorkspaceTrust,
  deleteClaudeTrustEntryForTests,
  deleteCodexTrustEntryForTests,
  deleteCursorTrustEntryForTests,
  deleteTrustEntryForTests,
  listAgentWorkspaceTrust,
  listCodexTrustedProjects,
  matchesDeleteTargetForTests,
  normalizedPrefixForTests,
  pruneAgentWorkspaceTrust,
  removeCodexProjectTrust,
  type AgentTrustAgent,
  type AgentTrustEntry,
} from "./agentWorkspaceTrustAdmin.ts";

const GROUNDCREW_TRUST_METHOD = "groundcrew-auto-trust";

describe(listAgentWorkspaceTrust, () => {
  let fakeHome: string;

  beforeEach(() => {
    fakeHome = mkdtempSync(path.join(os.tmpdir(), "agent-workspace-trust-admin-home-"));
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it("lists Cursor, Claude, and Codex trust entries", () => {
    const workspacePath = path.join(fakeHome, "worktrees", "repo-team-1");
    const markerPath = path.join(
      fakeHome,
      ".cursor",
      "projects",
      cursorProjectSlug(workspacePath),
      ".workspace-trusted",
    );
    mkdirSync(path.dirname(markerPath), { recursive: true });
    writeFileSync(
      markerPath,
      `${JSON.stringify({
        workspacePath,
        trustMethod: "groundcrew-auto-trust",
      })}\n`,
      "utf8",
    );

    writeFileSync(
      path.join(fakeHome, ".claude.json"),
      JSON.stringify({
        projects: {
          [path.resolve(fakeHome, "worktrees")]: { hasTrustDialogAccepted: true, theme: "keep" },
        },
      }),
      "utf8",
    );

    mkdirSync(path.join(fakeHome, ".codex"), { recursive: true });
    writeFileSync(
      path.join(fakeHome, ".codex", "config.toml"),
      `[features]\nhooks = true\n\n${codexProjectTableHeader(workspacePath)}\ntrust_level = "trusted"\n`,
      "utf8",
    );

    const entries = listAgentWorkspaceTrust({ homeDir: fakeHome });
    expect(entries).toHaveLength(3);
    expect(entries.map((entry) => entry.agent).toSorted()).toEqual(["claude", "codex", "cursor"]);
  });

  it("ignores invalid Claude JSON and unparseable Cursor markers", () => {
    mkdirSync(path.join(fakeHome, ".cursor", "projects", "bad-slug"), { recursive: true });
    writeFileSync(
      path.join(fakeHome, ".cursor", "projects", "bad-slug", ".workspace-trusted"),
      "not-json",
      "utf8",
    );
    mkdirSync(path.join(fakeHome, ".cursor", "projects", "no-marker-slug"), { recursive: true });
    writeFileSync(path.join(fakeHome, ".claude.json"), "[]", "utf8");

    const entries = listAgentWorkspaceTrust({ homeDir: fakeHome, agent: "cursor" });
    expect(entries).toEqual([
      expect.objectContaining({
        agent: "cursor",
        detail: "trusted (unparseable marker)",
      }),
    ]);
    expect(listAgentWorkspaceTrust({ homeDir: fakeHome, agent: "claude" })).toEqual([]);
  });

  it("lists Cursor markers that omit optional JSON fields", () => {
    const workspacePath = path.resolve(fakeHome, "explicit-path");
    const fallbackSlug = "tmp-fallback-slug";
    mkdirSync(path.join(fakeHome, ".cursor", "projects", fallbackSlug), { recursive: true });
    writeFileSync(
      path.join(fakeHome, ".cursor", "projects", fallbackSlug, ".workspace-trusted"),
      `${JSON.stringify({ workspacePath })}\n`,
      "utf8",
    );
    mkdirSync(path.join(fakeHome, ".cursor", "projects", "trust-method-only"), { recursive: true });
    writeFileSync(
      path.join(fakeHome, ".cursor", "projects", "trust-method-only", ".workspace-trusted"),
      `${JSON.stringify({ trustMethod: "manual" })}\n`,
      "utf8",
    );
    mkdirSync(path.join(fakeHome, ".cursor", "projects", "array-marker"), { recursive: true });
    writeFileSync(
      path.join(fakeHome, ".cursor", "projects", "array-marker", ".workspace-trusted"),
      "[]\n",
      "utf8",
    );

    const entries = listAgentWorkspaceTrust({ homeDir: fakeHome, agent: "cursor" });
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agent: "cursor",
          workspacePath,
          detail: "trusted",
        }),
        expect.objectContaining({
          agent: "cursor",
          detail: "manual",
        }),
        expect.objectContaining({
          agent: "cursor",
          detail: "trusted (unparseable marker)",
        }),
      ]),
    );
  });

  it("treats malformed Claude JSON as empty", () => {
    writeFileSync(path.join(fakeHome, ".claude.json"), "{not-json", "utf8");
    expect(listAgentWorkspaceTrust({ homeDir: fakeHome, agent: "claude" })).toEqual([]);
  });

  it("skips Claude projects without accepted trust dialog", () => {
    writeFileSync(
      path.join(fakeHome, ".claude.json"),
      JSON.stringify({
        projects: {
          [path.resolve(fakeHome, "no-trust")]: { note: "skip-me" },
        },
      }),
      "utf8",
    );
    expect(listAgentWorkspaceTrust({ homeDir: fakeHome, agent: "claude" })).toEqual([]);
  });

  it("treats unreadable Codex config as empty", () => {
    const codexConfig = path.join(fakeHome, ".codex", "config.toml");
    mkdirSync(path.dirname(codexConfig), { recursive: true });
    writeFileSync(codexConfig, "[features]\nhooks = true\n", "utf8");
    chmodSync(codexConfig, 0o000);
    expect(listAgentWorkspaceTrust({ homeDir: fakeHome, agent: "codex" })).toEqual([]);
    chmodSync(codexConfig, 0o600);
  });

  it("lists only missing workspace paths when requested", () => {
    const existingPath = path.resolve(fakeHome, "still-here");
    const missingPath = path.resolve(fakeHome, "gone");
    mkdirSync(existingPath, { recursive: true });
    writeFileSync(
      path.join(fakeHome, ".claude.json"),
      JSON.stringify({
        projects: {
          [existingPath]: { hasTrustDialogAccepted: true },
          [missingPath]: { hasTrustDialogAccepted: true },
        },
      }),
      "utf8",
    );

    expect(listAgentWorkspaceTrust({ homeDir: fakeHome, missingOnly: true })).toEqual([
      expect.objectContaining({
        agent: "claude",
        workspacePath: missingPath,
      }),
    ]);
  });
});

describe(matchesDeleteTargetForTests, () => {
  const entry = {
    agent: "cursor" as const,
    workspacePath: "/tmp/ws",
    detail: GROUNDCREW_TRUST_METHOD,
    store: "/tmp/.cursor/projects/slug/.workspace-trusted",
  };

  it("filters by agent, groundcrew markers, and path prefix", () => {
    expect(matchesDeleteTargetForTests(entry, { homeDir: "/tmp", all: true })).toBe(true);
    expect(
      matchesDeleteTargetForTests(entry, {
        homeDir: "/tmp",
        agent: "claude",
        all: true,
      }),
    ).toBe(false);
    expect(
      matchesDeleteTargetForTests(
        { ...entry, detail: "manual" },
        { homeDir: "/tmp", groundcrewOnly: true, all: true },
      ),
    ).toBe(false);
    expect(
      matchesDeleteTargetForTests(entry, {
        homeDir: "/tmp",
        groundcrewOnly: true,
        all: true,
      }),
    ).toBe(true);
    expect(
      matchesDeleteTargetForTests(entry, {
        homeDir: "/tmp",
        path: "/tmp/ws",
      }),
    ).toBe(true);
    expect(
      matchesDeleteTargetForTests(entry, {
        homeDir: "/tmp",
        path: "/tmp/other",
      }),
    ).toBe(false);
    expect(
      matchesDeleteTargetForTests(entry, {
        homeDir: "/tmp",
        pathPrefix: "/tmp",
      }),
    ).toBe(true);
    expect(
      matchesDeleteTargetForTests(entry, {
        homeDir: "/tmp",
        pathPrefix: "/elsewhere",
      }),
    ).toBe(false);
    expect(matchesDeleteTargetForTests(entry, { homeDir: "/tmp" })).toBe(false);
  });
});

describe(normalizedPrefixForTests, () => {
  it("keeps root prefixes and appends separators elsewhere", () => {
    expect(normalizedPrefixForTests("/")).toBe("/");
    expect(normalizedPrefixForTests("/tmp/prefix")).toBe(`/tmp/prefix${path.sep}`);
  });
});

describe(deleteCodexTrustEntryForTests, () => {
  let fakeHome: string;

  beforeEach(() => {
    fakeHome = mkdtempSync(path.join(os.tmpdir(), "agent-workspace-trust-admin-codex-delete-"));
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it("returns false when the project trust section is already absent", () => {
    mkdirSync(path.join(fakeHome, ".codex"), { recursive: true });
    writeFileSync(
      path.join(fakeHome, ".codex", "config.toml"),
      "[features]\nhooks = true\n",
      "utf8",
    );
    expect(deleteCodexTrustEntryForTests(fakeHome, "/tmp/missing")).toBe(false);
  });
});

describe(deleteClaudeTrustEntryForTests, () => {
  let fakeHome: string;

  beforeEach(() => {
    fakeHome = mkdtempSync(path.join(os.tmpdir(), "agent-workspace-trust-admin-claude-delete-"));
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it("returns false when the project never accepted trust", () => {
    const workspacePath = path.resolve(fakeHome, "no-trust");
    writeFileSync(
      path.join(fakeHome, ".claude.json"),
      JSON.stringify({
        projects: {
          [workspacePath]: { note: "skip-me" },
        },
      }),
      "utf8",
    );
    expect(deleteClaudeTrustEntryForTests(fakeHome, workspacePath)).toBe(false);
  });

  it("handles a Claude config without a projects map", () => {
    writeFileSync(path.join(fakeHome, ".claude.json"), "{}\n", "utf8");
    expect(deleteClaudeTrustEntryForTests(fakeHome, path.resolve(fakeHome, "missing"))).toBe(false);
  });
});

describe(deleteCursorTrustEntryForTests, () => {
  it("returns false when the marker file is already gone", () => {
    expect(deleteCursorTrustEntryForTests("/tmp/missing-marker")).toBe(false);
  });
});

describe(deleteTrustEntryForTests, () => {
  it("rejects unsupported agents", () => {
    expect(() =>
      deleteTrustEntryForTests("/tmp/home", {
        agent: "invalid" as unknown as AgentTrustAgent,
        workspacePath: "/tmp/ws",
        detail: "trusted",
        store: "/tmp/marker",
      } satisfies AgentTrustEntry),
    ).toThrow("Unsupported trust agent: invalid");
  });
});

describe(listCodexTrustedProjects, () => {
  it("parses trusted Codex project sections", () => {
    const workspacePath = "/tmp/repo-team-1";
    const config = `${codexProjectTableHeader(workspacePath)}\ntrust_level = "trusted"\napproval_policy = "on-request"\n`;
    expect(listCodexTrustedProjects(config)).toEqual([
      { path: workspacePath, trustLevel: "trusted" },
    ]);
  });

  it("stops at the next TOML section when reading project bodies", () => {
    const workspacePath = "/tmp/repo-team-1";
    const config = [
      codexProjectTableHeader(workspacePath),
      'trust_level = "trusted"',
      "[features]",
      "hooks = true",
      "",
    ].join("\n");
    expect(removeCodexProjectTrust(config, workspacePath)).toBe("[features]\nhooks = true\n");
  });

  it("skips Codex sections without trust_level and parses escaped paths", () => {
    const trustedPath = "/tmp/repo team";
    const afterNextPath = "/tmp/after-next";
    const config = [
      `${codexProjectTableHeader(trustedPath)}\ntrust_level = "trusted"\n`,
      `${codexProjectTableHeader("/tmp/other")}\napproval_policy = "on-request"\n`,
      `${codexProjectTableHeader(afterNextPath)}\ntrust_level = "trusted"\n`,
    ].join("\n");
    expect(listCodexTrustedProjects(config)).toEqual(
      expect.arrayContaining([
        { path: trustedPath, trustLevel: "trusted" },
        { path: afterNextPath, trustLevel: "trusted" },
      ]),
    );
    expect(listCodexTrustedProjects(config)).toHaveLength(2);
  });
});

describe(removeCodexProjectTrust, () => {
  it("removes trust_level and keeps other project keys", () => {
    const workspacePath = "/tmp/repo-team-1";
    const config = `${codexProjectTableHeader(workspacePath)}\napproval_policy = "on-request"\ntrust_level = "trusted"\n`;
    expect(removeCodexProjectTrust(config, workspacePath)).toBe(
      `${codexProjectTableHeader(workspacePath)}\napproval_policy = "on-request"\n`,
    );
  });

  it("removes the whole project section when trust_level was the only key", () => {
    const workspacePath = "/tmp/repo-team-1";
    const config = `[features]\nhooks = true\n\n${codexProjectTableHeader(workspacePath)}\ntrust_level = "trusted"\n`;
    expect(removeCodexProjectTrust(config, workspacePath)).toBe("[features]\nhooks = true\n");
  });

  it("is a no-op when the Codex project section is missing", () => {
    const config = "[features]\nhooks = true\n";
    expect(removeCodexProjectTrust(config, "/tmp/missing")).toBe(config);
  });
});

describe(deleteAgentWorkspaceTrust, () => {
  let fakeHome: string;

  beforeEach(() => {
    fakeHome = mkdtempSync(path.join(os.tmpdir(), "agent-workspace-trust-admin-delete-"));
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it("deletes trust for an exact path across agents", () => {
    const parentPath = path.resolve(fakeHome, "worktrees");
    const childPath = path.join(parentPath, "repo-team-1");
    const markerPath = path.join(
      fakeHome,
      ".cursor",
      "projects",
      cursorProjectSlug(parentPath),
      ".workspace-trusted",
    );
    mkdirSync(path.dirname(markerPath), { recursive: true });
    writeFileSync(
      markerPath,
      `${JSON.stringify({ workspacePath: parentPath, trustMethod: "manual" })}\n`,
      "utf8",
    );
    writeFileSync(
      path.join(fakeHome, ".claude.json"),
      JSON.stringify({
        projects: {
          [parentPath]: { hasTrustDialogAccepted: true, note: "keep" },
        },
      }),
      "utf8",
    );
    mkdirSync(path.join(fakeHome, ".codex"), { recursive: true });
    writeFileSync(
      path.join(fakeHome, ".codex", "config.toml"),
      `${codexProjectTableHeader(childPath)}\ntrust_level = "trusted"\n`,
      "utf8",
    );

    const results = deleteAgentWorkspaceTrust({
      homeDir: fakeHome,
      path: childPath,
    });
    expect(results).toEqual([
      { agent: "codex", workspacePath: path.resolve(childPath), deleted: true },
    ]);
    expect(existsSync(markerPath)).toBe(true);
    expect(listAgentWorkspaceTrust({ homeDir: fakeHome, agent: "claude" })).toHaveLength(1);
  });

  it("deletes every entry under a path prefix", () => {
    const parentPath = path.resolve(fakeHome, "worktrees");
    const childPath = path.join(parentPath, "repo-team-1");
    writeFileSync(
      path.join(fakeHome, ".claude.json"),
      JSON.stringify({
        projects: {
          [parentPath]: { hasTrustDialogAccepted: true },
          [childPath]: { hasTrustDialogAccepted: true },
          [path.resolve(fakeHome, "other")]: { hasTrustDialogAccepted: true },
        },
      }),
      "utf8",
    );

    const results = deleteAgentWorkspaceTrust({
      homeDir: fakeHome,
      agent: "claude",
      pathPrefix: parentPath,
    });
    expect(results).toHaveLength(2);
    expect(results.every((result) => result.deleted)).toBe(true);
    expect(listAgentWorkspaceTrust({ homeDir: fakeHome, agent: "claude" })).toHaveLength(1);
  });

  it("normalizes root path prefixes when deleting by prefix", () => {
    const workspacePath = path.resolve(fakeHome, "root-prefix");
    writeFileSync(
      path.join(fakeHome, ".claude.json"),
      JSON.stringify({
        projects: {
          [workspacePath]: { hasTrustDialogAccepted: true },
        },
      }),
      "utf8",
    );

    const results = deleteAgentWorkspaceTrust({
      homeDir: fakeHome,
      agent: "claude",
      pathPrefix: "/",
    });
    expect(results).toEqual([{ agent: "claude", workspacePath, deleted: true }]);
  });

  it("deletes only groundcrew Cursor markers when requested", () => {
    const groundcrewPath = path.resolve(fakeHome, "gc");
    const manualPath = path.resolve(fakeHome, "manual");
    for (const [workspacePath, trustMethod] of [
      [groundcrewPath, "groundcrew-auto-trust"],
      [manualPath, "manual"],
    ] as const) {
      const markerPath = path.join(
        fakeHome,
        ".cursor",
        "projects",
        cursorProjectSlug(workspacePath),
        ".workspace-trusted",
      );
      mkdirSync(path.dirname(markerPath), { recursive: true });
      writeFileSync(markerPath, `${JSON.stringify({ workspacePath, trustMethod })}\n`, "utf8");
    }

    const results = deleteAgentWorkspaceTrust({
      homeDir: fakeHome,
      agent: "cursor",
      all: true,
      groundcrewOnly: true,
    });
    expect(results).toEqual([{ agent: "cursor", workspacePath: groundcrewPath, deleted: true }]);
    expect(listAgentWorkspaceTrust({ homeDir: fakeHome, agent: "cursor" })).toHaveLength(1);
    expect(listAgentWorkspaceTrust({ homeDir: fakeHome, agent: "cursor" })[0]?.workspacePath).toBe(
      manualPath,
    );
  });

  it("requires a delete target", () => {
    expect(() => deleteAgentWorkspaceTrust({ homeDir: fakeHome })).toThrow(
      "delete requires --all, --path, or --prefix",
    );
  });

  it("returns no results when nothing matches the delete filter", () => {
    const workspacePath = path.resolve(fakeHome, "claude-ws");
    writeFileSync(
      path.join(fakeHome, ".claude.json"),
      JSON.stringify({
        projects: {
          [workspacePath]: { hasTrustDialogAccepted: true },
        },
      }),
      "utf8",
    );

    expect(
      deleteAgentWorkspaceTrust({
        homeDir: fakeHome,
        agent: "codex",
        path: workspacePath,
      }),
    ).toEqual([]);
    expect(
      deleteAgentWorkspaceTrust({
        homeDir: fakeHome,
        path: path.resolve(fakeHome, "missing"),
      }),
    ).toEqual([]);
    expect(
      deleteAgentWorkspaceTrust({
        homeDir: fakeHome,
        pathPrefix: path.resolve(fakeHome, "no-such-prefix"),
      }),
    ).toEqual([]);
  });

  it("preserves unrelated Claude project fields when clearing trust", () => {
    const workspacePath = path.resolve(fakeHome, "claude-keep-fields");
    writeFileSync(
      path.join(fakeHome, ".claude.json"),
      JSON.stringify({
        projects: {
          [workspacePath]: { hasTrustDialogAccepted: true, note: "keep-me" },
        },
      }),
      "utf8",
    );

    deleteAgentWorkspaceTrust({ homeDir: fakeHome, path: workspacePath });

    const projects = JSON.parse(readFileSync(path.join(fakeHome, ".claude.json"), "utf8"))
      .projects as Record<string, Record<string, unknown>>;
    expect(projects[workspacePath]).toEqual({ note: "keep-me" });
  });

  it("deletes Cursor trust using the listed marker path", () => {
    const workspacePath = path.resolve(fakeHome, "repo_with_underscore");
    const slug = "custom-cursor-slug";
    const markerPath = path.join(fakeHome, ".cursor", "projects", slug, ".workspace-trusted");
    mkdirSync(path.dirname(markerPath), { recursive: true });
    writeFileSync(
      markerPath,
      `${JSON.stringify({ workspacePath, trustMethod: "manual" })}\n`,
      "utf8",
    );

    const results = deleteAgentWorkspaceTrust({
      homeDir: fakeHome,
      agent: "cursor",
      path: workspacePath,
    });
    expect(results).toEqual([{ agent: "cursor", workspacePath, deleted: true }]);
    expect(existsSync(markerPath)).toBe(false);
  });

  it("deletes Cursor trust for an exact parent path", () => {
    const workspacePath = path.resolve(fakeHome, "worktrees");
    const markerPath = path.join(
      fakeHome,
      ".cursor",
      "projects",
      cursorProjectSlug(workspacePath),
      ".workspace-trusted",
    );
    mkdirSync(path.dirname(markerPath), { recursive: true });
    writeFileSync(
      markerPath,
      `${JSON.stringify({ workspacePath, trustMethod: "manual" })}\n`,
      "utf8",
    );

    const results = deleteAgentWorkspaceTrust({
      homeDir: fakeHome,
      agent: "cursor",
      path: workspacePath,
    });
    expect(results).toEqual([{ agent: "cursor", workspacePath, deleted: true }]);
    expect(existsSync(markerPath)).toBe(false);
  });

  it("removes the Claude project key when trust flags were the only fields", () => {
    const workspacePath = path.resolve(fakeHome, "claude-only-trust");
    writeFileSync(
      path.join(fakeHome, ".claude.json"),
      JSON.stringify({
        projects: {
          [workspacePath]: {
            hasTrustDialogAccepted: true,
            hasCompletedProjectOnboarding: true,
          },
        },
      }),
      "utf8",
    );

    deleteAgentWorkspaceTrust({ homeDir: fakeHome, path: workspacePath });

    const claudeJson = JSON.parse(readFileSync(path.join(fakeHome, ".claude.json"), "utf8")) as {
      projects?: Record<string, unknown>;
    };
    expect(claudeJson.projects).toEqual({});
  });

  it("deletes all trust entries with --all", () => {
    const workspacePath = path.resolve(fakeHome, "codex-all");
    mkdirSync(path.join(fakeHome, ".codex"), { recursive: true });
    writeFileSync(
      path.join(fakeHome, ".codex", "config.toml"),
      `${codexProjectTableHeader(workspacePath)}\ntrust_level = "trusted"\n`,
      "utf8",
    );

    const results = deleteAgentWorkspaceTrust({
      homeDir: fakeHome,
      agent: "codex",
      all: true,
    });
    expect(results).toEqual([{ agent: "codex", workspacePath, deleted: true }]);
    expect(listAgentWorkspaceTrust({ homeDir: fakeHome, agent: "codex" })).toEqual([]);
  });
});

describe(pruneAgentWorkspaceTrust, () => {
  let fakeHome: string;

  beforeEach(() => {
    fakeHome = mkdtempSync(path.join(os.tmpdir(), "agent-workspace-trust-admin-prune-"));
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it("removes trust entries whose workspace paths no longer exist", () => {
    const existingPath = path.resolve(fakeHome, "still-here");
    const missingPath = path.resolve(fakeHome, "gone");
    mkdirSync(existingPath, { recursive: true });
    writeFileSync(
      path.join(fakeHome, ".claude.json"),
      JSON.stringify({
        projects: {
          [existingPath]: { hasTrustDialogAccepted: true },
          [missingPath]: { hasTrustDialogAccepted: true },
        },
      }),
      "utf8",
    );
    mkdirSync(path.join(fakeHome, ".codex"), { recursive: true });
    writeFileSync(
      path.join(fakeHome, ".codex", "config.toml"),
      `${codexProjectTableHeader(missingPath)}\ntrust_level = "trusted"\n`,
      "utf8",
    );

    const results = pruneAgentWorkspaceTrust({ homeDir: fakeHome });
    expect(results).toEqual(
      expect.arrayContaining([
        { agent: "claude", workspacePath: missingPath, deleted: true },
        { agent: "codex", workspacePath: missingPath, deleted: true },
      ]),
    );
    expect(listAgentWorkspaceTrust({ homeDir: fakeHome, agent: "claude" })).toHaveLength(1);
    expect(listAgentWorkspaceTrust({ homeDir: fakeHome, agent: "codex" })).toEqual([]);
  });

  it("prunes only the requested agent", () => {
    const existingPath = path.resolve(fakeHome, "still-here");
    const missingClaudePath = path.resolve(fakeHome, "gone-claude");
    const missingCodexPath = path.resolve(fakeHome, "gone-codex");
    mkdirSync(existingPath, { recursive: true });
    writeFileSync(
      path.join(fakeHome, ".claude.json"),
      JSON.stringify({
        projects: {
          [existingPath]: { hasTrustDialogAccepted: true },
          [missingClaudePath]: { hasTrustDialogAccepted: true },
        },
      }),
      "utf8",
    );
    mkdirSync(path.join(fakeHome, ".codex"), { recursive: true });
    writeFileSync(
      path.join(fakeHome, ".codex", "config.toml"),
      `${codexProjectTableHeader(missingCodexPath)}\ntrust_level = "trusted"\n`,
      "utf8",
    );

    const results = pruneAgentWorkspaceTrust({ homeDir: fakeHome, agent: "claude" });
    expect(results).toEqual([{ agent: "claude", workspacePath: missingClaudePath, deleted: true }]);
    expect(listAgentWorkspaceTrust({ homeDir: fakeHome, agent: "codex" })).toHaveLength(1);
  });
});
