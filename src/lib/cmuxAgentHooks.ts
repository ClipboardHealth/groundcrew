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
 * Trailing shell comment stamped on every groundcrew-authored hook command. It
 * is inert at runtime but lets the project-settings merge recognize our own
 * prior entries — so a re-launch replaces them and leaves the user's unrelated
 * hooks untouched. See `isCmuxAgentHookCommand`.
 */
const CMUX_AGENT_HOOK_MARKER = "groundcrew:cmux-activity";

/**
 * Claude Code hook settings that report the agent's own lifecycle to the cmux
 * sidebar. Written to a project-level settings file in the worktree (Layer A of
 * the live activity bridge) that the CLI auto-discovers on every startup, so the
 * panel reflects what the agent is doing within a session — and keeps updating
 * across manual restarts (`claude --resume`) that bypass the staged launch.
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
    { event: "Notification", value: 0.5, label: "idle" },
    { event: "Stop", value: 0.9, label: "idle" },
    { event: "SessionEnd", value: 1, label: "done" },
  ];

  const hooks: Record<string, readonly CmuxAgentHookGroup[]> = {};
  for (const phase of phases) {
    hooks[phase.event] = [{ hooks: [{ type: "command", command: setProgressCommand(phase) }] }];
  }

  return { hooks };
}

/** True when `command` is a groundcrew-authored cmux activity hook command. */
export function isCmuxAgentHookCommand(command: string): boolean {
  return command.includes(CMUX_AGENT_HOOK_MARKER);
}

export interface CmuxAgentHookDelivery {
  /**
   * Worktree-relative path of the project settings file the agent auto-loads on
   * every startup. Written at launch so the activity hooks survive manual
   * restarts that bypass the staged launch.
   */
  projectSettingsPath: string;
}

/**
 * Per-agent map of how the agent receives its cmux activity hooks. Only agents
 * with a project-level settings file the CLI auto-discovers are listed; agents
 * without a hook integration (e.g. codex) return `undefined` and receive none.
 */
const CMUX_AGENT_HOOK_DELIVERY: Readonly<Record<string, CmuxAgentHookDelivery>> = {
  claude: { projectSettingsPath: ".claude/settings.local.json" },
};

export function cmuxAgentHookDelivery(agentCommandName: string): CmuxAgentHookDelivery | undefined {
  return CMUX_AGENT_HOOK_DELIVERY[agentCommandName];
}

interface CmuxAgentHookPhase {
  event: string;
  value: number;
  label: string;
}

function setProgressCommand(phase: CmuxAgentHookPhase): string {
  const setProgress = `"\${CMUX_BUNDLED_CLI_PATH:-cmux}" set-progress ${phase.value} --label ${shellSingleQuote(phase.label)} --workspace "$CMUX_WORKSPACE_ID" >/dev/null 2>&1 || true`;

  return `if [ -n "$CMUX_WORKSPACE_ID" ]; then ${setProgress}; fi # ${CMUX_AGENT_HOOK_MARKER}`;
}
