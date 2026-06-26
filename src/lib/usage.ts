/**
 * Usage data — wraps `codexbar usage` for every agent in
 * `config.agents.definitions` that has a `usage` block configured. The
 * orchestrator's dispatcher consumes the per-agent snapshot to gate work by
 * `orchestrator.sessionLimitPercentage`. There is no CLI surface for usage —
 * `codexbar` itself is the user-facing inspection tool.
 */

import { runCommandAsync } from "./commandRunner.ts";
import type { AgentDefinition, ResolvedConfig } from "./config.ts";
import { debug, errorMessage } from "./util.ts";

interface UsageWindow {
  usedPercent: number;
  resetDescription?: string;
  resetsAt?: string;
  windowMinutes?: number;
}

interface Usage {
  primary?: UsageWindow | null;
  secondary?: UsageWindow | null;
  tertiary?: UsageWindow | null;
  loginMethod?: string;
  identity?: {
    loginMethod?: string;
    providerID?: string;
    accountEmail?: string;
  };
  updatedAt?: string;
}

interface CodexbarEntry {
  provider: string;
  source?: string;
  version?: string;
  usage?: Usage;
  error?: { message?: string };
}

interface NormalizedUsage {
  session: number | null;
  sessionEndDuration: number | null;
  weekly: number | null;
  weekEndDuration: number | null;
  /** Set when the snapshot is fail-closed because codexbar could not be read. */
  unavailableReason?: string;
}

export type UsageByAgent = Record<string, NormalizedUsage>;

/**
 * Synthetic snapshot used when codexbar can't be read for a agent. Both
 * window fractions are pinned to Infinity so the dispatcher's
 * `session * 100 > sessionLimitPercentage` check fires at every legal
 * threshold — `sessionLimitPercentage: 100` would otherwise accept
 * `session: 1` (100 > 100 is false), reopening the very gate this entry
 * exists to close.
 */
export const EXHAUSTED_USAGE: NormalizedUsage = {
  session: Number.POSITIVE_INFINITY,
  sessionEndDuration: null,
  weekly: Number.POSITIVE_INFINITY,
  weekEndDuration: null,
};

const MS_PER_MINUTE = 60_000;
const PERCENT_FRACTION_DIVISOR = 100;

const CODEXBAR_TIMEOUT_MS = 30_000;

function defaultCodexbarSource(provider: string): string {
  if (process.platform !== "darwin") {
    return "cli";
  }
  // codexbar's CLI `auto` for Codex/Claude probes browser sessions before OAuth,
  // while the menu bar app prefers OAuth. Match the app so gates follow the CLI account.
  if (provider === "codex" || provider === "claude") {
    return "oauth";
  }
  return "auto";
}

