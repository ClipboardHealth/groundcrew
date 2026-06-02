import { loadConfig, type ResolvedConfig } from "../lib/config.ts";
import { readRunState, removeRunState } from "../lib/runState.ts";
import { recordCleanedUpRuns } from "../lib/runStateCleanup.ts";
import { log } from "../lib/util.ts";
import { worktrees } from "../lib/worktrees.ts";
import { logTeardown } from "./teardownReporter.ts";

export interface CleanupWorkspaceOptions {
  ticket: string;
  /** Default false. The automated cleanup path keeps in-flight uncommitted work. */
  force?: boolean;
}

function parseArguments(argv: string[]): CleanupWorkspaceOptions {
  let force = false;
  const positionals: string[] = [];
  for (const argument of argv) {
    if (argument === "--force") {
      force = true;
      continue;
    }
    if (argument.startsWith("-")) {
      throw new Error(
        `Unknown option: ${argument}\nUsage: crew cleanup [--force] <ticket>\nExample: crew cleanup team-220`,
      );
    }
    positionals.push(argument);
  }
  const [ticket, ...extras] = positionals;
  if (ticket === undefined || ticket.length === 0 || extras.length > 0) {
    throw new Error("Usage: crew cleanup [--force] <ticket>\nExample: crew cleanup team-220");
  }
  return { ticket: ticket.toLowerCase(), force };
}

export async function cleanupWorkspace(
  config: ResolvedConfig,
  options: CleanupWorkspaceOptions,
): Promise<void> {
  const { ticket, force = false } = options;
  const entries = worktrees.findByTicket(config, ticket);

  if (entries.length === 0) {
    // No worktree to tear down, but a run-state record can outlive its
    // worktree (removed out-of-band, or created under a since-changed
    // projectDir/repo that `findByTicket` no longer scans). Clearing a local
    // record is low-risk, so do it regardless of `--force` to give a manual
    // escape hatch for an otherwise-immortal stale run-state.
    if (readRunState(config, ticket) === undefined) {
      log(`No worktree found for ${ticket}; nothing to clean up.`);
      return;
    }
    removeRunState(config, ticket);
    log(`No worktree found for ${ticket}; cleared stale run-state.`);
    return;
  }

  const result = await worktrees.teardown(config, entries, { force });
  recordCleanedUpRuns(config, result.removed);
  logTeardown(result);
  if (result.failures.length > 0) {
    throw result.failures[0]?.error;
  }
}

export async function cleanupWorkspaceCli(argv: string[]): Promise<void> {
  const config = await loadConfig();
  const options = parseArguments(argv);
  await cleanupWorkspace(config, options);
}
