/**
 * The status read model (design §10.4, contracts §7): the join of Run (the
 * reported layer — state/outcome/artifacts/events), Workspace (the observed
 * layer — branches/commits/dirty), the dispatch skip verdicts, the presenter
 * probe (stray/dead session detection, both directions), and the source queue.
 * Pure-ish: it gathers, never renders. A source-queue failure never fails the
 * command — local truth still renders and the queue is marked unavailable.
 */
import * as fs from "node:fs";

import { z } from "zod";

import type { Task } from "../../acquisition/index.js";
import { type RunRecord, listRuns, runRecordPath, readRunRecord } from "../../run/index.js";
import { isManagedSessionName, sessionNameFor } from "../../session/index.js";
import {
  type WorkspaceObservation,
  observeWorkspace,
  taskSlug,
} from "../../workspace/index.js";
import type { Context, ResolvedSource } from "../context.js";

export const SKIP_REASONS = [
  "repo-not-on-disk",
  "slots-full",
  "claim-rejected",
  "ineligible",
] as const;

const dispatchVerdictSchema = z.object({
  skipReason: z.string(),
  detail: z.string().optional(),
  ts: z.string().optional(),
});

const dispatchFileSchema = z.object({
  version: z.number().optional(),
  verdicts: z.record(z.string(), dispatchVerdictSchema).default({}),
});

export type SkipVerdict = z.infer<typeof dispatchVerdictSchema>;

/** Per-run join of reported (record) and observed (git) truth. */
export interface RunView {
  readonly record: RunRecord;
  readonly observation: WorkspaceObservation | undefined;
  /** Live session? `undefined` when the presenter probe was unavailable. */
  readonly sessionAlive: boolean | undefined;
}

/** A source task that has not been claimed, with any last-poll skip reason. */
export interface QueuedView {
  readonly taskId: string;
  readonly title: string | undefined;
  readonly blocked: boolean;
  readonly verdict: SkipVerdict | undefined;
}

/** Discovery + capability flags for one configured source (design §6). */
export interface SourceView {
  readonly name: string;
  readonly origin: "package" | "user" | undefined;
  readonly status: "ok" | "unsupported" | "invalid" | "missing";
  readonly readOnly: boolean;
  readonly sandboxOff: boolean;
  readonly shadows: "package" | "user" | undefined;
  readonly protocolVersion: number | undefined;
  readonly supportedVersions: readonly number[] | undefined;
  /** Set when this source's queue could not be listed (SURFACE-03). */
  readonly queueUnavailable: string | undefined;
  readonly message: string | undefined;
}

/** A managed presenter session with no owning run record (stray, design §10.5). */
export interface StraySession {
  readonly name: string;
  readonly alive: boolean;
}

export interface StatusModel {
  readonly scope: "all" | "task";
  readonly probeAvailable: boolean;
  readonly runs: readonly RunView[];
  readonly queue: readonly QueuedView[];
  readonly sources: readonly SourceView[];
  readonly strays: readonly StraySession[];
  /** A run that expects a live session but has none (dead, SESSION-03). */
  readonly deadRuns: readonly RunView[];
  readonly logFile: string;
  /** Present only when scoped to a task that has no run record. */
  readonly missingTaskId: string | undefined;
}

export async function buildStatusModel(input: {
  readonly context: Context;
  readonly task?: string;
}): Promise<StatusModel> {
  const { context } = input;
  const scope = input.task === undefined ? "all" : "task";

  const records = await loadRecords({ context, ...(input.task === undefined ? {} : { task: input.task }) });
  const probe = await probePresenter(context);

  const runs: RunView[] = await Promise.all(
    records.map(async (record) => ({
      record,
      observation: await observeWorkspace({ config: context.workspaceConfig(), taskId: record.taskId }),
      sessionAlive: sessionLiveness({ probe, record }),
    })),
  );

  const sources = buildSourceViews(context);
  const { queue, queueFailures } = await buildQueue({ context, records });
  annotateQueueFailures(sources, queueFailures);

  const managedNames = new Set(records.map((record) => record.sessionName));
  const strays: StraySession[] =
    probe.available
      ? probe.sessions
          .filter((session) => isManagedSessionName(session.name) && !managedNames.has(session.name))
          .map((session) => ({ name: session.name, alive: session.alive }))
      : [];

  const deadRuns = probe.available
    ? runs.filter((run) => run.record.state === "running" && run.sessionAlive === false)
    : [];

  return {
    scope,
    probeAvailable: probe.available,
    runs,
    queue,
    sources,
    strays,
    deadRuns,
    logFile: context.config.logging?.file ?? "",
    missingTaskId:
      scope === "task" && records.length === 0 ? input.task : undefined,
  };
}

