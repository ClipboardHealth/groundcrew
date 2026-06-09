/**
 * Shared `AdapterDefinition` shape that every built-in adapter
 * (`src/lib/adapters/<kind>/index.ts`) default-exports. The runtime registry
 * (`./adapters/registry.ts`) discovers adapters by enumerating that
 * directory and reading each module's default export.
 */

import type { z } from "zod";

import type { ResolvedConfig } from "./config.ts";
import type { TaskSource } from "./taskSource.ts";

/**
 * Cross-cutting context every adapter receives at construction time. Holds
 * the global resolved config so adapters can read shared concerns (the
 * `workspace.knownRepositories` list, `agents.*` definitions, etc.) without
 * each one duplicating them in its per-source config block.
 */
export interface AdapterContext {
  readonly globalConfig: ResolvedConfig;
}

export interface AdapterDefinition<TSchema extends z.ZodType = z.ZodType> {
  /** Discriminator value used in `SourceConfig.kind`. Must equal the directory name. */
  readonly kind: string;
  /** Zod schema for this adapter's config block. The `kind` field must be `z.literal(kind)`. */
  readonly configSchema: TSchema;
  /** Builds a TaskSource from a validated config and the shared adapter context. */
  readonly create: (config: z.infer<TSchema>, context: AdapterContext) => TaskSource;
}
