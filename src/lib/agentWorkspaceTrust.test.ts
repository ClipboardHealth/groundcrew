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

import { cursorProjectSlug, seedAgentWorkspaceTrust } from "./agentWorkspaceTrust.ts";

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

  it("seeds the provided workspace path when it differs from the worktree root", () => {
    const worktreeDir = path.join(fakeHome, "repo-team-1");
    const workingDir = path.join(worktreeDir, "services", "api");
    mkdirSync(workingDir, { recursive: true });

    seedAgentWorkspaceTrust({
      agentCommandName: "cursor-agent",
      workspacePath: workingDir,
      homeDir: fakeHome,
    });

    const markerPath = path.join(
      fakeHome,
      ".cursor",
      "projects",
      cursorProjectSlug(workingDir),
      ".workspace-trusted",
    );
    expect(existsSync(markerPath)).toBe(true);
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as { workspacePath: string };
    expect(marker.workspacePath).toBe(path.resolve(workingDir));
    expect(marker.workspacePath).not.toBe(path.resolve(worktreeDir));
  });

  it("is a no-op for codex and unknown agents", () => {
    const workspacePath = path.join(fakeHome, "noop-ws");

    seedAgentWorkspaceTrust({
      agentCommandName: "codex",
      workspacePath,
      homeDir: fakeHome,
    });
    seedAgentWorkspaceTrust({
      agentCommandName: "unknown-agent",
      workspacePath,
      homeDir: fakeHome,
    });

    expect(existsSync(path.join(fakeHome, ".claude.json"))).toBe(false);
    expect(existsSync(path.join(fakeHome, ".cursor"))).toBe(false);
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
