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
 *   toolchains needed to *run* the agent, the agent's own config/credential
 *   dirs, and — on macOS, for keychain-authenticated agents (claude) — the user
 *   keychain dir (`~/Library/Keychains`) so the agent can authenticate under
 *   the home mask. srt skips non-existent allow/deny paths, so listing a path
 *   that isn't present (a Linux keychain dir, an uninstalled toolchain) is
 *   harmless.
 * - **Writes** are allow-only in srt. Two STAFF-1305 structural fixes shape it:
 *   1. **Agent state (work item 1).** The host-CLI persistence vector (planting
 *      hooks, `mcpServers`, commands, plugins, … that execute on the user's
 *      next host run) is closed per agent. **claude** runs with a writable
 *      `~/.claude` (its Bash tool creates `session-env`/scratch state there) but
 *      every fixed-path executable/instruction surface — including
 *      `~/.claude.json` (`mcpServers`) and the bundled `chrome` binary — is
 *      denied; claude tolerates those write denials. **codex** hard-fails with a
 *      read-only home, so it is pointed at a relocated, per-launch writable
 *      config dir (`CODEX_HOME`, see {@link agentConfigRelocation}) and its real
 *      `~/.codex` is never write-granted at all.
 *   2. **Git (work item 2).** The git common dir is granted write as a **narrow
 *      allowlist** of exactly the paths `status/diff/add/commit/push/gc` write —
 *      never wholesale — so the per-worktree gitdir redirection files, sibling
 *      worktree gitdirs, and the repo `config`/`hooks` stay unwritable.
 *   `denyWrite` is belt-and-suspenders over global toolchain bins and the agent
 *   homes; it uses **literal paths only** because bubblewrap silently ignores
 *   globs on Linux.
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
   * Granted read wholesale, but write only as a narrow allowlist of the paths
   * the git workflow actually touches (see `GIT_COMMON_WRITE_PATHS`).
   */
  gitCommonDir: string;
  /** Agent identity (e.g. "claude", "codex") used to pick the credential profile. */
  agent: string;
  /** srt `network.allowedDomains`, already translated from the clearance allowlist. */
  allowedDomains: readonly string[];
  /**
   * Absolute path to the agent's relocated, writable config/state home for this
   * launch (codex's `CODEX_HOME`). When set it is granted read + write so the
   * agent persists session state there instead of its real home, which stays
   * read-only. claude does not relocate (its macOS keychain credential is bound
   * to the default config dir), so this is omitted for it.
   */
  relocatedConfigDir?: string;
  /** Defaults to `process.platform`. Injected in tests to exercise both deny-read roots. */
  platform?: NodeJS.Platform;
  /** Defaults to `os.homedir()`. Injected in tests. */
  homeDir?: string;
  /** Defaults to `process.execPath`; used to locate the global node_modules to deny writes to. */
  nodeExecPath?: string;
}

/**
 * How an agent that cannot run with a read-only config home is pointed at a
 * relocated, per-launch writable home instead. The launch stages a temp dir,
 * seeds it with the minimal files the agent needs to authenticate + keep its
 * config, exports `configDirEnv` to that dir, and grants it write — so the real
 * home (which holds the persistence surfaces) is never written.
 *
 * Empirically (STAFF-1305 live validation, macOS): codex hard-fails to launch
 * with a read-only `~/.codex` ("failed to initialize in-process app-server
 * client") and authenticates from a file (`auth.json`), so relocating
 * `CODEX_HOME` + seeding `auth.json`/`config.toml` both unblocks it and closes
 * persistence. claude is deliberately absent: its macOS keychain credential is
 * bound to the default config dir, so relocating `CLAUDE_CONFIG_DIR` breaks
 * auth — claude instead runs with a writable home whose executable surfaces are
 * denied (see `AGENT_SRT_PROFILES`).
 */
export interface AgentConfigRelocation {
  /** Env var that points the agent at a relocated config home. */
  configDirEnv: string;
  /** Home-relative dir the seed files are copied from (the agent's real home). */
  sourceHomeRelativeDir: string;
  /** Files (relative to `sourceHomeRelativeDir`) seeded into the relocated home. */
  seedFiles: readonly string[];
}

/**
 * Return the config-relocation spec for an agent, or `undefined` when the agent
 * runs with a writable real home + deny-list and does not relocate (claude,
 * unknown agents).
 */
export function agentConfigRelocation(agent: string): AgentConfigRelocation | undefined {
  return AGENT_CONFIG_RELOCATIONS[agent.toLowerCase()];
}

