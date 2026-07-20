/**
 * Typed errors for the run module. v2 internals use plain exceptions plus typed
 * error classes (native stack traces) rather than a result type (spec §12.1);
 * Shell maps these to exit codes at the boundary.
 */
/** Thrown when a run record is expected on disk but is absent. */
export class RunNotFoundError extends Error {
  public readonly path: string;

  public constructor(recordPath: string) {
    super(`run record not found: ${recordPath}`);
    this.name = "RunNotFoundError";
    this.path = recordPath;
  }
}

/**
 * Thrown when a file in the runs directory is present but is not a v2 run record
 * (unparseable JSON, wrong version, or missing/invalid fields — most often live
 * v1 state). Carries a one-line human message, never raw zod issues, so Shell
 * can surface it cleanly and v2 tolerates a directory it does not own.
 */
export class ForeignRunRecordError extends Error {
  public readonly path: string;
  /** A short classification detail (e.g. "not valid JSON", "unknown version"). */
  public readonly reason: string;

  public constructor(recordPath: string, reason: string) {
    super(`${recordPath}: not a v2 run record (v1 state?)`);
    this.name = "ForeignRunRecordError";
    this.path = recordPath;
    this.reason = reason;
  }
}

/**
 * Thrown when a lifecycle call is illegal for the run's current state (spec §3).
 * `from` is a run state; typed as `string` here so this leaf module stays free
 * of a `runRecord` import (keeps the module import graph acyclic).
 */
export class InvalidTransitionError extends Error {
  public readonly from: string;
  public readonly to: string;

  public constructor(input: { from: string; to: string }) {
    super(`invalid run transition: ${input.from} -> ${input.to}`);
    this.name = "InvalidTransitionError";
    this.from = input.from;
    this.to = input.to;
  }
}
