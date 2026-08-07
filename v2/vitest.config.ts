import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: { enabled: false },
    include: ["src/**/*.test.ts", "e2e/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
