/**
 * Dispatches a `SourceConfig[]` (typed as `unknown[]` at this boundary because
 * Zod will validate each entry) into `TicketSource[]` via the runtime adapter
 * registry. The two-function shape lets tests target `buildSourcesWith` with a
 * fake registry, while production code calls `buildSources` which awaits the
 * directory-scanned `adapterRegistry`.
 */

import { z } from "zod";

import type { AdapterContext, AdapterDefinition } from "./adapterDefinition.ts";
import { adapterRegistry } from "./adapters/registry.ts";
import type { ResolvedConfig } from "./config.ts";
import type { TicketSource } from "./ticketSource.ts";

const kindShape = z.object({ kind: z.string() });

/**
 * Production entry point. Awaits the directory-scanned registry, then dispatches.
 */
export async function buildSources(
  rawConfigs: readonly unknown[],
  context: AdapterContext,
): Promise<TicketSource[]> {
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
): TicketSource[] {
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

/**
 * Returns the runtime source name a `config.sources[]` entry would resolve
 * to. Adapters default the name to their `kind` when `name` is omitted
 * (see `createLinearTicketSource`'s `config.name ?? "linear"`); explicit
 * `name` always wins. Returns `undefined` for malformed entries (no `kind`
 * at all) — those get rejected by the Zod schema downstream.
 */
const effectiveSourceNameShape = z.looseObject({
  name: z.string().optional(),
  kind: z.string().optional(),
});

function effectiveSourceName(raw: unknown): string | undefined {
  const parsed = effectiveSourceNameShape.safeParse(raw);
  /* v8 ignore next 3 @preserve -- looseObject() with all-optional fields only fails to parse non-object inputs (null, primitives); the same input would be rejected by the per-adapter Zod schema in buildSourcesWith, so this guard never fires in practice. */
  if (!parsed.success) {
    return undefined;
  }
  return parsed.data.name ?? parsed.data.kind;
}

/**
 * Build the runtime source list from a ResolvedConfig: synthesizes the
 * implicit linear source from `linear.projects` (when present) and appends
 * any user-declared `sources`. ResolvedConfig.sources stays exactly what
 * the user wrote — synthesis is a runtime concern.
 *
 * Throws when an explicit `sources[]` entry would resolve to runtime name
 * `"linear"`, which would collide with the implicit Linear source and
 * produce ambiguous canonical-id routing + duplicate writebacks.
 * (`createBoard` has a final-line duplicate-name guard, but catching the
 * collision here gives the user an actionable config-level error rather
 * than a runtime "duplicate source name" error from deep in the stack.)
 */
export function sourcesFromConfig(config: ResolvedConfig): readonly unknown[] {
  if (config.linear.projects.length === 0) {
    return [...config.sources];
  }
  const collision = config.sources.find((source) => effectiveSourceName(source) === "linear");
  if (collision !== undefined) {
    throw new Error(
      `sourcesFromConfig: config.sources contains an entry that resolves to source name "linear", which conflicts with the implicit Linear source synthesized from config.linear.projects. Either give the explicit entry a distinct \`name\` or empty config.linear.projects.`,
    );
  }
  return [{ kind: "linear" }, ...config.sources];
}
