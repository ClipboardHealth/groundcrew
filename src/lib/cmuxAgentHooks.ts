import { shellSingleQuote } from "./shell.ts";

interface CmuxAgentHookCommand {
  type: "command";
  command: string;
}

interface CmuxAgentHookGroup {
  hooks: readonly CmuxAgentHookCommand[];
}

export interface CmuxAgentHookSettings {
  hooks: Record<string, readonly CmuxAgentHookGroup[]>;
}

/**
 * Claude Code hook settings that report the agent's own lifecycle to the cmux
 * sidebar. Passed to the agent as `--settings <json>` (Layer A of the live
 * activity bridge), so the panel reflects what the agent is doing within a
 * session rather than the single coarse milestone the orchestrator can paint.
 *
 * Each hook calls `cmux set-progress` against `$CMUX_WORKSPACE_ID` — present in
 * the safehouse cmux env-pass allowlist, so the call reaches cmux from inside
 * the sandbox and resolves identity by id rather than the brittle title match.
 * The call is guarded and best-effort: a missing workspace id or a cmux failure
 * is swallowed so a hook never breaks the agent.
 */
export function buildCmuxAgentHookSettings(input: { agent: string }): CmuxAgentHookSettings {
  const { agent } = input;
  const phases: readonly CmuxAgentHookPhase[] = [
    { event: "SessionStart", value: 0.05, label: `running · ${agent}` },
    { event: "UserPromptSubmit", value: 0.5, label: "working" },
    { event: "Notification", value: 0.5, label: "needs input" },
    { event: "Stop", value: 0.9, label: "idle" },
    { event: "SessionEnd", value: 1, label: "done" },
  ];

  const hooks: Record<string, readonly CmuxAgentHookGroup[]> = {};
  for (const phase of phases) {
    hooks[phase.event] = [{ hooks: [{ type: "command", command: setProgressCommand(phase) }] }];
  }

  return { hooks };
}

export function cmuxAgentHookSettingsJson(input: { agent: string }): string {
  return JSON.stringify(buildCmuxAgentHookSettings(input));
}

interface CmuxAgentHookPhase {
  event: string;
  value: number;
  label: string;
}

function setProgressCommand(phase: CmuxAgentHookPhase): string {
  const setProgress = `"\${CMUX_BUNDLED_CLI_PATH:-cmux}" set-progress ${phase.value} --label ${shellSingleQuote(phase.label)} --workspace "$CMUX_WORKSPACE_ID" >/dev/null 2>&1 || true`;

  return `if [ -n "$CMUX_WORKSPACE_ID" ]; then ${setProgress}; fi`;
}
