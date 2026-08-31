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
  // Pi's state dir, where it keeps auth.json (see docs/credentials.md). A
  // custom `PI_CODING_AGENT_DIR` is not followed here; that one needs its own
  // Safehouse grants anyway (docs/runners.md).
  pi: ".pi/agent",
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
/**
 * Never auto-granted, however a link reaches them. The sandboxed agent can write
 * its own config dir, so it could plant a link to `~/.aws/credentials` and have
 * the next launch grant it — inference must not be the thing that hands over a
 * credential store. Home-relative; matched against the resolved target and its
 * ancestors. Not a proof of safety, a barrier on the known-valuable paths:
 * anything here still works as an explicit `local.readOnlyDirs` line.
 */
const REFUSED_TARGET_DIRS: readonly string[] = [
  ".ssh",
  ".aws",
  ".gnupg",
  ".kube",
  ".docker",
  ".config/gcloud",
  ".config/op",
  "Library/Keychains",
];

/**
 * Safehouse joins the read-only grant list on `:`, so a path containing one
 * would be delivered as two paths. Dropped rather than escaped: no legitimate
 * config path needs it, and a silently split path grants something nobody named.
 */
const GRANT_LIST_DELIMITER = ":";

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
  /**
   * `local.readOnlyDirs`. Used only to skip what they already cover, so an
   * explicit entry does not spend a slot under `MAX_AUTO_GRANTS` twice.
   */
  explicitDirs?: readonly string[] | undefined;
}): readonly string[] {
  const agentConfigDir = AGENT_CONFIG_DIRS[input.agent.toLowerCase()];
  const roots = [...(agentConfigDir === undefined ? [] : [agentConfigDir]), ...TOOL_CONFIG_PATHS];
  const refusalReason = targetRefusal(input.homeDir);
  const explicitDirs = new Set(input.explicitDirs ?? []);
  const grants = new Set<string>();
  let capped = false;

  function addGrant(targetPath: string, source: string): void {
    if (isCovered(targetPath, grants) || isCovered(targetPath, explicitDirs)) {
      return;
    }
    // Canonicalize before the cap, not after: a tree granted late subsumes the
    // children granted earlier, and those slots must come back or a required
    // target can be dropped while the final list is nowhere near the cap.
    for (const granted of grants) {
      if (granted.startsWith(targetPath + path.sep)) {
        grants.delete(granted);
      }
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
    const isRefused = (targetPath: string): boolean => refusalReason(targetPath) !== undefined;
    for (const targetPath of symlinkTargetsAt({ rootPath, isRefused, descendNames })) {
      const reason = refusalReason(targetPath);
      if (reason === undefined) {
        addGrant(targetPath, `symlinked under ${rootPath}`);
      } else {
        refuse(targetPath, reason, `resolved from a symlink under ${rootPath}`);
      }
    }
  }

  for (const originPath of gitConfigOriginPaths({
    homeDir: input.homeDir,
    worktreeDir: input.worktreeDir,
  })) {
    const reason = refusalReason(originPath);
    if (reason === undefined) {
      addGrant(originPath, "git config origin");
    } else {
      refuse(originPath, reason, "a git config file");
    }
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
  return [...grants];
}

function refuse(targetPath: string, reason: string, source: string): void {
  writeError(
    `Skipping auto-grant of ${targetPath} (${source}): ${reason} Add it to ` +
      "local.readOnlyDirs in crew.config.ts if you really want it.",
  );
}

/**
 * Why a resolved target must not be auto-granted, or `undefined` to grant it.
 * Inference is held to a stricter standard than an explicit config line: a
 * refusal costs a legible EPERM naming the path, while an over-eager grant is
 * silent, so anything doubtful is refused and pointed at `local.readOnlyDirs`.
 */
function targetRefusal(homeDir: string): (targetPath: string) => string | undefined {
  const degenerate = degenerateTargets(homeDir);
  const refusedDirs = new Set(REFUSED_TARGET_DIRS.map((dir) => path.join(homeDir, dir)));
  return (targetPath) => {
    if (degenerate.has(targetPath)) {
      return "granting the home directory or filesystem root read-only would expose credentials and every other repo to the sandboxed agent.";
    }
    if (refusedDirs.has(targetPath) || isCovered(targetPath, refusedDirs)) {
      return "it is a credential store, which groundcrew will not open on inference alone.";
    }
    return targetPath.includes(GRANT_LIST_DELIMITER)
      ? `safehouse joins read-only grants on "${GRANT_LIST_DELIMITER}", so this path cannot be passed without splitting into two.`
      : undefined;
  };
}

/** Whether one of `dirs` is an ancestor directory of `targetPath`. */
function isCovered(targetPath: string, dirs: ReadonlySet<string>): boolean {
  return [...dirs].some((dir) => targetPath.startsWith(dir + path.sep));
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
 * Symlink targets for one configured root. A root that is itself a symlink
 * (a whole dotfiles-managed `~/.config/gh`, or a bare `~/.gitconfig` file) is
 * granted directly; a real directory is walked for the links inside it.
 */
function* symlinkTargetsAt(input: {
  rootPath: string;
  isRefused: (targetPath: string) => boolean;
  /** When set, only real subdirectories with these names are descended into. */
  descendNames?: ReadonlySet<string> | undefined;
}): Generator<string> {
  const walk = { depth: 0, visited: new Set<string>(), isRefused: input.isRefused };
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
  isRefused: (targetPath: string) => boolean;
}): Generator<string> {
  const targetPath = resolveRealPath(input.linkPath);
  if (targetPath === undefined) {
    return;
  }
  yield targetPath;
  if (input.isRefused(targetPath)) {
    // Never walked: descending into a refused target would crawl the very tree
    // the refusal exists to keep out (a link to `/` walks the filesystem).
    return;
  }
  // Unconditional: readdir on a file fails with ENOTDIR, which the walk already
  // treats as "nothing further", so a file link costs no extra stat.
  yield* walkSymlinkTargets({
    dir: targetPath,
    depth: input.depth + 1,
    visited: input.visited,
    isRefused: input.isRefused,
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
  isRefused: (targetPath: string) => boolean;
  descendNames?: ReadonlySet<string> | undefined;
}): Generator<string> {
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
        isRefused: input.isRefused,
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
        isRefused: input.isRefused,
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
