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
 * implicit Linear source (Linear is always active under the post-#110
 * model — viewer + agent-* label filtering happens at the GraphQL layer)
 * and appends any user-declared `sources`. The implicit source is omitted
 * when the user already declared one with runtime name "linear" so they
 * can override its `name` / construction without colliding.
 */
export function sourcesFromConfig(config: ResolvedConfig): readonly unknown[] {
  const hasExplicitLinear = config.sources.some(
    (source) => effectiveSourceName(source) === "linear",
  );
  if (hasExplicitLinear) {
    return [...config.sources];
  }
  return [{ kind: "linear" }, ...config.sources];
}
