/**
 * Zod schemas for the shell adapter:
 *
 * - `ShellIssue` — the JSON shape a `commands.fetch` / `commands.resolveOne`
 *   script must emit on stdout. Mirrors the canonical `Issue` shape but with
 *   nullable `repository`/`agent` (scripts use `null` rather than omitting)
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
  statusReason: z.enum(["missing", "unmapped"]).optional(),
  nativeStatus: z.string().optional(),
});

export const shellIssueSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  status: canonicalStatusSchema,
  repository: z.string().nullable(),
  agent: z.string().nullable(),
  assignee: z.string(),
  updatedAt: z.string(),
  blockers: z.array(shellBlockerSchema),
  hasMoreBlockers: z.boolean().optional().default(false),
  /**
   * Direct web URL for the task. Optional so scripts can omit it without
   * breaking; `crew status` falls back to displaying just the id.
   */
  url: z.url().optional(),
  sourceRef: z.unknown(),
});

export type ShellIssue = z.infer<typeof shellIssueSchema>;

export const shellFetchOutputSchema = z.array(shellIssueSchema);

/**
 * Shape a `commands.validate` script must emit on stdout: a JSON array of
 * human-readable error strings. An empty array (or empty stdout, handled by
 * the factory) means "no problems found".
 */
export const shellValidateOutputSchema = z.array(z.string());

export const shellAdapterConfigSchema = z.object({
  kind: z.literal("shell"),
  name: z
    .string()
    .regex(/^[a-z][a-z0-9-]*$/, "name must be kebab-case (lowercase letters, digits, hyphens)"),
  /**
   * Local directories the sandbox opens for **read + write** while an agent
   * works a task owned by this source. When the task id is source-qualified
   * (a `<source>:` prefix), the grant is scoped to that source, so a task from
   * another source does not receive these paths; an unqualified task id grants
   * every eligible source's declared paths. `~` expands at config load. Use for
   * an external task store the agent must read and update in place (e.g. a
   * plan-keeper `~/plans` tree).
   */
  sandboxWritePaths: z
    .array(z.string().min(1, "sandboxWritePaths entries must be non-empty"))
    .optional(),
  commands: z
    .object({
      verify: z.string().optional(),
      /** Preferred name. Alias: `fetch`. */
      listTasks: z.string().optional(),
      /** Legacy alias for `listTasks`. Prefer `listTasks` in new configs. */
      fetch: z.string().optional(),
      /** Preferred name. Alias: `resolveOne`. */
      getTask: z.string().optional(),
      /** Legacy alias for `getTask`. Prefer `getTask` in new configs. */
      resolveOne: z.string().optional(),
      markInProgress: z.string().optional(),
      markInReview: z.string().optional(),
      markDone: z.string().optional(),
      /**
       * Create a task from a `CreateTaskInput`. Receives the input fields as
       * shell-quoted `${...}` placeholders (see factory) and must print one
       * ShellIssue JSON on stdout. Omitting it leaves the source unable to
       * create tasks.
       */
      createTask: z.string().optional(),
      /**
       * Validate task content. Must print a JSON array of error strings on
       * stdout (empty array / empty stdout = no problems). Omitting it leaves
       * the source unable to validate.
       */
      validate: z.string().optional(),
    })
    .superRefine((commands, ctx) => {
      if (commands.listTasks === undefined && commands.fetch === undefined) {
        ctx.addIssue({
          code: "custom",
          message: "commands.listTasks (or the legacy alias commands.fetch) is required",
        });
      }
    }),
  cwd: z.string().optional(),
  timeouts: z
    .object({
      // Per-method timeout in milliseconds. Must be a positive integer —
      // zero, negative, and fractional values would either deadlock or
      // misbehave inside setTimeout.
      verify: z.number().int().positive().optional(),
      /** Timeout for the listTasks command (preferred). */
      listTasks: z.number().int().positive().optional(),
      /** Legacy timeout alias for listTasks. Prefer `listTasks` in new configs. */
      fetch: z.number().int().positive().optional(),
      /** Timeout for the getTask command (preferred). */
      getTask: z.number().int().positive().optional(),
      /** Legacy timeout alias for getTask. Prefer `getTask` in new configs. */
      resolveOne: z.number().int().positive().optional(),
      markInProgress: z.number().int().positive().optional(),
      markInReview: z.number().int().positive().optional(),
      markDone: z.number().int().positive().optional(),
      /** Timeout for the createTask command. */
      createTask: z.number().int().positive().optional(),
      /** Timeout for the validate command. */
      validate: z.number().int().positive().optional(),
    })
    .optional(),
  env: z.record(z.string(), z.string()).optional(),
});

export type ShellAdapterConfig = z.infer<typeof shellAdapterConfigSchema>;
