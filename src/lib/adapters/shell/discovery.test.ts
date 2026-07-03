import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { discoverFromRoots } from "./discovery.ts";

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
});
