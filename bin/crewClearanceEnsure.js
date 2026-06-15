#!/usr/bin/env node

// Groundcrew-owned `crew-clearance-ensure` command: a thin shim that ships on
// PATH with `crew` and dispatches to clearance's `clearance-ensure` entrypoint,
// passing args, stdio, and exit code straight through.

import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

// Resolve clearance wherever npm placed it (nested under groundcrew or hoisted
// to a top-level node_modules). Clearance's `exports` map exposes only `.` and
// `./package.json`, so we locate the package root through `package.json`, then
// import the bin by absolute file URL, which is not subject to the `exports`
// gate. Reading the path from `bin["clearance-ensure"]` keeps the shim correct
// if clearance relocates the file in a future version.
const packageJsonPath = require.resolve("@clipboard-health/clearance/package.json");
const packageJson = require("@clipboard-health/clearance/package.json");
const ensureRelativePath = packageJson.bin["clearance-ensure"];
const ensurePath = path.resolve(path.dirname(packageJsonPath), ensureRelativePath);

await import(pathToFileURL(ensurePath).href);
