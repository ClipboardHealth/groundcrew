/**
 * Built-in adapter registry — enumerates `src/lib/adapters/*` at startup and
 * builds a `Record<kind, AdapterDefinition>` plus the Zod discriminated union
 * for `SourceConfig`.
 *
 * `buildRegistry` is the pure logic (takes a directory-name list + a loader);
 * `adapterRegistry` is the production IIFE that points at the on-disk
 * `src/lib/adapters/` tree via `import.meta.dirname` + dynamic `import()`.
 * Path resolution lets the same code work in dev (tsx → `src/lib/adapters/*.ts`)
 * and prod (built → `dist/lib/adapters/*.js`).
 */

import { readdirSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

import type { AdapterDefinition } from "../adapterDefinition.ts";

import { discoverTaskSourceManifests, type DiscoveredManifest } from "./shell/discovery.ts";
import { manifestAdapter } from "./shell/manifestAdapter.ts";

export type AdapterLoader = (directoryName: string) => Promise<AdapterDefinition>;

/**
 * Pure logic: given a list of subdirectory names and an async loader, build a
 * `kind → AdapterDefinition` registry. Enforces directory-name === kind and
 * rejects duplicate kinds. No filesystem or import side effects of its own.
 */
export async function buildRegistry(
  directoryNames: readonly string[],
  loader: AdapterLoader,
): Promise<Record<string, AdapterDefinition>> {
  const registry: Record<string, AdapterDefinition> = {};
  for (const name of directoryNames) {
    // oxlint-disable-next-line no-await-in-loop -- adapter loading is sequential by design
    const def = await loader(name);
    if (def.kind !== name) {
      throw new Error(
        `Adapter directory mismatch: ${name}/index.ts exports kind="${def.kind}". Directory name and kind must match.`,
      );
    }
    if (registry[def.kind]) {
      throw new Error(`Duplicate adapter kind: "${def.kind}"`);
    }
    registry[def.kind] = def;
  }
  return registry;
}

/**
 * Build the Zod schema for `SourceConfig` from a registry.
 * - 0 adapters → `z.never()` so any config is rejected (defensive — should
 *   not occur in practice because the built-in linear and shell adapters
 *   are always present).
 * - 1 adapter → that adapter's schema directly.
 * - 2+ adapters → `z.union(...)` over each adapter's schema. We use `z.union`
 *   rather than `z.discriminatedUnion` so we don't have to convince the type
 *   system that every adapter's configSchema is a discriminable type —
 *   semantically equivalent here because each kind has a unique literal.
 */
export function buildSourceConfigSchema(registry: Record<string, AdapterDefinition>): z.ZodType {
  const schemas = Object.values(registry).map((a) => a.configSchema);
  const [first, second, ...rest] = schemas;
  if (first === undefined) {
    return z.never();
  }
  if (second === undefined) {
    return first;
  }
  // z.union (rather than z.discriminatedUnion) so we don't have to convince
  // the type system that every adapter's configSchema is a discriminable type
  // — semantically equivalent here because each kind has a unique literal.
  return z.union([first, second, ...rest]);
}

/**
 * Fold discovered manifest sources into a code-adapter registry. Each becomes
 * an adapter keyed by its manifest name. A manifest may not shadow a built-in
 * code-adapter kind (`linear`, `shell`, `todo-txt`) - those are reserved, so a
 * collision is a hard error. Manifest-vs-manifest precedence (user over
 * package) is already resolved by discovery, so `discovered` has no duplicates.
 */
export function mergeManifestAdapters(
  codeRegistry: Record<string, AdapterDefinition>,
  discovered: readonly DiscoveredManifest[],
): Record<string, AdapterDefinition> {
  const merged: Record<string, AdapterDefinition> = { ...codeRegistry };
  for (const { manifest, manifestDir } of discovered) {
    if (codeRegistry[manifest.name]) {
      throw new Error(
        `Task source "${manifest.name}" collides with the built-in "${manifest.name}" adapter. Rename the source manifest.`,
      );
    }
    merged[manifest.name] = manifestAdapter(manifest, manifestDir);
  }
  return merged;
}

const here = import.meta.dirname;

async function defaultImportLoader(directoryName: string): Promise<AdapterDefinition> {
  // Resolve relative to this module's directory. tsx maps `.js` → `.ts` in dev;
  // prod Node ESM resolves the actual `.js` file.
  const modulePath = path.resolve(here, directoryName, "index.js");
  // oxlint-disable-next-line typescript/no-unsafe-assignment -- dynamic import return type is `any`; adapter contract is enforced by buildRegistry
  const mod: { default: AdapterDefinition } = await import(modulePath);
  return mod.default;
}

export function listAdapterDirectories(baseDir: string): string[] {
  const names: string[] = [];
  for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      names.push(entry.name);
    }
  }
  return names;
}

/**
 * Production registry. Scans `src/lib/adapters/` for code adapters, then folds
 * in the manifest sources discovered under the package + user task-sources roots.
 */
export const adapterRegistry: Promise<Record<string, AdapterDefinition>> = buildRegistry(
  listAdapterDirectories(here),
  defaultImportLoader,
).then((codeRegistry) => mergeManifestAdapters(codeRegistry, discoverTaskSourceManifests()));
