/**
 * The Writeback adapter Dispatch injects into Run (design doc §9.3, CONTEXT.md
 * "Writeback"). Run owns the port; Dispatch closes the adapter over one source
 * handle and its source-local id. A read-only source (no `update`) is served by
 * Run's `noopWritebackPort` — first-class and silent, so a completion issues
 * zero `update` spawns (COMPLETE-05).
 *
 * Exported for Shell to reuse: `crew done` is Shell → Run and must rebuild the
 * same adapter (it runs in a fresh process, so the launch-time closure is gone).
 */

import type { SourceHandle } from "../acquisition/index.js";
import { noopWritebackPort, type WritebackPort } from "../run/index.js";

/**
 * The source-local id embedded in a canonical task id (`<source>:<localId>`).
 * The run record stores `taskId` and `source`; writeback needs the local id.
 */
export function localIdOf(input: { taskId: string; source: string }): string {
  const prefix = `${input.source}:`;
  return input.taskId.startsWith(prefix) ? input.taskId.slice(prefix.length) : input.taskId;
}

/**
 * Builds the Writeback port for a source. On `completed`, drives the source's
 * `update(localId, { type: "completed", … })`; a read-only source no-ops.
 */
export function createSourceWriteback(input: {
  source: SourceHandle;
  localId: string;
}): WritebackPort {
  if (input.source.readOnly) {
    return noopWritebackPort;
  }

  return {
    async completed(completion): Promise<void> {
      await input.source.update(input.localId, {
        type: "completed",
        outcome: completion.outcome,
        artifacts: completion.artifacts,
        ...(completion.message === undefined ? {} : { message: completion.message }),
      });
    },
  };
}
