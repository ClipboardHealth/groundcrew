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
import { firstToken, lookupExecutable, type LookupExecutable } from "./shellCommand.js";

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

  const command = await maybeWrap(input.agentCommand, input.policy, input.wrapCommand);
  const sessionName = sessionNameFor({ taskId: input.taskId });

  try {
    await input.presenter.open({
      name: sessionName,
      cwd: input.workspaceDirectory,
      command,
      environment: overlayEnvironment(input, input.profileEnvironment),
    });
  } catch (error) {
    throw new LaunchError(`could not open session "${sessionName}": ${errorMessage(error)}`);
  }

  return { sessionName, command };
}

/**
 * The presenter overlay (contracts §9): the profile's non-secret environment
 * plus the two injected correlation variables. Ambient PATH etc. is inherited by
 * the presenter process, not layered here.
 */
export function overlayEnvironment(
  input: { taskId: string; workspaceDirectory: string },
  profileEnvironment: Record<string, string>,
): Record<string, string> {
  return {
    ...profileEnvironment,
    GROUNDCREW_WORKSPACE: input.workspaceDirectory,
    GROUNDCREW_TASK_ID: input.taskId,
  };
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
