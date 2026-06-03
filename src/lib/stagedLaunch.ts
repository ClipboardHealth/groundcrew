import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { BUILD_SECRET_NAMES, type ResolvedConfig } from "./config.ts";
import { shellSingleQuote } from "./launchCommand.ts";
import { readEnvironmentVariable } from "./util.ts";

export interface StagedPrompt {
  directory: string;
  file: string;
}

interface PromptTemplateVariables {
  ticket: string;
  worktree: string;
  title: string;
  description: string;
  workspaceContinuationInstruction: string;
}

function renderPromptTemplate(template: string, variables: PromptTemplateVariables): string {
  return template
    .replaceAll("{{ticket}}", variables.ticket)
    .replaceAll("{{worktree}}", variables.worktree)
    .replaceAll("{{title}}", variables.title)
    .replaceAll("{{description}}", variables.description)
    .replaceAll("{{workspaceContinuationInstruction}}", variables.workspaceContinuationInstruction);
}

export function stagePromptText(input: {
  prefix: string;
  ticket: string;
  text: string;
}): StagedPrompt {
  const promptDir = mkdtempSync(path.join(tmpdir(), `${input.prefix}-${input.ticket}-`));
  const promptFile = path.join(promptDir, "prompt.txt");
  writeFileSync(promptFile, input.text);
  return { directory: promptDir, file: promptFile };
}

export function stagePromptFromTemplate(input: {
  config: ResolvedConfig;
  prefix: string;
  ticket: string;
  variables: PromptTemplateVariables;
}): StagedPrompt {
  return stagePromptText({
    prefix: input.prefix,
    ticket: input.ticket,
    text: renderPromptTemplate(input.config.prompts.initial, input.variables),
  });
}

/**
 * Stage a `KEY='value'` env file for any populated build-time secret so
 * the launch command can source it. Returns `undefined` when groundcrew
 * has nothing to forward, leaving the launch command unchanged.
 */
export function stageBuildSecrets(promptDir: string): string | undefined {
  const lines: string[] = [];
  for (const name of BUILD_SECRET_NAMES) {
    const value = readEnvironmentVariable(name);
    if (value === undefined || value.length === 0) {
      continue;
    }
    lines.push(`${name}=${shellSingleQuote(value)}`);
  }
  if (lines.length === 0) {
    return undefined;
  }
  const secretsFile = path.join(promptDir, "secrets.env");
  writeFileSync(secretsFile, `${lines.join("\n")}\n`, { mode: 0o600 });
  return secretsFile;
}

export interface StagedSrtSettings {
  directory: string;
  /** Profile-neutral policy for the prepareWorktree wrap (no agent credentials). */
  prepareFile: string;
  /** Full agent policy for the agent wrap. */
  agentFile: string;
}

/**
 * Stage the generated srt settings JSON in its own temp dir, separate from the
 * prompt dir (which the launch command wipes before the agent execs). The
 * launch command tears this dir down after srt exits.
 *
 * Two files: the repo-controlled prepareWorktree hook runs under the
 * profile-neutral `prepare` policy (no `~/.claude`/`~/.codex` grants), while
 * the agent runs under the full `agent` policy — so a malicious repo hook
 * cannot read or mutate the agent's credentials before the agent starts.
 */
export function stageSrtSettings(
  ticket: string,
  settings: { prepare: SandboxRuntimeConfig; agent: SandboxRuntimeConfig },
): StagedSrtSettings {
  const directory = mkdtempSync(path.join(tmpdir(), `groundcrew-srt-${ticket}-`));
  const prepareFile = path.join(directory, "prepare-settings.json");
  const agentFile = path.join(directory, "agent-settings.json");
  writeFileSync(prepareFile, `${JSON.stringify(settings.prepare, undefined, 2)}\n`);
  writeFileSync(agentFile, `${JSON.stringify(settings.agent, undefined, 2)}\n`);
  return { directory, prepareFile, agentFile };
}

function stageLaunchScript(promptDir: string, command: string): string {
  const launcherFile = path.join(promptDir, "launch.sh");
  writeFileSync(launcherFile, `#!/usr/bin/env bash\n${command}\n`, { mode: 0o700 });
  return launcherFile;
}

export function stageWorkspaceLaunchCommand(promptDir: string, command: string): string {
  return `bash ${shellSingleQuote(stageLaunchScript(promptDir, command))}`;
}

export function removeStagedPrompt(directory: string): void {
  rmSync(directory, { recursive: true, force: true });
}
