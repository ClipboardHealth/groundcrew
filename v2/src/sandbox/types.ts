/**
 * The policy vocabulary of the sandbox seam, in its own file so internal
 * modules can import it without a cycle through the module interface.
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
