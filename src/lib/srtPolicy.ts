/**
 * Generate the srt (Anthropic sandbox-runtime) settings object for a single
 * agent launch. srt is only a sandbox engine — it has no groundcrew- or
 * agent-aware policy of its own — so this module owns the policy ergonomics
 * that safehouse previously supplied via its bundled `.sb` profiles.
 *
 * The shape, in one place:
 *
 * - **Reads** start broad and are clamped: `denyRead` masks the whole home
 *   region (`/Users` on macOS, `/home` + `/root` on Linux) so the agent cannot
 *   read `~/.ssh`, `~/.aws`, shell history, or unrelated repos; `allowRead`
 *   then re-opens exactly the worktree, the repo's git metadata, the language
 *   toolchains needed to *run* the agent, and the agent's own credential dirs.
 *   srt skips non-existent allow/deny paths, so listing a toolchain that isn't
 *   installed is harmless.
 * - **Writes** are allow-only in srt, so a narrow `allowWrite` (worktree, git
 *   metadata, npm cache, the agent's own state) is the primary defense against
 *   the toolchain-persistence vector (agent-safehouse#102). `denyWrite` is
 *   belt-and-suspenders over global toolchain bins; it uses **literal paths
 *   only** because bubblewrap silently ignores globs on Linux.
 * - **Network** is allow-only and sourced from the existing clearance
 *   allowlist (see {@link ./clearanceHosts.ts}); local binding and unix sockets
 *   stay off (the docker socket and the DNS-exfil vector in srt#88).
 *
 * `allowPty` is on because the agent runs interactively under tmux;
 * `allowGitConfig` stays off so the agent cannot rewrite `~/.gitconfig` or
 * `.git/config` (both readable, just not writable).
 */

import os from "node:os";
import path from "node:path";
import process from "node:process";

import {
  SandboxRuntimeConfigSchema,
  type SandboxRuntimeConfig,
} from "@anthropic-ai/sandbox-runtime";

export interface BuildSrtSettingsInput {
  /** Absolute worktree directory the agent runs in (read + write). */
  worktreeDir: string;
  /**
   * Absolute path to the repo's git common dir (the parent clone's `.git`).
   * The worktree's per-worktree git dir lives under it, so granting it
   * read + write covers `git status/diff/add/commit/branch`.
   */
  gitCommonDir: string;
  /** Agent identity (e.g. "claude", "codex") used to pick the credential profile. */
  agent: string;
  /** srt `network.allowedDomains`, already translated from the clearance allowlist. */
  allowedDomains: readonly string[];
  /** Defaults to `process.platform`. Injected in tests to exercise both deny-read roots. */
  platform?: NodeJS.Platform;
  /** Defaults to `os.homedir()`. Injected in tests. */
  homeDir?: string;
  /** Defaults to `process.execPath`; used to locate the global node_modules to deny writes to. */
  nodeExecPath?: string;
}

interface AgentCredentialProfile {
  /** Home-relative paths the agent must read (config, credentials). */
  readPaths: readonly string[];
  /** Home-relative paths the agent must write (session state). */
  writePaths: readonly string[];
  /**
   * Home-relative config/executable subtrees carved back OUT of `writePaths`.
   * These are read by the agent but, if the agent could *write* them, a
   * prompted agent could persist by planting hooks/commands/plugins that
   * execute on the user's next host run. srt's mandatory deny only covers
   * `.claude/commands` and `.claude/agents`, so the rest (hooks-bearing
   * `settings.json`, plugins, skills, codex config) must be denied explicitly.
   */
  denyPaths: readonly string[];
}

/**
 * Per-agent credential/config paths re-opened under the home deny-read mask.
 * Deliberately narrow — no blanket `~/.config`, which would re-expose
 * unrelated apps' secrets. Extend via config in a later phase; an unknown
 * agent gets no extra home access and must be granted paths explicitly.
 *
 * `writePaths` keep the agent's mutable state writable (sessions, history,
 * todos, projects, caches, sqlite — a large, version-volatile set that an
 * allowlist would break on the next agent release); `denyPaths` re-close the
 * small, enumerable executable/instruction surfaces within them. The agent
 * does not write those during a task, so denying them degrades gracefully. The
 * lists below were validated against the real `~/.claude` / `~/.codex` layout;
 * srt's own mandatory deny additionally covers `.claude/commands`/`agents`.
 * Drift across agent versions is tracked for the live-validation pass.
 */
