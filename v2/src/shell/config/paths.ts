/**
 * Filesystem locations the CLI resolves (contracts §2). Everything keys off the
 * XDG base directories, overridable via environment so the e2e suite stays
 * hermetic. `~` in a config-provided path expands against `$HOME`.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";

export interface PathEnvironment {
  readonly HOME?: string;
  readonly XDG_CONFIG_HOME?: string;
  readonly XDG_STATE_HOME?: string;
  readonly GROUNDCREW_CONFIG?: string;
}

const CONFIG_FILENAME = "crew.config.jsonc";

/** Expand a leading `~` against `$HOME` (or the OS home). */
export function expandTilde(input: {
  readonly value: string;
  readonly environment: PathEnvironment;
}): string {
  const { value } = input;
  const home = homeDirectory(input.environment);
  if (value === "~") {
    return home;
  }

  if (value.startsWith("~/")) {
    return path.join(home, value.slice(2));
  }

  return value;
}

export function homeDirectory(environment: PathEnvironment): string {
  return environment.HOME ?? os.homedir();
}

/** `$XDG_CONFIG_HOME` or `~/.config`. */
export function configHome(environment: PathEnvironment): string {
  return environment.XDG_CONFIG_HOME ?? path.join(homeDirectory(environment), ".config");
}

/** `$XDG_STATE_HOME/groundcrew` or `~/.local/state/groundcrew` (contracts §2). */
export function stateRoot(environment: PathEnvironment): string {
  const base =
    environment.XDG_STATE_HOME ?? path.join(homeDirectory(environment), ".local", "state");
  return path.join(base, "groundcrew");
}

/** `$XDG_CONFIG_HOME/groundcrew`. */
export function groundcrewConfigDirectory(environment: PathEnvironment): string {
  return path.join(configHome(environment), "groundcrew");
}

/** The global config path: `$XDG_CONFIG_HOME/groundcrew/crew.config.jsonc`. */
export function globalConfigPath(environment: PathEnvironment): string {
  return path.join(groundcrewConfigDirectory(environment), CONFIG_FILENAME);
}

/** The project-local config path: `./crew.config.jsonc` from `cwd`. */
export function localConfigPath(cwd: string): string {
  return path.join(cwd, CONFIG_FILENAME);
}

/** The installed package version, read from the package `package.json`. */
export function packageVersion(): string {
  try {
    const manifest: unknown = JSON.parse(
      fs.readFileSync(path.join(packageRoot(), "package.json"), "utf8"),
    );
    if (typeof manifest === "object" && manifest !== null && "version" in manifest) {
      return typeof manifest.version === "string" ? manifest.version : "0.0.0";
    }

    return "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** User source bundles: `$XDG_CONFIG_HOME/groundcrew/task-sources/`. */
export function userBundlesDirectory(environment: PathEnvironment): string {
  return path.join(groundcrewConfigDirectory(environment), "task-sources");
}

/** Package source bundles: `<package>/task-sources/`, found by walking up. */
export function packageBundlesDirectory(): string {
  return path.join(packageRoot(), "task-sources");
}

/** Default log file: `<stateRoot>/groundcrew.jsonl` (config `logging.file` wins). */
export function defaultLogFile(environment: PathEnvironment): string {
  return path.join(stateRoot(environment), "groundcrew.jsonl");
}

/** The dispatch skip-verdict map: `<stateRoot>/dispatch.json`. */
export function dispatchFile(environment: PathEnvironment): string {
  return path.join(stateRoot(environment), "dispatch.json");
}

export const CONFIG_FILE_NAME = CONFIG_FILENAME;

/** Legacy v1 config filenames (design §11 loud-failure detection). */
export const V1_CONFIG_FILENAMES = [
  "crew.config.ts",
  "crew.config.js",
  "crew.config.mjs",
  "crew.config.cjs",
  ".crewrc",
  ".crewrc.json",
] as const;

/**
 * The installed package root: the nearest ancestor of this module that holds a
 * `task-sources` directory (works from `dist/shell/**` and from `src` under a
 * loader alike).
 */
function packageRoot(): string {
  let directory = path.dirname(new URL(import.meta.url).pathname);
  for (;;) {
    if (fs.existsSync(path.join(directory, "task-sources"))) {
      return directory;
    }

    const parent = path.dirname(directory);
    if (parent === directory) {
      // Fall back to two levels up from dist/shell (the built layout).
      return path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
    }

    directory = parent;
  }
}
