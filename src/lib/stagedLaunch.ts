import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { BUILD_SECRET_NAMES, type ResolvedConfig } from "./config.ts";
import { shellSingleQuote } from "./launchCommand.ts";
import type {
  AttachmentFetchResult,
  ReferenceLinkAttachment,
  SkippedAttachment,
  StagedFileAttachment,
} from "./taskSource.ts";
import { readEnvironmentVariable } from "./util.ts";

export interface StagedPrompt {
  directory: string;
  file: string;
}

interface PromptTemplateVariables {
  task: string;
  worktree: string;
  title: string;
  description: string;
  workspaceContinuationInstruction: string;
  /** Rendered `renderAttachments` output; "" when the task has none. */
  attachments: string;
}

function renderPromptTemplate(template: string, variables: PromptTemplateVariables): string {
  const withOptionals = replaceOptionalPlaceholder({
    template: replaceOptionalPlaceholder({
      template,
      placeholder: "{{workspaceContinuationInstruction}}",
      value: variables.workspaceContinuationInstruction,
    }),
    placeholder: "{{attachments}}",
    value: variables.attachments,
  });
  return withOptionals
    .replaceAll("{{task}}", variables.task)
    .replaceAll("{{worktree}}", variables.worktree)
    .replaceAll("{{title}}", variables.title)
    .replaceAll("{{description}}", variables.description);
}

/**
 * Substitute an optional placeholder. Non-empty values replace verbatim; an
 * empty value also absorbs the placeholder's own line (and one adjacent blank
 * line) so the template doesn't render stacked blank lines. Scoped to the
 * placeholder site on purpose: the template body is user-authored config and
 * must never be reflowed.
 */
function replaceOptionalPlaceholder(arguments_: {
  template: string;
  placeholder: string;
  value: string;
}): string {
  const { template, placeholder, value } = arguments_;
  if (value !== "") {
    return template.replaceAll(placeholder, value);
  }
  return template
    .replaceAll(`\n${placeholder}\n\n`, "\n")
    .replaceAll(`\n${placeholder}\n`, "\n")
    .replaceAll(placeholder, "");
}

/**
 * Render an attachment fetch result into the `{{attachments}}` prompt
 * section: an "Attached files" section (staged files as backticked
 * launchDir-relative paths, plus visible skips), then a "References" section
 * (URL-only links). Each section is omitted when empty; an empty result
 * renders the empty string. A wholesale fetch failure renders a notice line
 * so the agent knows attachments may exist that it cannot see.
 */
export function renderAttachments(result: AttachmentFetchResult): string {
  const sections: string[] = [];
  if (result.fetchError !== undefined) {
    sections.push(
      `*Attachment fetch failed: ${result.fetchError}. The task may have attachments that are not available here.*`,
    );
  }

  const attachedLines = result.attachments.flatMap((attachment) => {
    if (attachment.kind === "file") {
      return [stagedFileLine(attachment)];
    }
    if (attachment.kind === "skipped") {
      return skippedAttachmentLines(attachment);
    }
    return [];
  });
  if (attachedLines.length > 0) {
    sections.push(["## Attached files", "", ...attachedLines].join("\n"));
  }

  const referenceLines = result.attachments
    .filter((attachment) => attachment.kind === "link")
    .map((link) => referenceLinkLine(link));
  if (referenceLines.length > 0) {
    sections.push(["## References", "", ...referenceLines].join("\n"));
  }

  return sections.join("\n\n");
}

function stagedFileLine(attachment: StagedFileAttachment): string {
  const renamed =
    attachment.filename === attachment.title ? "" : ` - originally "${attachment.title}"`;
  return `- \`${attachment.relativePath}\`${renamed}`;
}

function referenceLinkLine(link: ReferenceLinkAttachment): string {
  return `- "${link.title}" - ${link.url}`;
}

function skippedAttachmentLines(attachment: SkippedAttachment): string[] {
  const lines = [
    `- "${attachment.title}" - not staged`,
    `  - reason: ${attachment.reason} - ${attachment.detail}`,
  ];
  if (attachment.url !== undefined) {
    lines.push(`  - url: ${attachment.url}`);
  }
  return lines;
}

export function stagePromptText(input: {
  prefix: string;
  task: string;
  text: string;
}): StagedPrompt {
  const promptDir = mkdtempSync(path.join(tmpdir(), `${input.prefix}-${input.task}-`));
  const promptFile = path.join(promptDir, "prompt.txt");
  writeFileSync(promptFile, input.text);
  return { directory: promptDir, file: promptFile };
}

export function stagePromptFromTemplate(input: {
  config: ResolvedConfig;
  prefix: string;
  task: string;
  variables: PromptTemplateVariables;
}): StagedPrompt {
  return stagePromptText({
    prefix: input.prefix,
    task: input.task,
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
