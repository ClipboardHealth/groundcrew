/**
 * Agent-launch policy composition (contracts §9, ported from v1 `srtPolicy.ts`).
 * The sandbox module is a pure `policy → srt` translator; this module owns the
 * *policy ergonomics* a real coding-agent CLI needs, which the initial v2 port
 * dropped — so a sandboxed `claude`/`codex`/`cursor` could neither find its own
 * install (masked under `$HOME`), reach its API (empty egress), nor commit
 * (the parent clone's `.git` was unwritable).
 *
 * The composition, deny-by-default with narrow re-opens:
 *
 * - **Reads.** Start from the config's `readOnlyDirectories` and add the
 *   HOME-relative carve-outs an agent needs under the home read-mask: its own
 *   config/credential dirs (scoped to the agent kinds actually in play), the
 *   language toolchains and version managers that run it, git identity
 *   (`~/.gitconfig`, `~/.config/git`), `gh` config, and — on macOS for
 *   keychain-authenticated agents — the user keychain dir. srt skips any path
 *   that does not exist, so listing an uninstalled toolchain or an absent agent
 *   home is harmless.
 * - **Writes.** The task workspace and the state root (run records + log file
 *   the in-session `crew` writes), plus the agent's own state dir(s), the npm
 *   cache, `$TMPDIR`, and — critically — **each provisioned repo clone's `.git`
 *   directory**. A worktree shares the parent clone's object store, so a commit
 *   inside the worktree writes `<clone>/.git/objects` and its worktree metadata
 *   lives in `<clone>/.git/worktrees/<id>`; without this grant no sandboxed
 *   agent can ever commit.
 * - **Network.** Config `sandbox.network`, when specified, is the egress
 *   allowlist verbatim (config principle 1: specified = exactly yours). When it
 *   is omitted, the {@link DEFAULT_AGENT_EGRESS} baseline applies so a fresh
 *   install can reach the agent APIs, package registries, git hosts, and the
 *   common MCP endpoints out of the box.
 *
 * The v2 {@link SandboxPolicy} is allow-only (no deny dimension), so v1's
 * per-surface write carve-outs — denying `~/.claude.json`/`~/.claude/settings`,
 * the git `config`/`hooks`, and the worktree gitdir redirection files — are
 * expressed here by **omission** where possible (`.claude.json` is read-only
 * because it is granted read but not write) and otherwise deliberately dropped
 * (the whole `.git` is writable rather than a curated subpath allowlist). See
 * the module's port notes for the full ledger of what was kept vs dropped.
 */

import os from "node:os";
import path from "node:path";
import process from "node:process";

import type { SandboxPolicy } from "../sandbox/index.js";

/**
 * The config-derived slice of the agent sandbox policy Shell owns: the
 * host-wide read-only dirs and the (optional) egress allowlist. `network` is
 * `undefined` when the config omits `sandbox.network` (⇒ the default baseline
 * applies) and an array — possibly empty (⇒ deny all egress) — when specified.
 */
export interface AgentSandboxConfig {
  readonly readOnlyPaths: readonly string[];
  readonly network?: readonly string[];
}

export interface ComposeAgentPolicyInput {
  /** Config `sandbox.readOnlyDirectories`/`network`, already tilde-expanded. */
  readonly configPolicy: AgentSandboxConfig;
  /** The task workspace directory (read + write). */
  readonly workspaceDirectory: string;
  /** The groundcrew state root (read + write: run records, log file). */
  readonly stateRoot: string;
  /**
   * Each provisioned repo clone's `.git` directory (read + write). Worktrees
   * share the parent clone's object store, so this is what lets a sandboxed
   * agent commit. Dispatch computes these per task from `clonePath`.
   */
  readonly repoCloneGitDirectories: readonly string[];
  /** Ambient environment; supplies `HOME` and `TMPDIR` for path expansion. */
  readonly environment: Record<string, string>;
  /**
   * Agent kinds in play (profile names, e.g. `["claude"]`). Scopes the agent
   * home read/write carve-outs to the agents actually configured/detected so
   * one agent's session cannot read another's credentials. Omitted ⇒ the full
   * known-agent set (the safe superset).
   */
  readonly agentKinds?: readonly string[];
  /** Defaults to `process.platform`. Injected in tests. */
  readonly platform?: NodeJS.Platform;
  /** Defaults to `environment.HOME ?? os.homedir()`. Injected in tests. */
  readonly homeDir?: string;
}

