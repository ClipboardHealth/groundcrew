import { type Dirent, lstatSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";

import { runCommand } from "./commandRunner.ts";
import { debug, log, writeError } from "./util.ts";

/**
 * Home-relative config directory each agent reads its settings, skills, hooks,
 * agents, commands, and instruction files from. Only agents that keep a config
 * dir groundcrew must re-open inside the sandbox are listed; codex is absent on
 * purpose because its `CODEX_HOME` is relocated into a staged, writable home
 * (see `codexConfigRelocation.ts`) rather than read in place.
 */
const AGENT_CONFIG_DIRS: Record<string, string> = {
  claude: ".claude",
};

/**
 * Real subdirectories of the agent config dir worth descending into. Everything
 * else at that level is runtime state, not config — `projects` alone holds every
 * session transcript, and walking it both costs seconds and auto-grants whatever
 * stray links live in it. Symlinked entries are still resolved whatever they are
 * named; this list only bounds the crawl of *real* directories.
 */
const AGENT_CONFIG_DESCEND_NAMES: ReadonlySet<string> = new Set([
  "agents",
  "commands",
  "contexts",
  "hooks",
  "plugins",
  "skills",
]);

/**
 * Home-relative config paths of the host tools every agent shells out to,
 * resolved alongside the agent's own config dir.
 *
 * This is an allowlist rather than all of `~/.config` on purpose. Resolving
 * every `~/.config` entry would silently follow a dozen unrelated links (on the
 * reporting machine: `nvim`, `ranger`, `raycast`, `opencode`, ...) into
 * whatever a dotfiles repo happens to contain, which is a large inference to
 * make without the user writing anything down. Resolving only the agent's own
 * config dir is too narrow in the other direction: it leaves `gh` unable to
 * start, so the agent cannot open the PR it was dispatched to open. The
 * allowlist is the middle position — each entry is a tool groundcrew's own
 * workflow depends on, and anything outside it stays an explicit
 * `local.readOnlyDirs` line.
 */
const TOOL_CONFIG_PATHS: readonly string[] = [
  // `gh` refuses to start when it cannot read config.yml, blocking PR creation.
  ".config/gh",
  // git reads whichever of these exists; a dotfiles-managed one breaks every
  // git invocation in the sandbox, not just PR creation. `~/.gitconfig` is
  // covered by `gitConfigOriginPaths` instead, which also catches includes.
  ".config/git",
];

/**
 * Directory names never descended into, wherever they appear. These hold cached
 * copies of other repositories (`~/.claude/plugins/cache` alone can be hundreds
 * of megabytes), so crawling them costs launch latency proportional to something
 * groundcrew does not control, and finds no config worth granting.
 */
const SKIPPED_DIR_NAMES: ReadonlySet<string> = new Set(["cache", "node_modules"]);

/**
 * Upper bound on auto-grants. The list is joined into a shell command delivered
 * through the terminal multiplexer, and its length scales with the size of the
 * user's dotfiles repo rather than with anything groundcrew bounds. Tripping the
 * cap is loud: a truncated grant list means EPERM somewhere, and the user needs
 * to know it was groundcrew that stopped short.
 */
const MAX_AUTO_GRANTS = 256;

/**
 * Config scopes whose files are host-owned and safe to grant. Repository-local
 * and per-worktree scopes are excluded: `.git/config` is writable by the
 * sandboxed agent and by repo-controlled hooks, so an `include.path` there could
 * name `~/.aws/credentials` and widen the next launch's sandbox to it.
 */
const TRUSTED_CONFIG_SCOPES: ReadonlySet<string> = new Set(["system", "global"]);
const UNTRUSTED_CONFIG_SCOPES: ReadonlySet<string> = new Set([
  "local",
  "worktree",
  "command",
  "submodule",
]);

/**
 * How deep the walk descends, counting both real subdirectories and hops across
 * a resolved symlink target. Deep enough for the nested layouts agents ship
 * (`skills/<name>/SKILL.md`) reached through a two-hop dotfiles chain, without
 * turning a launch into a full-tree crawl.
 */
const MAX_WALK_DEPTH = 6;

/**
 * Resolve symlinked config paths into read-only sandbox grants.
 *
 * Dotfile managers (stow, chezmoi, yadm, dotbot) make every entry under
 * `~/.claude` and `~/.config` a symlink into a repo elsewhere on disk. macOS
 * seatbelt resolves symlinks *before* evaluating policy, so granting `~/.claude`
 * leaves the kernel checking an ungranted target path and the agent sees
 * `EPERM ... stat '~/.claude/settings.json'` for a file that plainly exists.
 * Granting the resolved targets read-only is the only fix seatbelt allows.
 *
 * Covers the agent's own config dir plus `TOOL_CONFIG_PATHS` — see there for
 * why the tool list is an allowlist and not all of `~/.config`.
 *
 * Chains are followed to the end. A dotfiles layout routinely nests — `~/.claude/skills`
 * links to `~/.dot_files/config/claude/skills`, whose entries link on again to
 * `~/.dot_files/agents/skills/<name>` — and granting only the first hop is worse
 * than granting nothing: the agent can *list* the directory and sees every skill
 * name, but reading any file inside returns EPERM, so Claude Code reports the
 * skill as merely unavailable with no permission error surfaced. Every resolved
 * directory is therefore walked in turn for the links it contains.
 *
 * A file link grants the resolved **file**, never its parent directory, so a
 * single symlinked `settings.json` does not re-open the whole dotfiles repo.
 * Degenerate targets (`/`, `$HOME`) are refused and logged: a read-only grant
 * of the home directory would hand the agent `~/.ssh`, `~/.aws/credentials`,
 * and every other repo on the machine. The failure modes are asymmetric — an
 * over-cautious skip produces a legible EPERM naming the exact path, while an
 * over-eager grant produces no signal at all — so the guard errs toward
 * skipping and points at the explicit `local.readOnlyDirs` escape hatch.
 *
 * git is handled by asking git itself which files it loads rather than by
 * walking links: `~/.gitconfig` is routinely a *real* file whose indirection is
 * an `include.path` directive, which no amount of symlink resolution finds.
 *
 * Callers still filter the result through `existsSync`; broken links are
 * dropped here as well since `realpathSync` cannot resolve them.
 */
export function resolveSandboxSymlinkGrants(input: {
  agent: string;
  homeDir: string;
  /** Repo the launch targets; git config includes are evaluated from here. */
  worktreeDir?: string | undefined;
}): readonly string[] {
  const agentConfigDir = AGENT_CONFIG_DIRS[input.agent.toLowerCase()];
  const roots = [...(agentConfigDir === undefined ? [] : [agentConfigDir]), ...TOOL_CONFIG_PATHS];
  const guard = degenerateTargets(input.homeDir);
  const grants = new Set<string>();
  let capped = false;

  function addGrant(targetPath: string, source: string): void {
    if (grants.has(targetPath) || isCoveredByGrantedDir({ targetPath, grants })) {
      return;
    }
    if (grants.size >= MAX_AUTO_GRANTS) {
      capped = true;
      return;
    }
    grants.add(targetPath);
    debug(`Auto-granting read-only sandbox access to ${targetPath} (${source})`);
  }

  for (const root of roots) {
    const rootPath = path.join(input.homeDir, root);
    const descendNames = root === agentConfigDir ? AGENT_CONFIG_DESCEND_NAMES : undefined;
    for (const { targetPath, refused } of symlinkTargetsAt({ rootPath, guard, descendNames })) {
      if (refused) {
        writeError(
          `Skipping auto-grant of ${targetPath} (resolved from a symlink under ${rootPath}): ` +
            "granting the home directory or filesystem root read-only would expose credentials " +
            "and every other repo to the sandboxed agent. Add it to local.readOnlyDirs in " +
            "crew.config.ts if you really want it.",
        );
        continue;
      }
      addGrant(targetPath, `symlinked under ${rootPath}`);
    }
  }

  for (const originPath of gitConfigOriginPaths({
    homeDir: input.homeDir,
    worktreeDir: input.worktreeDir,
  })) {
    if (guard.has(originPath)) {
      writeError(
        `Skipping auto-grant of ${originPath} (a git config file): granting the home ` +
          "directory or filesystem root read-only would expose credentials and every other " +
          "repo to the sandboxed agent. Add it to local.readOnlyDirs in crew.config.ts if you " +
          "really want it.",
      );
      continue;
    }
    addGrant(originPath, "git config origin");
  }

  if (capped) {
    writeError(
      `Stopped auto-granting after ${MAX_AUTO_GRANTS} paths; the rest are not readable in the ` +
        "sandbox. Add the tree they live in to local.readOnlyDirs in crew.config.ts.",
    );
  }
  if (grants.size > 0) {
    log(
      `Auto-granted ${grants.size} read-only sandbox path(s) resolved from ${roots.join(", ")} ` +
        "and git config; run with --verbose to list them.",
    );
  }
  // Pruned at the end, not only as targets arrive: a parent tree can be granted
  // after a file inside it, and one flag for the tree covers both.
  return [...grants].filter((targetPath) => !isCoveredByGrantedDir({ targetPath, grants }));
}

/**
 * Every file git actually loads at **system and global scope**, straight from
 * git. `~/.gitconfig` is commonly a real file that pulls a dotfiles-managed
 * config in through `include.path`, and `includeIf "hasconfig:remote.*.url:..."`
 * adds per-remote files on top — neither is discoverable by walking symlinks,
 * and both are fatal inside the sandbox (git aborts on a config file it cannot
 * read). Asking git removes the guessing.
 *
 * Repository-local and per-worktree scopes are deliberately dropped. `.git/config`
 * is writable by the sandboxed agent and by repo-controlled hooks, and an
 * `include.path` there names any file on the host — so honoring local scope would
 * let a repo widen its own sandbox to `~/.aws/credentials` on the next launch.
 * Local config lives inside the worktree, which is already granted, so nothing is
 * lost by ignoring it.
 *
 * Run from the worktree so conditional includes evaluate against the real remote.
 * Best-effort: a git that fails here (not installed, not a repo, broken config)
 * must not abort the launch — the agent then gets the pre-existing behavior.
 */
function gitConfigOriginPaths(input: {
  homeDir: string;
  worktreeDir?: string | undefined;
}): readonly string[] {
  const options = input.worktreeDir === undefined ? {} : { cwd: input.worktreeDir };
  // Typed as string, but a test double can hand back nothing; an empty read is
  // the same "no origins to grant" outcome as a git that refused to run.
  let output: string | undefined;
  try {
    output = runCommand(
      "git",
      ["config", "--list", "--show-scope", "--show-origin", "--name-only", "-z"],
      options,
    );
  } catch {
    return [];
  }
  const origins = new Set<string>();
  // NUL-separated triples: scope, origin, name. Only the origin of a trusted
  // scope names a path worth granting.
  let trustedScope = false;
  for (const field of (output ?? "").split("\0")) {
    if (TRUSTED_CONFIG_SCOPES.has(field)) {
      trustedScope = true;
      continue;
    }
    if (UNTRUSTED_CONFIG_SCOPES.has(field)) {
      trustedScope = false;
      continue;
    }
    if (!trustedScope || !field.startsWith("file:")) {
      continue;
    }
    const originPath = path.resolve(input.homeDir, field.slice("file:".length));
    const resolved = resolveRealPath(originPath);
    if (resolved !== undefined) {
      origins.add(resolved);
    }
  }
  return [...origins];
}

/**
 * Whether an already-granted directory covers this path, so the sandbox reaches
 * it without a second flag. This only collapses a path whose ancestor happens to
 * be granted; siblings resolved out of the same tree are still granted one by
 * one, which is the tighter grant. `MAX_AUTO_GRANTS` is what bounds the list.
 */
function isCoveredByGrantedDir(input: {
  targetPath: string;
  grants: ReadonlySet<string>;
}): boolean {
  let parent = path.dirname(input.targetPath);
  while (parent !== path.dirname(parent)) {
    if (input.grants.has(parent)) {
      return true;
    }
    parent = path.dirname(parent);
  }
  return false;
}

/**
 * Paths never auto-granted: the filesystem root(s) above the config dir, the
 * user's home, and the directory holding all homes. Both the literal and the
 * `realpath`-resolved home are guarded so a home that is itself a symlink
 * (`/home/x` → `/System/Volumes/.../x`) cannot slip past under its other name.
 */
function degenerateTargets(homeDir: string): ReadonlySet<string> {
  const targets = new Set<string>([path.parse(homeDir).root, "/"]);
  for (const home of [homeDir, resolveRealPath(homeDir)]) {
    if (home !== undefined) {
      const resolvedHome = path.resolve(home);
      targets.add(resolvedHome);
      // `/Users` or `/home`: granting it exposes every account on the machine.
      targets.add(path.dirname(resolvedHome));
    }
  }
  return targets;
}

/**
 * One resolved symlink target. `refused` marks a degenerate target the caller
 * must log instead of grant; the walk also stops there rather than descending,
 * so a link to `/` never crawls the filesystem.
 */
interface ResolvedTarget {
  targetPath: string;
  refused: boolean;
}

/**
 * Symlink targets for one configured root. A root that is itself a symlink
 * (a whole dotfiles-managed `~/.config/gh`, or a bare `~/.gitconfig` file) is
 * granted directly; a real directory is walked for the links inside it.
 */
function* symlinkTargetsAt(input: {
  rootPath: string;
  guard: ReadonlySet<string>;
  /** When set, only real subdirectories with these names are descended into. */
  descendNames?: ReadonlySet<string> | undefined;
}): Generator<ResolvedTarget> {
  const walk = { depth: 0, visited: new Set<string>(), guard: input.guard };
  if (isSymbolicLink(input.rootPath)) {
    yield* resolvedLinkTargets({ ...walk, linkPath: input.rootPath });
    return;
  }
  yield* walkSymlinkTargets({ ...walk, dir: input.rootPath, descendNames: input.descendNames });
}

/**
 * The grant for one symlink, plus everything reachable through it. A resolved
 * directory is granted and then walked, because its own entries may link on
 * again into a third tree — the nested case a single `realpath` hop misses.
 */
function* resolvedLinkTargets(input: {
  linkPath: string;
  depth: number;
  visited: Set<string>;
  guard: ReadonlySet<string>;
}): Generator<ResolvedTarget> {
  const targetPath = resolveRealPath(input.linkPath);
  if (targetPath === undefined) {
    return;
  }
  if (input.guard.has(targetPath)) {
    yield { targetPath, refused: true };
    return;
  }
  yield { targetPath, refused: false };
  // Walked unconditionally: readdir on a file target fails with ENOTDIR, which
  // the walk already treats as "nothing further here", so a file link costs one
  // failed syscall instead of a stat on every link.
  yield* walkSymlinkTargets({
    dir: targetPath,
    depth: input.depth + 1,
    visited: input.visited,
    guard: input.guard,
  });
}

/**
 * Symlink targets found under `dir`. Real subdirectories are descended into so
 * nested links (`skills/<name>` → dotfiles) resolve too. `visited` holds the
 * directories already walked, so a chain that loops back on itself terminates.
 * Unreadable entries are skipped — a config dir that cannot be walked (or is a
 * plain file, or absent) must not abort a launch.
 */
function* walkSymlinkTargets(input: {
  dir: string;
  depth: number;
  visited: Set<string>;
  guard: ReadonlySet<string>;
  descendNames?: ReadonlySet<string> | undefined;
}): Generator<ResolvedTarget> {
  if (input.depth > MAX_WALK_DEPTH || input.visited.has(input.dir)) {
    return;
  }
  input.visited.add(input.dir);
  let entries: readonly Dirent[];
  try {
    entries = readdirSync(input.dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const entryPath = path.join(input.dir, entry.name);
    if (entry.isSymbolicLink()) {
      yield* resolvedLinkTargets({
        linkPath: entryPath,
        depth: input.depth,
        visited: input.visited,
        guard: input.guard,
      });
      continue;
    }
    if (
      entry.isDirectory() &&
      !SKIPPED_DIR_NAMES.has(entry.name) &&
      (input.descendNames?.has(entry.name) ?? true)
    ) {
      yield* walkSymlinkTargets({
        dir: entryPath,
        depth: input.depth + 1,
        visited: input.visited,
        guard: input.guard,
      });
    }
  }
}

function isSymbolicLink(entryPath: string): boolean {
  try {
    return lstatSync(entryPath).isSymbolicLink();
  } catch {
    return false;
  }
}

/** `realpath`, or `undefined` for a broken link / unreadable path. */
function resolveRealPath(entryPath: string): string | undefined {
  try {
    return realpathSync(entryPath);
  } catch {
    return undefined;
  }
}
