/**
 * The console IO seam. Commands write their own output through an injectable
 * {@link Io} so unit tests can capture it; the default binds to the real
 * process streams. Log lines never come through here — the logging lib owns the
 * JSONL file and its own human console rendering (contracts §6, design §10.3).
 */

export interface Io {
  out(text: string): void;
  err(text: string): void;
}

/** The real process-stream IO. */
export const processIo: Io = {
  out(text: string): void {
    process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
  },
  err(text: string): void {
    process.stderr.write(text.endsWith("\n") ? text : `${text}\n`);
  },
};

/** A capturing IO for tests: collects written lines. */
export function createCaptureIo(): Io & { readonly stdout: string[]; readonly stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    out(text: string): void {
      stdout.push(text);
    },
    err(text: string): void {
      stderr.push(text);
    },
  };
}
