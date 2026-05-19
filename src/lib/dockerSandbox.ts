import { runCommandAsync } from "./commandRunner.ts";

/**
 * Derive a deterministic sbx sandbox name from the repository + model
 * tuple so `crew sandbox auth <repo>` and the subsequent `crew local`
 * launch agree on which sandbox to target. Lowercased and reduced to the
 * sbx-safe charset (`a-z0-9.+-`) so unusual repo names still round-trip
 * cleanly. Keep the prefix stable — doctor and teardown use it to
 * identify groundcrew-owned sandboxes.
 */
export function sandboxNameFor(arguments_: { repository: string; model: string }): string {
  const raw = `groundcrew-${arguments_.repository}-${arguments_.model}`.toLowerCase();
  return raw
    .replaceAll(/[^a-z0-9.+-]+/g, "-")
    .replaceAll(/-+/g, "-")
    .replaceAll(/^-|-$/g, "");
}

/**
 * Probe `sbx ls` to see whether a sandbox with `sandboxName` already
 * exists. Used by `crew sandbox auth` to switch between create vs reuse
 * branches without surfacing the raw sbx error on first run.
 */
export async function sandboxExists(sandboxName: string, signal?: AbortSignal): Promise<boolean> {
  const out =
    signal === undefined
      ? await runCommandAsync("sbx", ["ls"])
      : await runCommandAsync("sbx", ["ls"], { signal });
  return out.split("\n").some((line) => line.trim().split(/\s+/)[0] === sandboxName);
}
