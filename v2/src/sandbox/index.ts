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

export interface SandboxPolicy {
  /** Absolute paths the sandboxed process may read and write. */
  writablePaths: string[];
  /** Absolute paths readable (not writable) in addition to system defaults. */
  readOnlyPaths: string[];
  /**
   * Network egress allowlist entries (`host` or `host:port`). Empty array =
   * deny all egress. Sources declare theirs in manifests; agent sessions get
   * config `sandbox.network` (contracts §5).
   */
  network: string[];
}

export interface WrapCommandInput {
  /** The fully composed command line to confine. */
  command: string;
  policy: SandboxPolicy;
}

export interface WrappedCommand {
  /** The command line to hand to the presenter/spawner in place of the input. */
  command: string;
}

/**
 * Wrap a command in the srt sandbox (`sandbox-exec` on macOS, bubblewrap on
 * Linux) under the given policy. Nesting is presenter → sandbox → agent; the
 * caller composes, the presenter never knows (spec §8).
 */
export async function wrapCommand(_input: WrapCommandInput): Promise<WrappedCommand> {
  throw new Error("not implemented: sandbox.wrapCommand");
}

/** Whether the srt runner is usable on this host (doctor's sandbox check). */
export async function isSandboxRunnerAvailable(): Promise<boolean> {
  throw new Error("not implemented: sandbox.isSandboxRunnerAvailable");
}
