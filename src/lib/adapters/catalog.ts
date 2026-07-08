/**
 * Unified task-source catalog: one descriptor list over every enable-by-kind
 * source, built-in code adapters (`linear`, `todo-txt`) and discovered manifest
 * sources (`jira`, ...) alike. Only the descriptive layer is unified; execution
 * stays per-adapter (a code adapter is not reimplemented as a shell manifest).
 *
 * Lives above `registry.ts` and `discovery.ts` and imports the registry
 * one-directionally, so putting `listTaskSources` here (rather than in
 * `discovery.ts`, which `registry.ts` already imports) keeps the module graph a
 * DAG. crew-config calls this to enumerate installable sources instead of
 * hardcoding presets.
 */

import type { AdapterDefinition, AdapterOrigin } from "../adapterDefinition.ts";

import { adapterRegistry } from "./registry.ts";

/**
 * One row of the source catalog. `requiresCredentials` is always concrete (an
 * adapter's optional `meta.requiresCredentials` defaults to `false`) so callers
 * never branch on `undefined`.
 */
export interface TaskSourceCatalogEntry {
  readonly name: string;
  readonly description: string;
  readonly origin: AdapterOrigin;
  readonly requiresCredentials: boolean;
}

/**
 * Pure projection of a merged registry into catalog rows. Adapters without
 * `meta`, and the generic `shell` template (`meta.template`), are excluded; the
 * template is a bring-your-own-scripts escape hatch, not an installable source.
 */
export function catalogFromRegistry(
  registry: Record<string, AdapterDefinition>,
): TaskSourceCatalogEntry[] {
  const entries: TaskSourceCatalogEntry[] = [];
  for (const adapter of Object.values(registry)) {
    const { meta } = adapter;
    if (meta === undefined || meta.template === true) {
      continue;
    }
    entries.push({
      name: adapter.kind,
      description: meta.description,
      origin: meta.origin,
      requiresCredentials: meta.requiresCredentials ?? false,
    });
  }
  return entries;
}

/**
 * The production catalog: awaits the merged adapter registry (code adapters plus
 * discovered manifest sources) and projects it into catalog rows.
 */
export async function listTaskSources(): Promise<TaskSourceCatalogEntry[]> {
  const registry = await adapterRegistry;
  return catalogFromRegistry(registry);
}
