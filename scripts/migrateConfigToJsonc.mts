#!/usr/bin/env node
/**
 * Convert a legacy `config.ts` to `config.jsonc` while preserving
 * comments and trailing commas.
 *
 * Usage:
 *   node scripts/migrateConfigToJsonc.mts <config.ts> [<config.jsonc>]
 *
 * Default destination is the same directory with the `.jsonc` extension.
 * The conversion is intentionally conservative: it strips the
 * `export const config[: Config] =` wrapper and trailing `as Config`,
 * then quotes bare identifier keys and rewrites single-quoted strings
 * and numeric separators (e.g. `120_000`). It does NOT execute the
 * file, so dynamic expressions (function calls, template strings,
 * spreads) need a manual rewrite — everything else round-trips.
 *
 * After running, validate the result with `node --run config:check`
 * (or `crew doctor` for an already-installed groundcrew).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { type ParseError, parse as parseJsonc } from "jsonc-parser";

const [inputArg, outputArg] = process.argv.slice(2);

if (inputArg === undefined || inputArg.length === 0) {
  process.stderr.write(
    "Usage: node scripts/migrateConfigToJsonc.mts <config.ts> [<config.jsonc>]\n",
  );
  process.exit(2);
}

const inputPath = resolve(inputArg);
const outputPath =
  outputArg === undefined || outputArg.length === 0
    ? inputPath.replace(/\.ts$/, ".jsonc")
    : resolve(outputArg);

if (!existsSync(inputPath)) {
  process.stderr.write(`Not found: ${inputPath}\n`);
  process.exit(2);
}

if (existsSync(outputPath) && process.env["MIGRATE_CONFIG_FORCE"] === undefined) {
  process.stderr.write(
    `Refusing to overwrite ${outputPath}. Re-run with MIGRATE_CONFIG_FORCE=1 to overwrite.\n`,
  );
  process.exit(2);
}

const source = readFileSync(inputPath, "utf8");

let jsonc: string = source;

// Drop leading `import ... ;` lines — TS type imports have no JSONC analog.
jsonc = jsonc.replaceAll(/^import[\s\S]*?;\s*\n/gm, "");

// Drop `export const config: Config = ` / `export const config = ` prefix
jsonc = jsonc.replace(/export\s+const\s+config\s*(:\s*Config)?\s*=\s*/m, "");

// Drop trailing `as Config` and final semicolon at end of file
jsonc = jsonc.replace(/\s*as\s+Config\s*;?\s*$/m, "");
jsonc = jsonc.replace(/;\s*$/, "");

// Quote bare identifier keys: `linear:` -> `"linear":`. Match positions where
// a key follows `{` or `,` (with optional whitespace and line comments in
// between) and consists of a bare JS identifier.
jsonc = jsonc.replaceAll(
  /([{,]\s*(?:\/\/[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*)([A-Za-z_$][A-Za-z0-9_$]*)(\s*:)/g,
  '$1"$2"$3',
);

// Rewrite single-quoted strings to double-quoted. Avoid touching escapes or
// embedded double quotes — the conservative regex bails on those.
jsonc = jsonc.replaceAll(/'([^'\\\n"]*)'/g, '"$1"');

// Remove numeric separators (`120_000` -> `120000`). Repeat until stable to
// handle multi-separator literals like `1_000_000`.
let previous = "";
while (previous !== jsonc) {
  previous = jsonc;
  jsonc = jsonc.replaceAll(/(\d)_(\d)/g, "$1$2");
}

jsonc = jsonc.replaceAll(/[ \t]+$/gm, "").replace(/\n+$/, "\n");

const errors: ParseError[] = [];
parseJsonc(jsonc, errors, { allowTrailingComma: true });
if (errors.length > 0) {
  process.stderr.write("Conversion produced invalid JSONC. Inspect the output:\n");
  process.stderr.write(`${jsonc}\n`);
  const [first] = errors;
  if (first !== undefined) {
    process.stderr.write(`\nFirst error: ${JSON.stringify(first)}\n`);
  }
  process.exit(1);
}

writeFileSync(outputPath, jsonc);
process.stdout.write(`Wrote ${outputPath}\n`);
process.stdout.write(
  "Validate with: node --run config:check (or `crew doctor` once the file is at the XDG path).\n",
);
