/**
 * Omitted-section detection (design §7.2 principle 1: omitted = detected,
 * specified = exactly yours, never merged). Sources omitted → `[{ kind: "todo-txt" }]`;
 * agents omitted → presets for the CLIs found on PATH (claude > codex > cursor);
 * the presenter is detected by the Session module. Listing anything replaces the
 * detected set — there is no merge.
 */
import * as fs from "node:fs";
import path from "node:path";

import { PRESET_NAMES } from "../session/index.js";
import type { Config, SourceConfigSection } from "./config/schema.js";

/** The default source when `sources` is omitted (design §7.2). */
export const DEFAULT_SOURCE_KIND = "todo-txt";

/** The configured sources, or the detected default when omitted. */
export function effectiveSources(config: Config): readonly SourceConfigSection[] {
  if (config.sources !== undefined) {
    return config.sources;
  }

  return [{ kind: DEFAULT_SOURCE_KIND }];
}

export interface EffectiveAgents {
  readonly default: string | undefined;
  readonly profiles: Readonly<Record<string, unknown>>;
  /** True when the agent set was detected rather than configured. */
  readonly detected: boolean;
}

/**
 * The configured agents, or presets detected on PATH when `agents.profiles` is
 * omitted. The default profile is the config's `agents.default`, else the first
 * detected preset in priority order.
 */
export function effectiveAgents(input: {
  readonly config: Config;
  readonly pathValue: string;
}): EffectiveAgents {
  const configured = input.config.agents;
  if (configured?.profiles !== undefined) {
    return {
      default: configured.default,
      profiles: configured.profiles,
      detected: false,
    };
  }

  const detectedPresets = detectAgentPresets(input.pathValue);
  const profiles: Record<string, Record<string, never>> = {};
  for (const name of detectedPresets) {
    profiles[name] = {};
  }

  return {
    default: configured?.default ?? detectedPresets[0],
    profiles,
    detected: true,
  };
}

/** Preset agent CLIs found on PATH, in priority order (claude > codex > cursor). */
export function detectAgentPresets(pathValue: string): string[] {
  const cliFor: Record<string, string> = {
    claude: "claude",
    codex: "codex",
    cursor: "cursor-agent",
  };

  return PRESET_NAMES.filter((name) => onPath({ name: cliFor[name] ?? name, pathValue }));
}

/** Whether an executable named `name` is on `pathValue`. */
export function onPath(input: { readonly name: string; readonly pathValue: string }): boolean {
  if (input.name.includes("/")) {
    return isExecutable(input.name);
  }

  for (const directory of input.pathValue.split(path.delimiter)) {
    if (directory === "") {
      continue;
    }

    if (isExecutable(path.join(directory, input.name))) {
      return true;
    }
  }

  return false;
}

function isExecutable(candidate: string): boolean {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
