/**
 * Crash-safe JSON file writes. Callers persist state that another process may
 * read at any moment, so a partially written file must never be observable.
 */

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Writes `value` as pretty JSON to `filePath`, creating parent directories.
 *
 * The write lands in a sibling temp file and is then renamed, which is atomic
 * on POSIX, so a concurrent reader sees either the old file or the new one and
 * never a half-written document. The pid in the temp name keeps two processes
 * writing the same target from clobbering each other's temp file. Mode 0600
 * matches the rest of groundcrew's state, which can carry task titles.
 */
export function writeJsonAtomic(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, undefined, 2)}\n`, { mode: 0o600 });
  renameSync(temporaryPath, filePath);
}
