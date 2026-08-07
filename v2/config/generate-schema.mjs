import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { format } from "oxfmt";
import { configurationJsonSchema } from "../dist/shell/index.js";

const schemaPath = join(import.meta.dirname, "..", "schema.json");
const formatted = await format(
  "schema.json",
  `${JSON.stringify(configurationJsonSchema(), undefined, 2)}\n`,
);
if (formatted.errors.length > 0) {
  throw new Error(formatted.errors.map((error) => error.message).join("; "));
}
const expected = formatted.code;

if (process.argv.includes("--check")) {
  const current = await readFile(schemaPath, "utf8");
  if (current !== expected) {
    process.stderr.write("schema.json is stale; run node --run schema:generate\n");
    process.exitCode = 1;
  }
} else {
  await writeFile(schemaPath, expected);
}
