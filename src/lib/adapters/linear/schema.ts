/**
 * Zod schema for the Linear adapter's per-source config block. The built-in
 * Linear adapter is implicit and derives scope from the API key's viewer plus
 * `agent-*` labels, so the source config only needs an optional display name.
 */

import { z } from "zod";

export const linearAdapterConfigSchema = z.object({
  kind: z.literal("linear"),
  name: z
    .string()
    .regex(/^[a-z][a-z0-9-]*$/, "name must be kebab-case (lowercase letters, digits, hyphens)")
    .optional(),
});

export type LinearAdapterConfig = z.infer<typeof linearAdapterConfigSchema>;
