/**
 * Zod schemas mirroring the pinned cross-module contracts (contracts §3–§4).
 *
 * The e2e suite is black-box: it never imports the implementation's schemas.
 * These are an independent transcription of the contract document, and the
 * suite validates every state file and protocol message it reads against them.
 * A drift between these shapes and what `crew` emits is a contract violation,
 * surfaced as a parse failure at the assertion point.
 */

import { z } from "zod";

/** ISO-8601 timestamp in UTC (trailing `Z`), used across state files and logs. */
export const isoUtcTimestamp = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u,
    "expected an ISO-8601 UTC timestamp ending in Z",
  );

// --- Source protocol (contracts §4) ---------------------------------------

/** Agent-reported artifact record (contracts §3.1/§4.4). */
export const artifactSchema = z.object({
  kind: z.string(),
  locator: z.string(),
  title: z.string().optional(),
  repo: z.string().optional(),
});

/** Task shape returned by a source's `list`/`get` (contracts §4.3). */
export const taskSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  priority: z.number().optional(),
  blocked: z.boolean().optional(),
  agent: z.string().optional(),
  repos: z.array(z.string()).optional(),
  terminal: z.boolean().optional(),
});

export const runOutcomeSchema = z.enum(["delivered", "failed", "stopped"]);

/** Writeback events a source's `update` receives (contracts §4.4). */
export const writebackEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("claimed"), runId: z.string() }),
  z.object({ type: z.literal("progress"), note: z.string() }),
  z.object({
    type: z.literal("completed"),
    outcome: runOutcomeSchema,
    artifacts: z.array(artifactSchema).optional(),
    message: z.string().optional(),
  }),
]);

/** Result-shaped protocol response on stdout (contracts §4.2). */
export function protocolResultSchema<Data extends z.ZodType>(data: Data) {
  return z.union([
    z.object({ ok: z.literal(true), data }),
    z.object({ ok: z.literal(false), error: z.object({ message: z.string() }) }),
  ]);
}

export const listDataSchema = z.object({ tasks: z.array(taskSchema) });
export const getDataSchema = z.object({ task: taskSchema });
export const updateDataSchema = z.union([
  z.object({ result: z.literal("ok") }),
  z.object({ result: z.literal("rejected"), reason: z.string().optional() }),
]);

// --- State files (contracts §3) --------------------------------------------

export const runStateSchema = z.enum([
  "provisioning",
  "running",
  "paused",
  "complete",
]);

/** Run record — `runs/<taskSlug>.json` (contracts §3.1). */
export const runRecordSchema = z.object({
  version: z.literal(1),
  taskId: z.string(),
  runId: z.string(),
  source: z.string(),
  agentProfile: z.string(),
  state: runStateSchema,
  outcome: runOutcomeSchema.optional(),
  reason: z.string().optional(),
  resumeCount: z.number(),
  sessionName: z.string(),
  sessionId: z.string().optional(),
  workspaceDirectory: z.string(),
  repos: z.array(z.string()),
  artifacts: z.array(artifactSchema),
  events: z.array(
    z.object({
      ts: isoUtcTimestamp,
      event: z.string(),
      detail: z.string().optional(),
    }),
  ),
});

/** Workspace marker — `.groundcrew/task.json` (contracts §3.2). */
export const workspaceMarkerSchema = z.object({
  version: z.literal(1),
  taskId: z.string(),
  branch: z.string(),
  repos: z.array(z.string()),
});

export const skipReasonSchema = z.enum([
  "repo-not-on-disk",
  "slots-full",
  "claim-rejected",
  "ineligible",
]);

/** Dispatch verdicts — `dispatch.json` (contracts §3.3). */
export const dispatchVerdictsSchema = z.object({
  version: z.literal(1),
  verdicts: z.record(
    z.string(),
    z.object({
      skipReason: skipReasonSchema,
      detail: z.string().optional(),
      ts: isoUtcTimestamp,
    }),
  ),
});

export type Artifact = z.infer<typeof artifactSchema>;
export type Task = z.infer<typeof taskSchema>;
export type WritebackEvent = z.infer<typeof writebackEventSchema>;
export type RunRecord = z.infer<typeof runRecordSchema>;
export type WorkspaceMarker = z.infer<typeof workspaceMarkerSchema>;
export type DispatchVerdicts = z.infer<typeof dispatchVerdictsSchema>;
export type RunOutcome = z.infer<typeof runOutcomeSchema>;
export type SkipReason = z.infer<typeof skipReasonSchema>;