async function codexbarUsage(definition: AgentDefinition, signal?: AbortSignal): Promise<Usage> {
  /* v8 ignore next 3 @preserve -- callers filter to definitions with usage; this is a defensive guard */
  if (!definition.usage) {
    throw new Error("agent has no usage configured");
  }
  const { provider } = definition.usage.codexbar;
  const configuredSource = definition.usage.codexbar.source;
  const source = configuredSource ?? defaultCodexbarSource(provider);
  const arguments_: string[] = [
    "usage",
    "--provider",
    provider,
    "--source",
    source,
    "--format",
    "json",
  ];

  const options =
    signal === undefined
      ? { timeoutMs: CODEXBAR_TIMEOUT_MS }
      : { signal, timeoutMs: CODEXBAR_TIMEOUT_MS };
  let out: string;
  try {
    out = await runCommandAsync("codexbar", arguments_, options);
  } catch (error) {
    if (signal?.aborted === true) {
      throw error;
    }
    // codexbar exits non-zero (e.g. status 3 for "no rate limit events yet")
    // for handled provider conditions while still writing its JSON payload to
    // stdout. runCommandAsync rejects on the exit code, so recover that payload
    // and parse it like a success — its per-entry `error` field, not the exit
    // code, distinguishes "available" from a genuine failure below. A missing
    // or unparseable payload is a real failure: rethrow so the caller fails
    // closed.
    const recovered = recoverStdout(error);
    if (recovered === undefined) {
      throw error;
    }
    out = recovered;
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- JSON.parse returns any; codexbar's --format json output matches CodexbarEntry[]
  const parsed = JSON.parse(out) as CodexbarEntry[];
  // codexbar can return multiple entries when a provider has several
  // accounts/sources. When the user pinned a specific source, only an exact
  // match counts — falling back to a different account would silently
  // misreport quotas. When `auto`/`cli` was inferred, fall back to a provider
  // match only when it is unambiguous (a single entry) so codexbar's resolved
  // backend label ("openai-web", "local", etc.) doesn't have to equal the
  // request literal. Ambiguous fallbacks fail closed and the caller surfaces
  // EXHAUSTED_USAGE.
  const providerMatches = parsed.filter((entry) => entry.provider === provider);
  const exact = providerMatches.find((entry) => entry.source === source);
  const match =
    configuredSource === undefined
      ? (exact ?? (providerMatches.length === 1 ? providerMatches[0] : undefined))
      : exact;
  if (!match) {
    throw new Error(
      `codexbar returned no matching entry for provider=${provider}, source=${source}`,
    );
  }
  if (!match.usage) {
    // codexbar reports a valid session that simply has no rate-limit events
    // recorded yet — a fresh, low-traffic, or unlimited-quota account that has
    // consumed nothing the windows can measure. That is the *least* exhausted
    // state, not an unreadable one: return empty windows so it normalizes to
    // `session: null` (available) instead of fail-closing to exhausted.
    if (isNoRateLimitEvents(match.error)) {
      return {};
    }
    // codexbar can otherwise return `{error: ...}` instead of `{usage: ...}`
    // when the underlying provider failed (e.g. codex app-server crashed). The
    // outer catch in getUsageByAgent turns this into a fail-closed
    // exhausted entry; surface codexbar's error message so the operator
    // can fix the underlying CLI.
    const detail = match.error?.message ?? "no usage data";
    throw new Error(
      `codexbar returned no usage for provider=${provider}, source=${source}: ${detail}`,
    );
  }
  return match.usage;
}

/**
 * codexbar signals an authenticated account with zero recorded rate-limit
 * events via this provider error (e.g. "Found sessions, but no rate limit
 * events yet."). It means no quota consumed — available — not a probe failure.
 */
function isNoRateLimitEvents(error: CodexbarEntry["error"]): boolean {
  return /no rate limit events/i.test(error?.message ?? "");
}

/**
 * runCommandAsync rejects on a non-zero exit, attaching the captured stdout
 * Buffer to the thrown error's `cause`. codexbar uses non-zero exits for handled
 * provider conditions while still emitting its JSON payload, so pull that stdout
 * back out to parse like a success. Returns undefined when no stdout was
 * captured (a real failure with nothing to parse).
 */
function recoverStdout(error: unknown): string | undefined {
  /* v8 ignore next 3 @preserve -- runCommandAsync always rejects with an Error */
  if (!(error instanceof Error)) {
    return undefined;
  }
  // A plain command failure with no captured output carries no cause/stdout.
  if (!(error.cause instanceof Error) || !("stdout" in error.cause)) {
    return undefined;
  }
  const { stdout } = error.cause;
  return Buffer.isBuffer(stdout) ? stdout.toString("utf8") : undefined;
}

function toFraction(value: number | undefined | null): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  return value / PERCENT_FRACTION_DIVISOR;
}

function minutesUntil(isoTimestamp: string | undefined): number | null {
  if (isoTimestamp === undefined) {
    return null;
  }
  const ms = new Date(isoTimestamp).getTime();
  if (Number.isNaN(ms)) {
    return null;
  }
  return Math.max(0, Math.round((ms - Date.now()) / MS_PER_MINUTE));
}

function normalize(usage: Usage): NormalizedUsage {
  return {
    session: toFraction(usage.primary?.usedPercent),
    sessionEndDuration: minutesUntil(usage.primary?.resetsAt),
    weekly: toFraction(usage.secondary?.usedPercent),
    weekEndDuration: minutesUntil(usage.secondary?.resetsAt),
  };
}

export function gatedAgents(config: ResolvedConfig): string[] {
  return Object.entries(config.agents.definitions)
    .filter(([, definition]) => definition.usage !== undefined)
    .map(([name]) => name);
}

export async function getUsageByAgent(
  config: ResolvedConfig,
  signal?: AbortSignal,
): Promise<UsageByAgent> {
  const agents = gatedAgents(config);
  if (agents.length === 0) {
    return {};
  }
  const out: UsageByAgent = {};
  for (const agent of agents) {
    const definition = config.agents.definitions[agent];
    /* v8 ignore next 3 @preserve -- gatedAgents only emits names that exist in definitions */
    if (!definition) {
      continue;
    }
    try {
      // oxlint-disable-next-line no-await-in-loop -- codexbar probes are intentionally sequential to avoid launching multiple CLI probes at once
      out[agent] = normalize(await codexbarUsage(definition, signal));
    } catch (error) {
      if (signal?.aborted === true) {
        throw error;
      }
      // Per-agent failure: fail closed. A silent skip would let the
      // dispatcher spawn agents on a agent whose quota we can't see —
      // the exact bug a usage gate is supposed to prevent. Record the
      // failure (debug-tier — always in the log file, console under
      // --verbose) so operators can fix the underlying CLI, and return a
      // fully-exhausted snapshot so the dispatcher gates the agent. The
      // gate itself surfaces a visible skip line via formatUsageExhaustion.
      const reason = errorMessage(error);
      debug(`Usage check failed for ${agent} (treating as exhausted): ${reason}`);
      out[agent] = { ...EXHAUSTED_USAGE, unavailableReason: reason };
    }
  }
  return out;
}
