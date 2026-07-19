/**
 * `createLogger` internals (the pinned seam re-exports this). Composes the
 * rotating file sink with the human console renderer: the file gets every
 * level as a JSON line matching `logLineSchema`; the console gets human lines
 * on stderr at the configured threshold, or nothing when "silent".
 */
import { renderHumanLine } from "./consoleRenderer.js";
import { createFileSink } from "./fileSink.js";
import type { CreateLoggerInput, LogEventInput, Logger, LogLevel } from "./types.js";

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_FILES = 3;

export function createLogger(input: CreateLoggerInput): Logger {
  const consoleLevel = input.consoleLevel ?? "info";
  const now = input.now ?? (() => new Date());
  const writeConsole = input.writeConsole ?? ((text: string) => void process.stderr.write(text));
  const sink = createFileSink({
    filePath: input.filePath,
    maxBytes: input.maxBytes ?? DEFAULT_MAX_BYTES,
    maxFiles: input.maxFiles ?? DEFAULT_MAX_FILES,
  });

  return {
    log(event: LogEventInput): void {
      const record = buildLine({ event, timestamp: now().toISOString() });
      sink(JSON.stringify(record));

      if (consoleLevel !== "silent" && LEVEL_RANK[event.level] >= LEVEL_RANK[consoleLevel]) {
        writeConsole(`${renderHumanLine(record)}\n`);
      }
    },
  };
}

/**
 * The flat line object (contracts §6): base keys first, then the optional
 * message, then extra fields, then correlation ids last so a reserved id always
 * wins a key collision with a caller-supplied field.
 */
function buildLine(input: {
  event: LogEventInput;
  timestamp: string;
}): Record<string, unknown> {
  const { event, timestamp } = input;
  const line: Record<string, unknown> = {
    ts: timestamp,
    level: event.level,
    module: event.module,
    event: event.event,
  };

  if (event.msg !== undefined) {
    line["msg"] = event.msg;
  }

  if (event.fields !== undefined) {
    for (const [key, value] of Object.entries(event.fields)) {
      line[key] = value;
    }
  }

  for (const [key, value] of correlationEntries(event)) {
    line[key] = value;
  }

  return line;
}

function correlationEntries(event: LogEventInput): Array<[string, string]> {
  const candidates: Array<[string, string | undefined]> = [
    ["taskId", event.taskId],
    ["runId", event.runId],
    ["sessionId", event.sessionId],
    ["source", event.source],
    ["repo", event.repo],
  ];

  return candidates.filter((entry): entry is [string, string] => entry[1] !== undefined);
}