/**
 * Per-agent HOME-relative config/state carve-outs, keyed by profile name. `read`
 * re-opens the agent's config/credentials under the home mask; `write` grants
 * the session-state dirs the agent writes during a task. `keychain` re-opens the
 * macOS user keychain dir for agents that authenticate through it.
 *
 * `.claude.json` (the `mcpServers` host-RCE surface) is intentionally in `read`
 * but not `write`: in v2's allow-only model, omitting it from `write` keeps it
 * read-only, preserving v1's persistence protection for that file without a deny
 * dimension. Unlike v1, codex is NOT relocated (`CODEX_HOME`) — its real
 * `~/.codex` is granted write directly (simpler; the relocation+seed dance is
 * dropped, see port notes).
 */
const AGENT_HOME_PROFILES: Record<
  string,
  { readonly read: readonly string[]; readonly write: readonly string[]; readonly keychain?: boolean }
> = {
  claude: {
    // `.local/share/claude` is the native installer's versioned binary dir
    // (`~/.local/bin/claude` symlinks into it); without it the agent binary is
    // masked and cannot exec itself. Validated live (real-agent smoke).
    read: [".claude", ".claude.json", ".config/claude", ".local/share/claude"],
    write: [".claude"],
    keychain: true,
  },
  codex: {
    read: [".codex", ".config/codex"],
    write: [".codex"],
  },
  cursor: {
    read: [".cursor", ".config/cursor", ".local/share/cursor-agent"],
    write: [".cursor"],
    keychain: true,
  },
};

/**
 * Language toolchains and version managers re-opened read-only so the agent's
 * runtime and any installed CLIs execute under the home mask. Ported from v1's
 * `TOOLCHAIN_READ_ROOTS`, plus `mise` and the npm global prefix. The active Node
 * runtime prefix itself is re-opened by the sandbox module; these cover the rest
 * of a polyglot install. Pure version-manager dirs are kept whole; multi-purpose
 * homes are narrowed to their executable/cache subpaths so credential files
 * (e.g. `~/.cargo/credentials.toml`) stay masked.
 */
const TOOLCHAIN_READ_HOME_PATHS: readonly string[] = [
  ".nvm",
  ".rustup",
  ".asdf",
  ".volta",
  ".pyenv",
  ".rbenv",
  ".npm",
  ".npm-global",
  ".local/bin",
  ".local/lib",
  ".local/share/mise",
  ".config/mise",
  ".cargo/bin",
  ".cargo/registry",
  ".cargo/git",
  ".bun/bin",
  ".bun/install",
  ".deno/bin",
  "go/bin",
  "go/pkg",
];

/** Git identity + `gh` config the agent reads (never writes — `allowGitConfig` stays off). */
const IDENTITY_READ_HOME_PATHS: readonly string[] = [".gitconfig", ".config/git", ".config/gh"];

/** HOME-relative dirs granted write regardless of agent kind: caches the toolchain writes. */
const SHARED_WRITE_HOME_PATHS: readonly string[] = [".npm"];

/** macOS user keychain dir, re-opened read-only for keychain-authenticated agents. */
const MACOS_KEYCHAIN_READ_PATH = "Library/Keychains";

/**
 * System temp dirs granted write so agent shell tools can scratch. On macOS
 * `/tmp` is a symlink to `/private/tmp`; the sandbox resolves paths, so both are
 * listed to cover either form.
 */
const SYSTEM_TEMP_WRITE_PATHS: Record<"darwin" | "other", readonly string[]> = {
  darwin: ["/tmp", "/private/tmp"],
  other: ["/tmp"],
};

/**
 * Default agent egress allowlist, applied when config omits `sandbox.network`.
 * Curated from v1's `clearance-allow-hosts`: the agent-provider APIs, package
 * registries, git hosts, and the MCP/observability endpoints the shipped agent
 * skills reach. Trimmed of v1 entries that are not agent-relevant. A config
 * `sandbox.network` (even `[]`) replaces this wholesale.
 */
