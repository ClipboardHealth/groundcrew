/**
 * Wire format for the two status documents an external monitor reads, plus
 * their atomic persistence. Knows nothing about boards, worktrees, or
 * sessions — collectors build these shapes, `statusJoin` combines them.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { writeJsonAtomic } from "./atomicJson.ts";

import type { ResolvedConfig } from "./config.ts";
import type { PullRequestSummary } from "./pullRequests.ts";
import type { RunLifecycleState } from "./runState.ts";
import type { CanonicalStatus } from "./taskSource.ts";
import type { WorktreeDirtiness, WorktreeKind } from "./worktrees.ts";

/**
 * Contract version for both documents. Bump on any breaking shape change;
 * readers refuse a version they don't know rather than misreading fields.
 */
export const STATUS_SNAPSHOT_SCHEMA_VERSION = 1;

/**
 * Optional fields are written by `JSON.stringify`, which omits a key whose
 * value is `undefined`. So every `field?:` below is genuinely ABSENT on disk
 * rather than present-and-null, and a reader must treat absence as "not set".
 */
export type StatusSchemaVersion = typeof STATUS_SNAPSHOT_SCHEMA_VERSION;

/** Two-state health verdict shared by the probe and the board attempt. */
export type AvailabilityStatus = "ok" | "unavailable";

export type StatusSessionState = "live" | "exited" | "not-live" | "unknown";

export type StatusLifecycle = RunLifecycleState | "idle";

export interface StatusWorktree {
  repository: string;
  kind: WorktreeKind;
  dir: string;
  branch: string;
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
  /**
   * Lines mentioning this task, from a bounded tail of the shared log. A line
   * older than that tail is absent here but still shown by `crew status <task>`.
   */
  recentLogLines: string[];
}

export interface StatusProbeState {
  status: AvailabilityStatus;
  error?: string | undefined;
}

/**
 * The local tier. Every field here comes from a local subprocess or a file
 * read, so a monitor can poll this document every few seconds.
 *
 * Placement rule for a new field: if producing it needs the network, it
 * belongs in `RemoteStatusPayload`. `--local-only` is a promise about this
 * whole document, and one network-backed field voids it.
 */
export interface LocalStatusDocument {
  schemaVersion: StatusSchemaVersion;
  capturedAt: string;
  /** From config, never the network, so capacity renders before any fetch. */
  maximumInProgress: number;
  workspaceProbe: StatusProbeState;
  tasks: StatusTask[];
  orphanedSessions: string[];
}

export interface StatusBoardIssue {
  id: string;
  naturalId: string;
  title: string;
  url?: string | undefined;
  repository?: string | undefined;
  agent?: string | undefined;
}

/**
 * A queued issue. Only groundcrew-eligible todos reach a queue, and
 * eligibility means both fields resolved, so they are required here.
 */
export interface StatusQueueIssue extends StatusBoardIssue {
  repository: string;
  agent: string;
}

export interface StatusBlocker {
  id: string;
  naturalId: string;
  status: CanonicalStatus;
  nativeStatus?: string | undefined;
}

export interface StatusBlockedIssue extends StatusQueueIssue {
  blockedBy: StatusBlocker[];
}

/**
 * The remote tier. Placement rule for a new field: it belongs here when
 * producing it needs the network, because this tier polls slowly, near
 * `pollIntervalMilliseconds`.
 *
 * Board-derived facts only. Board-side classification is applied; the local
 * worktree subtraction deliberately is not. Precomputing that join here would
 * make the document assert something false as soon as a worktree appears,
 * because the local tier refreshes far more often than this one.
 */
export interface RemoteStatusPayload {
  capturedAt: string;
  /** Lowercased natural id to canonical status. Ambiguous ids are omitted. */
  statusByTask: Record<string, CanonicalStatus>;
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
   * depend on the board, so a board outage must not freeze or hide them. An
   * empty array means none were found OR the lookup failed; `gh` failures are
   * not distinguishable here.
   */
  pullRequestsByWorktree: Record<string, PullRequestSummary[]>;
}

export type BoardOutcome =
  | { kind: "ok"; payload: RemoteStatusPayload }
  | { kind: "error"; message: string };

