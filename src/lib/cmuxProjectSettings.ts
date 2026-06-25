import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { runCommand } from "./commandRunner.ts";
import {
  buildCmuxAgentHookSettings,
  cmuxAgentHookDelivery,
  type CmuxAgentHookSettings,
  isCmuxAgentHookCommand,
} from "./cmuxAgentHooks.ts";

/**
 * Write the agent's cmux activity hooks to its project-level settings file in
 * the worktree (e.g. `<worktree>/.claude/settings.local.json` for Claude),
 * which the CLI auto-discovers on every startup — so the hooks fire across
 * manual restarts (`claude --resume`) that bypass the staged launch command.
 *
 * No-op for agents without a hook integration. The file is git-excluded (via the
 * repo's `info/exclude`) and never committed, and the write is skipped entirely
 * when the repo already tracks the file so a committed config is never clobbered.
 * The hook block is merged idempotently into any pre-existing file: unrelated
 * user settings (and user-authored hooks) are preserved, and only prior
 * groundcrew-authored hook entries are replaced.
 */
export function writeCmuxAgentProjectSettings(input: {
  worktreeDir: string;
  agentCommandName: string;
}): void {
  const delivery = cmuxAgentHookDelivery(input.agentCommandName);
  if (delivery === undefined) {
    return;
  }
  const { projectSettingsPath } = delivery;
  if (isTrackedByGit({ worktreeDir: input.worktreeDir, relativePath: projectSettingsPath })) {
    return;
  }

  const settingsFile = path.join(input.worktreeDir, projectSettingsPath);
  const merged = mergeHookSettings({
    existing: readJsonObject(settingsFile),
    settings: buildCmuxAgentHookSettings({ agent: input.agentCommandName }),
  });
  mkdirSync(path.dirname(settingsFile), { recursive: true });
  writeFileSync(settingsFile, `${JSON.stringify(merged, undefined, 2)}\n`);

  excludeFromGit({ worktreeDir: input.worktreeDir, relativePath: projectSettingsPath });
}

function mergeHookSettings(input: {
  existing: Record<string, unknown>;
  settings: CmuxAgentHookSettings;
}): Record<string, unknown> {
  const existingHooks = isPlainObject(input.existing["hooks"]) ? input.existing["hooks"] : {};
  const mergedHooks: Record<string, unknown> = { ...existingHooks };
  for (const [event, ourGroups] of Object.entries(input.settings.hooks)) {
    const userGroups = asArray(existingHooks[event]).filter(
      (group) => !isCmuxAgentHookGroup(group),
    );
    mergedHooks[event] = [...userGroups, ...ourGroups];
  }
  return { ...input.existing, hooks: mergedHooks };
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * A hook group is ours when it carries at least one command and every command
 * in it is a groundcrew-authored cmux activity hook (see `isCmuxAgentHookCommand`).
 * User groups — which never carry our marker — are left untouched on re-write.
 */
function isCmuxAgentHookGroup(group: unknown): boolean {
  if (!isPlainObject(group) || !Array.isArray(group["hooks"]) || group["hooks"].length === 0) {
    return false;
  }
  return group["hooks"].every(
    (hook) =>
      isPlainObject(hook) &&
      typeof hook["command"] === "string" &&
      isCmuxAgentHookCommand(hook["command"]),
  );
}

function readJsonObject(file: string): Record<string, unknown> {
  let contents: string;
  try {
    contents = readFileSync(file, "utf8");
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return {};
    }
    throw error;
  }
  const parsed: unknown = JSON.parse(contents);
  return isPlainObject(parsed) ? parsed : {};
}

function isTrackedByGit(input: { worktreeDir: string; relativePath: string }): boolean {
  try {
    runCommand("git", [
      "-C",
      input.worktreeDir,
      "ls-files",
      "--error-unmatch",
      "--",
      input.relativePath,
    ]);
    return true;
  } catch {
    return false;
  }
}

function excludeFromGit(input: { worktreeDir: string; relativePath: string }): void {
  const excludeFile = runCommand("git", [
    "-C",
    input.worktreeDir,
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "info/exclude",
  ]);
  const pattern = `/${input.relativePath}`;
  const contents = existsSync(excludeFile) ? readFileSync(excludeFile, "utf8") : "";
  if (contents.split("\n").some((line) => line.trim() === pattern)) {
    return;
  }
  const separator = contents.length === 0 || contents.endsWith("\n") ? "" : "\n";
  mkdirSync(path.dirname(excludeFile), { recursive: true });
  writeFileSync(excludeFile, `${contents}${separator}${pattern}\n`);
}

function isFileNotFoundError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
