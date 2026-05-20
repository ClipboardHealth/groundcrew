/**
 * Runtime secrets shuttled into the agent's environment. Unlike
 * `BUILD_SECRET_NAMES` (which are scrubbed before the agent execs), these
 * survive across the build-secret unset so the agent process inherits them
 * — agents commonly need to talk back to the same upstreams the host does
 * (e.g. Linear) and otherwise have no way to authenticate inside the
 * sandbox.
 *
 * Names listed here are the canonical names the agent sees. The host may
 * read its own value from a different env var (e.g. `LINEAR_API_KEY` is
 * sourced from `GROUNDCREW_LINEAR_API_KEY` first); resolution happens in
 * `stageAgentSecrets` (see `src/commands/setupWorkspace.ts`).
 */
export const AGENT_RUNTIME_SECRET_NAMES = ["LINEAR_API_KEY"] as const;