/** One remote pass: a board outcome plus pull requests, which succeed or fail apart. */
export interface RemoteFetchResult {
  board: BoardOutcome;
  pullRequestsByWorktree: Record<string, PullRequestSummary[]>;
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

type LoggingConfig = Pick<ResolvedConfig, "logging">;

/** Both documents sit beside the log file and the per-task run states. */
function statusSnapshotDirectory(config: LoggingConfig): string {
  return path.resolve(path.dirname(config.logging.file));
}

export function localSnapshotPath(config: LoggingConfig): string {
  return path.resolve(statusSnapshotDirectory(config), "status-local.json");
}

export function remoteSnapshotPath(config: LoggingConfig): string {
  return path.resolve(statusSnapshotDirectory(config), "status-remote.json");
}

export interface WriteLocalSnapshotInput {
  config: LoggingConfig;
  document: LocalStatusDocument;
}

/**
 * Same monotonic rule as `writeRemoteSnapshot`, for the same reason: a slow
 * run must not republish stale session state over a fresher poll. Returns what
 * is on disk afterwards so callers print the file's true contents.
 */
export function writeLocalSnapshot(input: WriteLocalSnapshotInput): LocalStatusDocument {
  const { config, document } = input;
  const existing = readLocalSnapshot(config);
  if (existing !== undefined && isStrictlyNewer(existing.capturedAt, document.capturedAt)) {
    return existing;
  }
  writeJsonAtomic(localSnapshotPath(config), document);
  return document;
}

/** A missing or unreadable snapshot is an ordinary first-run state, not an error. */
export function readLocalSnapshot(config: LoggingConfig): LocalStatusDocument | undefined {
  const parsed = readJsonFile(localSnapshotPath(config));
  return isLocalStatusDocument(parsed) ? parsed : undefined;
}

function isLocalStatusDocument(value: unknown): value is LocalStatusDocument {
  if (!isRecord(value)) {
    return false;
  }
  return (
    value["schemaVersion"] === STATUS_SNAPSHOT_SCHEMA_VERSION &&
    typeof value["capturedAt"] === "string" &&
    typeof value["maximumInProgress"] === "number" &&
    isRecord(value["workspaceProbe"]) &&
    Array.isArray(value["tasks"]) &&
    Array.isArray(value["orphanedSessions"])
  );
}

export interface WriteRemoteSnapshotInput {
  config: LoggingConfig;
  attemptAt: string;
  result: RemoteFetchResult;
}

/**
 * Refuses to write a document whose attempt is strictly older than the one on
 * disk. Equal timestamps are accepted: same-millisecond attempts are equally
 * current, and rejecting them would drop a legitimate result.
 *
 * This narrows the race, it does not close it. The read and the rename are
 * separate syscalls, so two processes can still interleave such that the older
 * attempt lands last. Closing it would need a lock file, which is not worth it
 * for a cache whose next poll corrects any regression.
 *
 * Returns whatever is on disk afterwards, which is the caller's document
 * unless the guard rejected it. Callers print the return value rather than
 * their own document, so stdout can never disagree with the file.
 */
export function writeRemoteSnapshot(input: WriteRemoteSnapshotInput): RemoteStatusDocument {
  const { config, attemptAt, result } = input;
  // The merge and the guard share this one read. Reading twice let a failed
  // run carry forward a payload that a concurrent success had already
  // replaced, then write it back under a newer timestamp.
  const existing = readRemoteSnapshot(config);
  if (existing !== undefined && isStrictlyNewer(existing.lastAttemptAt, attemptAt)) {
    return existing;
  }
  const document = buildRemoteDocument({ previous: existing, attemptAt, result });
  writeJsonAtomic(remoteSnapshotPath(config), document);
  return document;
}

/** A missing or unreadable snapshot is an ordinary first-run state, not an error. */
export function readRemoteSnapshot(config: LoggingConfig): RemoteStatusDocument | undefined {
  const parsed = readJsonFile(remoteSnapshotPath(config));
  return isRemoteStatusDocument(parsed) ? parsed : undefined;
}

function readJsonFile(filePath: string): unknown {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * True when `existing` is a later instant than `candidate`. An unparseable
 * or future-dated existing timestamp counts as older, so neither a foreign
 * timestamp format nor a clock that jumped forward can pin the file forever.
 */
function isStrictlyNewer(existing: string, candidate: string): boolean {
  const existingMs = Date.parse(existing);
  // A timestamp that is unparseable, or that this clock has not reached, is
  // not evidence of a newer run. Without the upper bound one future-dated file
  // pins the snapshot forever, with no command to clear it.
  if (Number.isNaN(existingMs) || existingMs > Date.now()) {
    return false;
  }
  return existingMs > Date.parse(candidate);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Structural only: it checks the containers a reader walks, not the elements
 * inside them. That catches the corruption a single writer can plausibly
 * produce. A hand-edited file with a malformed element still reaches the
 * reader, so this is a sanity check, not a schema validator.
 */
function isRemoteStatusPayload(value: unknown): value is RemoteStatusPayload {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value["capturedAt"] === "string" &&
    isRecord(value["statusByTask"]) &&
    Array.isArray(value["inProgress"]) &&
    Array.isArray(value["queueReady"]) &&
    Array.isArray(value["queueBlocked"])
  );
}

function isRemoteStatusDocument(value: unknown): value is RemoteStatusDocument {
  if (!isRecord(value)) {
    return false;
  }
  if (
    value["schemaVersion"] !== STATUS_SNAPSHOT_SCHEMA_VERSION ||
    typeof value["lastAttemptAt"] !== "string" ||
    (value["lastAttemptStatus"] !== "ok" && value["lastAttemptStatus"] !== "unavailable")
  ) {
    return false;
  }
  if (!isRecord(value["pullRequestsByWorktree"])) {
    return false;
  }
  const payload = value["payload"];
  return payload === undefined || isRemoteStatusPayload(payload);
}
