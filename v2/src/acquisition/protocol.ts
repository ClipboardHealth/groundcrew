/**
 * The source-protocol contract seam (spec §9.3): the wire shapes that cross the
 * source process boundary. Acquisition owns these; every other module speaks to
 * sources through {@link SourceHandle}, never these raw shapes.
 *
 * The boundary is result-shaped on ONE channel (contracts §4.2, design §12.1):
 * a source emits `{ ok: true, data }` or `{ ok: false, error: { message } }` on
 * stdout. The adapter in `openSource.ts` is the single seam that turns that
 * result — plus a nonzero exit, garbage stdout, a timeout, or a spawn failure —
 * into the module's internal model (plain values on success, a typed exception
 * on failure). No code above this module sees the result shape.
 */
import { z } from "zod";

/** Agent-reported artifact record (contracts §3.1/§4.4). */
export const artifactSchema = z.object({
  kind: z.string(),
  locator: z.string(),
  title: z.string().optional(),
  repo: z.string().optional(),
});

export type Artifact = z.infer<typeof artifactSchema>;

/** A unit of work a source offers, in the `list`/`get` protocol shape (contracts §4.3). */
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

export type Task = z.infer<typeof taskSchema>;

export const RUN_OUTCOMES = ["delivered", "failed", "stopped"] as const;
export const runOutcomeSchema = z.enum(RUN_OUTCOMES);
export type RunOutcome = z.infer<typeof runOutcomeSchema>;

/** The single writeback verb's events (contracts §4.4). `update(id, event)` carries one. */
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

export type WritebackEvent = z.infer<typeof writebackEventSchema>;

/**
 * The `update` result. A `claimed` event may be answered `rejected` where the
 * source arbitrates contention (contracts §4.2); this is a legitimate outcome,
 * not a protocol failure, so it rides the value channel rather than an exception.
 */
export const updateResultSchema = z.discriminatedUnion("result", [
  z.object({ result: z.literal("ok") }),
  z.object({ result: z.literal("rejected"), reason: z.string().optional() }),
]);

export type UpdateResult = z.infer<typeof updateResultSchema>;

/** The result envelope every source command emits on stdout (contracts §4.2). */
export const protocolEnvelopeSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), data: z.unknown() }),
  z.object({ ok: z.literal(false), error: z.object({ message: z.string() }) }),
]);

export type ProtocolEnvelope = z.infer<typeof protocolEnvelopeSchema>;

/** `list` → the ready/queued view (contracts §4.2). */
export const listDataSchema = z.object({ tasks: z.array(taskSchema) });
/** `get` → one task by id (contracts §4.2). */
export const getDataSchema = z.object({ task: taskSchema });

/** The three protocol commands a source bundle may expose. */
export const SOURCE_COMMANDS = ["list", "get", "update"] as const;
export type SourceCommand = (typeof SOURCE_COMMANDS)[number];
