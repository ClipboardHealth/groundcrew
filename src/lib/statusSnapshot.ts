/** Internal collection models used before status.ts builds StatusSnapshot. */

import type { PullRequestSummary } from "./pullRequests.ts";
import type { RunLifecycleState } from "./runState.ts";
import type { CanonicalStatus } from "./taskSource.ts";
import type { WorktreeDirtiness, WorktreeKind } from "./worktrees.ts";

/** Internal model version retained for the status join. */
export const STATUS_SNAPSHOT_SCHEMA_VERSION = 1;

/**
 * Optional fields are written by `JSON.stringify`, which omits a key whose
 * value is `undefined`. So every `field?:` below is genuinely ABSENT on disk
 * rather than present-and-null, and a reader must treat absence as "not set".
 */
type StatusSchemaVersion = typeof STATUS_SNAPSHOT_SCHEMA_VERSION;

/** Two-state health verdict shared by the probe and the board attempt. */
type AvailabilityStatus = "ok" | "unavailable";

export type StatusSessionState = "live" | "exited" | "not-live" | "unknown";

export type StatusLifecycle = RunLifecycleState | "idle";

export interface StatusWorktree {
  repository: string;
  kind: WorktreeKind;
  dir: string;
  branch: string;
  branchProblem?: string | undefined;
  git: WorktreeDirtiness;
}

export interface StatusTask {
  /** Lowercased source task id, matching `WorktreeEntry.task`. */
  task: string;
  title?: string | undefined;
  url?: string | undefined;
  agent?: string | undefined;
  lifecycle: StatusLifecycle;
  /** Probe-reconciliation flags, e.g. "session dead". Never a duration. */
  flags: string[];
  /**
   * When the run was first recorded. Readers derive elapsed time themselves:
   * a duration stored in a cached document shows a frozen clock, which reads
   * as "the agent stopped working" when it did not.
   */
  startedAt?: string | undefined;
  updatedAt?: string | undefined;
  resumeCount?: number | undefined;
  reason?: string | undefined;
  detail?: string | undefined;
  session: StatusSessionState;
  attachCommand?: string | undefined;
  hint?: string | undefined;
  worktrees: StatusWorktree[];
}

interface StatusProbeState {
  status: AvailabilityStatus;
  error?: string | undefined;
}

/** The local tier. Every field comes from a local subprocess or file read. */
export interface LocalStatusDocument {
  schemaVersion: StatusSchemaVersion;
  capturedAt: string;
  /** From config, never the network, so capacity renders before any fetch. */
  maximumInProgress: number;
  workspaceProbe: StatusProbeState;
  tasks: StatusTask[];
  orphanedSessions: string[];
  /** Orphaned sessions whose backend reports an exited process. */
  exitedOrphanedSessions?: string[] | undefined;
}

export interface StatusBoardIssue {
  id: string;
  naturalId: string;
  title: string;
  url?: string | undefined;
  repository?: string | undefined;
  agent?: string | undefined;
}

export interface StatusSourceIssue extends StatusBoardIssue {
  status: CanonicalStatus;
}

/**
 * A queued issue. Only groundcrew-eligible todos reach a queue, and
 * eligibility means both fields resolved, so they are required here.
 */
export interface StatusQueueIssue extends StatusBoardIssue {
  repository: string;
  agent: string;
}

interface StatusBlocker {
  id: string;
  naturalId: string;
  status: CanonicalStatus;
  nativeStatus?: string | undefined;
}

export interface StatusBlockedIssue extends StatusQueueIssue {
  blockedBy: StatusBlocker[];
}

/**
 * The remote tier contains facts whose collection needs the network.
 *
 * Board-derived facts only. Board-side classification is applied; the local
 * worktree subtraction deliberately is not. Precomputing that join here would
 * make the document assert something false as soon as a worktree appears,
 * because the local tier refreshes far more often than this one.
 */
export interface RemoteStatusPayload {
  capturedAt: string;
  /** Lowercased natural id to current source data. Ambiguous ids are omitted. */
  sourceByTask: Record<string, StatusSourceIssue>;
  /** Every in-progress issue. Its length is the used slot count. */
  inProgress: StatusBoardIssue[];
  queueReady: StatusQueueIssue[];
  queueBlocked: StatusBlockedIssue[];
}

export interface RemoteStatusDocument {
  schemaVersion: StatusSchemaVersion;
  /** The most recent attempt, successful or not. */
  lastAttemptAt: string;
  lastAttemptStatus: AvailabilityStatus;
  lastAttemptError?: string | undefined;
  /** The last successful BOARD fetch. Undefined when none has ever succeeded. */
  payload?: RemoteStatusPayload | undefined;
  /**
   * Keyed by absolute worktree directory. A task with two worktrees has two
   * branches, each with its own pull requests.
   *
   * Always from the current attempt, never carried forward: the lookups do not
   * depend on the board, so a board outage must not freeze or hide them.
   *
   * An empty entry means either no pull requests were found or the lookup
   * failed. Callers use `RemoteFetchResult.pullRequestProblems` to distinguish
   * those outcomes.
   */
  pullRequestsByWorktree: Record<string, PullRequestSummary[]>;
}

type BoardOutcome =
  | { kind: "ok"; payload: RemoteStatusPayload }
  | { kind: "error"; message: string };

/** One remote pass: a board outcome plus pull requests, which succeed or fail apart. */
export interface RemoteFetchResult {
  board: BoardOutcome;
  pullRequestsByWorktree: Record<string, PullRequestSummary[]>;
  pullRequestProblems: StatusPullRequestProblem[];
  sourceProblems: StatusSourceProbeProblem[];
}

export interface StatusPullRequestProblem {
  directory: string;
  message: string;
}

export interface StatusSourceProbeProblem {
  source: string;
  message: string;
}

export interface BuildRemoteDocumentInput {
  previous: RemoteStatusDocument | undefined;
  attemptAt: string;
  result: RemoteFetchResult;
}

/**
 * Merges an attempt into the previous document. A failure advances only the
 * attempt fields, so last-known-good queue data survives an outage while the
 * document still states plainly that the board is unreachable. Without that
 * split a reader cannot tell "nobody polled" from "the board is down", and
 * only the second is actionable.
 */
export function buildRemoteDocument(input: BuildRemoteDocumentInput): RemoteStatusDocument {
  const { previous, attemptAt, result } = input;
  const shared = {
    schemaVersion: STATUS_SNAPSHOT_SCHEMA_VERSION as StatusSchemaVersion,
    lastAttemptAt: attemptAt,
    // Never carried forward: these do not depend on the board.
    pullRequestsByWorktree: result.pullRequestsByWorktree,
  };
  if (result.board.kind === "ok") {
    return {
      ...shared,
      lastAttemptStatus: "ok",
      lastAttemptError: undefined,
      payload: result.board.payload,
    };
  }
  return {
    ...shared,
    lastAttemptStatus: "unavailable",
    lastAttemptError: result.board.message,
    payload: previous?.payload,
  };
}
