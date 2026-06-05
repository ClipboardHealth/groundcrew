/**
 * Zod schema for the Linear adapter's per-source config block. The built-in
 * Linear adapter is implicit and derives scope from the API key's viewer plus
 * `agent-*` labels. Source config is only needed to override display name or
 * Linear status names that disambiguate multiple `started` workflow states.
 */

import { z } from "zod";

const statusNamesSchema = z.array(z.string().trim().min(1)).min(1);

export const linearAdapterConfigSchema = z.object({
  kind: z.literal("linear"),
  name: z
    .string()
    .regex(/^[a-z][a-z0-9-]*$/, "name must be kebab-case (lowercase letters, digits, hyphens)")
    .optional(),
  statuses: z
    .object({
      inProgress: statusNamesSchema.optional(),
      inReview: statusNamesSchema.optional(),
    })
    .optional(),
});

export type LinearAdapterConfig = z.infer<typeof linearAdapterConfigSchema>;
