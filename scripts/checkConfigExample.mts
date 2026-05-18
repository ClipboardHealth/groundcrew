/**
 * Validate the shipped configExample.jsonc against the live zod schema.
 *
 * Runs as part of `node --run verify` and `node --run config:check`. Catches
 * drift between the example file we publish to users and the runtime schema
 * the CLI enforces — a typo in either lands here before it lands in a user's
 * `groundcrew config: ...` error.
 */
import { resolve } from "node:path";

const PACKAGE_ROOT = resolve(import.meta.dirname, "..");
const EXAMPLE_PATH = resolve(PACKAGE_ROOT, "configExample.jsonc");

process.env["GROUNDCREW_CONFIG"] = EXAMPLE_PATH;

const { loadConfig } = await import("../src/lib/config.ts");

try {
  await loadConfig();
  process.stdout.write(`OK: ${EXAMPLE_PATH} validates against the config schema\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
