/**
 * Config location, JSONC parse, and validation (contracts §5, design §7.2/§11).
 *
 * Location rule, highest priority first: `$GROUNDCREW_CONFIG` → `./crew.config.jsonc`
 * → `$XDG_CONFIG_HOME/groundcrew/crew.config.jsonc`. No v2 config anywhere is a
 * loud error: when a v1 config (`crew.config.ts` et al) is present it points at
 * migration; otherwise it points at `crew init` (design §11 — never a silent
 * fallback to defaults).
 */
import * as fs from "node:fs";

import { type ParseError, parse, printParseErrorCode } from "jsonc-parser";
import { z } from "zod";

import { ConfigError, V1ConfigError } from "../errors.js";
import {
  type Config,
  configSchema,
} from "./schema.js";
import {
  type PathEnvironment,
  V1_CONFIG_FILENAMES,
  globalConfigPath,
  groundcrewConfigDirectory,
  localConfigPath,
} from "./paths.js";
import path from "node:path";

export interface LoadConfigInput {
  readonly environment: PathEnvironment;
  readonly cwd: string;
}

export interface LoadedConfig {
  readonly config: Config;
  /** The file the config was read from. */
  readonly path: string;
}

/** Where a config search looked and what it found. */
export interface LocatedConfig {
  readonly path: string;
}

/** Resolves the config path per the location rule, or `undefined` when none exists. */
export function locateConfig(input: LoadConfigInput): LocatedConfig | undefined {
  const explicit = input.environment.GROUNDCREW_CONFIG;
  if (explicit !== undefined && explicit !== "") {
    if (!fs.existsSync(explicit)) {
      throw new ConfigError(
        `config file not found at $GROUNDCREW_CONFIG: ${explicit}`,
      );
    }

    return { path: explicit };
  }

  const local = localConfigPath(input.cwd);
  if (fs.existsSync(local)) {
    return { path: local };
  }

  const global = globalConfigPath(input.environment);
  if (fs.existsSync(global)) {
    return { path: global };
  }

  return undefined;
}

/** Finds a v1 config file in cwd or the global config dir, for the loud failure. */
export function findV1Config(input: LoadConfigInput): string | undefined {
  const directories = [input.cwd, groundcrewConfigDirectory(input.environment)];
  for (const directory of directories) {
    for (const filename of V1_CONFIG_FILENAMES) {
      const candidate = path.join(directory, filename);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return undefined;
}

/**
 * Parses and validates the config at `path`. JSONC syntax errors and schema
 * violations both surface as {@link ConfigError} naming the file and the reason.
 */
export function parseConfigFile(configPath: string): Config {
  let contents: string;
  try {
    contents = fs.readFileSync(configPath, "utf8");
  } catch (error) {
    throw new ConfigError(`could not read config file ${configPath}: ${messageOf(error)}`);
  }

  const errors: ParseError[] = [];
  const parsed: unknown = parse(contents, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    const detail = errors
      .map((error) => `${printParseErrorCode(error.error)} at offset ${String(error.offset)}`)
      .join(", ");
    throw new ConfigError(`invalid JSONC in ${configPath}: ${detail}`);
  }

  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    throw new ConfigError(`invalid config in ${configPath}:\n${formatIssues(result.error)}`);
  }

  return result.data;
}

/**
 * Locates, parses, and validates the config. Throws {@link V1ConfigError} when
 * only a v1 config exists, and {@link ConfigError} (run `crew init`) when none
 * does.
 */
export function loadConfig(input: LoadConfigInput): LoadedConfig {
  const located = locateConfig(input);
  if (located === undefined) {
    const v1 = findV1Config(input);
    if (v1 !== undefined) {
      throw new V1ConfigError(v1);
    }

    throw new ConfigError(
      "no groundcrew config found. Run `crew init` to create one (contracts §5).",
    );
  }

  return { config: parseConfigFile(located.path), path: located.path };
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const location = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `  - ${location}: ${issue.message}`;
    })
    .join("\n");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
