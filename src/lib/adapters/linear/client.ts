import { LinearClient } from "@linear/sdk";

import { readEnvironmentVariable } from "../../util.ts";

const LINEAR_API_KEY_SOURCES = ["GROUNDCREW_LINEAR_API_KEY", "LINEAR_API_KEY"] as const;

export type LinearApiKeySource = (typeof LINEAR_API_KEY_SOURCES)[number];

export interface ResolvedLinearApiKey {
  value: string;
  source: LinearApiKeySource;
}

export function resolveLinearApiKey(): ResolvedLinearApiKey | undefined {
  for (const source of LINEAR_API_KEY_SOURCES) {
    const value = readEnvironmentVariable(source);
    if (value === undefined) {
      continue;
    }
    if (value.length === 0) {
      continue;
    }
    return { value, source };
  }
  return undefined;
}

export function getLinearClient(): LinearClient {
  const resolved = resolveLinearApiKey();
  if (resolved === undefined) {
    throw new Error(
      "Linear API key not set. Set GROUNDCREW_LINEAR_API_KEY or LINEAR_API_KEY in your environment.",
    );
  }
  return new LinearClient({ apiKey: resolved.value });
}

/**
 * Returns a zero-arg getter that lazily constructs (and caches) a Linear
 * client on first call. Used by CLI entry points that may not need the
 * client at all (e.g. `--no-linear`), so we avoid blowing up on a missing
 * API key when no Linear call is actually made. The factory is taken as a
 * parameter (rather than calling `getLinearClient` directly) so callers can
 * pass their own module-level import of `getLinearClient` — that binding
 * respects `vi.mock` intercepts, whereas an intra-module reference would
 * not.
 */
export function lazyLinearClient(factory: () => LinearClient): () => LinearClient {
  let client: LinearClient | undefined;
  return () => {
    client ??= factory();
    return client;
  };
}
