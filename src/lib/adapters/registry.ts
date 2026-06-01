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
 * Production registry. Initialised at module load by scanning `src/lib/adapters/`.
 */
export const adapterRegistry: Promise<Record<string, AdapterDefinition>> = buildRegistry(
  listAdapterDirectories(here),
  defaultImportLoader,
);
