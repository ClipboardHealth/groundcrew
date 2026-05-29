import type { ResolvedConfig } from "./config.ts";
import { removeRunState } from "./runState.ts";
import { debug, errorMessage } from "./util.ts";
import type { WorktreeEntry } from "./worktrees.ts";

export function recordCleanedUpRuns(
  config: ResolvedConfig,
  entries: readonly WorktreeEntry[],
): void {
  for (const entry of entries) {
    try {
      removeRunState(config, entry.ticket);
    } catch (error) {
      debug(`Run state cleanup failed for ${entry.ticket}: ${errorMessage(error)}`);
    }
  }
}
