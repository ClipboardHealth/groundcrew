/**
 * Bridges a discovered `SourceManifest` to the shell adapter runtime so a
 * packaged/installed source is enabled with `{ kind: "<name>" }` alone. The
 * synthetic adapter's `kind` is the manifest name; its config schema accepts
 * light overrides (`name`, `env`, `timeouts`, `enabled`) that merge over the
 * manifest defaults. Full command control stays with the generic `kind:"shell"`
 * adapter. `create` materializes the scripts (idempotent) before building the
 * TaskSource, so enabling a source is also what installs it.
 */

import { z } from "zod";

import type { AdapterContext, AdapterDefinition } from "../../adapterDefinition.ts";
import type { TaskSource } from "../../taskSource.ts";

import { createShellTaskSource } from "./factory.ts";
import { installShellSource } from "./install.ts";
import { manifestTimeoutsSchema, type SourceManifest } from "./manifest.ts";
import type { ShellAdapterConfig } from "./schema.ts";

export interface ManifestOverrides {
  name?: string | undefined;
  env?: Record<string, string> | undefined;
  timeouts?: ShellAdapterConfig["timeouts"] | undefined;
}

export function shellConfigFromManifest(
  manifest: SourceManifest,
  overrides: ManifestOverrides = {},
): ShellAdapterConfig {
  const env = { ...manifest.env, ...overrides.env };
  const timeouts = overrides.timeouts ?? manifest.timeouts;
  return {
    kind: "shell",
    name: overrides.name ?? manifest.name,
    commands: manifest.commands,
    ...(Object.keys(env).length > 0 ? { env } : {}),
    ...(timeouts ? { timeouts } : {}),
  };
}

export function manifestAdapter(manifest: SourceManifest, manifestDir: string): AdapterDefinition {
  const configSchema = z.strictObject({
    kind: z.literal(manifest.name),
    name: z
      .string()
      .regex(/^[a-z][a-z0-9-]*$/, "name must be kebab-case (lowercase letters, digits, hyphens)")
      .optional(),
    env: z.record(z.string(), z.string()).optional(),
    timeouts: manifestTimeoutsSchema.optional(),
    enabled: z.boolean().optional(),
  });

  return {
    kind: manifest.name,
    configSchema,
    // `config` arrives already validated from buildSourcesWith; re-parse to
    // recover the typed overrides without an unsafe cast. Cheap and idempotent.
    create: (config: unknown, context: AdapterContext): TaskSource => {
      const overrides = configSchema.parse(config);
      installShellSource({ manifest, manifestDir });
      return createShellTaskSource(
        shellConfigFromManifest(manifest, {
          name: overrides.name,
          env: overrides.env,
          timeouts: overrides.timeouts,
        }),
        context,
      );
    },
  };
}
