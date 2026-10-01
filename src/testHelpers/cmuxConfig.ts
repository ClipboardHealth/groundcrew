import type { ResolvedConfig } from "../lib/config.ts";

export function makeCmuxConfig(
  overrides: Partial<ResolvedConfig["cmux"]["prStages"]> = {},
): ResolvedConfig["cmux"] {
  return {
    prStages: {
      enabled: false,
      labels: { selfReviewed: "self-reviewed", tested: "tested" },
      ...overrides,
    },
  };
}
