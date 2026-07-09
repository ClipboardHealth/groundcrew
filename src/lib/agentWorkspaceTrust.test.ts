import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  codexProjectTableHeader,
  cursorProjectSlug,
  resolveSeedTrustPath,
  seedAgentWorkspaceTrust,
} from "./agentWorkspaceTrust.ts";

const writeErrorMock = vi.hoisted(() => vi.fn<(message: string) => void>());

vi.mock(import("./util.ts"), async (importOriginal) => {
  const actual = await importOriginal<typeof import("./util.ts")>();
  return { ...actual, writeError: writeErrorMock };
});

describe(cursorProjectSlug, () => {
  it("strips the leading slash and replaces path separators with dashes", () => {
    expect(cursorProjectSlug("/Users/dev/repo/worktree")).toBe("Users-dev-repo-worktree");
  });
});

describe(codexProjectTableHeader, () => {
  it("quotes the absolute workspace path for Codex config.toml", () => {
    expect(codexProjectTableHeader("/Users/dev/repo-team-1")).toBe(
      '[projects."/Users/dev/repo-team-1"]',
    );
  });

  it("escapes backslashes and double quotes in workspace paths", () => {
    expect(codexProjectTableHeader(String.raw`/tmp\weird"path`)).toBe(
      String.raw`[projects."/tmp\\weird\"path"]`,
    );
  });
});

describe(resolveSeedTrustPath, () => {
  it("defaults a blank workspace path to cwd", () => {
    expect(
      resolveSeedTrustPath({
        workspacePath: "",
        cwd: "/tmp/test-ws",
      }),
    ).toBe("/tmp/test-ws");
  });

  it("uses an explicit workspace path when provided", () => {
    expect(
      resolveSeedTrustPath({
        workspacePath: "/tmp/child",
        cwd: "/tmp/ignored",
      }),
    ).toBe("/tmp/child");
  });

  it("defaults cwd to process.cwd when omitted", () => {
    expect(resolveSeedTrustPath({})).toBe(process.cwd());
  });
});

