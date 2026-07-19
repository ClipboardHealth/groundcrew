/**
 * The Writeback port (spec §9.4b): Run's only outward dependency. Run tells a
 * source what happened through this port; Dispatch injects an adapter closed
 * over the source. Run never sees Acquisition, so a read-only source (no
 * `update`) is served by `noopWritebackPort` — first-class and silent.
 *
 * Only `completed` lives here: `claimed` is arbitrated by Dispatch before a run
 * exists, and `progress` has no in-session emitter in v2.0 (contracts §4.4).
 */
import type { Artifact, RunOutcome } from "./runRecord.js";

/** The `completed` writeback payload (contracts §4.4). */
export interface WritebackCompletion {
  outcome: RunOutcome;
  artifacts: Artifact[];
  message?: string;
}

export interface WritebackPort {
  completed(completion: WritebackCompletion): Promise<void>;
}

/** The read-only-source port: completion is a silent no-op. */
export const noopWritebackPort: WritebackPort = {
  async completed(): Promise<void> {
    // Read-only source: nothing to write back.
  },
};
