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

const kindShape = z.object({ kind: z.string() });

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
 * This is what lets the `{ kind: "linear", enabled: false }` opt-out suppress
 * the implicit Linear source even though the entry itself is filtered out.
 */
function isLinearKindSource(raw: unknown): boolean {
  return sourceFields(raw).kind === "linear";
}

/**
 * True when `raw` is an explicitly-declared Linear source. Matches either a
 * `kind: "linear"` entry — regardless of any `name` override — or any entry
 * whose resolved runtime name (explicit `name`, else `kind`) is "linear".
 * The latter catches a non-Linear adapter the user named "linear", which
 * would otherwise collide with the implicit Linear source.
 *
 * Used to suppress the synthesized implicit Linear source so a renamed Linear
 * entry like `{ kind: "linear", name: "custom" }` doesn't spawn a duplicate
 * adapter pointed at the same viewer. Returns false for malformed entries
 * (no `kind`/`name`) — those get rejected by the per-adapter Zod schema
 * downstream.
 */
function isExplicitLinearSource(raw: unknown): boolean {
  const { kind, name } = sourceFields(raw);
  return kind === "linear" || (name ?? kind) === "linear";
}

/**
 * Build the runtime source list from a ResolvedConfig: synthesizes the
 * implicit Linear source (Linear is always active under the post-#110
 * model — viewer + agent-* label filtering happens at the GraphQL layer)
 * and appends any user-declared `sources`. The implicit source is omitted
 * when the user already declared a Linear source — by `kind: "linear"`, or by
 * a surviving (non-disabled) source whose runtime name is "linear" — so they
 * can override its `name` / construction without spawning a duplicate adapter.
 *
 * Users opt out of Linear entirely with the sentinel
 * `{ kind: "linear", enabled: false }`: it still counts as an explicit Linear
 * declaration (so the implicit source is suppressed) and is itself filtered
 * out (so no Linear adapter is constructed and no API key is required). Any
 * other source with `enabled: false` is likewise dropped from the result.
 */
export function sourcesFromConfig(config: ResolvedConfig): readonly unknown[] {
  const kept = config.sources.filter((source) => !isSourceDisabled(source));
  // A `kind: "linear"` entry suppresses the implicit source even when it is the
  // disabled opt-out sentinel — it's removed from `kept` above, leaving Linear
  // off entirely. A source that's Linear only by *name* (e.g. a shell source
  // named "linear") suppresses the implicit source only while it survives the
  // filter, so disabling such an entry doesn't silently drop Linear.
  const hasExplicitLinear =
    config.sources.some(isLinearKindSource) || kept.some(isExplicitLinearSource);
  if (hasExplicitLinear) {
    return kept;
  }
  return [{ kind: "linear" }, ...kept];
}
