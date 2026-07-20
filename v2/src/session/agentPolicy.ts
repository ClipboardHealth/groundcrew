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
 *   common MCP endpoints out of the box. `additionalNetwork` is appended to the
 *   effective list (baseline or explicit `network`) so a host can be added
 *   without recopying the whole baseline.
 *
 * v1's per-surface write carve-outs are restored through {@link SandboxPolicy}'s
 * `denyWritePaths` dimension (deny wins over allow): the executable/persistence
 * surfaces inside the whole-dir grants — `~/.claude/{settings,commands,hooks,…}`,
 * `~/.cursor/{mcp.json,hooks,rules,…}`, `~/.codex/config.toml`, `~/.npm/_npx`,
 * and each repo clone's `.git/{hooks,config}` — are denied so an agent cannot
 * plant something that runs on the user's next host invocation. The whole `.git`
 * stays writable (contracts §9) so a sandboxed commit still succeeds; only the
 * two code-execution files under it are carved out. See the profile `deny` lists
 * and `denyWritePaths` composition below for the full ledger, each with its v1
 * `srtPolicy.ts` cite.
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
  /**
   * Hosts appended to the effective egress list rather than replacing it: the
   * baseline when `network` is omitted, or `network` when specified. The additive
   * counterpart to `network` (contracts §5) — add a host without recopying the
   * ~30-entry baseline.
   */
  readonly additionalNetwork?: readonly string[];
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
 * `.claude.json` (the `mcpServers` host-RCE surface) is read-only by omission (in
 * `read`, not `write`). `deny` re-adds v1's per-surface write carve-outs
 * (`srtPolicy.ts:175`, `:217`) that the whole-dir `write` grant would otherwise
 * re-open: the executable/instruction surfaces inside `~/.claude`/`~/.cursor`
 * that would execute on the user's next host run. codex is NOT relocated to a
 * temp `CODEX_HOME` here (v1 `srtLaunch.ts:96` — that needs launch-side env +
 * temp-dir plumbing); instead its real `~/.codex` stays writable for session
 * state but the `config.toml` MCP-server surface is denied (the cited host-RCE
 * vector), which closes persistence without the relocation dance. Deny wins over
 * allow, so a denied surface stays read-only under the whole-dir grant.
 */
const AGENT_HOME_PROFILES: Record<
  string,
  {
    readonly read: readonly string[];
    readonly write: readonly string[];
    readonly deny?: readonly string[];
    readonly keychain?: boolean;
  }
