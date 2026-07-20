/**
 * Session: harness profiles (declarative), launch composition
 * (presenter → sandbox → agent), pause/resume and session-id capture;
 * cmux/tmux/zellij adapters in-core. Owns the presenter contract seam
 * (design doc §8, §9.3). This `index.ts` is the module's only interface; other
 * modules import from here alone.
 */
export const MODULE = "session";

// Presenter contract seam (contracts §8, design doc §8).
export type {
  Presenter,
  PresenterOpenSpec,
  PresenterProbe,
  PresenterSession,
  PresenterStatus,
} from "./presenter.js";

// Session-name identity (contracts §1).
export { isManagedSessionName, SESSION_NAME_PREFIX, sessionNameFor, taskSlug } from "./identity.js";

// The one process seam the adapters run through.
export { runProcess } from "./exec.js";
export type { ExecFn, ExecInput, ExecResult } from "./exec.js";

// Agent profiles and command composition (contracts §5, design doc §7.2).
export {
  composeLaunchCommand,
  composeResumeCommand,
  CREW_DONE_INSTRUCTION,
  defaultInitialPrompt,
  isPresetName,
  noSessionIdCapture,
  PRESET_NAMES,
  ProfileError,
  resolveProfile,
} from "./profiles.js";
export type {
  AgentProfileConfig,
  PresetName,
  ResolvedProfile,
  SessionIdCapture,
} from "./profiles.js";

// In-core presenter adapters.
export { createTmuxPresenter } from "./tmuxPresenter.js";
export type { CreateTmuxPresenterInput } from "./tmuxPresenter.js";
export { createCmuxPresenter } from "./cmuxPresenter.js";
export type { CreateCmuxPresenterInput } from "./cmuxPresenter.js";
export { createZellijPresenter } from "./zellijPresenter.js";
export type { CreateZellijPresenterInput } from "./zellijPresenter.js";

// Presenter detection (contracts §5, design doc §8).
export { detectPresenter, PRESENTER_NAMES, PresenterError } from "./detect.js";
export type { DetectedPresenter, DetectPresenterInput, PresenterName } from "./detect.js";

// Launch composition and the typed launch-failure gate (contracts §9, COMPLETE-03).
export { DEFAULT_PROMPT, launchSession, LaunchError } from "./launch.js";
export type { LaunchResult, LaunchSessionInput, WrapCommand } from "./launch.js";

// Session lifecycle: pause / resume / close / probe.
export { closeSession, pauseSession, probeSessions, resumeSession } from "./lifecycle.js";
export type { ResumeSessionInput, SessionRef } from "./lifecycle.js";
