/**
 * Arbitrary-key cmux sidebar status read/write, for the `crew_stage` /
 * `crew_ticket` / `crew_labels` / `crew_poller_heartbeat` fields `pr-stage-sync`
 * owns. Deliberately separate from `cmuxAdapter.ts`'s `Adapter` implementation,
 * whose `set-status` helper is typed to the two keys (`"agent" | "task"`) the
 * workspace-lifecycle contract uses — these keys are a different namespace
 * with their own priorities, so a shared untyped-key helper would weaken both.
 */

import { runWorkspaceCommand } from "./workspaceAdapter.ts";

export interface CmuxStatusWrite {
  key: string;
  priority: number;
  /** Empty string clears the key; otherwise it is set verbatim. */
  value: string;
}

/**
 * Parses `cmux list-status`'s `key=value [attr=val ...]` lines into a
 * key -> value map. A value is the token immediately after `=`, up to the
 * next whitespace — matching the retired bash poller's `sed` extraction, so
 * the two stay byte-for-byte comparable during cutover.
 */
export function parseCmuxStatusLines(output: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }
    const equalsIndex = line.indexOf("=");
    if (equalsIndex <= 0) {
      continue;
    }
    const key = line.slice(0, equalsIndex);
    const rest = line.slice(equalsIndex + 1);
    const spaceIndex = rest.indexOf(" ");
    const value = spaceIndex === -1 ? rest : rest.slice(0, spaceIndex);
    result.set(key, value);
  }
  return result;
}

export async function readCmuxStatus(
  workspaceId: string,
  signal?: AbortSignal,
): Promise<Map<string, string>> {
  const output = await runWorkspaceCommand(
    "cmux",
    ["list-status", "--workspace", workspaceId],
    signal,
  );
  return parseCmuxStatusLines(output);
}

/** Sets `write.key`, or clears it when `write.value` is empty. */
export async function writeCmuxStatus(
  workspaceId: string,
  write: CmuxStatusWrite,
  signal?: AbortSignal,
): Promise<void> {
  if (write.value.length === 0) {
    await runWorkspaceCommand(
      "cmux",
      ["clear-status", write.key, "--workspace", workspaceId],
      signal,
    );
    return;
  }
  await runWorkspaceCommand(
    "cmux",
    [
      "set-status",
      write.key,
      write.value,
      "--priority",
      String(write.priority),
      "--workspace",
      workspaceId,
    ],
    signal,
  );
}
