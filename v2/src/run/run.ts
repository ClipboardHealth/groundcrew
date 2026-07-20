/**
 * The run lifecycle (spec §3): `provisioning -> running <-> paused -> complete`.
 * `Run` wraps a record on disk; every mutating method validates the transition,
 * appends to the append-only event history, and persists atomically. `complete`
 * additionally drives the injected Writeback port exactly once. A completed run
 * is terminal: re-dispatch replaces the record via a fresh `createRun`
 * (DISPATCH-09), so `createRun` overwrites any prior record for the slug.
 */
import { randomBytes } from "node:crypto";

import type { Logger } from "../logging/index.js";
import { InvalidTransitionError } from "./errors.js";
import {
  type Artifact,
  type RunOutcome,
  type RunRecord,
  type RunState,
  RUN_RECORD_VERSION,
  deleteRunRecord,
  listRunRecords,
  readRunRecord,
  runRecordExists,
  runRecordPath,
  writeRunRecord,
} from "./runRecord.js";
import { type WritebackPort, noopWritebackPort } from "./writeback.js";

const MODULE = "run" as const;

export interface CreateRunInput {
  stateRoot: string;
  /** Task slug (contracts §1); the caller computes it. Names the record file. */
  taskSlug: string;
  taskId: string;
  source: string;
  agentProfile: string;
  sessionName: string;
  workspaceDirectory: string;
  /** Provisioned worktrees at dispatch time; defaults to empty. */
  repos?: string[];
  /** Override the generated `r_`+8-hex id (tests, replay). */
  runId?: string;
  writeback?: WritebackPort;
  logger?: Logger;
  now?: () => Date;
}

export interface LoadRunInput {
  stateRoot: string;
  taskSlug: string;
  writeback?: WritebackPort;
  logger?: Logger;
  now?: () => Date;
}

export interface CompleteRunInput {
  outcome: RunOutcome;
  /** Optional detail for a failure (e.g. "launch"). */
  reason?: string;
  message?: string;
}

