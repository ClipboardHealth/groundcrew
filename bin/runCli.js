import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { constants as osConstants } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Load a side-effecting entrypoint by basename. In published/built mode,
 * dynamically imports the compiled `dist/${name}.js` in-process. In source/dev
 * mode (no compiled output present), spawns a child node that loads the `.ts`
 * source while dependencies resolve through normal package exports.
 *
 * @param {string} packageRoot
 * @param {string} name
 */
export async function runCli(packageRoot, name) {
  const compiledPath = path.join(packageRoot, "dist", `${name}.js`);
  if (existsSync(compiledPath)) {
    await import(pathToFileURL(compiledPath).href);
    return;
  }

  const sourcePath = path.join(packageRoot, "src", `${name}.ts`);
  const result = spawnSync(process.execPath, [sourcePath, ...process.argv.slice(2)], {
    stdio: "inherit",
  });

  if (result.error !== undefined) {
    throw result.error;
  }

  if (result.signal !== null) {
    const signalNumber = osConstants.signals[result.signal];
    process.exitCode = signalNumber === undefined ? 1 : 128 + signalNumber;
    return;
  }

  process.exitCode = result.status ?? 1;
}