export const DEFAULT_AGENT_EGRESS: readonly string[] = [
  // Anthropic / Claude
  "api.anthropic.com",
  "docs.anthropic.com",
  "docs.claude.com",
  "downloads.claude.ai",
  "platform.claude.com",
  "mcp-proxy.anthropic.com",
  // OpenAI / codex
  "api.openai.com",
  "chatgpt.com",
  "ab.chatgpt.com",
  // Cursor (numbered API hosts rotate under *.cursor.sh)
  "*.cursor.sh",
  "cursor.com",
  "www.cursor.com",
  // GitHub + gh + release/artifact CDNs
  "api.github.com",
  "github.com",
  "codeload.github.com",
  "raw.githubusercontent.com",
  "release-assets.githubusercontent.com",
  // npm + PyPI (agents installing deps)
  "registry.npmjs.org",
  "api.npmjs.org",
  "www.npmjs.com",
  "pypi.org",
  "files.pythonhosted.org",
  // Linear (issue tracker + MCP)
  "api.linear.app",
  "linear.app",
  "mcp.linear.app",
  // Datadog (investigation skills + MCP)
  "api.datadoghq.com",
  "mcp.datadoghq.com",
  // Slack + Notion MCP
  "api.slack.com",
  "slack.com",
  "mcp.slack.com",
  "api.notion.com",
  "mcp.notion.com",
  // Schemas + code search commonly resolved by tooling
  "json.schemastore.org",
  "sourcegraph.com",
];

/** Every known agent kind — the default home-grant scope when none is passed. */
const KNOWN_AGENT_KINDS: readonly string[] = Object.keys(AGENT_HOME_PROFILES);

/**
 * Compose the full per-task agent sandbox policy from the config slice plus the
 * per-task workspace/state/repo values. Returns a {@link SandboxPolicy} ready to
 * hand to `launchSession`.
 */
export function composeAgentPolicy(input: ComposeAgentPolicyInput): SandboxPolicy {
  const platform = input.platform ?? process.platform;
  const homeDir = input.homeDir ?? input.environment["HOME"] ?? os.homedir();
  const underHome = (relativePath: string): string => path.join(homeDir, relativePath);

  const kinds = input.agentKinds ?? KNOWN_AGENT_KINDS;
  const activeProfiles = kinds
    .map((kind) => AGENT_HOME_PROFILES[kind.toLowerCase()])
    .filter((profile): profile is (typeof AGENT_HOME_PROFILES)[string] => profile !== undefined);

  const keychainRead =
    platform === "darwin" && activeProfiles.some((profile) => profile.keychain === true)
      ? [underHome(MACOS_KEYCHAIN_READ_PATH)]
      : [];

  const readOnlyPaths = unique([
    ...input.configPolicy.readOnlyPaths,
    ...activeProfiles.flatMap((profile) => profile.read).map(underHome),
    ...TOOLCHAIN_READ_HOME_PATHS.map(underHome),
    ...IDENTITY_READ_HOME_PATHS.map(underHome),
    ...keychainRead,
  ]);

  const tmpDir = input.environment["TMPDIR"];
  const writablePaths = unique([
    input.workspaceDirectory,
    input.stateRoot,
    ...activeProfiles.flatMap((profile) => profile.write).map(underHome),
    ...SHARED_WRITE_HOME_PATHS.map(underHome),
    ...input.repoCloneGitDirectories,
    ...(tmpDir === undefined || tmpDir === "" ? [] : [tmpDir]),
    // Agent shell tools scratch under the system temp dir, and it is not always
    // `$TMPDIR` — claude's Bash tool writes snapshots to `/tmp/claude-<uid>/…`
    // (validated live). `/tmp` is shared scratch, not a credential surface.
    ...SYSTEM_TEMP_WRITE_PATHS[platform === "darwin" ? "darwin" : "other"],
  ]);

  const network = input.configPolicy.network ?? DEFAULT_AGENT_EGRESS;

  return { writablePaths, readOnlyPaths, network: [...network] };
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
