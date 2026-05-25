/**
 * Zod schema for the Linear adapter's per-source config block. Minimal in MVP-2:
 * the global `linear.projects` field (validated in config.ts) is the source of
 * truth for which projects to watch and their per-project status names. A
 * future refactor can move `projects` into this block to enable multi-workspace
 * Linear (one adapter per API key), but that's V1.5+ scope.
 */

import { z } from "zod";

export const linearAdapterConfigSchema = z.object({
  kind: z.literal("linear"),
  name: z
    .string()
    .regex(/^[a-z][a-z0-9-]*$/, "name must be kebab-case (lowercase letters, digits, hyphens)")
    .optional(),
  view: z
    .object({
      url: z.url(),
    })
    .strict()
    .optional(),
});

export type LinearAdapterConfig = z.infer<typeof linearAdapterConfigSchema>;
