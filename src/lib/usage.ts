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

  const out = await runCommandAsync(
    "codexbar",
    arguments_,
    signal === undefined
      ? { timeoutMs: CODEXBAR_TIMEOUT_MS }
      : {
          signal,
          timeoutMs: CODEXBAR_TIMEOUT_MS,
        },
  );
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
    // codexbar can return `{error: ...}` instead of `{usage: ...}` when
    // the underlying provider failed (e.g. codex app-server crashed). The
    // outer catch in getUsageByAgent turns this into a fail-closed
    // exhausted entry; surface codexbar's error message so the operator
    // can fix the underlying CLI.
    const detail = match.error?.message ?? "no usage data";
    throw new Error(`codexbar returned no usage for provider=${provider}: ${detail}`);
  }
  return match.usage;
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
      debug(`Usage check failed for ${agent} (treating as exhausted): ${errorMessage(error)}`);
      out[agent] = EXHAUSTED_USAGE;
    }
  }
  return out;
}
