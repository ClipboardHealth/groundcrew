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

import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";

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
}

/**
 * Per-agent credential/config paths re-opened under the home deny-read mask.
 * Deliberately narrow — no blanket `~/.config`, which would re-expose
 * unrelated apps' secrets. Extend via config in a later phase; an unknown
 * agent gets no extra home access and must be granted paths explicitly.
 */
const AGENT_SRT_PROFILES: Record<string, AgentCredentialProfile> = {
  claude: { readPaths: [".claude", ".claude.json"], writePaths: [".claude", ".claude.json"] },
  codex: { readPaths: [".codex"], writePaths: [".codex"] },
};

/**
 * Language toolchains and version managers re-opened read-only so the agent's
 * runtime (and any installed CLIs) can execute even though they live under the
 * home deny-read mask. Read-only: writes to their bin dirs are denied below.
 */
const TOOLCHAIN_READ_ROOTS: readonly string[] = [
  ".nvm",
  ".local",
  ".npm",
  ".bun",
  ".cargo",
  ".rustup",
  ".deno",
  "go",
  ".asdf",
  ".volta",
  ".pyenv",
  ".rbenv",
];

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
  };

  const underHome = (relativePath: string): string => path.join(homeDir, relativePath);

  // `<nodeBin>/../` is the node prefix; nvm/Volta-managed nodes keep their
  // global modules at `<prefix>/lib/node_modules` and shims at `<prefix>/bin`.
  const nodePrefix = path.dirname(path.dirname(nodeExecPath));
  const nodeGlobalModules = path.join(nodePrefix, "lib", "node_modules");
  const nodeBinDir = path.join(nodePrefix, "bin");

  const denyRead = platform === "darwin" ? ["/Users"] : ["/home", "/root"];

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
    // Narrow the broad gitCommonDir write grant: the agent commits objects and
    // refs but must never rewrite the repo's config or install hooks (a
    // persistence vector). srt's mandatory deny is anchored at the cwd `.git`,
    // which for a worktree is a file pointing elsewhere — so guard the common
    // dir's config/hooks explicitly.
    path.join(input.gitCommonDir, "config"),
    path.join(input.gitCommonDir, "hooks"),
  ]);

  return {
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
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
