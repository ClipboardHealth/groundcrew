/**
 * Session lifecycle beyond the initial launch (design doc §9.3): pause, resume,
 * close, and probe. A run spans sessions — `pause`/`resume` close and reopen a
 * session under the same session name (contracts §1); `--fresh` starts a new
 * session within the same run, ignoring any captured harness id (CONTEXT.md,
 * the anchor triple).
 *
 * `pause` and `close` are both a presenter `close` at this layer — the work
 * (worktree, branch) is Workspace's and survives; the difference between
 * "paused" and "complete" is the run state Run records, not the presenter
 * action. `resume` recomposes the profile's resume form (or falls back to a
 * fresh launch when a custom profile exposes no resume form) and reopens the
 * same session name through the shared launch path.
 */

import type { SandboxPolicy } from "../sandbox/index.js";
import { sessionNameFor } from "./identity.js";
import {
  DEFAULT_PROMPT,
  type LaunchResult,
  openComposed,
  type WrapCommand,
} from "./launch.js";
import type { Presenter, PresenterProbe } from "./presenter.js";
import {
  type AgentProfileConfig,
  composeLaunchCommand,
  composeResumeCommand,
  resolveProfile,
} from "./profiles.js";
import type { LookupExecutable } from "./shellCommand.js";

/** A task-scoped handle onto a presenter surface. */
export interface SessionRef {
  taskId: string;
  presenter: Presenter;
}

/**
 * Pause: close the presenter surface, leaving the run's work intact. The run
 * record's `paused` state is Run's concern; here it is a presenter close.
 */
export async function pauseSession(input: SessionRef): Promise<void> {
  await input.presenter.close(sessionNameFor({ taskId: input.taskId }));
}

/**
 * Close: terminal teardown of the session surface (completion or stop).
 * Mechanically the same presenter `close` as pause; the distinction is the run
 * state the caller records, not the presenter action.
 */
export async function closeSession(input: SessionRef): Promise<void> {
  await input.presenter.close(sessionNameFor({ taskId: input.taskId }));
}

/** Probe the presenter for its live managed sessions (`available:false` ≠ empty). */
export async function probeSessions(input: { presenter: Presenter }): Promise<PresenterProbe> {
  return await input.presenter.probe();
}

export interface ResumeSessionInput {
  taskId: string;
  workspaceDirectory: string;
  profileName: string;
  profile: AgentProfileConfig;
  /** Captured harness session id, when one exists (undefined in v2.0). */
  sessionId?: string;
  /** Ignore any captured id and resume fresh within the same run and session name. */
  fresh?: boolean;
  /** Prompt used only for the fresh-launch fallback (profile with no resume form). */
  prompt?: string;
  environment: Record<string, string>;
  /** Workspace-level session env layered beneath the profile env (contracts §9). */
  sessionEnvironment?: Record<string, string>;
  policy?: SandboxPolicy;
  wrapCommand?: WrapCommand;
  presenter: Presenter;
  lookup?: LookupExecutable;
}

export async function resumeSession(input: ResumeSessionInput): Promise<LaunchResult> {
  const resolved = resolveProfile({ name: input.profileName, profile: input.profile });
  const effective = input.fresh === true ? { ...resolved, fresh: true } : resolved;

  const resumeCommand = composeResumeCommand({
    profile: effective,
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
  });
  // A custom profile without a resume form cannot resume; fall back to a fresh
  // launch with the initial prompt under the same session name.
  const agentCommand =
    resumeCommand ?? composeLaunchCommand({ profile: effective, prompt: input.prompt ?? DEFAULT_PROMPT });

  const { sessionName, command } = await openComposed({
    taskId: input.taskId,
    workspaceDirectory: input.workspaceDirectory,
    profileName: input.profileName,
    profileEnvironment: resolved.environment,
    agentCommand,
    environment: input.environment,
    sessionEnvironment: input.sessionEnvironment,
    policy: input.policy,
    wrapCommand: input.wrapCommand,
    presenter: input.presenter,
    lookup: input.lookup,
  });

  return { sessionName, sessionId: effective.captureSessionId({}), command };
}
