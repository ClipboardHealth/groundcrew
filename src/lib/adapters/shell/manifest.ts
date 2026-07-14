/**
 * `SourceManifest` describes a packaged task source's `source.json` (for
 * example `task-sources/jira/source.json`). It is the install-time contract
 * between whoever ships a source (groundcrew itself, or an external installer
 * that drops a bundle into `~/.config/groundcrew/task-sources`) and groundcrew,
 * which discovers manifests and exposes each as an enable-by-kind adapter.
 *
 * Deliberately separate from `ShellAdapterConfig` (the runtime config block in
 * `./schema.ts`): the manifest carries install-only fields (`installDir`,
 * `files`, `prerequisites`, `secrets`) and command templates whose script paths
 * are not yet installed. `shellConfigFromManifest` (see `./manifestAdapter.ts`)
 * bridges the two once the scripts are materialized.
 */

import { z } from "zod";

/**
 * A prerequisite's install hint. A plain string applies to every platform; an
 * object keys hints by Node's `process.platform` value (`darwin`, `linux`) so a
 * consumer can index by platform directly, with `default` as the fallback for
 * platforms without an explicit entry. Only crew-config reads this field, so the
 * per-OS shape stays JSON-serializable and an older crew-config that expects a
 * string simply shows no hint for the object form (a graceful degradation).
 */
const installSchema = z.union([
  z.string(),
  z.strictObject({
    darwin: z.string().optional(),
    linux: z.string().optional(),
    default: z.string().optional(),
  }),
]);

const prerequisiteSchema = z.strictObject({
  bin: z.string().min(1),
  install: installSchema.optional(),
  setup: z.string().optional(),
});

const secretSchema = z.strictObject({
  env: z.string().min(1),
  file: z.string().min(1),
  mode: z.string().optional(),
  url: z.string().optional(),
});

const commandsSchema = z.strictObject({
  verify: z.string().optional(),
  listTasks: z.string(),
  getTask: z.string().optional(),
  markInProgress: z.string().optional(),
  markInReview: z.string().optional(),
  markDone: z.string().optional(),
  createTask: z.string().optional(),
  validate: z.string().optional(),
});

/**
 * Per-command timeouts in milliseconds. Shared with the override schema in
 * `./manifestAdapter.ts` so a `{ kind }` entry can override manifest timeouts.
 */
export const manifestTimeoutsSchema = z.strictObject({
  verify: z.number().int().positive().optional(),
  listTasks: z.number().int().positive().optional(),
  getTask: z.number().int().positive().optional(),
  markInProgress: z.number().int().positive().optional(),
  markInReview: z.number().int().positive().optional(),
  markDone: z.number().int().positive().optional(),
  createTask: z.number().int().positive().optional(),
  validate: z.number().int().positive().optional(),
});

export const sourceManifestSchema = z.strictObject({
  name: z
    .string()
    .regex(/^[a-z][a-z0-9-]*$/, "name must be kebab-case (lowercase letters, digits, hyphens)"),
  kind: z.literal("shell"),
  description: z.string(),
  installDir: z.string().min(1),
  files: z.array(z.string().min(1)).default([]),
  prerequisites: z.array(prerequisiteSchema).optional(),
  secrets: z.array(secretSchema).optional(),
  env: z.record(z.string(), z.string()).optional(),
  commands: commandsSchema,
  timeouts: manifestTimeoutsSchema.optional(),
});

export type SourceManifest = z.infer<typeof sourceManifestSchema>;
