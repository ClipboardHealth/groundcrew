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

interface CursorProjectHookCommand {
  command: string;
}

export interface CursorProjectHooks {
  version: 1;
  hooks: Record<string, readonly CursorProjectHookCommand[]>;
}

/**
 * How an agent's lifecycle hooks reach it. Both deliveries paint the same cmux
 * progress phases; only the wire format and where it lives differ:
 * - `claude-settings` rides inline as `--settings <json>` on the agent argv.
 * - `cursor-project-file` is written to `<worktree>/.cursor/hooks.json`, which
 *   the cursor CLI auto-discovers (cursor exposes no per-invocation hook flag,
 *   and its plugin-dir hooks don't reach the headless agent).
 */
export type AgentHookDelivery = "claude-settings" | "cursor-project-file";

type LifecyclePhase = "start" | "prompt" | "notify" | "idle" | "end";

interface PhaseProgress {
  value: number;
  label: string;
}

interface AgentHookEvent {
  phase: LifecyclePhase;
  event: string;
}

/**
 * The single source of truth for what each lifecycle phase paints into the cmux
 * progress channel. Shared across agents — only the per-agent event names that
 * fire each phase differ (see {@link AGENT_HOOK_EVENTS}). `start`'s label is
 * completed per-agent in {@link phaseLabel} so it reads `running · <agent>`.
 */
const PHASE_PROGRESS: Record<LifecyclePhase, PhaseProgress> = {
  start: { value: 0.05, label: "" },
  prompt: { value: 0.5, label: "working" },
  notify: { value: 0.5, label: "idle" },
  idle: { value: 0.9, label: "idle" },
  end: { value: 1, label: "done" },
};

/**
 * Per-agent lifecycle event names mapped to shared progress phases. Adding an
 * agent is a table entry plus a delivery in {@link AGENT_HOOK_DELIVERY}, not a
 * new hook implementation. Claude's events ride `--settings`; cursor's mirror
 * the same transitions under its own (lowercase) hook event names.
 */
const AGENT_HOOK_EVENTS: Record<string, readonly AgentHookEvent[]> = {
  claude: [
    { phase: "start", event: "SessionStart" },
    { phase: "prompt", event: "UserPromptSubmit" },
    { phase: "notify", event: "Notification" },
    { phase: "idle", event: "Stop" },
    { phase: "end", event: "SessionEnd" },
  ],
  cursor: [
    { phase: "start", event: "sessionStart" },
    { phase: "prompt", event: "beforeSubmitPrompt" },
    { phase: "idle", event: "stop" },
    { phase: "idle", event: "afterAgentResponse" },
    { phase: "end", event: "sessionEnd" },
  ],
};

const AGENT_HOOK_DELIVERY: Record<string, AgentHookDelivery> = {
  claude: "claude-settings",
  cursor: "cursor-project-file",
};

/**
 * The delivery for an agent's cmux lifecycle hooks, or undefined when the agent
 * has no hook integration (it then reports only the coarse orchestrator
 * milestones). Keyed by the inferred agent command name.
 */
export function agentHookDelivery(agent: string): AgentHookDelivery | undefined {
  return AGENT_HOOK_DELIVERY[agent];
}

function phaseLabel(phase: LifecyclePhase, agent: string): string {
  if (phase === "start") {
    return `running · ${agent}`;
  }

  return PHASE_PROGRESS[phase].label;
}

/**
 * The best-effort shell command a hook runs: paint the phase via
 * `cmux set-progress` against `$CMUX_WORKSPACE_ID` (resolves identity by id, not
 * a brittle title match). Guarded on a present workspace id and swallows any
 * cmux failure so a hook never breaks the agent. Identical across agents and
 * deliveries.
 */
function setProgressCommand(phase: LifecyclePhase, agent: string): string {
  const { value } = PHASE_PROGRESS[phase];
  const label = phaseLabel(phase, agent);
  const setProgress = `"\${CMUX_BUNDLED_CLI_PATH:-cmux}" set-progress ${value} --label ${shellSingleQuote(label)} --workspace "$CMUX_WORKSPACE_ID" >/dev/null 2>&1 || true`;

  return `if [ -n "$CMUX_WORKSPACE_ID" ]; then ${setProgress}; fi`;
}

function hookEventsFor(agent: string): readonly AgentHookEvent[] {
  return AGENT_HOOK_EVENTS[agent] ?? AGENT_HOOK_EVENTS["claude"] ?? [];
}

/**
 * Claude Code hook settings that report the agent's own lifecycle to the cmux
 * sidebar, passed as `--settings <json>` (Layer A of the live activity bridge)
 * so the panel reflects what the agent is doing within a session rather than the
 * single coarse milestone the orchestrator can paint. Always emits the claude
 * event shape; `agent` only flows into the `running · <agent>` label.
 */
export function buildCmuxAgentHookSettings(input: { agent: string }): CmuxAgentHookSettings {
  const { agent } = input;
  const hooks: Record<string, readonly CmuxAgentHookGroup[]> = {};
  for (const { phase, event } of AGENT_HOOK_EVENTS["claude"] ?? []) {
    hooks[event] = [{ hooks: [{ type: "command", command: setProgressCommand(phase, agent) }] }];
  }

  return { hooks };
}

export function cmuxAgentHookSettingsJson(input: { agent: string }): string {
  return JSON.stringify(buildCmuxAgentHookSettings(input));
}

/**
 * Cursor hooks in the `.cursor/hooks.json` shape, written per-worktree so the
 * cursor CLI auto-discovers them. Same progress phases as the claude settings,
 * mapped onto cursor's event names; a phase can bind to more than one event
 * (e.g. both `stop` and `afterAgentResponse` mark the agent idle).
 */
export function buildCursorProjectHooks(input: { agent: string }): CursorProjectHooks {
  const { agent } = input;
  const hooks: Record<string, CursorProjectHookCommand[]> = {};
  for (const { phase, event } of hookEventsFor("cursor")) {
    (hooks[event] ??= []).push({ command: setProgressCommand(phase, agent) });
  }

  return { version: 1, hooks };
}

export function cursorProjectHooksJson(input: { agent: string }): string {
  return JSON.stringify(buildCursorProjectHooks(input), undefined, 2);
}

/**
 * Whether a hook command is one groundcrew painted (vs. a command the repo's own
 * `.cursor/hooks.json` already carries). Lets the writer re-merge idempotently
 * across resumes without stripping the repo's hooks.
 */
export function isGroundcrewHookCommand(command: string): boolean {
  return command.includes("set-progress") && command.includes("CMUX_WORKSPACE_ID");
}
