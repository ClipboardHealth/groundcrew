import { readFileSync } from "node:fs";
import path from "node:path";

import type { HookCommands, PrepareWorktreeSource } from "./config.ts";

const REPOSITORY_CONFIG_RELATIVE_PATH = ".groundcrew/config.json";

interface ResolvePrepareWorktreeCommandArguments {
  worktreeDir: string;
  /**
   * Per-repo operator hooks from this repo's `knownRepositories[]` entry in
   * `crew.config.ts`. Slots between the repo-committed file and the global
   * `defaults.hooks` so an operator can set the hook for a repo they don't
   * want to (or can't) commit a `.groundcrew/config.json` into.
   */
  perRepoHooks?: HookCommands;
  defaultHooks: HookCommands;
}

export interface ResolvedPrepareWorktreeCommand {
  command: string;
  /**
   * Which layer supplied `command`. The safehouse runner keys its host-vs-sandbox
   * decision off this: `"repository"` hooks are untrusted and stay sandboxed;
   * `"operator"` hooks are trusted and run on the host. See {@link PrepareWorktreeSource}.
   */
  source: PrepareWorktreeSource;
}

// Flat precedence cascade, highest priority first: the repo-committed
// `.groundcrew/config.json` wins (closest to the code), then the per-repo
// operator layer, then the global `defaults.hooks` fallback. The winning layer's
// provenance is returned alongside the command because it is a security boundary
// — only the operator layers are trusted enough to run unsandboxed.
export function resolvePrepareWorktreeCommand(
  arguments_: ResolvePrepareWorktreeCommandArguments,
): ResolvedPrepareWorktreeCommand | undefined {
  const repositoryConfig = readRepositoryConfig(arguments_.worktreeDir);
  const repositoryCommand = repositoryConfig?.hooks.prepareWorktree;
  if (repositoryCommand !== undefined) {
    return { command: repositoryCommand, source: "repository" };
  }
  const operatorCommand =
    arguments_.perRepoHooks?.prepareWorktree ?? arguments_.defaultHooks.prepareWorktree;
  if (operatorCommand !== undefined) {
    return { command: operatorCommand, source: "operator" };
  }
  return undefined;
}

interface RepositoryConfig {
  hooks: HookCommands;
}

function readRepositoryConfig(worktreeDir: string): RepositoryConfig | undefined {
  const configPath = path.join(worktreeDir, REPOSITORY_CONFIG_RELATIVE_PATH);
  let contents: string;
  try {
    contents = readFileSync(configPath, "utf8");
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return undefined;
    }
    throw new Error(`Could not read ${REPOSITORY_CONFIG_RELATIVE_PATH}.`, { cause: error });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new Error(`${REPOSITORY_CONFIG_RELATIVE_PATH}: expected valid JSON.`, { cause: error });
  }
  return normalizeRepositoryConfig(parsed);
}

function normalizeRepositoryConfig(value: unknown): RepositoryConfig {
  if (!isPlainObject(value)) {
    fail("must be a JSON object");
  }
  if (value["version"] !== 1) {
    fail("version must be 1");
  }
  return {
    hooks: normalizeHookCommands(value["hooks"]),
  };
}

function normalizeHookCommands(value: unknown): HookCommands {
  if (value === undefined) {
    return {};
  }
  if (!isPlainObject(value)) {
    fail("hooks must be an object");
  }
  const hooks: HookCommands = {};
  const prepareWorktree = normalizeOptionalHookCommand(
    value["prepareWorktree"],
    "hooks.prepareWorktree",
  );
  if (prepareWorktree !== undefined) {
    hooks.prepareWorktree = prepareWorktree;
  }
  return hooks;
}

function normalizeOptionalHookCommand(value: unknown, configKey: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(`${configKey} must be a non-empty string`);
  }
  return value.trim();
}

function fail(message: string): never {
  throw new Error(`${REPOSITORY_CONFIG_RELATIVE_PATH}: ${message}`);
}

function isFileNotFoundError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
