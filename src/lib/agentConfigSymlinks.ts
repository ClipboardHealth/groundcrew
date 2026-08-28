import { type Dirent, readdirSync, realpathSync } from "node:fs";
import path from "node:path";

import { debug, writeError } from "./util.ts";

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
 * How deep the walk descends into real subdirectories of the config dir. Deep
 * enough for the nested layouts agents ship (`skills/<name>/SKILL.md`) without
 * turning a launch into a full-tree crawl.
 */
const MAX_WALK_DEPTH = 3;

/**
 * Resolve symlinks under an agent's config directory into read-only sandbox
 * grants.
 *
 * Dotfile managers (stow, chezmoi, yadm, dotbot) make every entry under
 * `~/.claude` a symlink into a repo elsewhere on disk. macOS seatbelt resolves
 * symlinks *before* evaluating policy, so granting `~/.claude` leaves the
 * kernel checking an ungranted target path and the agent sees
 * `EPERM ... stat '~/.claude/settings.json'` for a file that plainly exists.
 * Granting the resolved targets read-only is the only fix seatbelt allows.
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
 * Callers still filter the result through `existsSync`; broken links are
 * dropped here as well since `realpathSync` cannot resolve them.
 */
export function resolveAgentConfigSymlinkGrants(input: {
  agent: string;
  homeDir: string;
}): readonly string[] {
  const configDirName = AGENT_CONFIG_DIRS[input.agent.toLowerCase()];
  if (configDirName === undefined) {
    return [];
  }
  const configDir = path.join(input.homeDir, configDirName);
  const guard = degenerateTargets(input.homeDir);
  const grants = new Set<string>();
  for (const target of walkSymlinkTargets({ dir: configDir, depth: 0 })) {
    if (guard.has(target)) {
      writeError(
        `Skipping auto-grant of ${target} (resolved from a symlink under ${configDir}): ` +
          "granting the home directory or filesystem root read-only would expose credentials " +
          "and every other repo to the sandboxed agent. Add it to local.readOnlyDirs in " +
          "crew.config.ts if you really want it.",
      );
      continue;
    }
    if (grants.has(target)) {
      continue;
    }
    grants.add(target);
    debug(`Auto-granting read-only sandbox access to ${target} (symlinked under ${configDir})`);
  }
  return [...grants];
}

/**
 * Paths never auto-granted: the filesystem root(s) above the config dir and the
 * user's home. Both the literal and the `realpath`-resolved home are guarded so
 * a home that is itself a symlink (`/home/x` → `/System/Volumes/.../x`) cannot
 * slip past under its other name.
 */
function degenerateTargets(homeDir: string): ReadonlySet<string> {
  const targets = new Set<string>([path.parse(homeDir).root, "/"]);
  for (const home of [homeDir, resolveRealPath(homeDir)]) {
    if (home !== undefined) {
      targets.add(path.resolve(home));
    }
  }
  return targets;
}

/**
 * Symlink targets found under `dir`. Real subdirectories are descended into so
 * nested links (`skills/<name>` → dotfiles) resolve too; a symlinked directory
 * is granted whole and not descended into, since the grant already covers its
 * contents. Unreadable entries are skipped — a config dir that cannot be walked
 * must not abort a launch.
 */
function* walkSymlinkTargets(input: { dir: string; depth: number }): Generator<string> {
  let entries: readonly Dirent[];
  try {
    entries = readdirSync(input.dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const entryPath = path.join(input.dir, entry.name);
    if (entry.isSymbolicLink()) {
      const target = resolveRealPath(entryPath);
      if (target !== undefined) {
        yield target;
      }
      continue;
    }
    if (input.depth < MAX_WALK_DEPTH && entry.isDirectory()) {
      yield* walkSymlinkTargets({ dir: entryPath, depth: input.depth + 1 });
    }
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
