/**
 * Console rendering: humans-only lines, never raw JSON (spec §10.3). Correlation
 * ids and any extra flat fields are appended compactly so a tail of the console
 * still reads as prose. The file sink is the only JSON surface.
 */

/** Reserved correlation ids, rendered in this order when present (§10.2). */
const CORRELATION_KEYS = ["taskId", "runId", "sessionId", "source", "repo"] as const;
const CORRELATION_KEY_SET = new Set<string>(CORRELATION_KEYS);
const BASE_KEYS = new Set(["ts", "level", "module", "event", "msg"]);
const LEVEL_WIDTH = 5;

/** Stringify a log field value, JSON-encoding objects so they never render as `[object Object]`. */
function renderValue(value: unknown): string {
  return typeof value === "object" && value !== null ? JSON.stringify(value) : String(value);
}

export function renderHumanLine(record: Record<string, unknown>): string {
  const ts = String(record["ts"]);
  const level = String(record["level"]).padEnd(LEVEL_WIDTH);
  const module = String(record["module"]);
  const event = String(record["event"]);
  const message = record["msg"] === undefined ? "" : ` ${renderValue(record["msg"])}`;
  const context = renderContext(record);

  return `${ts} ${level} ${module} ${event}${message}${context}`;
}

function renderContext(record: Record<string, unknown>): string {
  const pairs: string[] = [];
  for (const key of CORRELATION_KEYS) {
    if (record[key] !== undefined) {
      pairs.push(`${key}=${renderValue(record[key])}`);
    }
  }

  for (const [key, value] of Object.entries(record)) {
    if (!BASE_KEYS.has(key) && !CORRELATION_KEY_SET.has(key)) {
      pairs.push(`${key}=${renderValue(value)}`);
    }
  }

  return pairs.length > 0 ? ` (${pairs.join(" ")})` : "";
}