interface AgentCredentialProfile {
  /** Home-relative paths the agent must read (config, credentials). */
  readPaths: readonly string[];
  /**
   * Home-relative paths the agent must write (session state). Empty for agents
   * whose real home stays read-only because they relocate (codex).
   */
  writePaths: readonly string[];
  /**
   * Home-relative executable/instruction surfaces carved back OUT of
   * `writePaths`. These are read by the agent but, if it could *write* them, a
   * prompted agent could persist by planting hooks/commands/plugins/mcpServers
   * that execute on the user's next host run. The agent does not write these
   * during a task (validated live in STAFF-1305 — claude stays fully functional,
   * Bash tool included, with all of these denied), so denying them degrades
   * gracefully. `~/.claude.json` (`mcpServers`) and the bundled `chrome` binary
   * are included — the sharpest vectors, which the pre-graduation policy left
   * writable.
   */
  denyPaths: readonly string[];
  /**
   * macOS only: re-open the user keychain dir (`~/Library/Keychains`) for read
   * so the agent can authenticate. The home deny-read mask (`/Users`) would
   * otherwise hide the keychain the agent's OAuth token lives in. No-op on Linux
   * (the path does not exist; srt skips it), where these agents use file creds.
   */
  usesMacosKeychain?: boolean;
}

/**
 * Per-agent credential/config profiles. Deliberately narrow — no blanket
 * `~/.config`, which would re-expose unrelated apps' secrets. An unknown agent
 * gets no extra home access and must be granted paths explicitly.
 *
 * claude keeps a writable home (`writePaths`) with the executable surfaces
 * re-closed (`denyPaths`) because its macOS keychain credential is bound to the
 * default config dir, so it cannot be relocated. codex has no `writePaths`: it
 * relocates (see `AGENT_CONFIG_RELOCATIONS`), so its real `~/.codex` is
 * read-only and no per-surface deny-list is needed there.
 */
const AGENT_SRT_PROFILES: Record<string, AgentCredentialProfile> = {
  claude: {
    readPaths: [".claude", ".claude.json"],
    writePaths: [".claude"],
    denyPaths: [
      // The mcpServers config — claude spawns these commands on every startup,
      // the sharpest host-RCE persistence vector. claude tolerates this being
      // read-only (validated live; it does not write it during a task).
      ".claude.json",
      ".claude/settings.json",
      ".claude/settings.local.json",
      ".claude/commands",
      ".claude/agents",
      ".claude/plugins",
      ".claude/skills",
      ".claude/hooks",
      ".claude/statusline.sh",
      ".claude/CLAUDE.md",
      // Bundled browser binary — replaceable with a malicious one that runs when
      // claude next drives a browser on the host.
      ".claude/chrome",
      // ~/.claude is itself a git repo; deny the executable surfaces within its
      // gitdir (commits, if any, still write objects/refs).
      ".claude/.git/hooks",
      ".claude/.git/config",
    ],
    usesMacosKeychain: true,
  },
  codex: {
    // Read-only: codex relocates its writable home (CODEX_HOME), so the real
    // ~/.codex never needs write and no per-surface deny-list is required.
    readPaths: [".codex"],
    writePaths: [],
    denyPaths: [],
  },
};

const AGENT_CONFIG_RELOCATIONS: Record<string, AgentConfigRelocation> = {
  codex: {
    configDirEnv: "CODEX_HOME",
    sourceHomeRelativeDir: ".codex",
    // auth.json carries the ChatGPT OAuth tokens (codex reads creds from a file,
    // not the keychain); config.toml preserves the user's codex configuration.
    seedFiles: ["auth.json", "config.toml"],
  },
};

/** macOS user keychain dir, re-opened read-only for keychain-authenticated agents. */
const MACOS_KEYCHAIN_READ_PATH = "Library/Keychains";

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
 * The git common dir is granted write only at these relative subpaths — never
 * wholesale — so the agent's `status/diff/add/commit/push` + `gc`/`pack-refs`
 * work while the persistence/tamper surfaces stay unwritable by *omission*
 * (macOS Seatbelt is deny-beats-allow, so a denied parent cannot be re-allowed
 * for a child — the allowlist is the only correct shape). Closed by not being
 * listed: `config`, `hooks`, `modules`, and **sibling** worktree gitdirs under
 * `worktrees/<other>` (cross-task tamper). This worktree's own gitdir is
 * granted separately and its redirection files carved back out (see
 * `gitCommonWriteDenies`).
 *
 * Enumerated against a live run under srt (STAFF-1305): `objects` (loose +
 * packs + commit-graph), `refs` + `logs` (branch + remote-tracking refs and
 * their reflogs — granted whole because `gc` packs/deletes refs across *all*
 * branches, so scoping to the current branch would break `gc`), `packed-refs`
 * (+ `.lock`/`.new` temps), `info` (`update-server-info`), and the root-level
 * `gc.pid`/`HEAD`/`ORIG_HEAD`/`FETCH_HEAD` (+ `.lock` temps) that `gc`'s
 * repo-global reflog expiry touches. None are code-execution surfaces.
 */