> = {
  claude: {
    // `.local/share/claude` is the native installer's versioned binary dir
    // (`~/.local/bin/claude` symlinks into it); without it the agent binary is
    // masked and cannot exec itself. Validated live (real-agent smoke).
    read: [".claude", ".claude.json", ".config/claude", ".local/share/claude"],
    write: [".claude"],
    // v1 srtPolicy.ts:175-196 — the mcpServers config, settings, and every
    // executable/instruction surface a prompted agent could plant to run on the
    // user's next host invocation. claude tolerates these being read-only
    // (validated live, STAFF-1305). `.claude.json` is already read-only by
    // omission; listed for parity/defense.
    deny: [
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
      ".claude/chrome",
      ".claude/.git/hooks",
      ".claude/.git/config",
    ],
    keychain: true,
  },
  codex: {
    read: [".codex", ".config/codex"],
    write: [".codex"],
    // v1 relocated CODEX_HOME so real ~/.codex was never written (srtPolicy.ts:234,
    // srtLaunch.ts:96). Here ~/.codex stays writable for session state; deny the
    // config.toml MCP-server surface (the cited host-RCE vector) so a prompted
    // agent cannot rewrite the commands codex spawns on the user's next host run.
    deny: [".codex/config.toml"],
  },
  cursor: {
    read: [".cursor", ".config/cursor", ".local/share/cursor-agent"],
    write: [".cursor"],
    // v1 srtPolicy.ts:217-229 — mcp.json (mcpServers), lifecycle hooks, global
    // rules/skills/plugins/commands: the host-RCE persistence surfaces.
    deny: [
      ".cursor/mcp.json",
      ".cursor/hooks.json",
      ".cursor/hooks",
      ".cursor/rules",
      ".cursor/skills-cursor",
      ".cursor/plugins",
      ".cursor/commands",
    ],
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

/** Every known agent credential/state home, HOME-relative. */
const ALL_AGENT_HOME_DIRS: readonly string[] = [".claude", ".codex", ".cursor"];

/**
 * Subpaths of each provisioned repo clone's `.git` carved back out of the
 * whole-`.git` write grant (contracts §9 pins the whole dir writable). `hooks`
 * (planting `post-checkout` etc.) and `config` (setting `core.hooksPath`) are the
 * v1 host-RCE surfaces (`srtPolicy.ts:414,453`) that fire on the user's next host
 * git op; a git commit inside the worktree writes none of them (it touches
 * objects/refs/logs/HEAD/index), so denying them keeps commits working.
 */
const GIT_WRITE_DENY_SUBPATHS: readonly string[] = ["hooks", "config"];

/**
 * `~/.npm/_npx` is denied even though `~/.npm` is writable for the npm cache:
 * npx stores downloaded tools there as ready-to-run binaries, so poisoning that
 * cache is host execution the next time the user runs `npx` outside the sandbox
 * (v1 `srtPolicy.ts:342,349`).
 */
const NPM_NPX_DENY_HOME_PATH = ".npm/_npx";

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

  const baseNetwork = input.configPolicy.network ?? DEFAULT_AGENT_EGRESS;
  const network = unique([...baseNetwork, ...(input.configPolicy.additionalNetwork ?? [])]);

  const ownedHomeDirs = new Set(activeProfiles.flatMap((profile) => profile.write));
  const denyWritePaths = unique([
    // Per-agent executable/persistence surfaces carved out of the whole-dir home
    // grant (v1's per-surface denies; deny wins over the `.claude`/`.cursor` grant).
    ...activeProfiles.flatMap((profile) => profile.deny ?? []).map(underHome),
    // Agent homes this launch does not own: closes srt's default `~/.claude/debug`
    // write path (added to every policy) and blocks cross-agent credential writes.
    ...ALL_AGENT_HOME_DIRS.filter((dir) => !ownedHomeDirs.has(dir)).map(underHome),
    // npx cache poison (whole `~/.npm` is writable for the cache).
    underHome(NPM_NPX_DENY_HOME_PATH),
    // Executable surfaces inside each repo clone's whole-`.git` write grant.
    ...input.repoCloneGitDirectories.flatMap((gitDir) =>
      GIT_WRITE_DENY_SUBPATHS.map((subpath) => path.join(gitDir, subpath)),
    ),
  ]);

  return { writablePaths, readOnlyPaths, network, denyWritePaths };
}

export interface ComposeHookPolicyInput {
  /** Config `sandbox.readOnlyDirectories`/`network`/`additionalNetwork` slice. */
  readonly configPolicy: AgentSandboxConfig;
  /** The just-created worktree the hook runs in (read + write). */
  readonly worktreeDirectory: string;
  /**
   * The worktree's parent clone `.git` (read + write minus `hooks`/`config`).
   * `npm ci` writes nothing here, but git operations a hook runs may.
   */
  readonly cloneGitDirectory: string;
  /** Ambient environment; supplies `HOME`/`TMPDIR` for path expansion. */
  readonly environment: Record<string, string>;
  /** Defaults to `process.platform`. Injected in tests. */
  readonly platform?: NodeJS.Platform;
  /** Defaults to `environment.HOME ?? os.homedir()`. Injected in tests. */
  readonly homeDir?: string;
}

/**
 * The profile-neutral policy for the repo-controlled `prepareWorktree` hook
 * (v1's `prepare` policy, `srtLaunch.ts:107`). The hook (default `npm ci`) can
 * come from a repo-committed `.groundcrew/config.json`, so it runs with **no
 * agent credentials**: home masked, only the worktree + its clone's `.git`
 * writable (plus the npm cache and temp scratch), toolchains/git-identity
 * readable, egress the same baseline agents get, and every agent home denied
 * write. This is what stops an unattended `crew start --watch` from running
 * arbitrary repo postinstall code on the host.
 */
export function composeHookPolicy(input: ComposeHookPolicyInput): SandboxPolicy {
  const platform = input.platform ?? process.platform;
  const homeDir = input.homeDir ?? input.environment["HOME"] ?? os.homedir();
  const underHome = (relativePath: string): string => path.join(homeDir, relativePath);

  const readOnlyPaths = unique([
    ...input.configPolicy.readOnlyPaths,
    ...TOOLCHAIN_READ_HOME_PATHS.map(underHome),
    ...IDENTITY_READ_HOME_PATHS.map(underHome),
  ]);

  const tmpDir = input.environment["TMPDIR"];
  const writablePaths = unique([
    input.worktreeDirectory,
    input.cloneGitDirectory,
    ...SHARED_WRITE_HOME_PATHS.map(underHome),
    ...(tmpDir === undefined || tmpDir === "" ? [] : [tmpDir]),
    ...SYSTEM_TEMP_WRITE_PATHS[platform === "darwin" ? "darwin" : "other"],
  ]);

  const baseNetwork = input.configPolicy.network ?? DEFAULT_AGENT_EGRESS;
  const network = unique([...baseNetwork, ...(input.configPolicy.additionalNetwork ?? [])]);

  const denyWritePaths = unique([
    // No agent runs the hook, so deny every agent home outright (also closes
    // srt's default `~/.claude/debug` write path): the repo hook gets zero creds.
    ...ALL_AGENT_HOME_DIRS.map(underHome),
    underHome(NPM_NPX_DENY_HOME_PATH),
    ...GIT_WRITE_DENY_SUBPATHS.map((subpath) => path.join(input.cloneGitDirectory, subpath)),
  ]);

  return { writablePaths, readOnlyPaths, network, denyWritePaths };
}

/**
 * A bound `prepareWorktree` hook wrapper injected DOWN into Workspace (which may
 * not import Sandbox): given the raw hook command and the worktree it runs in,
 * returns the sandbox-wrapped command line. Kept structural so Workspace declares
 * its own identical parameter type without importing Session.
 */
export type PrepareHookSandbox = (input: {
  readonly command: string;
  readonly worktreeDirectory: string;
  readonly cloneGitDirectory: string;
}) => Promise<string>;

/**
 * Build the {@link PrepareHookSandbox} the orchestrator injects into provisioning:
 * it composes the profile-neutral hook policy per worktree and wraps the command
 * with the given sandbox `wrapCommand`. The caller only creates this when the
 * sandbox is ON (the `GROUNDCREW_SANDBOX=off` kill-switch omits it, so the hook
 * runs unwrapped like agents and sources do).
 */
export function createPrepareHookSandbox(input: {
  readonly wrapCommand: (wrap: {
    command: string;
    policy: SandboxPolicy;
  }) => Promise<{ command: string }>;
  readonly configPolicy: AgentSandboxConfig;
  readonly environment: Record<string, string>;
  readonly platform?: NodeJS.Platform;
  readonly homeDir?: string;
}): PrepareHookSandbox {
  return async ({ command, worktreeDirectory, cloneGitDirectory }): Promise<string> => {
    const policy = composeHookPolicy({
      configPolicy: input.configPolicy,
      worktreeDirectory,
      cloneGitDirectory,
      environment: input.environment,
      ...(input.platform === undefined ? {} : { platform: input.platform }),
      ...(input.homeDir === undefined ? {} : { homeDir: input.homeDir }),
    });
    const wrapped = await input.wrapCommand({ command, policy });
    return wrapped.command;
  };
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
