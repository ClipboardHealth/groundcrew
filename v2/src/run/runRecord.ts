/**
 * The run record (contracts §3.1): the reported layer's truth on disk at
 * `<stateRoot>/runs/<taskSlug>.json`. The zod schema here reads and validates
 * records; the type is inferred from it so the implementation cannot drift from
 * the shape the e2e suite independently transcribes. Callers own slug
 * computation (spec §9.4: Run imports nothing else in src) and pass `taskSlug`.
 */
import * as fs from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { RunNotFoundError } from "./errors.js";

export const RUN_RECORD_VERSION = 1;

export const RUN_STATES = ["provisioning", "running", "paused", "complete"] as const;
export const RUN_OUTCOMES = ["delivered", "failed", "stopped"] as const;

const artifactSchema = z.object({
  kind: z.string(),
  locator: z.string(),
  title: z.string().optional(),
  repo: z.string().optional(),
});

const runEventSchema = z.object({
  ts: z.string(),
  event: z.string(),
  detail: z.string().optional(),
});

export const runRecordSchema = z.object({
  version: z.literal(1),
  taskId: z.string(),
  runId: z.string(),
  source: z.string(),
  agentProfile: z.string(),
  state: z.enum(RUN_STATES),
  outcome: z.enum(RUN_OUTCOMES).optional(),
  reason: z.string().optional(),
  resumeCount: z.number(),
  sessionName: z.string(),
  sessionId: z.string().optional(),
  workspaceDirectory: z.string(),
  repos: z.array(z.string()),
  artifacts: z.array(artifactSchema),
  events: z.array(runEventSchema),
});

export type Artifact = z.infer<typeof artifactSchema>;
export type RunEvent = z.infer<typeof runEventSchema>;
export type RunRecord = z.infer<typeof runRecordSchema>;
export type RunState = (typeof RUN_STATES)[number];
export type RunOutcome = (typeof RUN_OUTCOMES)[number];

export function runsDirectory(input: { stateRoot: string }): string {
  return path.join(input.stateRoot, "runs");
}

export function runRecordPath(input: { stateRoot: string; taskSlug: string }): string {
  return path.join(runsDirectory({ stateRoot: input.stateRoot }), `${input.taskSlug}.json`);
}

/** Atomic write: serialize to a sibling temp file, then rename over the target. */
export async function writeRunRecord(input: {
  path: string;
  record: RunRecord;
}): Promise<void> {
  await fs.mkdir(path.dirname(input.path), { recursive: true });
  const temporaryPath = `${input.path}.${String(process.pid)}.${randomSuffix()}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(input.record, undefined, 2)}\n`, {
    mode: 0o600,
  });
  await fs.rename(temporaryPath, input.path);
}

/** Reads and validates a record; throws `RunNotFoundError` when absent. */
export async function readRunRecord(input: { path: string }): Promise<RunRecord> {
  let raw: string;
  try {
    raw = await fs.readFile(input.path, "utf8");
  } catch {
    throw new RunNotFoundError(input.path);
  }

  return runRecordSchema.parse(JSON.parse(raw));
}

export async function runRecordExists(input: { path: string }): Promise<boolean> {
  try {
    await fs.access(input.path);
    return true;
  } catch {
    return false;
  }
}

export async function deleteRunRecord(input: { path: string }): Promise<void> {
  await fs.rm(input.path, { force: true });
}

/** All readable run records under `<stateRoot>/runs/`, sorted by task slug. */
export async function listRunRecords(input: { stateRoot: string }): Promise<RunRecord[]> {
  const directory = runsDirectory({ stateRoot: input.stateRoot });
  let entries: string[];
  try {
    entries = await fs.readdir(directory);
  } catch {
    return [];
  }

  const files = entries.filter((entry) => entry.endsWith(".json")).toSorted();
  const records: RunRecord[] = [];
  for (const file of files) {
    // eslint-disable-next-line no-await-in-loop -- small, ordered, filesystem-bound read
    const record = await readRunRecord({ path: path.join(directory, file) });
    records.push(record);
  }

  return records;
}

function randomSuffix(): string {
  return Math.random().toString(16).slice(2, 10);
}
