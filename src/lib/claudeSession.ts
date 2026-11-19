import { randomUUID } from "node:crypto";

import { isClaudeCommand, type AgentDefinition } from "./config.ts";
import { shellSingleQuote } from "./shell.ts";
import { logEvent } from "./util.ts";

export interface ClaudeSessionFlags {
  sessionId: string;
  mode: "new" | "resume";
  remoteControlName?: string;
}

const LINEAR_IDENTIFIER = /^[a-z][a-z0-9]*-\d+$/i;
const NON_PRINTABLE_ASCII = /[^ -~]/g;

export function isClaudeLocalDefinition(definition: AgentDefinition): boolean {
  return isClaudeCommand(definition.cmd);
}

export function claudeDesktopResumeCommand(claudeSessionId: string): string {
  return `claude --desktop --resume ${claudeSessionId}`;
}

export function newClaudeSessionId(): string {
  return randomUUID();
}

export function remoteControlName(input: { task: string; repository: string }): string {
  const task = LINEAR_IDENTIFIER.test(input.task) ? input.task.toUpperCase() : input.task;
  const repositoryShortName = input.repository.slice(input.repository.lastIndexOf("/") + 1);
  return `${task} ${repositoryShortName}`.replaceAll(NON_PRINTABLE_ASCII, "");
}

/**
 * Appends to `cmd` so the flags land before the trailing prompt positional
 * and keep the first token `inferAgentCommandName` reads. `--remote-control`
 * takes an optional name, so a name is always passed to stop it swallowing
 * the prompt.
 */
export function withClaudeSessionFlags(
  definition: AgentDefinition,
  flags: ClaudeSessionFlags,
): AgentDefinition {
  const sessionFlag = flags.mode === "resume" ? "--resume" : "--session-id";
  const remoteControlFlags =
    flags.remoteControlName === undefined
      ? []
      : [
          "--remote-control",
          shellSingleQuote(flags.remoteControlName),
          "-n",
          shellSingleQuote(flags.remoteControlName),
        ];
  return {
    ...definition,
    cmd: [definition.cmd, sessionFlag, flags.sessionId, ...remoteControlFlags].join(" "),
  };
}

const CLAUDE_SESSION_EVENT = "claude_session_launch";

export interface ClaudeLaunchPlan {
  definition: AgentDefinition;
  claudeSessionId?: string;
  remoteControlName?: string;
}

export function planClaudeLaunch(input: {
  definition: AgentDefinition;
  task: string;
  repository: string;
  remoteControlEnabled: boolean;
  mode: ClaudeSessionFlags["mode"];
  sessionId?: string | undefined;
}): ClaudeLaunchPlan {
  const { definition, task, repository, remoteControlEnabled, mode } = input;
  const logContext = { flow: "claude-session-launch", task, mode };
  if (!isClaudeLocalDefinition(definition)) {
    logEvent(CLAUDE_SESSION_EVENT, { ...logContext, outcome: "skipped", decision: "not_claude" });
    return { definition };
  }
  if (mode === "resume" && input.sessionId === undefined) {
    logEvent(CLAUDE_SESSION_EVENT, {
      ...logContext,
      outcome: "skipped",
      decision: "no_session_id",
    });
    return { definition };
  }
  const claudeSessionId = input.sessionId ?? newClaudeSessionId();
  const name = remoteControlEnabled ? remoteControlName({ task, repository }) : undefined;
  logEvent(CLAUDE_SESSION_EVENT, {
    ...logContext,
    outcome: "pinned",
    claudeSessionId,
    remoteControl: remoteControlEnabled,
  });
  return {
    definition: withClaudeSessionFlags(definition, {
      sessionId: claudeSessionId,
      mode,
      ...(name === undefined ? {} : { remoteControlName: name }),
    }),
    claudeSessionId,
    ...(name === undefined ? {} : { remoteControlName: name }),
  };
}

export function claudeRunStateFields(
  plan: ClaudeLaunchPlan | undefined,
): Pick<ClaudeLaunchPlan, "claudeSessionId" | "remoteControlName"> {
  return {
    ...(plan?.claudeSessionId === undefined ? {} : { claudeSessionId: plan.claudeSessionId }),
    ...(plan?.remoteControlName === undefined ? {} : { remoteControlName: plan.remoteControlName }),
  };
}
