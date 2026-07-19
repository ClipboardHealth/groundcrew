/**
 * Live source health probe for `doctor` / `source doctor` (SURFACE-07). Runs a
 * real `list` round-trip and reports ok/failure, naming the failing source. A
 * declared-but-missing secret is reported as a failure BEFORE spawning, so the
 * finding is the missing secret rather than whatever the source does without it.
 */
import { SourceProtocolError } from "./errors.js";
import { missingSecretError } from "./openSource.js";
import type { SourceHandle } from "./openSource.js";

export type ProbeResult =
  | { readonly ok: true; readonly source: string; readonly taskCount: number }
  | { readonly ok: false; readonly source: string; readonly message: string };

/** Probes a source with a live `list`. Never throws — it reports the failure. */
export async function probeSource(input: { readonly handle: SourceHandle }): Promise<ProbeResult> {
  const { handle } = input;

  const missing = missingSecretError(handle);
  if (missing !== undefined) {
    return { ok: false, source: handle.name, message: missing.message };
  }

  try {
    const tasks = await handle.list();
    return { ok: true, source: handle.name, taskCount: tasks.length };
  } catch (error) {
    return { ok: false, source: handle.name, message: describeError(error) };
  }
}

function describeError(error: unknown): string {
  if (error instanceof SourceProtocolError) {
    return error.message;
  }

  return error instanceof Error ? error.message : String(error);
}