const AGENT_SRT_PROFILES: Record<string, AgentCredentialProfile> = {
  claude: {
    readPaths: [".claude", ".claude.json"],
    writePaths: [".claude", ".claude.json"],
    denyPaths: [
      ".claude/settings.json",
      ".claude/settings.local.json",
      ".claude/commands",
      ".claude/agents",
      ".claude/plugins",
      ".claude/skills",
      ".claude/hooks",
      ".claude/statusline.sh",
      ".claude/CLAUDE.md",
      // ~/.claude is itself a git repo; deny the executable surfaces within its
      // gitdir (commits, if any, still write objects/refs).
      ".claude/.git/hooks",
      ".claude/.git/config",
    ],
  },
  codex: {
    readPaths: [".codex"],
    writePaths: [".codex"],
    denyPaths: [
      ".codex/config.toml",
      ".codex/hooks.json",
      ".codex/AGENTS.md",
      ".codex/plugins",
      ".codex/skills",
      ".codex/rules",
      ".codex/.git/hooks",
      ".codex/.git/config",
    ],
  },
};

/**
 * Language toolchains and version managers re-opened read-only so the agent's
 * runtime (and any installed CLIs) can execute even though they live under the
 * home deny-read mask.
 *
 * srt's `allowRead` takes precedence over `denyRead`, so a credential carve-out
 * is impossible once a parent is re-opened — the roots themselves must be
 * narrow. Pure version-manager dirs (no credentials) are kept whole so version
 * resolution (`nvm use`, etc.) works; multi-purpose homes are narrowed to their
 * executable + dependency-cache subpaths so credential/config files (e.g.
 * `~/.cargo/credentials.toml`) and unrelated app state (`~/.local/share`) stay
 * masked. The node runtime itself is re-opened separately via `nodePrefix`.
 * (Polyglot coverage is best-effort + user-extensible; validated in STAFF-1305.)
 */
const TOOLCHAIN_READ_ROOTS: readonly string[] = [
  ".nvm",
  ".rustup",
  ".asdf",
  ".volta",
  ".pyenv",
  ".rbenv",
  ".npm", // npm cache; the ~/.npmrc credential file lives at $HOME and stays denied
  ".local/bin",
  ".local/lib",
  ".cargo/bin",
  ".cargo/registry",
  ".cargo/git",
  ".bun/bin",
  ".bun/install",
  ".deno/bin",
  "go/bin",
  "go/pkg",
];

/**
 * Every agent credential/state home dir. A profile that does NOT own one of
 * these must deny writes to it — both as cross-agent defense (the codex profile
 * shouldn't write `~/.claude`) and to override srt's hardcoded default write
 * path `~/.claude/debug`, which `getDefaultWritePaths()` adds to every policy.
 * Without this, that default re-opens `~/.claude/debug` (and, on Linux, makes
 * it readable via the write bind) even under the profile-neutral prepare
 * policy. `denyWrite` wins over `allowWrite`, so denying the home dir overrides
 * the default.
 */
const ALL_AGENT_HOME_DIRS: readonly string[] = [".claude", ".codex"];

/** Git identity/config the agent reads (never writes — see `allowGitConfig`). */
const GIT_READ_PATHS: readonly string[] = [".gitconfig", ".config/git"];

/**
 * Global toolchain bin/module locations writes are denied to, to close the
 * agent-safehouse#102 persistence vector (modifying a globally-installed CLI
 * that the user later runs outside the sandbox). Home-relative literals.
 *
 * `.npm/_npx` is denied even though `~/.npm` is writable for the npm cache:
 * `npx` stores downloaded tools there as ready-to-run binaries, so an agent
 * that poisons that cache would get host execution the next time the user runs
 * `npx <tool>` outside the sandbox — the same vector as the bin dirs above.
 */
const TOOLCHAIN_WRITE_DENY: readonly string[] = [
  ".cargo/bin",
  "go/bin",
  ".bun/install/global",
  ".deno/bin",
  ".local/bin",
  ".npm-global",
  ".npm/_npx",
  ".npmrc",
];

