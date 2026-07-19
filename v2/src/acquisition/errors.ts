/**
 * Typed errors for the acquisition module. Internally v2 uses plain exceptions
 * plus typed error classes (design §12.1); these are the failure vocabulary the
 * source adapter and doctor raise. The result-shaped protocol lives only at the
 * process boundary — these classes are what everything above the boundary sees.
 */
import type { SourceCommand } from "./protocol.js";

/** How a source invocation failed, before it was normalized to one message. */
export type SourceFailureKind =
  | "protocol-failure" // source emitted { ok: false, error }
  | "nonzero-exit" // process exited nonzero
  | "unparseable-stdout" // stdout was not a single well-formed result object
  | "timeout" // process exceeded the invocation budget
  | "spawn-failure"; // process could not be started at all

/**
 * The single failure shape every non-success source invocation collapses to
 * (design §12.1: the adapter is the one seam mapping caught exception / nonzero
 * exit / garbage stdout → protocol failure). Carries the failing source's name
 * so callers such as `source doctor` can name it (SURFACE-07).
 */
export class SourceProtocolError extends Error {
  public readonly source: string;
  public readonly command: SourceCommand;
  public readonly kind: SourceFailureKind;
  public readonly exitCode: number | undefined;

  public constructor(input: {
    readonly source: string;
    readonly command: SourceCommand;
    readonly kind: SourceFailureKind;
    readonly message: string;
    readonly exitCode?: number | undefined;
  }) {
    super(`source ${input.source} ${input.command}: ${input.message}`);
    this.name = "SourceProtocolError";
    this.source = input.source;
    this.command = input.command;
    this.kind = input.kind;
    this.exitCode = input.exitCode;
  }
}

/**
 * A declared secret could not be resolved. Surfaced by doctor rather than thrown
 * at spawn time (a missing secret is a health finding, not a crash): the handle
 * carries the names, doctor renders them through this typed error.
 */
export class MissingSecretError extends Error {
  public readonly source: string;
  public readonly secretNames: readonly string[];

  public constructor(input: { readonly source: string; readonly secretNames: readonly string[] }) {
    super(
      `source ${input.source} is missing declared secret(s): ${input.secretNames.join(", ")}`,
    );
    this.name = "MissingSecretError";
    this.source = input.source;
    this.secretNames = input.secretNames;
  }
}
