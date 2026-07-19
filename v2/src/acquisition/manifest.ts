/**
 * The source manifest — `source.json` in a bundle directory (contracts §4.1).
 * A bundle IS the plugin: `source.json` plus command scripts, crossing a process
 * boundary (design §6). The manifest parses successfully for ANY integer
 * `protocolVersion`; whether that version is supported is a separate check
 * (discovery), so an unsupported version becomes a loud entry, not a parse error.
 */
import { z } from "zod";

/** Command paths, relative to the bundle dir. `list` required; `get`/`update` optional. */
export const sourceCommandsSchema = z.object({
  list: z.string().min(1),
  get: z.string().min(1).optional(),
  update: z.string().min(1).optional(),
});

/** `source.json` schema. Unknown keys are stripped (forward-compatible additions). */
export const sourceManifestSchema = z.object({
  name: z.string().min(1).optional(),
  protocolVersion: z.number().int(),
  commands: sourceCommandsSchema,
  secrets: z.array(z.string()).default([]),
  environment: z.record(z.string(), z.string()).default({}),
  network: z.array(z.string()).default([]),
  prerequisites: z.array(z.string()).default([]),
});

export type SourceManifest = z.infer<typeof sourceManifestSchema>;

/** Parse outcome: a valid manifest, or a human-readable reason it was rejected. */
export type ParseManifestResult =
  | { readonly ok: true; readonly manifest: SourceManifest }
  | { readonly ok: false; readonly reason: string };

/**
 * Parses `source.json` text into a manifest. Both an unparseable JSON document
 * and a structurally-invalid one (e.g. missing the required `list` command or a
 * non-integer `protocolVersion`) yield `ok: false` — discovery turns that into a
 * skip-plus-warn entry, never a silent drop (design §6).
 */
export function parseManifest(contents: string): ParseManifestResult {
  let json: unknown;
  try {
    json = JSON.parse(contents);
  } catch (error) {
    return { ok: false, reason: `source.json is not valid JSON: ${messageOf(error)}` };
  }

  const parsed = sourceManifestSchema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, reason: `source.json is invalid: ${parsed.error.issues[0]?.message ?? "schema mismatch"}` };
  }

  return { ok: true, manifest: parsed.data };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
