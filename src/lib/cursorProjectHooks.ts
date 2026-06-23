import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  buildCursorProjectHooks,
  type CursorProjectHooks,
  isGroundcrewHookCommand,
} from "./cmuxAgentHooks.ts";
import { runCommand } from "./commandRunner.ts";
import { debug, writeError } from "./util.ts";

/**
 * Stage the cursor lifecycle hooks for a launch by writing them to
 * `<workingDir>/.cursor/hooks.json`, the only per-project hook source the cursor
 * CLI auto-discovers. Cursor has no `--settings`-style flag and its plugin-dir
 * hooks never reach the headless agent, so unlike the prompt and srt settings
 * (staged outside the checkout) these must live inside the worktree.
 *
 * Best-effort and non-destructive:
 * - A repo that *tracks* its own `.cursor/hooks.json` is left untouched, so we
 *   never dirty the worktree or bury its hooks (cursor status just stays coarse
 *   for that repo).
 * - An untracked repo hooks file is merged into, not clobbered: our commands are
 *   re-stamped idempotently on resume and the repo's own hooks are preserved.
 * - The file is added to the worktree's git exclude so it never lands in a PR.
 */
export function writeCursorProjectHooks(input: {
  workingDir: string;
  worktreeDir: string;
  agent: string;
}): void {
  const { workingDir, worktreeDir, agent } = input;
  const hooksPath = path.join(workingDir, ".cursor", "hooks.json");
  const relativePath = path.relative(worktreeDir, hooksPath);

  if (isTrackedInGit(worktreeDir, relativePath)) {
    writeError(
      `groundcrew: ${relativePath} is tracked by the repo; skipping cursor progress hooks to keep the worktree clean`,
    );
    return;
  }

  try {
    const ours = buildCursorProjectHooks({ agent });
    const merged = existsSync(hooksPath) ? mergeIntoExisting(hooksPath, ours) : ours;
    mkdirSync(path.dirname(hooksPath), { recursive: true });
    writeFileSync(hooksPath, `${JSON.stringify(merged, undefined, 2)}\n`);
    excludeFromGit(worktreeDir, relativePath);
  } catch (error) {
    debug(`groundcrew: failed to stage cursor hooks at ${hooksPath}: ${String(error)}`);
  }
}

function mergeIntoExisting(hooksPath: string, ours: CursorProjectHooks): CursorProjectHooks {
  const existing: unknown = JSON.parse(readFileSync(hooksPath, "utf8"));
  const existingHooks = readEventCommands(existing);
  const hooks: Record<string, Array<{ command: string }>> = {};

  for (const [event, commands] of Object.entries(existingHooks)) {
    hooks[event] = commands.filter((entry) => !isGroundcrewHookCommand(entry.command));
  }
  for (const [event, commands] of Object.entries(ours.hooks)) {
    (hooks[event] ??= []).push(...commands.map((entry) => ({ command: entry.command })));
  }

  return { version: 1, hooks };
}

function hasStringCommand(value: unknown): value is { command: string } {
  if (typeof value !== "object" || value === null || !("command" in value)) {
    return false;
  }

  return typeof value.command === "string";
}

function readEventCommands(value: unknown): Record<string, Array<{ command: string }>> {
  if (typeof value !== "object" || value === null || !("hooks" in value)) {
    return {};
  }
  const { hooks } = value;
  if (typeof hooks !== "object" || hooks === null) {
    return {};
  }

  const result: Record<string, Array<{ command: string }>> = {};
  for (const [event, commands] of Object.entries(hooks)) {
    if (!Array.isArray(commands)) {
      continue;
    }
    const entries: unknown[] = commands;
    result[event] = entries.flatMap((entry) =>
      hasStringCommand(entry) ? [{ command: entry.command }] : [],
    );
  }

  return result;
}

function isTrackedInGit(worktreeDir: string, relativePath: string): boolean {
  try {
    runCommand("git", ["-C", worktreeDir, "ls-files", "--error-unmatch", "--", relativePath]);
    return true;
  } catch {
    return false;
  }
}

function excludeFromGit(worktreeDir: string, relativePath: string): void {
  try {
    const reported = runCommand("git", [
      "-C",
      worktreeDir,
      "rev-parse",
      "--git-path",
      "info/exclude",
    ]);
    const excludeFile = path.isAbsolute(reported) ? reported : path.join(worktreeDir, reported);
    const current = existsSync(excludeFile) ? readFileSync(excludeFile, "utf8") : "";
    if (current.split("\n").includes(relativePath)) {
      return;
    }
    const separator = current.length === 0 || current.endsWith("\n") ? "" : "\n";
    writeFileSync(excludeFile, `${current}${separator}${relativePath}\n`);
  } catch (error) {
    debug(`groundcrew: failed to git-exclude ${relativePath}: ${String(error)}`);
  }
}
