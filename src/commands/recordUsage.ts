import { readFileSync } from "node:fs";

import { loadConfig } from "../lib/config.ts";
import { readRunState, updateRunState } from "../lib/runState.ts";
import {
  addTokenUsage,
  emptyTokenUsage,
  sumTranscriptUsage,
  type TokenUsage,
  transcriptPathFromHookPayload,
} from "../lib/tokenUsage.ts";

/**
 * Fold one agent session's token usage into a task's run state.
 *
 * Invoked by the SessionEnd hook groundcrew installs into the agent, which
 * pipes Claude's hook payload on stdin. Everything here is best-effort: the
 * hook already swallows a non-zero exit, and a missing token count should
 * degrade reporting rather than fail a run that otherwise succeeded.
 */

function readStdin(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function argumentValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);

  return index >= 0 ? argv[index + 1] : undefined;
}

export async function recordUsageCli(argv: string[]): Promise<void> {
  const task = argumentValue(argv, "--task");
  if (task === undefined || task.length === 0) {
    throw new Error("Usage: crew record-usage --task <task> [--transcript <path>]");
  }

  // Explicit --transcript exists for testing and for agents whose hook payload
  // shape differs; the stdin payload is the production path.
  const transcriptPath =
    argumentValue(argv, "--transcript") ?? transcriptPathFromHookPayload(readStdin());
  if (transcriptPath === undefined) {
    return;
  }

  let transcript: string;
  try {
    transcript = readFileSync(transcriptPath, "utf8");
  } catch {
    // The transcript can be rotated or cleaned up before the hook runs.
    return;
  }

  const session = sumTranscriptUsage(transcript);
  if (session.messages === 0) {
    return;
  }

  const config = await loadConfig();
  const existing = readRunState(config, task);
  if (existing === undefined) {
    // A session outliving its run state is not an error worth failing a hook
    // over; there is simply nothing left to attribute the tokens to.
    return;
  }

  const total: TokenUsage = addTokenUsage(existing.usage ?? emptyTokenUsage(), session);

  updateRunState({ config, task, patch: { state: existing.state, usage: total } });
}
