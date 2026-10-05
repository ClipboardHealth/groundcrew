import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { readEnvironmentVariable } from "./util.ts";

export interface WorkingDirectoryDeps {
  cwd: () => string;
  chdir: (directory: string) => void;
  exists: (directory: string) => boolean;
  /** The shell's logical working directory; still set after the directory is removed. */
  pwd: string | undefined;
  home: string;
}

export interface RecoveredWorkingDirectory {
  missing: string | undefined;
  recovered: string;
}

/**
 * When the shell's working directory was removed (e.g. `crew cleanup` run from
 * inside a worktree an earlier cleanup deleted), every `process.cwd()` call —
 * including cosmiconfig's at module load — throws ENOENT. Move to the nearest
 * surviving ancestor of `$PWD`, or the home directory, so commands can still run.
 * Returns undefined when the working directory is intact.
 */
export function recoverWorkingDirectory(
  deps: WorkingDirectoryDeps = defaultDeps(),
): RecoveredWorkingDirectory | undefined {
  if (!isMissingWorkingDirectory(deps)) {
    return undefined;
  }
  const ancestor = existingAncestors(deps).find((directory) => tryChdir({ deps, directory }));
  if (ancestor !== undefined) {
    return { missing: deps.pwd, recovered: ancestor };
  }
  deps.chdir(deps.home);
  return { missing: deps.pwd, recovered: deps.home };
}

function defaultDeps(): WorkingDirectoryDeps {
  return {
    cwd: () => process.cwd(),
    chdir: (directory) => {
      process.chdir(directory);
    },
    exists: existsSync,
    pwd: readEnvironmentVariable("PWD"),
    home: homedir(),
  };
}

function isMissingWorkingDirectory(deps: WorkingDirectoryDeps): boolean {
  try {
    deps.cwd();
    return false;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return true;
    }
    throw error;
  }
}

function existingAncestors(deps: WorkingDirectoryDeps): string[] {
  if (deps.pwd === undefined || !path.isAbsolute(deps.pwd)) {
    return [];
  }
  const candidates: string[] = [];
  let current = path.resolve(deps.pwd);
  for (;;) {
    if (deps.exists(current)) {
      candidates.push(current);
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return candidates;
    }
    current = parent;
  }
}

interface TryChdirInput {
  deps: WorkingDirectoryDeps;
  directory: string;
}

function tryChdir(input: TryChdirInput): boolean {
  const { deps, directory } = input;
  try {
    deps.chdir(directory);
    return true;
  } catch {
    return false;
  }
}
