import { agentTrustDir } from "agent-trust";

import { writeError } from "./util.ts";

const GROUNDCREW_TRUST_METHOD = "groundcrew-auto-trust";

/**
 * Record agent workspace trust for a launch directory. Fail-open: logs on
 * error and returns so agent launch can continue.
 */
export function seedLaunchWorkspaceTrust(input: {
  agentCommandName: string;
  launchDir: string;
}): void {
  const result = agentTrustDir({
    agent: input.agentCommandName,
    dirPath: input.launchDir,
    trustMethod: GROUNDCREW_TRUST_METHOD,
  });
  if (!result.ok) {
    writeError(`groundcrew: ${result.error}`);
  }
}
