/**
 * Wire format for the two status documents an external monitor reads, plus
 * their atomic persistence. Knows nothing about boards, worktrees, or
 * sessions — collectors build these shapes, `statusJoin` combines them.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { ResolvedConfig } from "./config.ts";
import type { PullRequestSummary } from "./pullRequests.ts";
import type { RunLifecycleState } from "./runState.ts";
import type { CanonicalStatus } from "./taskSource.ts";
import type { WorktreeDirtiness } from "./worktrees.ts";

/**
 * Contract version for both documents. Bump on any breaking shape change;
 * readers refuse a version they don't know rather than misreading fields.
 */
export const STATUS_SNAPSHOT_SCHEMA_VERSION = 1;

export type StatusSessionState = "live" | "exited" | "not-live" | "unknown";

export type StatusLifecycle = RunLifecycleState | "idle";

export interface StatusWorktree {
  repository: string;
  kind: string;
  dir: string;
  branch: string;
  git: WorktreeDirtiness;
}

export interface StatusTask {
  /** Lowercased source task id, matching `WorktreeEntry.task`. */
  task: string;
  title: string | undefined;
  url: string | undefined;
  repository: string;
  agent: string | undefined;
  lifecycle: StatusLifecycle;
  /** Probe-reconciliation flags, e.g. "session dead". Never a duration. */
  flags: string[];
  /** RunState.createdAt. Readers derive elapsed time; a stored duration in a
   * cached document shows a frozen clock. */
  startedAt: string | undefined;
  updatedAt: string | undefined;
  resumeCount: number | undefined;
  reason: string | undefined;
  detail: string | undefined;
  session: StatusSessionState;
  attachCommand: string | undefined;
  hint: string | undefined;
  worktrees: StatusWorktree[];
  recentLogLines: string[];
}

export interface StatusProbeState {
  status: "ok" | "unavailable";
  error: string | undefined;
}

export interface LocalStatusDocument {
  schemaVersion: number;
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
  url: string | undefined;
  repository: string | undefined;
  agent: string | undefined;
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
  status: CanonicalStatus;
  nativeStatus: string | undefined;
}

export interface StatusBlockedIssue extends StatusQueueIssue {
  blockedBy: StatusBlocker[];
}

/**
 * Board-derived facts only. Board-side classification is applied; the local
 * worktree subtraction deliberately is not. Precomputing that join here would
 * make the document assert something false as soon as a worktree appears,
 * because the local tier refreshes far more often than this one.
 */
export interface RemoteStatusPayload {
  capturedAt: string;
  /** Lowercased natural id to canonical status. Ambiguous ids are omitted. */
  statusByTask: Record<string, CanonicalStatus>;
  pullRequestsByTask: Record<string, PullRequestSummary[]>;
  /** Every in-progress issue. Its length is the used slot count. */
  inProgress: StatusBoardIssue[];
  queueReady: StatusQueueIssue[];
  queueBlocked: StatusBlockedIssue[];
}

export interface RemoteStatusDocument {
  schemaVersion: number;
  /** The most recent attempt, successful or not. */
  lastAttemptAt: string;
  lastAttemptStatus: "ok" | "unavailable";
  lastAttemptError: string | undefined;
  /** The last successful fetch. Undefined when none has ever succeeded. */
  payload: RemoteStatusPayload | undefined;
}

export type RemoteFetchResult =
  | { kind: "ok"; payload: RemoteStatusPayload }
  | { kind: "error"; message: string };

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
  if (result.kind === "ok") {
    return {
      schemaVersion: STATUS_SNAPSHOT_SCHEMA_VERSION,
      lastAttemptAt: attemptAt,
      lastAttemptStatus: "ok",
      lastAttemptError: undefined,
      payload: result.payload,
    };
  }
  return {
    schemaVersion: STATUS_SNAPSHOT_SCHEMA_VERSION,
    lastAttemptAt: attemptAt,
    lastAttemptStatus: "unavailable",
    lastAttemptError: result.message,
    payload: previous?.payload,
  };
}

type LoggingConfig = Pick<ResolvedConfig, "logging">;

/** Both documents sit beside the log file and the per-task run states. */
export function statusSnapshotDirectory(config: LoggingConfig): string {
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

export function writeLocalSnapshot(input: WriteLocalSnapshotInput): void {
  const { config, document } = input;
  writeDocument(localSnapshotPath(config), document);
}

export interface WriteRemoteSnapshotInput {
  config: LoggingConfig;
  document: RemoteStatusDocument;
}

/**
 * Monotonic: refuses to write a document whose attempt is strictly older than
 * the one on disk, so two concurrent runs interleaving read and write across
 * processes can never move the remote tier backwards. Equal timestamps are
 * accepted — same-millisecond attempts are equally current, and rejecting them
 * would silently drop a legitimate result.
 *
 * Returns whatever is on disk afterwards, which is the caller's document
 * unless the guard rejected it. Callers print the return value rather than
 * their own document, so stdout can never disagree with the file.
 */
export function writeRemoteSnapshot(input: WriteRemoteSnapshotInput): RemoteStatusDocument {
  const { config, document } = input;
  const existing = readRemoteSnapshot(config);
  if (existing !== undefined && existing.lastAttemptAt > document.lastAttemptAt) {
    return existing;
  }
  writeDocument(remoteSnapshotPath(config), document);
  return document;
}

/**
 * Reads the persisted remote document, or undefined when it is missing,
 * unreadable, corrupt, or written by an incompatible schema version. A
 * missing snapshot is an ordinary first-run state, not an error.
 */
export function readRemoteSnapshot(config: LoggingConfig): RemoteStatusDocument | undefined {
  let raw: string;
  try {
    raw = readFileSync(remoteSnapshotPath(config), "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  return isRemoteStatusDocument(parsed) ? parsed : undefined;
}

function isRemoteStatusDocument(value: unknown): value is RemoteStatusDocument {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate: Record<string, unknown> = { ...value };
  return (
    candidate["schemaVersion"] === STATUS_SNAPSHOT_SCHEMA_VERSION &&
    typeof candidate["lastAttemptAt"] === "string" &&
    (candidate["lastAttemptStatus"] === "ok" || candidate["lastAttemptStatus"] === "unavailable")
  );
}

function writeDocument(filePath: string, document: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  // Write-then-rename so a concurrent reader never observes a partial file.
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(document, undefined, 2)}\n`, { mode: 0o600 });
  renameSync(tmpPath, filePath);
}
