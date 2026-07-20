/**
 * Sandbox: a pure library — wrap(command, policy) → command; srt mechanics
 * hidden, no lifecycle ownership. Core-only by decision, nothing pluggable
 * (spec §9.3). Two callers: Session wraps agent commands, Acquisition wraps
 * source commands.
 *
 * SEAM (coordinator-pinned): implementers replace the internals and keep these
 * exported signatures; extending with new exports is fine, changing existing
 * ones needs coordinator approval.
 */

import type { WrapCommandInput, WrappedCommand } from "./types.js";
import { buildSrtSettings, stageSettings } from "./srtSettings.js";

export type { SandboxPolicy, WrapCommandInput, WrappedCommand } from "./types.js";
import { composeSrtInvocation, describeRunner, resolveSrtCli, type RunnerAvailability } from "./runner.js";

export {
  buildSrtSettings,
  homeReadMask,
  isLoopbackHost,
  nodeRuntimePrefix,
  settingsHash,
  stageSettings,
  toAllowedDomain,
  type BuildSrtSettingsOptions,
  type SrtSettings,
} from "./srtSettings.js";
export {
  composeSrtInvocation,
  describeRunner,
  isPlatformSupported,
  isRunnerAvailable,
  resolveSrtCli,
  shellSingleQuote,
} from "./runner.js";
export type { DescribeRunnerOptions, RunnerAvailability } from "./runner.js";

/**
 * Wrap a command in the srt sandbox (`sandbox-exec` on macOS, bubblewrap on
 * Linux) under the given policy. Nesting is presenter → sandbox → agent; the
 * caller composes, the presenter never knows (spec §8). The policy is compiled
 * to an srt settings file (staged deterministically under the OS temp dir) and
 * the returned command runs the original command line under that policy.
 */
export async function wrapCommand(input: WrapCommandInput): Promise<WrappedCommand> {
  const settingsFile = stageSettings(buildSrtSettings(input.policy));
  const command = composeSrtInvocation({
    srtCli: resolveSrtCli(),
    settingsFile,
    command: input.command,
  });
  return { command };
}

/** Whether the srt runner is usable on this host (doctor's sandbox check). */
export async function isSandboxRunnerAvailable(): Promise<boolean> {
  return describeRunner().available;
}

/**
 * The srt runner's availability plus, on failure, the actionable reason doctor
 * surfaces (unsupported platform, missing CLI, or — on Linux — missing runtime
 * dependencies with the apt/apparmor install hint).
 */
export async function describeSandboxRunner(): Promise<RunnerAvailability> {
  return describeRunner();
}
