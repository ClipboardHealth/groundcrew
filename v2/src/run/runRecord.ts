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

import { ForeignRunRecordError, RunNotFoundError } from "./errors.js";

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

/** A file in the runs directory that is not a v2 run record (contracts §3.1). */
export interface ForeignRunRecord {
  readonly path: string;
  /** Short human reason (e.g. "not valid JSON", "unknown version", "missing/invalid fields"). */
  readonly reason: string;
}

type Classification =
  | { readonly kind: "record"; readonly record: RunRecord }
  | { readonly kind: "foreign"; readonly reason: string };

/**
 * Classify raw file contents as a v2 run record or foreign state. Never throws:
 * unparseable JSON, an unsupported version, or any schema violation is
 * "foreign" (most often live v1 state that v2 must tolerate, not crash on).
 */
function classify(raw: string): Classification {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "foreign", reason: "not valid JSON" };
  }

  const result = runRecordSchema.safeParse(parsed);
  if (result.success) {
    return { kind: "record", record: result.data };
  }

  return { kind: "foreign", reason: foreignReason(parsed) };
}

/** A one-liner distinguishing a version mismatch from a shape mismatch. */
function foreignReason(parsed: unknown): string {
  const probe = z.object({ version: z.number() }).safeParse(parsed);
  if (probe.success && probe.data.version !== RUN_RECORD_VERSION) {
    return `unknown version ${String(probe.data.version)}`;
  }

  return "missing/invalid fields";
}

/**
 * Reads and validates a record. Throws `RunNotFoundError` when absent and
 * `ForeignRunRecordError` (a clean one-liner, never raw zod issues) when the
 * file is present but is not a v2 run record.
 */
export async function readRunRecord(input: { path: string }): Promise<RunRecord> {
  let raw: string;
  try {
    raw = await fs.readFile(input.path, "utf8");
  } catch {
    throw new RunNotFoundError(input.path);
  }

  const classified = classify(raw);
  if (classified.kind === "foreign") {
    throw new ForeignRunRecordError(input.path, classified.reason);
  }

  return classified.record;
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

/**
 * One tolerant scan of `<stateRoot>/runs/`, splitting readable v2 records from
 * foreign files (v1 state, junk). Neither list ever throws on a bad file —
 * foreign files are classified and set aside, never surfaced as zod issues.
 */
async function scanRunsDirectory(input: {
  stateRoot: string;
}): Promise<{ records: RunRecord[]; foreign: ForeignRunRecord[] }> {
  const directory = runsDirectory({ stateRoot: input.stateRoot });
  let entries: string[];
  try {
    entries = await fs.readdir(directory);
  } catch {
    return { records: [], foreign: [] };
  }

  const files = entries.filter((entry) => entry.endsWith(".json")).toSorted();
  const records: RunRecord[] = [];
  const foreign: ForeignRunRecord[] = [];
  for (const file of files) {
    const recordPath = path.join(directory, file);
    let raw: string;
    try {
      // eslint-disable-next-line no-await-in-loop -- small, ordered, filesystem-bound read
      raw = await fs.readFile(recordPath, "utf8");
    } catch {
      continue; // vanished between readdir and read
    }

    const classified = classify(raw);
    if (classified.kind === "record") {
      records.push(classified.record);
    } else {
      foreign.push({ path: recordPath, reason: classified.reason });
    }
  }

  return { records, foreign };
}

/** All readable v2 run records under `<stateRoot>/runs/`, sorted by task slug. */
export async function listRunRecords(input: { stateRoot: string }): Promise<RunRecord[]> {
  return (await scanRunsDirectory(input)).records;
}

/**
 * Files in the runs directory that are not v2 run records — surfaced as
 * `{ path, reason }` metadata (contracts §3.1), never as thrown errors, so
 * callers (doctor) can note them and everything else can skip them.
 */
export async function listForeignRunRecords(input: {
  stateRoot: string;
}): Promise<ForeignRunRecord[]> {
  return (await scanRunsDirectory(input)).foreign;
}

function randomSuffix(): string {
  return Math.random().toString(16).slice(2, 10);
}
