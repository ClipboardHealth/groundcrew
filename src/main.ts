import { recoverWorkingDirectory } from "./lib/workingDirectory.ts";

try {
  // Must run before cli.ts loads: config.ts builds its cosmiconfig explorer at
  // import time, which reads process.cwd() and crashes if the directory is gone.
  const recovery = recoverWorkingDirectory();
  if (recovery !== undefined) {
    process.stderr.write(
      `Current directory ${recovery.missing ?? "(unknown)"} no longer exists; continuing from ${recovery.recovered}\n`,
    );
  }
  const { run } = await import("./cli.ts");
  await run(process.argv.slice(2));
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
