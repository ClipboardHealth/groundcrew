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