interface PresenterProbeResult {
  readonly available: boolean;
  readonly sessions: ReadonlyArray<{ readonly name: string; readonly alive: boolean }>;
}

async function probePresenter(context: Context): Promise<PresenterProbeResult> {
  try {
    const presenter = context.presenter();
    return await presenter.probe();
  } catch {
    return { available: false, sessions: [] };
  }
}

async function loadRecords(input: {
  readonly context: Context;
  readonly task?: string;
}): Promise<RunRecord[]> {
  if (input.task === undefined) {
    return await listRuns({ stateRoot: input.context.stateRoot });
  }

  const path = runRecordPath({
    stateRoot: input.context.stateRoot,
    taskSlug: taskSlug({ taskId: input.task }),
  });
  try {
    return [await readRunRecord({ path })];
  } catch {
    return [];
  }
}

function sessionLiveness(input: {
  readonly probe: PresenterProbeResult;
  readonly record: RunRecord;
}): boolean | undefined {
  if (!input.probe.available) {
    return undefined;
  }

  const expected = sessionNameFor({ taskId: input.record.taskId });
  return input.probe.sessions.some((session) => session.name === expected && session.alive);
}

function buildSourceViews(context: Context): SourceView[] {
  return context.resolvedSources().map((resolved) => toSourceView(resolved));
}

function toSourceView(resolved: ResolvedSource): SourceView {
  const discovered = resolved.discovered;
  const sandboxOff = resolved.entry.sandbox === false;

  if (discovered === undefined) {
    return {
      name: resolved.name,
      origin: undefined,
      status: "missing",
      readOnly: false,
      sandboxOff,
      shadows: undefined,
      protocolVersion: undefined,
      supportedVersions: undefined,
      queueUnavailable: undefined,
      message: `no bundle named "${resolved.entry.kind}" was discovered`,
    };
  }

  const base = {
    name: resolved.name,
    origin: discovered.origin,
    sandboxOff,
    shadows: discovered.shadows,
    queueUnavailable: undefined,
  };

  switch (discovered.status) {
    case "ok": {
      return {
        ...base,
        status: "ok",
        readOnly: discovered.readOnly,
        protocolVersion: discovered.protocolVersion,
        supportedVersions: undefined,
        message: undefined,
      };
    }
    case "unsupported": {
      return {
        ...base,
        status: "unsupported",
        readOnly: false,
        protocolVersion: discovered.protocolVersion,
        supportedVersions: discovered.supportedVersions,
        message: discovered.message,
      };
    }
    case "invalid": {
      return {
        ...base,
        status: "invalid",
        readOnly: false,
        protocolVersion: undefined,
        supportedVersions: undefined,
        message: discovered.warning,
      };
    }
    default: {
      throw new Error("unreachable discovered source status");
    }
  }
}

async function buildQueue(input: {
  readonly context: Context;
  readonly records: readonly RunRecord[];
}): Promise<{ queue: QueuedView[]; queueFailures: Map<string, string> }> {
  const { context } = input;
  const verdicts = readDispatchVerdicts(context.dispatchFile);
  const activeTaskIds = new Set(
    input.records.filter((record) => record.state !== "complete").map((record) => record.taskId),
  );

  const queue: QueuedView[] = [];
  const queueFailures = new Map<string, string>();

  for (const resolved of context.resolvedSources()) {
    const handle = context.openHandle(resolved);
    if (handle === undefined) {
      continue;
    }

    let tasks: Task[];
    try {
      // eslint-disable-next-line no-await-in-loop -- sources are listed in order for a stable queue
      tasks = await handle.list();
    } catch (error) {
      queueFailures.set(resolved.name, error instanceof Error ? error.message : String(error));
      continue;
    }

    for (const task of tasks) {
      const taskId = `${resolved.name}:${task.id}`;
      if (activeTaskIds.has(taskId) || task.terminal === true) {
        continue;
      }

      queue.push({
        taskId,
        title: task.title,
        blocked: task.blocked ?? false,
        verdict: verdicts[taskId],
      });
    }
  }

  return { queue, queueFailures };
}

function annotateQueueFailures(sources: SourceView[], failures: Map<string, string>): void {
  for (let index = 0; index < sources.length; index += 1) {
    const view = sources[index];
    if (view === undefined) {
      continue;
    }

    const reason = failures.get(view.name);
    if (reason !== undefined) {
      sources[index] = { ...view, queueUnavailable: reason };
    }
  }
}

/** Reads `dispatch.json` skip verdicts; a missing/invalid file yields none. */
export function readDispatchVerdicts(dispatchPath: string): Record<string, SkipVerdict> {
  try {
    const parsed = dispatchFileSchema.safeParse(JSON.parse(fs.readFileSync(dispatchPath, "utf8")));
    return parsed.success ? parsed.data.verdicts : {};
  } catch {
    return {};
  }
}
