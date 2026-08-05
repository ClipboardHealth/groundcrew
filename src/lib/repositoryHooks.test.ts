import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ResolvedConfig } from "./config.ts";
import {
  resolvePrepareWorktreeCommand,
  resolveRepositoryPreparationCommands,
} from "./repositoryHooks.ts";

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

function preparationConfig(): ResolvedConfig {
  return {
    sources: [],
    defaults: { hooks: { prepareWorktree: "npm ci" } },
    git: { remote: "origin", defaultBranch: "main" },
    workspace: {
      projectDir: "/work",
      knownRepositories: ["acme/widgets"],
      repositories: [
        {
          name: "acme/widgets",
          hooks: { prepareWorktree: "make setup" },
          unsandboxedHooks: { prepareWorktree: "bin/setup" },
        },
      ],
    },
    orchestrator: {
      maximumInProgress: 4,
      pollIntervalMilliseconds: 1000,
      sessionLimitPercentage: 85,
    },
    agents: {
      default: "claude",
      definitions: { claude: { cmd: "claude", color: "#fff" } },
    },
    prompts: { initial: "x" },
    workspaceKind: "auto",
    local: {
      runner: "auto",
      networkEgress: "allowlisted",
      safehouse: { enable: [] },
      readOnlyDirs: [],
    },
    logging: { file: "/tmp/groundcrew-test.log" },
  };
}

describe(resolveRepositoryPreparationCommands, () => {
  it("resolves sandboxed and unsandboxed commands for a repository", () => {
    const worktreeDir = temporaryWorktree();
    try {
      expect(
        resolveRepositoryPreparationCommands({
          config: preparationConfig(),
          repository: "acme/widgets",
          worktreeDir,
        }),
      ).toStrictEqual({
        prepareWorktreeCommand: "make setup",
        prepareWorktreeUnsandboxedCommand: "bin/setup",
      });
    } finally {
      rmSync(worktreeDir, { recursive: true, force: true });
    }
  });
});

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

      expect(actual).toBe("npm ci");
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

      expect(actual).toBe("uv sync --dev");
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

      expect(actual).toBe("make setup");
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

      expect(actual).toBe("make setup");
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

      expect(actual).toBe("uv sync --dev");
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

      expect(actual).toBe("npm ci");
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

      expect(actual).toBe("npm ci");
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

      expect(actual).toBe("npm ci");
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

  it("rejects a repo config that sets unsandboxedHooks at the top level", () => {
    const worktreeDir = temporaryWorktree();
    try {
      writeRepositoryConfig(worktreeDir, {
        version: 1,
        unsandboxedHooks: { prepareWorktree: "bin/setup" },
      });

      expect(() =>
        resolvePrepareWorktreeCommand({
          worktreeDir,
          defaultHooks: {},
        }),
      ).toThrow(
        /unsandboxedHooks is operator-only and cannot be set in a repository config\. Move it to crew\.config\.ts\./,
      );
    } finally {
      rmSync(worktreeDir, { recursive: true, force: true });
    }
  });

  it("rejects a repo config that sets hookGeneratedPaths at the top level", () => {
    const worktreeDir = temporaryWorktree();
    try {
      writeRepositoryConfig(worktreeDir, {
        version: 1,
        hookGeneratedPaths: [".claude/settings.json"],
      });

      expect(() =>
        resolvePrepareWorktreeCommand({
          worktreeDir,
          defaultHooks: {},
        }),
      ).toThrow(
        /hookGeneratedPaths is operator-only and cannot be set in a repository config\. Move it to crew\.config\.ts\./,
      );
    } finally {
      rmSync(worktreeDir, { recursive: true, force: true });
    }
  });

  it("rejects a repo config that nests hookGeneratedPaths under hooks", () => {
    const worktreeDir = temporaryWorktree();
    try {
      writeRepositoryConfig(worktreeDir, {
        version: 1,
        hooks: { hookGeneratedPaths: [".claude/settings.json"] },
      });

      expect(() =>
        resolvePrepareWorktreeCommand({
          worktreeDir,
          defaultHooks: {},
        }),
      ).toThrow(/hookGeneratedPaths is operator-only and cannot be set in a repository config\./);
    } finally {
      rmSync(worktreeDir, { recursive: true, force: true });
    }
  });

  it("rejects a repo config that nests unsandboxedHooks under hooks", () => {
    const worktreeDir = temporaryWorktree();
    try {
      writeRepositoryConfig(worktreeDir, {
        version: 1,
        hooks: { unsandboxedHooks: { prepareWorktree: "bin/setup" } },
      });

      expect(() =>
        resolvePrepareWorktreeCommand({
          worktreeDir,
          defaultHooks: {},
        }),
      ).toThrow(/unsandboxedHooks is operator-only and cannot be set in a repository config\./);
    } finally {
      rmSync(worktreeDir, { recursive: true, force: true });
    }
  });
});
