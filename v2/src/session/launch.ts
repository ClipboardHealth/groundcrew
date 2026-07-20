/**
 * Launch composition (design doc §9.3, contracts §9): resolve the agent profile
 * into a command, gate it on the executable actually being runnable, optionally
 * sandbox-wrap it, then hand it to the presenter at the workspace root. Nesting
 * is presenter → sandbox → agent: this module composes and wraps; the presenter
 * receives a fully composed command and never learns about sandboxing.
 *
 * Environment (contracts §9): the orchestrator's own environment (PATH, …) is
 * inherited by the presenter process; the overlay handed to `open` is the
 * profile's `environment` plus the injected `GROUNDCREW_WORKSPACE` /
 * `GROUNDCREW_TASK_ID`. The ambient `environment` passed in here is used only to
 * resolve the agent executable on PATH — the launch-failure gate (COMPLETE-03):
 * a command whose first token is not runnable fails as a typed `LaunchError`
 * before anything is spawned, which Shell records as `complete{failed, reason:
 * launch}`. An `open` that throws is mapped to the same `LaunchError`.
 *
 * `openComposed` is the shared gate → wrap → open path used by both the initial
 * launch and `resumeSession` (it is intra-module; not part of the module's
 * public `index.ts` surface).
 */

import { type SandboxPolicy, wrapCommand as sandboxWrapCommand } from "../sandbox/index.js";
import { errorMessage } from "./exec.js";
import { sessionNameFor } from "./identity.js";
import type { Presenter } from "./presenter.js";
import {
  type AgentProfileConfig,
  composeLaunchCommand,
  defaultInitialPrompt,
  resolveProfile,
} from "./profiles.js";
import { firstToken, lookupExecutable, type LookupExecutable, shellQuote } from "./shellCommand.js";
import { seedWorkspaceTrust } from "./workspaceTrust.js";

/** The injected sandbox wrap; same shape as sandbox's `wrapCommand`. */
export type WrapCommand = (input: {
  command: string;
  policy: SandboxPolicy;
}) => Promise<{ command: string }>;

/**
 * The default initial prompt — the bare `crew done` instruction (contracts §9).
 * Callers own prompt policy and pass their own `prompt`; this is the fallback so
 * the closing instruction lives in one place.
 */
export const DEFAULT_PROMPT = defaultInitialPrompt();

export class LaunchError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "LaunchError";
  }
}

export interface LaunchSessionInput {
  taskId: string;
  workspaceDirectory: string;
  /** The agent profile name (`agents.profiles.<name>`), e.g. `claude` or `scripted`. */
  profileName: string;
  profile: AgentProfileConfig;
  /** Initial prompt; defaults to `DEFAULT_PROMPT`. */
  prompt?: string;
  /** Ambient environment (orchestrator's own); its `PATH` gates the launch. */
  environment: Record<string, string>;
  /**
   * The running crew installation's `bin` directory (contracts §9). Prepended to
   * the session `PATH` so in-session `crew` resolves to the launching crew, not
   * whatever is globally installed. Omitted ⇒ the session inherits ambient PATH
   * unchanged (unit tests / direct callers).
   */
  crewBinDir?: string;
  /**
   * Non-secret env layered into the session overlay beneath the profile's own
   * environment (`workspace.environment`, contracts §5/§9). Optional; defaults
   * to none.
   */
  sessionEnvironment?: Record<string, string>;
  /** When present, the composed command is sandbox-wrapped under this policy. */
  policy?: SandboxPolicy;
  /** Injected sandbox wrap; defaults to the real `wrapCommand` from `../sandbox`. */
  wrapCommand?: WrapCommand;
  presenter: Presenter;
  /** Injected executable resolver (unit tests). */
  lookup?: LookupExecutable;
}

export interface LaunchResult {
  sessionName: string;
  /** Captured harness session id, when the profile exposes one (undefined in v2.0). */
  sessionId: string | undefined;
  /** The fully composed command handed to the presenter (sandbox wrap included). */
  command: string;
}

export async function launchSession(input: LaunchSessionInput): Promise<LaunchResult> {
  const resolved = resolveProfile({ name: input.profileName, profile: input.profile });
  const agentCommand = composeLaunchCommand({
    profile: resolved,
    prompt: input.prompt ?? DEFAULT_PROMPT,
  });

  const { sessionName, command } = await openComposed({
    taskId: input.taskId,
    workspaceDirectory: input.workspaceDirectory,
    profileName: input.profileName,
    profileEnvironment: resolved.environment,
    agentCommand,
    environment: input.environment,
    sessionEnvironment: input.sessionEnvironment,
    crewBinDir: input.crewBinDir,
    policy: input.policy,
    wrapCommand: input.wrapCommand,
    presenter: input.presenter,
    lookup: input.lookup,
  });

  return { sessionName, sessionId: resolved.captureSessionId({}), command };
}

