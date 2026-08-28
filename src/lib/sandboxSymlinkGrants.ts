import { type Dirent, lstatSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";

import { runCommand } from "./commandRunner.ts";
import { debug, log, writeError } from "./util.ts";

/**
 * Where each agent keeps its config. Codex is absent on purpose: its
 * `CODEX_HOME` is relocated into a staged, writable home rather than read in
 * place (see `codexConfigRelocation.ts`).
 */
const AGENT_CONFIG_DIRS: Record<string, string> = {
  claude: ".claude",
};

/**
 * Real subdirectories of the agent config dir worth descending into. Everything
 * else there is runtime state: `projects` alone holds every session transcript,
 * so walking it costs seconds and grants stray links. Bounds the crawl of real
 * directories only — symlinked entries resolve whatever they are named.
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
 * Host tool configs resolved alongside the agent's own. An allowlist, not all of
 * `~/.config`: agent-config-only leaves `gh` unable to start (so the agent
 * cannot open its PR), while all of `~/.config` silently follows a dozen
 * unrelated links into the dotfiles repo. `~/.gitconfig` is covered by
 * `gitConfigOriginPaths`, which also catches its includes.
 */
const TOOL_CONFIG_PATHS: readonly string[] = [".config/gh", ".config/git"];

/**
 * Never descended into. These hold cached copies of other repositories
 * (`~/.claude/plugins/cache` can be hundreds of megabytes) and no config.
 */
const SKIPPED_DIR_NAMES: ReadonlySet<string> = new Set(["cache", "node_modules"]);

/**
 * Upper bound on auto-grants: the list is joined into a shell command and scales
 * with the user's dotfiles repo, not with anything groundcrew controls. Tripping
 * it is loud — a truncated list means EPERM somewhere.
 */
const MAX_AUTO_GRANTS = 256;

/**
 * Host-owned scopes, safe to grant. Local and worktree scopes are excluded:
 * `.git/config` is writable by the sandboxed agent, so an `include.path` there
 * could name `~/.aws/credentials` and widen the next launch's sandbox to it.
 */
const TRUSTED_CONFIG_SCOPES: ReadonlySet<string> = new Set(["system", "global"]);

/**
 * Walk depth, counting real subdirectories and hops across resolved links alike.
 * Deep enough for `skills/<name>/SKILL.md` behind a two-hop dotfiles chain.
 */
const MAX_WALK_DEPTH = 6;

/**
 * Resolve dotfiles-managed config paths into read-only sandbox grants.
 *
 * Dotfile managers (stow, chezmoi, yadm, dotbot) make entries under `~/.claude`
 * and `~/.config` symlinks into a repo elsewhere. macOS seatbelt resolves
 * symlinks *before* evaluating policy, so granting `~/.claude` leaves the kernel
 * checking an ungranted target and the agent sees `EPERM ... stat
 * '~/.claude/settings.json'` for a file that plainly exists. Granting the
 * resolved targets is the only fix seatbelt allows.
 *
 * Chains are followed to the end, because a partial grant is worse than none:
 * with `~/.claude/skills` → dotfiles → `agents/skills/<name>`, granting one hop
 * lets the agent *list* the directory while every read inside returns EPERM, and
 * Claude Code then reports the skill as merely unavailable.
 *
 * A file link grants the resolved file, never its parent. `/` and `$HOME` are
 * refused and logged — the failure modes are asymmetric, since an over-cautious
 * skip produces a legible EPERM naming the path while an over-eager grant
 * produces no signal at all — leaving `local.readOnlyDirs` as the escape hatch.
 * git is asked which files it loads rather than walked, since `~/.gitconfig` is
 * routinely a real file whose indirection is an `include.path` directive.
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
    if (grants.has(targetPath) || isUnderGrantedDir(targetPath, grants)) {
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
  // Pruned at the end too: a parent tree can be granted after a file inside it,
  // and one flag for the tree covers both.
  return [...grants].filter((targetPath) => !isUnderGrantedDir(targetPath, grants));
}

/** A path the sandbox already reaches through a granted ancestor directory. */
function isUnderGrantedDir(targetPath: string, grants: ReadonlySet<string>): boolean {
  return [...grants].some((granted) => targetPath.startsWith(granted + path.sep));
}

/**
 * Every file git loads at system and global scope, straight from git — an
 * `include.path` target and an `includeIf` conditional are both invisible to
 * symlink walking, and a config file git cannot read is fatal to every git
 * command in the sandbox. Local and worktree scopes are dropped (see
 * `TRUSTED_CONFIG_SCOPES`); that config lives inside the granted worktree
 * anyway. Run from the worktree so conditional includes evaluate correctly, and
 * best-effort: a git that fails here must not abort the launch.
 */
function gitConfigOriginPaths(input: {
  homeDir: string;
  worktreeDir?: string | undefined;
}): readonly string[] {
  const options = input.worktreeDir === undefined ? {} : { cwd: input.worktreeDir };
  // Typed as string, but a test double can hand back nothing.
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
  // NUL-separated triples: scope, origin, name.
  let trustedScope = false;
  for (const field of (output ?? "").split("\0")) {
    if (!field.startsWith("file:")) {
      trustedScope = TRUSTED_CONFIG_SCOPES.has(field);
      continue;
    }
    if (!trustedScope) {
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
 * Never auto-granted: the filesystem root, `$HOME`, and the directory holding
 * all homes. The `realpath`-resolved home is guarded too, so a home that is
 * itself a symlink cannot slip past under its other name.
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
 * The grant for one symlink, plus everything reachable through it: a resolved
 * directory is walked in turn, since its entries may link on into a third tree.
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
  // Unconditional: readdir on a file fails with ENOTDIR, which the walk already
  // treats as "nothing further", so a file link costs no extra stat.
  yield* walkSymlinkTargets({
    dir: targetPath,
    depth: input.depth + 1,
    visited: input.visited,
    guard: input.guard,
  });
}

/**
 * Symlink targets under `dir`, descending into real subdirectories. `visited`
 * terminates a chain that loops back on itself; an unreadable, absent, or
 * not-a-directory path is skipped rather than aborting a launch.
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
