/**
 * Dispatches a `SourceConfig[]` (typed as `unknown[]` at this boundary because
 * Zod will validate each entry) into `TaskSource[]` via the runtime adapter
 * registry. The two-function shape lets tests target `buildSourcesWith` with a
 * fake registry, while production code calls `buildSources` which awaits the
 * directory-scanned `adapterRegistry`.
 */

import { z } from "zod";

import type { AdapterContext, AdapterDefinition } from "./adapterDefinition.ts";
import { adapterRegistry } from "./adapters/registry.ts";
import type { ResolvedConfig } from "./config.ts";
import type { TaskSource } from "./taskSource.ts";

export const kindShape = z.object({ kind: z.string() });

/**
 * Production entry point. Awaits the directory-scanned registry, then dispatches.
 */
export async function buildSources(
  rawConfigs: readonly unknown[],
  context: AdapterContext,
): Promise<TaskSource[]> {
  const registry = await adapterRegistry;
  return buildSourcesWith(registry, rawConfigs, context);
}

/**
 * Pure dispatcher: caller supplies the registry directly. No filesystem or
 * import side effects.
 */
export function buildSourcesWith(
  registry: Record<string, AdapterDefinition>,
  rawConfigs: readonly unknown[],
  context: AdapterContext,
): TaskSource[] {
  return rawConfigs.map((raw) => {
    // First narrow to extract `kind` so we know which adapter to dispatch to.
    const { kind } = kindShape.parse(raw);
    const adapter = registry[kind];
    if (!adapter) {
      throw new Error(
        `Unknown source kind "${kind}". Registered: ${Object.keys(registry).join(", ") || "(none)"}`,
      );
    }
    // Now validate the full config via the matching adapter's schema.
    const config: unknown = adapter.configSchema.parse(raw);
    return adapter.create(config, context);
  });
}

const sourceShape = z.looseObject({
  name: z.string().optional(),
  kind: z.string().optional(),
  enabled: z.boolean().optional(),
});

/**
 * Read the structural `name` / `kind` / `enabled` fields off a raw source.
 * `looseObject()` with all-optional fields only fails to parse non-object
 * inputs (null, primitives); those are rejected downstream by the per-adapter
 * Zod schema in buildSourcesWith, so we treat a non-object entry as an empty
 * field set ("no opinion") rather than branching on it at every call site.
 */
function sourceFields(raw: unknown): z.infer<typeof sourceShape> {
  const parsed = sourceShape.safeParse(raw);
  /* v8 ignore next 3 @preserve -- non-object inputs never reach here in practice (see above); the guard exists only for type-narrowing. */
  if (!parsed.success) {
    return {};
  }
  return parsed.data;
}

/**
 * True when `raw` carries the opt-out sentinel `enabled: false`. Used to drop
 * a source the user explicitly disabled — most importantly a
 * `{ kind: "linear", enabled: false }` entry — so its adapter is never
 * constructed.
 */
function isSourceDisabled(raw: unknown): boolean {
  return sourceFields(raw).enabled === false;
}

/**
 * True when `raw` declares `kind: "linear"`, regardless of `name` or `enabled`.
 * Used by `isLinearEnabled` to detect explicitly configured Linear sources.
 */
function isLinearKindSource(raw: unknown): boolean {
  return sourceFields(raw).kind === "linear";
}

/**
 * Build the runtime source list from a ResolvedConfig: returns the enabled
 * entries from `config.sources`. Any source with `enabled: false` is dropped.
 * Returns an empty array when no sources are configured — callers are
 * responsible for detecting that state and guiding the user.
 */
export function sourcesFromConfig(config: ResolvedConfig): readonly unknown[] {
  return config.sources.filter((source) => !isSourceDisabled(source));
}

/**
 * True when an enabled source explicitly declares `kind: "linear"`. Callers
 * use this to skip Linear API calls (and the missing-API-key error they raise)
 * when Linear is not configured.
 */
export function isLinearEnabled(config: ResolvedConfig): boolean {
  return sourcesFromConfig(config).some(isLinearKindSource);
}