describe(seedAgentWorkspaceTrust, () => {
  let fakeHome: string;

  beforeEach(() => {
    fakeHome = mkdtempSync(path.join(os.tmpdir(), "agent-workspace-trust-home-"));
    writeErrorMock.mockReset();
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
  });

  function readClaudeJson(): Record<string, unknown> {
    return JSON.parse(readFileSync(path.join(fakeHome, ".claude.json"), "utf8")) as Record<
      string,
      unknown
    >;
  }

  function readCodexConfig(): string {
    return readFileSync(path.join(fakeHome, ".codex", "config.toml"), "utf8");
  }

  function codexConfigPath(): string {
    return path.join(fakeHome, ".codex", "config.toml");
  }

  it("creates a Cursor workspace trust marker for a new path", () => {
    const workspacePath = path.join(fakeHome, "worktrees", "repo-team-1");

    seedAgentWorkspaceTrust({
      agentCommandName: "cursor-agent",
      workspacePath,
      homeDir: fakeHome,
    });

    const markerPath = path.join(
      fakeHome,
      ".cursor",
      "projects",
      cursorProjectSlug(workspacePath),
      ".workspace-trusted",
    );
    expect(existsSync(markerPath)).toBe(true);
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as {
      workspacePath: string;
      trustMethod: string;
    };
    expect(marker.workspacePath).toBe(path.resolve(workspacePath));
    expect(marker.trustMethod).toBe("groundcrew-auto-trust");
  });

  it("is idempotent when the Cursor marker already exists", () => {
    const workspacePath = path.join(fakeHome, "cursor-ws");
    const markerPath = path.join(
      fakeHome,
      ".cursor",
      "projects",
      cursorProjectSlug(workspacePath),
      ".workspace-trusted",
    );
    mkdirSync(path.dirname(markerPath), { recursive: true });
    writeFileSync(markerPath, '{"trustMethod":"existing"}\n', "utf8");

    seedAgentWorkspaceTrust({
      agentCommandName: "cursor-agent",
      workspacePath,
      homeDir: fakeHome,
    });

    expect(readFileSync(markerPath, "utf8")).toBe('{"trustMethod":"existing"}\n');
  });

  it("accepts Claude workspace trust for a new path", () => {
    const workspacePath = path.join(fakeHome, "claude-ws");

    seedAgentWorkspaceTrust({
      agentCommandName: "claude",
      workspacePath,
      homeDir: fakeHome,
    });

    const projects = readClaudeJson()["projects"] as Record<string, Record<string, unknown>>;
    const entry = projects[path.resolve(workspacePath)];
    expect(entry?.["hasTrustDialogAccepted"]).toBe(true);
    expect(entry?.["hasCompletedProjectOnboarding"]).toBe(true);
  });

  it("is idempotent when Claude already trusts the workspace", () => {
    const workspacePath = path.resolve(fakeHome, "claude-trusted");
    writeFileSync(
      path.join(fakeHome, ".claude.json"),
      JSON.stringify({
        projects: {
          [workspacePath]: {
            hasTrustDialogAccepted: true,
            customField: "keep-me",
          },
        },
      }),
      "utf8",
    );

    seedAgentWorkspaceTrust({
      agentCommandName: "claude",
      workspacePath,
      homeDir: fakeHome,
    });

    const projects = readClaudeJson()["projects"] as Record<string, Record<string, unknown>>;
    expect(projects[workspacePath]).toEqual({
      hasTrustDialogAccepted: true,
      customField: "keep-me",
    });
  });

  it("recovers from malformed claude.json by creating a fresh projects entry", () => {
    const workspacePath = path.join(fakeHome, "claude-recover");
    writeFileSync(path.join(fakeHome, ".claude.json"), "not-json", "utf8");

    seedAgentWorkspaceTrust({
      agentCommandName: "claude",
      workspacePath,
      homeDir: fakeHome,
    });

    const projects = readClaudeJson()["projects"] as Record<string, Record<string, unknown>>;
    expect(projects[path.resolve(workspacePath)]?.["hasTrustDialogAccepted"]).toBe(true);
    expect(writeErrorMock).toHaveBeenCalledWith(expect.stringContaining("could not read"));
  });

  it("preserves unrelated Claude project entries", () => {
    const workspacePath = path.join(fakeHome, "claude-new");
    const otherPath = path.resolve(fakeHome, "other");
    writeFileSync(
      path.join(fakeHome, ".claude.json"),
      JSON.stringify({
        theme: "dark",
        projects: {
          [otherPath]: { hasTrustDialogAccepted: true, note: "leave-alone" },
        },
      }),
      "utf8",
    );

    seedAgentWorkspaceTrust({
      agentCommandName: "claude",
      workspacePath,
      homeDir: fakeHome,
    });

    const parsed = readClaudeJson();
    expect(parsed["theme"]).toBe("dark");
    const projects = parsed["projects"] as Record<string, Record<string, unknown>>;
    expect(projects[otherPath]).toEqual({ hasTrustDialogAccepted: true, note: "leave-alone" });
    expect(projects[path.resolve(workspacePath)]?.["hasTrustDialogAccepted"]).toBe(true);
  });

  it("seeds the launch cwd for Cursor when it is a monorepo subdir", () => {
    const worktreeRoot = path.join(fakeHome, "worktrees");
    const launchDir = path.join(worktreeRoot, "repo-team-1", "services", "api");
    mkdirSync(launchDir, { recursive: true });

    seedAgentWorkspaceTrust({
      agentCommandName: "cursor-agent",
      workspacePath: launchDir,
      homeDir: fakeHome,
    });

    const markerPath = path.join(
      fakeHome,
      ".cursor",
      "projects",
      cursorProjectSlug(launchDir),
      ".workspace-trusted",
    );
    expect(existsSync(markerPath)).toBe(true);
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as { workspacePath: string };
    expect(marker.workspacePath).toBe(path.resolve(launchDir));
    expect(marker.workspacePath).not.toBe(path.resolve(worktreeRoot));
  });

  it("seeds the launch cwd for Codex when it is a monorepo subdir", () => {
    const worktreeRoot = path.join(fakeHome, "worktrees");
    const launchDir = path.join(worktreeRoot, "repo-team-1", "services", "api");
    mkdirSync(launchDir, { recursive: true });

    seedAgentWorkspaceTrust({
      agentCommandName: "codex",
      workspacePath: launchDir,
      homeDir: fakeHome,
    });

    expect(readCodexConfig()).toBe(
      `${codexProjectTableHeader(path.resolve(launchDir))}\ntrust_level = "trusted"\n`,
    );
  });

  it("trusts a Codex workspace in config.toml for a new path", () => {
    const workspacePath = path.join(fakeHome, "codex-ws");

    seedAgentWorkspaceTrust({
      agentCommandName: "codex",
      workspacePath,
      homeDir: fakeHome,
    });

    const absolutePath = path.resolve(workspacePath);
    expect(readCodexConfig()).toBe(
      `${codexProjectTableHeader(absolutePath)}\ntrust_level = "trusted"\n`,
    );
  });

  it("is idempotent when Codex already trusts the workspace", () => {
    const workspacePath = path.resolve(fakeHome, "codex-trusted");
    const existing = `[features]\nhooks = true\n\n${codexProjectTableHeader(workspacePath)}\ntrust_level = "trusted"\n`;
    mkdirSync(path.join(fakeHome, ".codex"), { recursive: true });
    writeFileSync(codexConfigPath(), existing, "utf8");
    const before = statSync(codexConfigPath()).mtimeMs;

    seedAgentWorkspaceTrust({
      agentCommandName: "codex",
      workspacePath,
      homeDir: fakeHome,
    });

    expect(readCodexConfig()).toBe(existing);
    expect(statSync(codexConfigPath()).mtimeMs).toBe(before);
  });

  it("preserves unrelated Codex config.toml settings", () => {
    const workspacePath = path.join(fakeHome, "codex-new");
    mkdirSync(path.join(fakeHome, ".codex"), { recursive: true });
    writeFileSync(codexConfigPath(), "[features]\nhooks = true\n", "utf8");

    seedAgentWorkspaceTrust({
      agentCommandName: "codex",
      workspacePath,
      homeDir: fakeHome,
    });

    expect(readCodexConfig()).toBe(
      `[features]\nhooks = true\n${codexProjectTableHeader(path.resolve(workspacePath))}\ntrust_level = "trusted"\n`,
    );
  });

  it("upgrades an existing Codex project section to trusted", () => {
    const workspacePath = path.resolve(fakeHome, "codex-upgrade");
    mkdirSync(path.join(fakeHome, ".codex"), { recursive: true });
    writeFileSync(
      codexConfigPath(),
      `${codexProjectTableHeader(workspacePath)}\napproval_policy = "on-request"\n`,
      "utf8",
    );

    seedAgentWorkspaceTrust({
      agentCommandName: "codex",
      workspacePath,
      homeDir: fakeHome,
    });

    expect(readCodexConfig()).toBe(
      `${codexProjectTableHeader(workspacePath)}\napproval_policy = "on-request"\ntrust_level = "trusted"\n`,
    );
  });

  it("replaces a non-trusted Codex trust_level", () => {
    const workspacePath = path.resolve(fakeHome, "codex-replace");
    mkdirSync(path.join(fakeHome, ".codex"), { recursive: true });
    writeFileSync(
      codexConfigPath(),
      `${codexProjectTableHeader(workspacePath)}\ntrust_level = "untrusted"\n`,
      "utf8",
    );

    seedAgentWorkspaceTrust({
      agentCommandName: "codex",
      workspacePath,
      homeDir: fakeHome,
    });

    expect(readCodexConfig()).toBe(
      `${codexProjectTableHeader(workspacePath)}\ntrust_level = "trusted"\n`,
    );
  });

  it("updates trust inside a Codex project section when later sections follow", () => {
    const workspacePath = path.resolve(fakeHome, "codex-middle");
    mkdirSync(path.join(fakeHome, ".codex"), { recursive: true });
    writeFileSync(
      codexConfigPath(),
      `${codexProjectTableHeader(workspacePath)}\ntrust_level = "untrusted"\n[features]\nhooks = true\n`,
      "utf8",
    );

    seedAgentWorkspaceTrust({
      agentCommandName: "codex",
      workspacePath,
      homeDir: fakeHome,
    });

    expect(readCodexConfig()).toBe(
      `${codexProjectTableHeader(workspacePath)}\ntrust_level = "trusted"\n[features]\nhooks = true\n`,
    );
  });

  it("appends a newline before a new Codex project section when config omits a trailing newline", () => {
    const workspacePath = path.join(fakeHome, "codex-no-nl");
    mkdirSync(path.join(fakeHome, ".codex"), { recursive: true });
    writeFileSync(codexConfigPath(), "[features]\nhooks = true", "utf8");

    seedAgentWorkspaceTrust({
      agentCommandName: "codex",
      workspacePath,
      homeDir: fakeHome,
    });

    expect(readCodexConfig()).toBe(
      `[features]\nhooks = true\n${codexProjectTableHeader(path.resolve(workspacePath))}\ntrust_level = "trusted"\n`,
    );
  });

  it("adds trust_level to a Codex project section that omits a trailing newline", () => {
    const workspacePath = path.resolve(fakeHome, "codex-section-no-nl");
    mkdirSync(path.join(fakeHome, ".codex"), { recursive: true });
    writeFileSync(
      codexConfigPath(),
      `${codexProjectTableHeader(workspacePath)}\napproval_policy = "on-request"`,
      "utf8",
    );

    seedAgentWorkspaceTrust({
      agentCommandName: "codex",
      workspacePath,
      homeDir: fakeHome,
    });

    expect(readCodexConfig()).toBe(
      `${codexProjectTableHeader(workspacePath)}\napproval_policy = "on-request"\ntrust_level = "trusted"\n`,
    );
  });

  it("seeds from a fresh codex config when an existing config.toml cannot be read", () => {
    const workspacePath = path.join(fakeHome, "codex-unreadable");
    mkdirSync(path.join(fakeHome, ".codex"), { recursive: true });
    writeFileSync(codexConfigPath(), "[features]\nhooks = true\n", "utf8");
    chmodSync(codexConfigPath(), 0o000);

    seedAgentWorkspaceTrust({
      agentCommandName: "codex",
      workspacePath,
      homeDir: fakeHome,
    });

    chmodSync(codexConfigPath(), 0o600);
    expect(readCodexConfig()).toBe(
      `${codexProjectTableHeader(path.resolve(workspacePath))}\ntrust_level = "trusted"\n`,
    );
    expect(writeErrorMock).toHaveBeenCalledWith(expect.stringContaining("could not read"));
  });

  it("is a no-op for unknown agents", () => {
    const workspacePath = path.join(fakeHome, "noop-ws");

    seedAgentWorkspaceTrust({
      agentCommandName: "unknown-agent",
      workspacePath,
      homeDir: fakeHome,
    });

    expect(existsSync(path.join(fakeHome, ".claude.json"))).toBe(false);
    expect(existsSync(path.join(fakeHome, ".cursor"))).toBe(false);
    expect(existsSync(codexConfigPath())).toBe(false);
  });

  it("rejects non-object claude.json roots", () => {
    const workspacePath = path.join(fakeHome, "ws");
    writeFileSync(path.join(fakeHome, ".claude.json"), "[]", "utf8");

    seedAgentWorkspaceTrust({
      agentCommandName: "claude",
      workspacePath,
      homeDir: fakeHome,
    });

    const projects = readClaudeJson()["projects"] as Record<string, Record<string, unknown>>;
    expect(projects[path.resolve(workspacePath)]?.["hasTrustDialogAccepted"]).toBe(true);
    expect(writeErrorMock).toHaveBeenCalledWith(expect.stringContaining("is not a JSON object"));
  });

  it("recovers when claude.json projects is not an object", () => {
    const workspacePath = path.join(fakeHome, "claude-invalid-projects");
    writeFileSync(
      path.join(fakeHome, ".claude.json"),
      JSON.stringify({ projects: "bad", theme: "dark" }),
      "utf8",
    );

    seedAgentWorkspaceTrust({
      agentCommandName: "claude",
      workspacePath,
      homeDir: fakeHome,
    });

    const parsed = readClaudeJson();
    expect(parsed["theme"]).toBe("dark");
    const projects = parsed["projects"] as Record<string, Record<string, unknown>>;
    expect(projects[path.resolve(workspacePath)]?.["hasTrustDialogAccepted"]).toBe(true);
    expect(writeErrorMock).toHaveBeenCalledWith(expect.stringContaining("invalid projects field"));
  });

  it("logs when claude.json cannot be written", () => {
    const workspacePath = path.join(fakeHome, "claude-write-fail");
    chmodSync(fakeHome, 0o500);

    seedAgentWorkspaceTrust({
      agentCommandName: "claude",
      workspacePath,
      homeDir: fakeHome,
    });

    chmodSync(fakeHome, 0o700);
    expect(writeErrorMock).toHaveBeenCalledWith(
      expect.stringContaining("could not seed Claude workspace trust"),
    );
  });

  it("logs when Cursor workspace trust cannot be written", () => {
    const workspacePath = path.join(fakeHome, "cursor-write-fail");
    mkdirSync(path.join(fakeHome, ".cursor", "projects"), { recursive: true });
    chmodSync(path.join(fakeHome, ".cursor", "projects"), 0o500);

    seedAgentWorkspaceTrust({
      agentCommandName: "cursor-agent",
      workspacePath,
      homeDir: fakeHome,
    });

    chmodSync(path.join(fakeHome, ".cursor", "projects"), 0o700);
    expect(writeErrorMock).toHaveBeenCalledWith(
      expect.stringContaining("could not seed Cursor workspace trust"),
    );
  });

  it("logs when codex config.toml cannot be written", () => {
    const workspacePath = path.join(fakeHome, "codex-write-fail");
    mkdirSync(path.join(fakeHome, ".codex"), { recursive: true });
    chmodSync(path.join(fakeHome, ".codex"), 0o500);

    seedAgentWorkspaceTrust({
      agentCommandName: "codex",
      workspacePath,
      homeDir: fakeHome,
    });

    chmodSync(path.join(fakeHome, ".codex"), 0o700);
    expect(writeErrorMock).toHaveBeenCalledWith(
      expect.stringContaining("could not seed Codex workspace trust"),
    );
  });

  it("logs and skips seeding when home cannot be resolved", () => {
    seedAgentWorkspaceTrust({
      agentCommandName: "claude",
      workspacePath: "/tmp/ws",
      readHome: () => {
        throw new Error("no home");
      },
    });

    expect(writeErrorMock).toHaveBeenCalledWith(
      "groundcrew: could not resolve home directory for workspace trust seeding",
    );
  });
});
