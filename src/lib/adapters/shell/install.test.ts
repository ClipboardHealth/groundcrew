import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { installShellSource } from "./install.ts";
import type { SourceManifest } from "./manifest.ts";

function manifestWith(overrides: Partial<SourceManifest>): SourceManifest {
  return {
    name: "demo",
    kind: "shell",
    description: "demo",
    installDir: "/replaced/in/test",
    files: [],
    commands: { listTasks: "demo list" },
    ...overrides,
  };
}

describe("installShellSource", () => {
  it("copies script files into installDir and marks them executable", () => {
    const root = mkdtempSync(path.join(tmpdir(), "install-shell-"));
    try {
      const manifestDir = path.join(root, "manifest");
      const installDir = path.join(root, "install");
      mkdirSync(manifestDir);
      writeFileSync(path.join(manifestDir, "demo.sh"), "#!/bin/sh\necho hi\n");
      const manifest = manifestWith({ installDir, files: ["demo.sh"] });

      const actual = installShellSource({ manifest, manifestDir });

      expect(existsSync(path.join(installDir, "demo.sh"))).toBe(true);
      expect(actual.scriptPaths).toStrictEqual([path.join(installDir, "demo.sh")]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("creates nested directories for nested bundle files", () => {
    const root = mkdtempSync(path.join(tmpdir(), "install-shell-"));
    try {
      const manifestDir = path.join(root, "manifest");
      const installDir = path.join(root, "install");
      mkdirSync(path.join(manifestDir, "bin"), { recursive: true });
      writeFileSync(path.join(manifestDir, "bin", "demo.sh"), "#!/bin/sh\necho hi\n");
      const manifest = manifestWith({ installDir, files: ["bin/demo.sh"] });

      const actual = installShellSource({ manifest, manifestDir });

      expect(existsSync(path.join(installDir, "bin", "demo.sh"))).toBe(true);
      expect(actual.scriptPaths).toStrictEqual([path.join(installDir, "bin", "demo.sh")]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refreshes an installed script when the shipped copy differs", () => {
    const root = mkdtempSync(path.join(tmpdir(), "install-shell-"));
    try {
      const manifestDir = path.join(root, "manifest");
      const installDir = path.join(root, "install");
      mkdirSync(manifestDir);
      mkdirSync(installDir);
      writeFileSync(path.join(manifestDir, "demo.sh"), "new\n");
      writeFileSync(path.join(installDir, "demo.sh"), "stale\n");
      const manifest = manifestWith({ installDir, files: ["demo.sh"] });

      installShellSource({ manifest, manifestDir });

      expect(readFileSync(path.join(installDir, "demo.sh"), "utf8")).toBe("new\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("re-copies nothing when the installed script already matches", () => {
    const root = mkdtempSync(path.join(tmpdir(), "install-shell-"));
    try {
      const manifestDir = path.join(root, "manifest");
      const installDir = path.join(root, "install");
      mkdirSync(manifestDir);
      mkdirSync(installDir);
      writeFileSync(path.join(manifestDir, "demo.sh"), "same\n");
      writeFileSync(path.join(installDir, "demo.sh"), "same\n");
      const manifest = manifestWith({ installDir, files: ["demo.sh"] });

      const actual = installShellSource({ manifest, manifestDir });

      expect(readFileSync(path.join(installDir, "demo.sh"), "utf8")).toBe("same\n");
      expect(actual.scriptPaths).toStrictEqual([path.join(installDir, "demo.sh")]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a files entry that escapes the install directory", () => {
    const root = mkdtempSync(path.join(tmpdir(), "install-shell-"));
    try {
      const manifestDir = path.join(root, "manifest");
      const installDir = path.join(root, "install");
      mkdirSync(manifestDir);
      writeFileSync(path.join(manifestDir, "evil.sh"), "#!/bin/sh\n");
      const manifest = manifestWith({ installDir, files: ["../evil.sh"] });

      const run = (): unknown => installShellSource({ manifest, manifestDir });

      expect(run).toThrow(/escapes/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("installs nothing when the manifest lists no files", () => {
    const root = mkdtempSync(path.join(tmpdir(), "install-shell-"));
    try {
      const installDir = path.join(root, "install");
      const manifest = manifestWith({ installDir, files: [] });

      const actual = installShellSource({ manifest, manifestDir: root });

      expect(actual.scriptPaths).toStrictEqual([]);
      expect(existsSync(installDir)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