/** A fresh run in `provisioning`, its `claimed` event recorded and persisted. */
export async function createRun(input: CreateRunInput): Promise<Run> {
  const runId = input.runId ?? generateRunId();
  const record: RunRecord = {
    version: RUN_RECORD_VERSION,
    taskId: input.taskId,
    runId,
    source: input.source,
    agentProfile: input.agentProfile,
    state: "provisioning",
    resumeCount: 0,
    sessionName: input.sessionName,
    workspaceDirectory: input.workspaceDirectory,
    repos: input.repos === undefined ? [] : [...input.repos],
    artifacts: [],
    events: [],
  };

  const run = new Run({
    record,
    path: runRecordPath({ stateRoot: input.stateRoot, taskSlug: input.taskSlug }),
    writeback: input.writeback ?? noopWritebackPort,
    ...(input.logger === undefined ? {} : { logger: input.logger }),
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  await run.provision();
  return run;
}

/** Loads an existing run; throws `RunNotFoundError` when the record is absent. */
export async function loadRun(input: LoadRunInput): Promise<Run> {
  const recordPath = runRecordPath({ stateRoot: input.stateRoot, taskSlug: input.taskSlug });
  const record = await readRunRecord({ path: recordPath });
  return new Run({
    record,
    path: recordPath,
    writeback: input.writeback ?? noopWritebackPort,
    ...(input.logger === undefined ? {} : { logger: input.logger }),
    ...(input.now === undefined ? {} : { now: input.now }),
  });
}

export async function runExists(input: { stateRoot: string; taskSlug: string }): Promise<boolean> {
  return await runRecordExists({ path: runRecordPath(input) });
}

export async function deleteRun(input: { stateRoot: string; taskSlug: string }): Promise<void> {
  await deleteRunRecord({ path: runRecordPath(input) });
}

export async function listRuns(input: { stateRoot: string }): Promise<RunRecord[]> {
  return await listRunRecords(input);
}

export function generateRunId(): string {
  return `r_${randomBytes(4).toString("hex")}`;
}

export class Run {
  private readonly record: RunRecord;
  private readonly recordPath: string;
  private readonly writeback: WritebackPort;
  private readonly logger: Logger | undefined;
  private readonly now: () => Date;

  public constructor(input: {
    record: RunRecord;
    path: string;
    writeback: WritebackPort;
    logger?: Logger;
    now?: () => Date;
  }) {
    this.record = input.record;
    this.recordPath = input.path;
    this.writeback = input.writeback;
    this.logger = input.logger;
    this.now = input.now ?? ((): Date => new Date());
  }

  /** A defensive copy of the current record for read models (`status`). */
  public get snapshot(): RunRecord {
    return structuredClone(this.record);
  }

  public get path(): string {
    return this.recordPath;
  }

  public get state(): RunState {
    return this.record.state;
  }

  public get runId(): string {
    return this.record.runId;
  }

  /** Records the initial `claimed` event and persists the provisioning record. */
  public async provision(): Promise<void> {
    this.append({ event: "claimed" });
    this.emit({ level: "info", event: "run_created" });
    await this.persist();
  }

  public async markRunning(): Promise<void> {
    this.transition({ from: "provisioning", to: "running", event: "state_running" });
    this.emit({ level: "info", event: "run_running" });
    await this.persist();
  }

  public async pause(input: { reason?: string } = {}): Promise<void> {
    this.transition({
      from: "running",
      to: "paused",
      event: "state_paused",
      ...(input.reason === undefined ? {} : { detail: input.reason }),
    });
    this.emit({
      level: "info",
      event: "run_paused",
      ...(input.reason === undefined ? {} : { fields: { reason: input.reason } }),
    });
    await this.persist();
  }

  public async resume(): Promise<void> {
    if (this.record.state !== "paused") {
      throw new InvalidTransitionError({ from: this.record.state, to: "running" });
    }

    this.record.state = "running";
    this.record.resumeCount += 1;
    this.append({ event: "state_resumed", detail: `resume ${String(this.record.resumeCount)}` });
    this.emit({
      level: "info",
      event: "run_resumed",
      fields: { resumeCount: this.record.resumeCount },
    });
    await this.persist();
  }

  public async recordSessionId(sessionId: string): Promise<void> {
    this.assertMutable("record_session_id");
    this.record.sessionId = sessionId;
    await this.persist();
  }

  public async addRepo(repo: string): Promise<void> {
    this.assertMutable("add_repo");
    if (!this.record.repos.includes(repo)) {
      this.record.repos.push(repo);
      await this.persist();
    }
  }

  public async addArtifact(artifact: Artifact): Promise<void> {
    this.assertMutable("add_artifact");
    this.record.artifacts.push({ ...artifact });
    this.append({ event: "artifact_reported", detail: `${artifact.kind} ${artifact.locator}` });
    this.emit({
      level: "info",
      event: "artifact_reported",
      ...(artifact.repo === undefined ? {} : { repo: artifact.repo }),
    });
    await this.persist();
  }

  /**
   * Terminal transition: any non-complete state -> complete. Drives the
   * Writeback port once, THEN persists exactly once — so the record is never
   * observably `complete` before the completed writeback has landed (the e2e
   * contract: an observer that sees state=complete is guaranteed the writeback
   * fired). If the port throws, the run stays non-complete and the error
   * propagates. A no-op port (read-only source) is silent.
   */
  public async complete(input: CompleteRunInput): Promise<void> {
    if (this.record.state === "complete") {
      throw new InvalidTransitionError({ from: "complete", to: "complete" });
    }

    this.record.state = "complete";
    this.record.outcome = input.outcome;
    if (input.reason !== undefined) {
      this.record.reason = input.reason;
    }
    this.append({ event: "state_complete", detail: input.outcome });
    this.emit({ level: "info", event: "run_completed", fields: { outcome: input.outcome } });

    await this.writeback.completed({
      outcome: input.outcome,
      artifacts: this.record.artifacts.map((artifact) => ({ ...artifact })),
      ...(input.message === undefined ? {} : { message: input.message }),
    });

    this.append({ event: "writeback_completed", detail: input.outcome });
    this.emit({ level: "info", event: "writeback_completed", fields: { outcome: input.outcome } });
    await this.persist();
  }

  public async persist(): Promise<void> {
    await writeRunRecord({ path: this.recordPath, record: this.record });
  }

  private transition(input: {
    from: RunState;
    to: RunState;
    event: string;
    detail?: string;
  }): void {
    if (this.record.state !== input.from) {
      throw new InvalidTransitionError({ from: this.record.state, to: input.to });
    }

    this.record.state = input.to;
    this.append({ event: input.event, ...(input.detail === undefined ? {} : { detail: input.detail }) });
  }

  private assertMutable(intent: string): void {
    if (this.record.state === "complete") {
      throw new InvalidTransitionError({ from: "complete", to: intent });
    }
  }

  private append(input: { event: string; detail?: string }): void {
    this.record.events.push({
      ts: this.now().toISOString(),
      event: input.event,
      ...(input.detail === undefined ? {} : { detail: input.detail }),
    });
  }

  private emit(input: {
    level: "debug" | "info" | "warn" | "error";
    event: string;
    repo?: string;
    fields?: Record<string, string | number | boolean>;
  }): void {
    this.logger?.log({
      level: input.level,
      module: MODULE,
      event: input.event,
      taskId: this.record.taskId,
      runId: this.record.runId,
      source: this.record.source,
      ...(this.record.sessionId === undefined ? {} : { sessionId: this.record.sessionId }),
      ...(input.repo === undefined ? {} : { repo: input.repo }),
      ...(input.fields === undefined ? {} : { fields: input.fields }),
    });
  }
}
