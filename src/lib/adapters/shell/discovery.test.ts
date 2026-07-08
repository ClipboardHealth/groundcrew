import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  discoverFromRoots,
  discoverTaskSourceManifests,
  getTaskSourceManifest,
} from "./discovery.ts";

function writeBundle(root: string, name: string, listTasks: string): void {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "source.json"),
    JSON.stringify({
      name,
      kind: "shell",
      description: name,
      installDir: "~/.config/groundcrew",
      commands: { listTasks },
    }),
  );
}

describe("discoverFromRoots", () => {
  it("discovers manifests from a root", () => {
    const root = mkdtempSync(path.join(tmpdir(), "discover-"));
    try {
      writeBundle(root, "jira", "jira list");

      const { manifests } = discoverFromRoots([{ dir: root, origin: "package" }]);

      expect(manifests.map((m) => m.manifest.name)).toStrictEqual(["jira"]);
      expect(manifests[0]?.origin).toBe("package");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("lets a later root override an earlier one and records a warning", () => {
    const pkg = mkdtempSync(path.join(tmpdir(), "discover-pkg-"));
    const user = mkdtempSync(path.join(tmpdir(), "discover-user-"));
    try {
      writeBundle(pkg, "jira", "package jira");
      writeBundle(user, "jira", "user jira");

      const { manifests, warnings } = discoverFromRoots([
        { dir: pkg, origin: "package" },
        { dir: user, origin: "user" },
      ]);

      expect(manifests).toHaveLength(1);
      expect(manifests[0]?.origin).toBe("user");
      expect(manifests[0]?.manifest.commands.listTasks).toBe("user jira");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/jira/);
    } finally {
      rmSync(pkg, { recursive: true, force: true });
      rmSync(user, { recursive: true, force: true });
    }
  });

  it("skips a root that does not exist", () => {
    const { manifests } = discoverFromRoots([
      { dir: path.join(tmpdir(), "does-not-exist-xyz"), origin: "user" },
    ]);

    expect(manifests).toStrictEqual([]);
  });

  it("treats a file path root as empty rather than crashing", () => {
    const root = mkdtempSync(path.join(tmpdir(), "discover-file-"));
    try {
      const filePath = path.join(root, "not-a-dir");
      writeFileSync(filePath, "x");

      const { manifests } = discoverFromRoots([{ dir: filePath, origin: "user" }]);

      expect(manifests).toStrictEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("re-raises an unexpected readdir failure rather than swallowing it", () => {
    // An over-long path component makes readdir fail with ENAMETOOLONG (not
    // ENOENT/ENOTDIR), which discovery must surface rather than treat as an
    // empty root. Deterministic and independent of the running user.
    const tooLong = `/${"a".repeat(1000)}`;
    const run = (): unknown => discoverFromRoots([{ dir: tooLong, origin: "user" }]);

    expect(run).toThrow(/ENAMETOOLONG/i);
  });

  it("skips a manifest with invalid JSON and records a warning", () => {
    const root = mkdtempSync(path.join(tmpdir(), "discover-bad-"));
    try {
      const broken = path.join(root, "broken");
      mkdirSync(broken, { recursive: true });
      writeFileSync(path.join(broken, "source.json"), "{ not valid json");
      writeBundle(root, "jira", "jira list");

      const { manifests, warnings } = discoverFromRoots([{ dir: root, origin: "package" }]);

      expect(manifests.map((m) => m.manifest.name)).toStrictEqual(["jira"]);
      expect(warnings.some((w) => w.includes("broken"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips a subdirectory that has no source.json", () => {
    const root = mkdtempSync(path.join(tmpdir(), "discover-no-source-"));
    try {
      mkdirSync(path.join(root, "not-a-source"));
      writeBundle(root, "jira", "jira list");

      const { manifests } = discoverFromRoots([{ dir: root, origin: "package" }]);

      expect(manifests.map((m) => m.manifest.name)).toStrictEqual(["jira"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("getTaskSourceManifest", () => {
  it("returns the manifest for a discovered source and undefined for a code-adapter kind", () => {
    const home = mkdtempSync(path.join(tmpdir(), "get-manifest-"));
    vi.stubEnv("XDG_CONFIG_HOME", home);
    try {
      writeBundle(path.join(home, "groundcrew", "task-sources"), "acme", "acme list");

      expect(getTaskSourceManifest("acme")?.name).toBe("acme");
      expect(getTaskSourceManifest("linear")).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("discoverTaskSourceManifests", () => {
  it("warns to stderr when a user source overrides a package source", () => {
    const home = mkdtempSync(path.join(tmpdir(), "discover-xdg-"));
    const errorSpy = vi.spyOn(console, "error").mockReturnValue();
    vi.stubEnv("XDG_CONFIG_HOME", home);
    try {
      // "jira" collides with the package-bundled jira source, so the user copy
      // wins and a warning is written to stderr.
      writeBundle(path.join(home, "groundcrew", "task-sources"), "jira", "user jira list");

      const manifests = discoverTaskSourceManifests();

      const jira = manifests.find((m) => m.manifest.name === "jira");
      expect(jira?.origin).toBe("user");
      expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/jira/));
    } finally {
      vi.unstubAllEnvs();
      errorSpy.mockRestore();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
