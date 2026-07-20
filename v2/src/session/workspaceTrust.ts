/**
 * Seed agent workspace trust for a launch directory (ported from v1
 * `seedLaunchWorkspaceTrust`). Interactive agent CLIs (Claude Code, Codex, …)
 * prompt for "do you trust the files in this directory?" on first launch in a
 * new path; groundcrew launches unattended, so an unseeded workspace stalls the
 * session on that prompt forever. Recording trust up front — keyed by the
 * agent's command name and the workspace dir — is what lets a fresh worktree
 * launch run to completion.
 *
 * Fail-open by design: trust seeding is a convenience, not a guarantee. A
 * failure (unknown agent, unwritable trust store) logs and returns so the
 * launch still proceeds — exactly as v1 did.
 */
import { agentTrustDir, isAgentTrustAgent } from "agent-trust";

import { firstToken } from "./shellCommand.js";

const TRUST_METHOD = "groundcrew-auto-trust";

export interface SeedWorkspaceTrustInput {
  /** The composed agent command; its first token is the agent CLI name. */
  agentCommand: string;
  /** The directory the session launches in (the task workspace root). */
  workspaceDirectory: string;
  /** Sink for the fail-open diagnostic; defaults to stderr. */
  warn?: (message: string) => void;
}

/**
 * Record trust for `workspaceDirectory` under the agent named by the command's
 * first token, when `agent-trust` recognizes that agent. No-op for unrecognized
 * agents (e.g. a custom `cmd` script) — there is no trust store to seed.
 */
export function seedWorkspaceTrust(input: SeedWorkspaceTrustInput): void {
  const warn =
    input.warn ??
    ((message: string): void => {
      process.stderr.write(`${message}\n`);
    });
  const agent = firstToken(input.agentCommand);
  if (agent === undefined || !isAgentTrustAgent(agent)) {
    return;
  }

  try {
    const result = agentTrustDir({
      agent,
      dirPath: input.workspaceDirectory,
      trustMethod: TRUST_METHOD,
    });
    if (!result.ok) {
      warn(`groundcrew: could not seed ${agent} workspace trust: ${result.error}`);
    }
  } catch (error) {
    warn(
      `groundcrew: could not seed ${agent} workspace trust: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
