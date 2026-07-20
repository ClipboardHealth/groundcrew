/**
 * `prepareWorktree` hook resolution and execution. Ported and adapted from v1's
 * `src/lib/repositoryHooks.ts`: a repo may commit a `.groundcrew/config.json`
 * that overrides the operator's config hook (closest-to-the-code wins).
 * Precedence: the repo-committed hook, then the per-repo config override, then
 * the workspace default (`workspace.prepareWorktree`, v2's home for v1's
 * `defaults.hooks`, contracts §3.2/§5). The hook runs with cwd = the worktree
 * root, its process env `workspace.environment` overlaid on the ambient env.
 */

import * as fs from "node:fs";
import path from "node:path";

import { execa } from "execa";

import { PrepareWorktreeError } from "./errors.js";

const REPOSITORY_CONFIG_RELATIVE_PATH = path.join(".groundcrew", "config.json");

/**
 * The effective hook command, or `undefined` when none applies. Precedence:
 * the repo-committed `.groundcrew/config.json` hook, then the config per-repo
 * override.
 */
export function resolvePrepareWorktreeCommand(input: {
  readonly worktreeDirectory: string;
  readonly perRepoHook?: string;
  readonly defaultHook?: string;
}): string | undefined {
  const committed = readRepositoryConfigHook({ worktreeDirectory: input.worktreeDirectory });
  return committed ?? input.perRepoHook ?? input.defaultHook;
}

/**
 * Runs the resolved hook (if any) at the worktree root, with
 * `environment` overlaid on the ambient env. Throws `PrepareWorktreeError` on
 * nonzero exit so provisioning rolls back.
 *
 * The hook command can be supplied by a repo-committed `.groundcrew/config.json`,
 * so when `wrapCommand` is injected the resolved command is sandbox-wrapped
 * before it runs (the orchestrator composes a profile-neutral, credential-free
 * policy — architecture keeps this module's imports git-only, so the wrap is
 * injected rather than imported). Omitted ⇒ the hook runs unwrapped, which is the
 * `GROUNDCREW_SANDBOX=off` path and the direct-unit-test path.
 */
export async function runPrepareWorktree(input: {
  readonly worktreeDirectory: string;
  readonly repo: string;
  readonly perRepoHook?: string;
  readonly defaultHook?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly wrapCommand?: (command: string) => Promise<string>;
}): Promise<void> {
  const resolved = resolvePrepareWorktreeCommand({
    worktreeDirectory: input.worktreeDirectory,
    ...(input.perRepoHook === undefined ? {} : { perRepoHook: input.perRepoHook }),
    ...(input.defaultHook === undefined ? {} : { defaultHook: input.defaultHook }),
  });
  if (resolved === undefined) {
    return;
  }

  const command = input.wrapCommand === undefined ? resolved : await input.wrapCommand(resolved);

  const result = await execa(command, {
    shell: true,
    cwd: input.worktreeDirectory,
    reject: false,
    stripFinalNewline: false,
    // Ambient env is inherited; workspace.environment overlays it (contracts §5).
    ...(input.environment === undefined ? {} : { env: { ...input.environment } }),
  });
  const exitCode = typeof result.exitCode === "number" ? result.exitCode : 1;
  if (exitCode !== 0) {
    throw new PrepareWorktreeError({
      repo: input.repo,
      // Report the human-readable hook, not the srt wrapper line.
      command: resolved,
      exitCode,
      stderr: typeof result.stderr === "string" ? result.stderr : "",
    });
  }
}

function readRepositoryConfigHook(input: {
  readonly worktreeDirectory: string;
}): string | undefined {
  const configPath = path.join(input.worktreeDirectory, REPOSITORY_CONFIG_RELATIVE_PATH);
  let contents: string;
  try {
    contents = fs.readFileSync(configPath, "utf8");
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

  return extractHook({ value: parsed });
}

function extractHook(input: { readonly value: unknown }): string | undefined {
  const { value } = input;
  if (!isPlainObject(value)) {
    fail("must be a JSON object");
  }

  if (value["version"] !== 1) {
    fail("version must be 1");
  }

  const hooks = value["hooks"];
  if (hooks === undefined) {
    return undefined;
  }

  if (!isPlainObject(hooks)) {
    fail("hooks must be an object");
  }

  const prepareWorktree = hooks["prepareWorktree"];
  if (prepareWorktree === undefined) {
    return undefined;
  }

  if (typeof prepareWorktree !== "string" || prepareWorktree.trim().length === 0) {
    fail("hooks.prepareWorktree must be a non-empty string");
  }

  return prepareWorktree.trim();
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