const GIT_COMMON_WRITE_PATHS: readonly string[] = [
  "objects",
  "refs",
  "logs",
  "info",
  "packed-refs",
  "packed-refs.lock",
  "packed-refs.new",
  "gc.pid",
  "gc.pid.lock",
  "HEAD",
  "HEAD.lock",
  "ORIG_HEAD",
  "FETCH_HEAD",
];

/**
 * Every agent credential/state home dir. A profile that does NOT own one of
 * these (it isn't in the profile's `writePaths`) must deny writes to it — both
 * as cross-agent defense (the codex profile shouldn't write `~/.claude`) and to
 * override srt's hardcoded default write path `~/.claude/debug`, which
 * `getDefaultWritePaths()` adds to every policy. Without this, that default
 * re-opens `~/.claude/debug` (and, on Linux, makes it readable via the write
 * bind) even under the profile-neutral prepare policy and the relocating codex
 * profile. `denyWrite` wins over `allowWrite`, so denying the home dir overrides
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
  const underGit = (relativePath: string): string => path.join(input.gitCommonDir, relativePath);
  const worktreeBasename = path.basename(input.worktreeDir);

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

  // macOS keychain re-open for keychain-authenticated agents. Home-relative so
  // it is a no-op on Linux (the path does not exist there; srt skips it), where
  // these agents read credentials from a file under their (readable) home.
  const keychainRead =
    platform === "darwin" && profile.usesMacosKeychain === true
      ? [underHome(MACOS_KEYCHAIN_READ_PATH)]
      : [];

  const allowRead = unique([
    input.worktreeDir,
    input.gitCommonDir,
    nodePrefix,
    ...TOOLCHAIN_READ_ROOTS.map(underHome),
    ...GIT_READ_PATHS.map(underHome),
    ...profile.readPaths.map(underHome),
    ...keychainRead,
    ...(input.relocatedConfigDir === undefined ? [] : [input.relocatedConfigDir]),
  ]);

  const allowWrite = unique([
    input.worktreeDir,
    underHome(".npm"),
    // Narrow git allowlist — never the whole common dir (see GIT_COMMON_WRITE_PATHS).
    ...GIT_COMMON_WRITE_PATHS.map(underGit),
    underGit(path.join("worktrees", worktreeBasename)),
    ...profile.writePaths.map(underHome),
    // The agent's relocated, writable config home (codex). Absent for agents
    // that write their real home behind a deny-list (claude).
    ...(input.relocatedConfigDir === undefined ? [] : [input.relocatedConfigDir]),
  ]);

  const denyWrite = unique([
    nodeGlobalModules,
    nodeBinDir,
    ...TOOLCHAIN_WRITE_DENY.map(underHome),
    // Carve the agent's executable/config surfaces back out of its writable
    // state dir so a prompted agent can't plant a hook/command/plugin/mcpServer
    // that runs on the user's next host invocation (denyWrite wins over
    // allowWrite).
    ...profile.denyPaths.map(underHome),
    // Deny agent home dirs this profile does not own — counters srt's default
    // `~/.claude/debug` write path for the neutral prepare policy and the
    // relocating codex profile, and keeps profiles from writing each other's
    // credentials.
    ...ALL_AGENT_HOME_DIRS.filter((dir) => !profile.writePaths.includes(dir)).map(underHome),
    // Carve the per-worktree git redirection + config files back out of the
    // granted worktree gitdir: `commondir`/`gitdir` redirect git to a fake
    // common dir with its own hooks/config, and `config.worktree` can set
    // `core.*` hooks that run when git next operates here on the host. git
    // writes these once at worktree creation, never during a task.
    ...gitCommonWriteDenies(input.gitCommonDir, worktreeBasename),
    // The worktree's `.git` is a pointer *file* (`gitdir: …`). Deny writing it so
    // the agent can't redirect the gitdir to a writable fake with its own
    // config/hooks. git sets this pointer once at creation.
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

/**
 * Files inside this worktree's granted gitdir that must stay unwritable: the
 * `commondir`/`gitdir` redirection pointers and the per-worktree
 * `config.worktree`. Returned as denies so they override the gitdir's
 * `allowWrite` grant.
 */
function gitCommonWriteDenies(gitCommonDir: string, worktreeBasename: string): string[] {
  const worktreeGitDir = path.join(gitCommonDir, "worktrees", worktreeBasename);
  return [
    path.join(worktreeGitDir, "commondir"),
    path.join(worktreeGitDir, "gitdir"),
    path.join(worktreeGitDir, "config.worktree"),
  ];
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
