/**
 * The JSON-lines file sink: one global file, size-based rotation (~10 MB × 3).
 * Writes are synchronous append-per-line so a line survives a crash mid-run
 * (the pinned `Logger.log` returns void, so there is nothing to await). Each
 * append opens, flushes, and closes, so there is no long-lived descriptor to
 * leak or to close on shutdown.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export interface FileSinkInput {
  /** Absolute path of the active JSON-lines file. */
  filePath: string;
  /** Rotation threshold in bytes for the active file. */
  maxBytes: number;
  /** Total files kept (active + archives); archives are `.1 … .(maxFiles-1)`. */
  maxFiles: number;
}

export type FileSink = (line: string) => void;

export function createFileSink(input: FileSinkInput): FileSink {
  const { filePath, maxBytes, maxFiles } = input;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  return function write(line: string): void {
    const payload = `${line}\n`;
    const incomingBytes = Buffer.byteLength(payload);
    if (shouldRotate({ currentBytes: currentSize(filePath), incomingBytes, maxBytes })) {
      rotate({ filePath, maxFiles });
    }

    fs.appendFileSync(filePath, payload, { mode: 0o600 });
  };
}

function currentSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function shouldRotate(input: {
  currentBytes: number;
  incomingBytes: number;
  maxBytes: number;
}): boolean {
  const { currentBytes, incomingBytes, maxBytes } = input;
  return currentBytes > 0 && currentBytes + incomingBytes > maxBytes;
}

function rotate(input: { filePath: string; maxFiles: number }): void {
  const { filePath, maxFiles } = input;
  const oldest = maxFiles - 1;
  if (oldest < 1) {
    fs.rmSync(filePath, { force: true });
    return;
  }

  fs.rmSync(`${filePath}.${String(oldest)}`, { force: true });
  for (let index = oldest - 1; index >= 1; index -= 1) {
    renameIfExists(`${filePath}.${String(index)}`, `${filePath}.${String(index + 1)}`);
  }

  renameIfExists(filePath, `${filePath}.1`);
}

function renameIfExists(from: string, to: string): void {
  if (fs.existsSync(from)) {
    fs.renameSync(from, to);
  }
}
