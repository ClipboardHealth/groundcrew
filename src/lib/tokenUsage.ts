/**
 * Token accounting for agent sessions.
 *
 * `status` already records wall clock and pull request outcomes, so the only
 * thing missing before cost per task is computable is the token count. Claude
 * writes one JSONL transcript per session and stamps each assistant message
 * with its own `usage`, so the numbers exist already and cost nothing extra to
 * collect: no API call, no provider lookup, no second run.
 *
 * Two details decide whether the resulting number is trustworthy.
 *
 * The first is deduplication. A transcript contains the same assistant message
 * more than once, because a message is rewritten as it streams and again when a
 * session resumes. On a real 718-usage-record transcript only 327 message ids
 * were distinct, and summing every record inflated the total 2.13x. The
 * inflation is not uniform across fields either (2.10x on cache reads against
 * 2.64x on output), so it cannot be corrected with a constant factor after the
 * fact: it distorts the mix as well as the total. Usage is therefore counted
 * once per `message.id`.
 *
 * The second is keeping the four fields apart. Cache reads bill at roughly a
 * tenth of fresh input, so a single `totalTokens` would make a cached-heavy
 * workload look far more expensive than it is. Pricing belongs downstream,
 * where the rate sheet lives; this module counts and does not price.
 */

/** Token counts for one agent session, kept unpriced and unsummed. */
export interface TokenUsage {
  inputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  outputTokens: number;
  /** Distinct assistant messages the counts came from. */
  messages: number;
}

export function emptyTokenUsage(): TokenUsage {
  return {
    inputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    outputTokens: 0,
    messages: 0,
  };
}

/** Absent, null and non-numeric all mean zero; a real 0 must survive as 0. */
function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

/**
 * The transcript path Claude hands a hook on stdin.
 *
 * Hooks receive `{"session_id":..,"transcript_path":..,"hook_event_name":..}`.
 * A malformed or unexpected payload returns undefined rather than throwing, so
 * a hook can never break the agent it is observing.
 */
export function transcriptPathFromHookPayload(stdin: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdin);
  } catch {
    return undefined;
  }

  const path = asRecord(parsed)?.["transcript_path"];

  return typeof path === "string" && path.length > 0 ? path : undefined;
}

/**
 * Sum a session transcript, counting each assistant message once.
 *
 * Malformed lines are skipped rather than fatal: a transcript is appended to
 * while the agent runs, so reading one mid-write is expected and a partial
 * final line should cost the caller nothing. Records carrying usage but no id
 * are counted, since dropping them would undercount, and no id means there is
 * nothing to double count against.
 */
export function sumTranscriptUsage(transcript: string): TokenUsage {
  const total = emptyTokenUsage();
  const counted = new Set<string>();

  for (const line of transcript.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }

    let entry: unknown;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }

    const record = asRecord(entry);
    if (record === undefined) {
      continue;
    }

    const message = asRecord(record["message"]);
    const usage = asRecord(message?.["usage"] ?? record["usage"]);
    if (usage === undefined) {
      continue;
    }

    const id = message?.["id"];
    if (typeof id === "string" && id.length > 0) {
      if (counted.has(id)) {
        continue;
      }

      counted.add(id);
    }

    total.inputTokens += count(usage["input_tokens"]);
    total.cacheCreationInputTokens += count(usage["cache_creation_input_tokens"]);
    total.cacheReadInputTokens += count(usage["cache_read_input_tokens"]);
    total.outputTokens += count(usage["output_tokens"]);
    total.messages += 1;
  }

  return total;
}

/** Fold a resumed session's counts into the ones already recorded. */
export function addTokenUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    cacheCreationInputTokens: left.cacheCreationInputTokens + right.cacheCreationInputTokens,
    cacheReadInputTokens: left.cacheReadInputTokens + right.cacheReadInputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    messages: left.messages + right.messages,
  };
}
