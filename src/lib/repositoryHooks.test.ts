import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { resolvePrepareWorktreeCommand } from "./repositoryHooks.ts";

function temporaryWorktree(): string {
  return mkdtempSync(path.join(tmpdir(), "groundcrew-hooks-"));
}

function writeRepositoryConfig(worktreeDir: string, config: unknown): void {
  mkdirSync(path.join(worktreeDir, ".groundcrew"), { recursive: true });
  writeFileSync(
    path.join(worktreeDir, ".groundcrew", "config.json"),
    `${JSON.stringify(config, undefined, 2)}\n`,
  );
}

describe(resolvePrepareWorktreeCommand, () => {
  it("returns undefined when neither repo config nor defaults define prepareWorktree", () => {
    const worktreeDir = temporaryWorktree();
    try {
      const actual = resolvePrepareWorktreeCommand({
        worktreeDir,
        defaultHooks: {},
      });

      expect(actual).toBeUndefined();
    } finally {
      rmSync(worktreeDir, { recursive: true, force: true });
    }
  });

  it("falls back to the crew config default when repo config is absent", () => {
    const worktreeDir = temporaryWorktree();
    try {
      const actual = resolvePrepareWorktreeCommand({
        worktreeDir,
        defaultHooks: { prepareWorktree: "npm ci" },
      });

      expect(actual).toEqual({ command: "npm ci", source: "operator" });
    } finally {
      rmSync(worktreeDir, { recursive: true, force: true });
    }
  });

  it("uses the repo-local prepareWorktree hook over the crew config default", () => {
    const worktreeDir = temporaryWorktree();
    try {
      writeRepositoryConfig(worktreeDir, {
        version: 1,
        hooks: { prepareWorktree: "uv sync --dev" },
      });

      const actual = resolvePrepareWorktreeCommand({
        worktreeDir,
        defaultHooks: { prepareWorktree: "npm ci" },
      });

      expect(actual).toEqual({ command: "uv sync --dev", source: "repository" });
    } finally {
      rmSync(worktreeDir, { recursive: true, force: true });
    }
  });

  it("uses the per-repo operator hook over the crew config default", () => {
    const worktreeDir = temporaryWorktree();
    try {
      const actual = resolvePrepareWorktreeCommand({
        worktreeDir,
        perRepoHooks: { prepareWorktree: "make setup" },
        defaultHooks: { prepareWorktree: "npm ci" },
      });

      expect(actual).toEqual({ command: "make setup", source: "operator" });
    } finally {
      rmSync(worktreeDir, { recursive: true, force: true });
    }
  });

  it("uses the per-repo operator hook when no crew config default is set", () => {
    const worktreeDir = temporaryWorktree();
    try {
      const actual = resolvePrepareWorktreeCommand({
        worktreeDir,
        perRepoHooks: { prepareWorktree: "make setup" },
        defaultHooks: {},
      });

      expect(actual).toEqual({ command: "make setup", source: "operator" });
    } finally {
      rmSync(worktreeDir, { recursive: true, force: true });
    }
  });

  it("uses the repo-local hook over the per-repo operator hook", () => {
    const worktreeDir = temporaryWorktree();
    try {
      writeRepositoryConfig(worktreeDir, {
        version: 1,
        hooks: { prepareWorktree: "uv sync --dev" },
      });

      const actual = resolvePrepareWorktreeCommand({
        worktreeDir,
        perRepoHooks: { prepareWorktree: "make setup" },
        defaultHooks: { prepareWorktree: "npm ci" },
      });

      expect(actual).toEqual({ command: "uv sync --dev", source: "repository" });
    } finally {
      rmSync(worktreeDir, { recursive: true, force: true });
    }
  });

  it("falls back to the crew config default when the per-repo layer has no hook", () => {
    const worktreeDir = temporaryWorktree();
    try {
      const actual = resolvePrepareWorktreeCommand({
        worktreeDir,
        perRepoHooks: {},
        defaultHooks: { prepareWorktree: "npm ci" },
      });

      expect(actual).toEqual({ command: "npm ci", source: "operator" });
    } finally {
      rmSync(worktreeDir, { recursive: true, force: true });
    }
  });

  it("falls back to the crew config default when repo config has no prepareWorktree hook", () => {
    const worktreeDir = temporaryWorktree();
    try {
      writeRepositoryConfig(worktreeDir, { version: 1, hooks: {} });

      const actual = resolvePrepareWorktreeCommand({
        worktreeDir,
        defaultHooks: { prepareWorktree: "npm ci" },
      });

      expect(actual).toEqual({ command: "npm ci", source: "operator" });
    } finally {
      rmSync(worktreeDir, { recursive: true, force: true });
    }
  });

  it("falls back to the crew config default when repo config omits hooks", () => {
    const worktreeDir = temporaryWorktree();
    try {
      writeRepositoryConfig(worktreeDir, { version: 1 });

      const actual = resolvePrepareWorktreeCommand({
        worktreeDir,
        defaultHooks: { prepareWorktree: "npm ci" },
      });

      expect(actual).toEqual({ command: "npm ci", source: "operator" });
    } finally {
      rmSync(worktreeDir, { recursive: true, force: true });
    }
  });

  it("wraps read errors for repo config files that exist but cannot be read", () => {
    const worktreeDir = temporaryWorktree();
    try {
      mkdirSync(path.join(worktreeDir, ".groundcrew", "config.json"), { recursive: true });

      expect(() =>
        resolvePrepareWorktreeCommand({
          worktreeDir,
          defaultHooks: {},
        }),
      ).toThrow(/Could not read \.groundcrew\/config\.json/);
    } finally {
      rmSync(worktreeDir, { recursive: true, force: true });
    }
  });

  it("rejects invalid repo config JSON", () => {
    const worktreeDir = temporaryWorktree();
    try {
      mkdirSync(path.join(worktreeDir, ".groundcrew"), { recursive: true });
      writeFileSync(path.join(worktreeDir, ".groundcrew", "config.json"), "{");

      expect(() =>
        resolvePrepareWorktreeCommand({
          worktreeDir,
          defaultHooks: {},
        }),
      ).toThrow(/expected valid JSON/);
    } finally {
      rmSync(worktreeDir, { recursive: true, force: true });
    }
  });

  it("rejects repo config JSON that is not an object", () => {
    const worktreeDir = temporaryWorktree();
    try {
      writeRepositoryConfig(worktreeDir, []);

      expect(() =>
        resolvePrepareWorktreeCommand({
          worktreeDir,
          defaultHooks: {},
        }),
      ).toThrow(/must be a JSON object/);
    } finally {
      rmSync(worktreeDir, { recursive: true, force: true });
    }
  });

  it("rejects a repo config without version 1", () => {
    const worktreeDir = temporaryWorktree();
    try {
      writeRepositoryConfig(worktreeDir, { hooks: { prepareWorktree: "npm ci" } });

      expect(() =>
        resolvePrepareWorktreeCommand({
          worktreeDir,
          defaultHooks: {},
        }),
      ).toThrow(/\.groundcrew\/config\.json.*version.*1/);
    } finally {
      rmSync(worktreeDir, { recursive: true, force: true });
    }
  });

  it("rejects empty prepareWorktree commands", () => {
    const worktreeDir = temporaryWorktree();
    try {
      writeRepositoryConfig(worktreeDir, { version: 1, hooks: { prepareWorktree: " " } });

      expect(() =>
        resolvePrepareWorktreeCommand({
          worktreeDir,
          defaultHooks: {},
        }),
      ).toThrow(/hooks\.prepareWorktree must be a non-empty string/);
    } finally {
      rmSync(worktreeDir, { recursive: true, force: true });
    }
  });

  it("rejects repo config hooks that are not objects", () => {
    const worktreeDir = temporaryWorktree();
    try {
      writeRepositoryConfig(worktreeDir, { version: 1, hooks: [] });

      expect(() =>
        resolvePrepareWorktreeCommand({
          worktreeDir,
          defaultHooks: {},
        }),
      ).toThrow(/hooks must be an object/);
    } finally {
      rmSync(worktreeDir, { recursive: true, force: true });
    }
  });
});