export function buildSrtSettings(input: BuildSrtSettingsInput): SandboxRuntimeConfig {
  const platform = input.platform ?? process.platform;
  const homeDir = input.homeDir ?? os.homedir();
  const nodeExecPath = input.nodeExecPath ?? process.execPath;
  const profile = AGENT_SRT_PROFILES[input.agent.toLowerCase()] ?? {
    readPaths: [],
    writePaths: [],
    denyPaths: [],
  };

  const underHome = (relativePath: string): string => path.join(homeDir, relativePath);

  // `<nodeBin>/../` is the node prefix; nvm/Volta-managed nodes keep their
  // global modules at `<prefix>/lib/node_modules` and shims at `<prefix>/bin`.
  const nodePrefix = path.dirname(path.dirname(nodeExecPath));
  const nodeGlobalModules = path.join(nodePrefix, "lib", "node_modules");
  const nodeBinDir = path.join(nodePrefix, "bin");

  // `/mnt` masks WSL's Windows drive mounts (e.g. `/mnt/c/Users/<user>/.aws`,
  // `.ssh`) — the Windows profile is readable from WSL and would otherwise
  // bypass the home mask on a documented-supported platform. Harmless on native
  // Linux (the worktree, if it lives under /mnt, is re-allowed below since
  // allowRead wins over denyRead).
  const denyRead = platform === "darwin" ? ["/Users"] : ["/home", "/root", "/mnt"];

  const allowRead = unique([
    input.worktreeDir,
    input.gitCommonDir,
    nodePrefix,
    ...TOOLCHAIN_READ_ROOTS.map(underHome),
    ...GIT_READ_PATHS.map(underHome),
    ...profile.readPaths.map(underHome),
  ]);

  const allowWrite = unique([
    input.worktreeDir,
    input.gitCommonDir,
    underHome(".npm"),
    ...profile.writePaths.map(underHome),
  ]);

  const denyWrite = unique([
    nodeGlobalModules,
    nodeBinDir,
    ...TOOLCHAIN_WRITE_DENY.map(underHome),
    // Carve the agent's executable/config surfaces back out of its writable
    // state dir so a prompted agent can't plant a hook/command/plugin that runs
    // on the user's next host invocation (denyWrite wins over allowWrite).
    ...profile.denyPaths.map(underHome),
    // Deny agent home dirs this profile does not own — counters srt's default
    // `~/.claude/debug` write path for the neutral prepare policy and the codex
    // profile, and keeps profiles from writing each other's credentials.
    ...ALL_AGENT_HOME_DIRS.filter((dir) => !profile.writePaths.includes(dir)).map(underHome),
    // Narrow the broad gitCommonDir write grant: the agent commits objects and
    // refs but must never rewrite the repo's config or install hooks (a
    // persistence vector). srt's mandatory deny is anchored at the cwd `.git`,
    // which for a worktree is a file pointing elsewhere — so guard the common
    // dir's config/hooks explicitly.
    path.join(input.gitCommonDir, "config"),
    path.join(input.gitCommonDir, "hooks"),
    // Nested git persistence surfaces the top-level config/hooks deny misses:
    // submodule gitdirs (`.git/modules/**/{config,hooks}`) and this worktree's
    // per-worktree `config.worktree`. Commits never write these. (Cross-worktree
    // isolation + full git-write scoping are tracked for live validation —
    // STAFF-1305.)
    path.join(input.gitCommonDir, "modules"),
    path.join(input.gitCommonDir, "worktrees", path.basename(input.worktreeDir), "config.worktree"),
    // The worktree's `.git` is a pointer *file* (`gitdir: …`). Deny writing it
    // so the agent can't redirect the gitdir to a writable fake with its own
    // config/hooks (e.g. `core.fsmonitor`) that runs when git next operates in
    // this worktree on the host. git sets this pointer once at creation.
    path.join(input.worktreeDir, ".git"),
  ]);

  const settings: SandboxRuntimeConfig = {
    network: {
      allowedDomains: [...input.allowedDomains],
      deniedDomains: [],
      allowLocalBinding: false,
      allowUnixSockets: [],
      allowAllUnixSockets: false,
    },
    filesystem: {
      denyRead,
      allowRead,
      allowWrite,
      denyWrite,
      allowGitConfig: false,
    },
    allowPty: true,
  };

  // Fail closed: validate with srt's own schema before this is staged. srt's
  // `loadConfig` `safeParse`s the settings file and, on ANY failure, returns
  // null — at which point the CLI silently falls back to a default config with
  // `denyRead: []`, disabling the home read mask for the launch. A single
  // malformed `allowedDomains` entry (e.g. a URL or host:port that slipped
  // through `collectAllowedDomains`) would otherwise trip that fail-open. Throw
  // here instead so the launch aborts loudly rather than running unsandboxed.
  const validation = SandboxRuntimeConfigSchema.safeParse(settings);
  if (!validation.success) {
    const detail = validation.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(
      `Generated srt settings failed validation (refusing to launch unsandboxed): ${detail}`,
    );
  }
  return settings;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
