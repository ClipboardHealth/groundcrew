import { defineConfig } from "vitest/config";

// The e2e suite is black-box: it spawns the built `crew` binary and observes
// the world (spec / catalog §1). Harness self-tests (§1.5) live alongside it
// and run without any binary. No coverage thresholds — the suite asserts
// behavior, not line coverage.
export default defineConfig({
  test: {
    include: ["e2e/**/*.e2e.test.ts", "e2e/harness/**/*.test.ts"],
    passWithNoTests: true,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
