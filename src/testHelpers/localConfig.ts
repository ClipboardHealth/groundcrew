import type { ResolvedConfig } from "../lib/config.ts";

export function makeLocalConfig(
  overrides: Partial<ResolvedConfig["local"]> = {},
): ResolvedConfig["local"] {
  return {
    runner: "auto",
    networkEgress: "allowlisted",
    safehouse: { enable: [], appendProfile: [] },
    readOnlyDirs: [],
    ...overrides,
  };
}
