import { shellSingleQuote } from "./shell.ts";

export interface CloudPlaceholderInput {
  task: string;
  title: string;
  sessionUrl: string;
  crewEntrypoint: readonly string[];
}

const CLOUD_PROGRESS_LABEL = "running (cloud)";

export function buildCloudPlaceholderCommand(input: CloudPlaceholderInput): string {
  const { task, title, sessionUrl, crewEntrypoint } = input;
  const takeoverCommand = [...crewEntrypoint, "resume", task].map(shellSingleQuote).join(" ");
  const banner = [
    `Task: ${task}`,
    `Title: ${title}`,
    `Session: ${sessionUrl}`,
    "This run is in the cloud.",
    "",
    "Take it over locally with:",
    `  ${takeoverCommand}`,
  ]
    .map(shellSingleQuote)
    .join(" ");
  const reportProgress = `"\${CMUX_BUNDLED_CLI_PATH:-cmux}" set-progress 0.5 --label ${shellSingleQuote(CLOUD_PROGRESS_LABEL)} --workspace "$CMUX_WORKSPACE_ID" >/dev/null 2>&1 || true`;
  return [
    "clear 2>/dev/null || true",
    `printf '%s\\n' ${banner}`,
    `if [ -n "$CMUX_WORKSPACE_ID" ]; then ${reportProgress}; fi`,
    `exec "\${SHELL:-/bin/sh}"`,
  ].join("; ");
}
