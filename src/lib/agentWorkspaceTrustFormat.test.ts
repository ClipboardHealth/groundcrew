import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  formatAgentTrustList,
  formatTrustActionResults,
  shortenTrustPath,
} from "./agentWorkspaceTrustFormat.ts";

describe(shortenTrustPath, () => {
  it("replaces the home directory prefix with tilde", () => {
    const home = "/Users/test";
    expect(shortenTrustPath("/Users/test/dev/repo", home)).toBe("~/dev/repo");
    expect(shortenTrustPath("/Users/test", home)).toBe("~");
  });

  it("leaves paths outside the home directory unchanged", () => {
    expect(shortenTrustPath("/tmp/ws", "/Users/test")).toBe("/tmp/ws");
  });
});

describe(formatAgentTrustList, () => {
  let fakeHome: string;
  let existingPath: string;

  beforeEach(() => {
    fakeHome = mkdtempSync(path.join(os.tmpdir(), "agent-workspace-trust-format-"));
    existingPath = path.join(fakeHome, "still-here");
    mkdirSync(existingPath, { recursive: true });
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it("groups entries by agent without redundant trust detail lines", () => {
    const missingPath = path.join(fakeHome, "gone");
    const formatted = formatAgentTrustList(
      [
        {
          agent: "claude",
          workspacePath: existingPath,
          detail: "hasTrustDialogAccepted",
          store: `${fakeHome}/.claude.json#projects`,
        },
        {
          agent: "cursor",
          workspacePath: missingPath,
          detail: "groundcrew-auto-trust",
          store: `${fakeHome}/.cursor/projects/slug/.workspace-trusted`,
        },
      ],
      { homeDir: fakeHome },
    );

    expect(formatted).toContain("Workspace trust (2 entries · 1 missing)");
    expect(formatted).toContain("Claude (1)");
    expect(formatted).toContain(`✓  ${shortenTrustPath(existingPath, fakeHome)}`);
    expect(formatted).toContain("Cursor (1)");
    expect(formatted).toContain(`✗  ${shortenTrustPath(missingPath, fakeHome)}`);
    expect(formatted).toContain("[missing]");
    expect(formatted).not.toContain("hasTrustDialogAccepted");
    expect(formatted).not.toContain("groundcrew-auto-trust");
  });

  it("shows a warning only for unparseable Cursor markers", () => {
    const formatted = formatAgentTrustList(
      [
        {
          agent: "cursor",
          workspacePath: existingPath,
          detail: "trusted (unparseable marker)",
          store: `${fakeHome}/.cursor/projects/slug/.workspace-trusted`,
        },
      ],
      { homeDir: fakeHome },
    );

    expect(formatted).toContain("⚠");
    expect(formatted).toContain("unparseable marker");
    expect(existsSync(existingPath)).toBe(true);
  });

  it("uses a stale header when listing missing entries only", () => {
    const formatted = formatAgentTrustList(
      [
        {
          agent: "codex",
          workspacePath: path.join(fakeHome, "gone"),
          detail: "trust_level=trusted",
          store: `${fakeHome}/.codex/config.toml`,
        },
      ],
      { homeDir: fakeHome, missingOnly: true },
    );

    expect(formatted).toContain("Stale workspace trust (1 entry)");
    expect(formatted).not.toContain("trust_level");
  });
});

describe(formatTrustActionResults, () => {
  const fakeHome = "/Users/test";

  it("renders prune results without trust metadata", () => {
    const formatted = formatTrustActionResults(
      [
        { agent: "claude", workspacePath: "/Users/test/gone", deleted: true },
        { agent: "cursor", workspacePath: "/Users/test/stuck", deleted: false },
      ],
      { homeDir: fakeHome, action: "prune" },
    );

    expect(formatted).toContain("Pruned 1 stale entry");
    expect(formatted).toContain("✓  claude  ~/gone");
    expect(formatted).toContain("✗  cursor  ~/stuck");
    expect(formatted).toContain("Summary: 1 removed · 1 failed");
  });

  it("reports when delete finds no matches", () => {
    expect(formatTrustActionResults([], { homeDir: fakeHome, action: "delete" })).toBe(
      "No matching workspace trust entries.",
    );
  });

  it("reports when list is empty", () => {
    expect(formatAgentTrustList([], { homeDir: fakeHome })).toBe(
      "No workspace trust entries found.",
    );
  });
});