/** Shared gate → wrap → open path. Fields are undefined-allowed, not optional. */
export interface OpenComposedInput {
  taskId: string;
  workspaceDirectory: string;
  profileName: string;
  profileEnvironment: Record<string, string>;
  /** The composed agent command (launch or resume form), pre-wrap. */
  agentCommand: string;
  environment: Record<string, string>;
  /** Workspace-level session env layered beneath the profile env (contracts §9). */
  sessionEnvironment: Record<string, string> | undefined;
  /** The launching crew's bin directory, prepended to the session PATH (contracts §9). */
  crewBinDir: string | undefined;
  policy: SandboxPolicy | undefined;
  wrapCommand: WrapCommand | undefined;
  presenter: Presenter;
  lookup: LookupExecutable | undefined;
}

export async function openComposed(
  input: OpenComposedInput,
): Promise<{ sessionName: string; command: string }> {
  assertRunnable({
    command: input.agentCommand,
    profileName: input.profileName,
    pathValue: input.environment["PATH"] ?? "",
    cwd: input.workspaceDirectory,
    lookup: input.lookup ?? lookupExecutable,
  });

  // Seed workspace trust before launch so an interactive agent (Claude, Codex)
  // does not stall on its first-run "trust this directory?" prompt in an
  // unattended session. Keyed by the pre-wrap agent command's name; fail-open.
  seedWorkspaceTrust({
    agentCommand: input.agentCommand,
    workspaceDirectory: input.workspaceDirectory,
  });

  const wrapped = await maybeWrap(input.agentCommand, input.policy, input.wrapCommand);
  // The crew-bin PATH prepend rides the outermost command (post-wrap) so both
  // the sandbox process and the agent it runs resolve `crew` to this install.
  const command = withCrewBinPath(wrapped, input.crewBinDir);
  const sessionName = sessionNameFor({ taskId: input.taskId });

  try {
    await input.presenter.open({
      name: sessionName,
      cwd: input.workspaceDirectory,
      command,
      environment: overlayEnvironment(input, input.profileEnvironment, input.sessionEnvironment),
    });
  } catch (error) {
    throw new LaunchError(`could not open session "${sessionName}": ${errorMessage(error)}`);
  }

  return { sessionName, command };
}

/**
 * The presenter overlay (contracts §9): the workspace-level session env, then
 * the profile's non-secret environment (which wins on conflict), then the
 * injected correlation variables. Ambient PATH etc. is inherited by the
 * presenter process, not layered here.
 *
 * PATH is deliberately NOT overlaid here: tmux silently ignores `-e PATH` for
 * the spawned command (verified — other `-e` vars propagate, PATH does not), so
 * the crew-bin prepend rides the command string instead ({@link withCrewBinPath}).
 */
export function overlayEnvironment(
  input: { taskId: string; workspaceDirectory: string },
  profileEnvironment: Record<string, string>,
  sessionEnvironment?: Record<string, string>,
): Record<string, string> {
  return {
    ...sessionEnvironment,
    ...profileEnvironment,
    GROUNDCREW_WORKSPACE: input.workspaceDirectory,
    GROUNDCREW_TASK_ID: input.taskId,
    // The outermost wrap is the only wrap (contracts §9): in-session `crew`
    // must never nest a second srt sandbox inside an already-confined session,
    // so every session carries the kill-switch for its own children.
    GROUNDCREW_SANDBOX: "off",
    // Sandboxed remote egress rides srt's injected filtering proxy; node's
    // fetch ignores proxy env vars unless this is set (node ≥ 24). Node-based
    // agent CLIs would otherwise see ENOTFOUND for allowlisted hosts.
    NODE_USE_ENV_PROXY: "1",
  };
}

/**
 * Prepend the launching crew's bin directory to `PATH` for the session command
 * (contracts §9). Emitted as a shell env-assignment prefix on the composed
 * command — `PATH=<crewBinDir>:"$PATH" <command>` — because the presenter runs
 * the command through a shell and tmux ignores `-e PATH`. Applied to the
 * outermost (post-sandbox-wrap) command so the sandbox process and the agent it
 * runs both see the prepend, and in-session `crew` resolves to this installation.
 * `$PATH` expands at launch to the session's inherited PATH, so nothing is lost.
 */
export function withCrewBinPath(command: string, crewBinDir: string | undefined): string {
  if (crewBinDir === undefined || crewBinDir.length === 0) {
    return command;
  }
  return `PATH=${shellQuote(crewBinDir)}:"$PATH" ${command}`;
}

async function maybeWrap(
  command: string,
  policy: SandboxPolicy | undefined,
  wrapCommand: WrapCommand | undefined,
): Promise<string> {
  if (policy === undefined) {
    return command;
  }
  const wrapped = await (wrapCommand ?? sandboxWrapCommand)({ command, policy });
  return wrapped.command;
}

function assertRunnable(input: {
  command: string;
  profileName: string;
  pathValue: string;
  cwd: string;
  lookup: LookupExecutable;
}): void {
  const token = firstToken(input.command);
  if (token === undefined) {
    throw new LaunchError(`agent profile "${input.profileName}" produced an empty command`);
  }
  const resolved = input.lookup({ name: token, pathValue: input.pathValue, cwd: input.cwd });
  if (resolved === undefined) {
    throw new LaunchError(
      `agent command for profile "${input.profileName}" is not runnable: "${token}" was not found on PATH`,
    );
  }
}
