import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

import { readEnvironmentVariable } from "./util.ts";

// Per the XDG Base Directory spec, relative override paths are invalid and
// must be ignored — without this guard, a relative override would anchor to
// the cwd via `resolve` instead of falling back to $HOME.
function xdgBase(envName: string, fallbackSegments: readonly string[]): string {
  const override = readEnvironmentVariable(envName);
  if (override !== undefined && override.length > 0 && isAbsolute(override)) {
    return override;
  }
  return resolve(homedir(), ...fallbackSegments);
}

export function xdgConfigPath(...segments: string[]): string {
  return resolve(xdgBase("XDG_CONFIG_HOME", [".config"]), ...segments);
}

export function xdgStatePath(...segments: string[]): string {
  return resolve(xdgBase("XDG_STATE_HOME", [".local", "state"]), ...segments);
}
