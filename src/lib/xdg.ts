import { homedir } from "node:os";
import { resolve } from "node:path";

import { readEnvironmentVariable } from "./util.ts";

function xdgBase(envName: string, fallbackSegments: readonly string[]): string {
  const override = readEnvironmentVariable(envName);
  if (override !== undefined && override.length > 0) {
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
