/**
 * Discover task-source manifests from two roots: the sources bundled inside
 * this package (`<pkg>/task-sources`) and the user-installed sources under
 * `~/.config/groundcrew/task-sources`. Each `<dir>/source.json` is validated
 * and indexed by manifest name; a later root overrides an earlier one on a
 * name collision (user over package), recording a warning. The registry
 * (`../registry.ts`) turns each result into an enable-by-kind adapter.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { writeError } from "../../util.ts";
import { xdgConfigPath } from "../../xdg.ts";

import { sourceManifestSchema, type SourceManifest } from "./manifest.ts";

export type ManifestOrigin = "package" | "user";

export interface DiscoveredManifest {
  manifest: SourceManifest;
  manifestDir: string;
  origin: ManifestOrigin;
}

export interface ManifestRoot {
  dir: string;
  origin: ManifestOrigin;
}

export interface DiscoveryResult {
  manifests: DiscoveredManifest[];
  warnings: string[];
}

/** Sources bundled with this package, next to the built output in dev and prod. */
const PACKAGE_TASK_SOURCES_ROOT = path.resolve(import.meta.dirname, "../../../../task-sources");

/** Sources any external installer drops into the groundcrew config dir. */
export function userTaskSourcesRoot(): string {
  return xdgConfigPath("groundcrew", "task-sources");
}

export function discoverFromRoots(roots: readonly ManifestRoot[]): DiscoveryResult {
  const byName = new Map<string, DiscoveredManifest>();
  const warnings: string[] = [];

  for (const root of roots) {
    if (!existsSync(root.dir)) {
      continue;
    }
    for (const entry of readdirSync(root.dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const manifestDir = path.join(root.dir, entry.name);
      const manifestPath = path.join(manifestDir, "source.json");
      if (!existsSync(manifestPath)) {
        continue;
      }
      const manifest = sourceManifestSchema.parse(JSON.parse(readFileSync(manifestPath, "utf8")));
      const previous = byName.get(manifest.name);
      if (previous) {
        warnings.push(
          `Task source "${manifest.name}" from ${manifestDir} overrides the ${previous.origin} source at ${previous.manifestDir}.`,
        );
      }
      byName.set(manifest.name, { manifest, manifestDir, origin: root.origin });
    }
  }

  return { manifests: [...byName.values()], warnings };
}

export function discoverTaskSourceManifests(): DiscoveredManifest[] {
  const { manifests, warnings } = discoverFromRoots([
    { dir: PACKAGE_TASK_SOURCES_ROOT, origin: "package" },
    { dir: userTaskSourcesRoot(), origin: "user" },
  ]);
  for (const warning of warnings) {
    writeError(warning);
  }
  return manifests;
}
