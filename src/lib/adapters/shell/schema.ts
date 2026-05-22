/**
 * Zod schemas for the shell adapter:
 *
 * - `ShellIssue` — the JSON shape a `commands.fetch` / `commands.resolveOne`
 *   script must emit on stdout. Mirrors the canonical `Issue` shape but with
 *   nullable `repository`/`model` (scripts use `null` rather than omitting)
 *   and an optional `hasMoreBlockers` (defaults to `false`).
 * - `ShellAdapterConfig` — the per-source config block users declare in
 *   `crew.config.ts`'s `sources: [...]` array.
 */

import { z } from "zod";

const canonicalStatusSchema = z.enum(["todo", "in-progress", "in-review", "done", "other"]);

const shellBlockerSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: canonicalStatusSchema,
});

export const shellIssueSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  status: canonicalStatusSchema,
  repository: z.string().nullable(),
  model: z.string().nullable(),
  assignee: z.string(),
  updatedAt: z.string(),
  blockers: z.array(shellBlockerSchema),
  hasMoreBlockers: z.boolean().optional().default(false),
  sourceRef: z.unknown(),
});

export type ShellIssue = z.infer<typeof shellIssueSchema>;

export const shellFetchOutputSchema = z.array(shellIssueSchema);

export const shellAdapterConfigSchema = z.object({
  kind: z.literal("shell"),
  name: z
    .string()
    .regex(/^[a-z][a-z0-9-]*$/, "name must be kebab-case (lowercase letters, digits, hyphens)"),
  commands: z.object({
    verify: z.string().optional(),
    fetch: z.string(),
    resolveOne: z.string().optional(),
    markInProgress: z.string().optional(),
  }),
  cwd: z.string().optional(),
  timeouts: z
    .object({
      verify: z.number().optional(),
      fetch: z.number().optional(),
      resolveOne: z.number().optional(),
      markInProgress: z.number().optional(),
    })
    .optional(),
  env: z.record(z.string(), z.string()).optional(),
});

export type ShellAdapterConfig = z.infer<typeof shellAdapterConfigSchema>;
