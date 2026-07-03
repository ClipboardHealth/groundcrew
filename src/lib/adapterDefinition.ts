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

/**
 * Where an adapter came from. A superset of a manifest's `ManifestOrigin`
 * (`package | user`, see `./adapters/shell/discovery.ts`): code adapters shipped
 * in this package are `builtin`, discovered manifests are `package` (bundled) or
 * `user` (installed under `~/.config/groundcrew/task-sources`).
 */
export type AdapterOrigin = "builtin" | "package" | "user";

/**
 * Descriptive metadata that lets the unified catalog (`./adapters/catalog.ts`)
 * list every enable-by-kind source uniformly, whatever its runtime. Purely the
 * descriptor layer; execution stays per-adapter. The generic `shell` adapter
 * sets `template: true` so it is excluded from the catalog (it is a
 * bring-your-own-scripts escape hatch, not an installable source).
 */
export interface AdapterMeta {
  /** One-line human summary shown when enumerating installable sources. */
  readonly description: string;
  /** True when enabling the source needs a secret/token (e.g. an API key). */
  readonly requiresCredentials?: boolean;
  /** True for the generic `shell` escape hatch; excluded from the catalog. */
  readonly template?: boolean;
  /** Provenance of the adapter. */
  readonly origin: AdapterOrigin;
}

export interface AdapterDefinition<TSchema extends z.ZodType = z.ZodType> {
  /** Discriminator value used in `SourceConfig.kind`. Must equal the directory name. */
  readonly kind: string;
  /** Zod schema for this adapter's config block. The `kind` field must be `z.literal(kind)`. */
  readonly configSchema: TSchema;
  /** Builds a TaskSource from a validated config and the shared adapter context. */
  readonly create: (config: z.infer<TSchema>, context: AdapterContext) => TaskSource;
  /**
   * Optional descriptive metadata for the unified source catalog. Every
   * built-in and manifest adapter sets it; an adapter without `meta` is simply
   * absent from `listTaskSources()`.
   */
  readonly meta?: AdapterMeta;
}
