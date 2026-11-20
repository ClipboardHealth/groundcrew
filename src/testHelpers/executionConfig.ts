import type { ResolvedConfig } from "../lib/config.ts";

export function makeExecutionConfig(
  overrides: Partial<ResolvedConfig["execution"]> = {},
): ResolvedConfig["execution"] {
  return { default: "local", maximumInProgress: 10, ...overrides };
}
