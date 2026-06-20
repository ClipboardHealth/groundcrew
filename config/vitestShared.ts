import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { coverageConfigDefaults, defineConfig } from "vitest/config";

interface CoverageThresholds {
  branches?: number;
  functions?: number;
  lines?: number;
  statements?: number;
}

interface CreateVitestConfigInput {
  importMetaUrl: string;
  name: string;
  coverageThresholds?: CoverageThresholds;
  coverageExclude?: string[];
}

export function createVitestConfig(
  input: CreateVitestConfigInput,
): ReturnType<typeof defineConfig> {
  const { importMetaUrl, name, coverageExclude, coverageThresholds } = input;
  const packageRoot = path.dirname(fileURLToPath(importMetaUrl));
  const workspaceRoot = packageRoot;
  const directory = path.relative(workspaceRoot, packageRoot);
  const coverageDirectory = path.join(packageRoot, "test-output", "vitest", "coverage");

  mkdirSync(path.join(coverageDirectory, ".tmp"), { recursive: true });

  return defineConfig({
    cacheDir: path.join(workspaceRoot, "node_modules", ".vite", directory),
    root: packageRoot,
    test: {
      coverage: {
        provider: "v8",
        reportsDirectory: coverageDirectory,
        exclude: [...coverageConfigDefaults.exclude, ...(coverageExclude ?? [])],
        thresholds: {
          branches: coverageThresholds?.branches ?? 100,
          functions: coverageThresholds?.functions ?? 100,
          lines: coverageThresholds?.lines ?? 100,
          statements: coverageThresholds?.statements ?? 100,
        },
      },
      environment: "node",
      globals: true,
      include: ["{src,tests}/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}"],
      name,
      reporters: ["default"],
      // Subprocess-spawning tests (adapters/shell/*, orchestrator) spawn a
      // child process that races the shell adapter's per-call timeout (up to
      // 30s). With one worker thread per core plus v8 coverage, the pool
      // saturates every core and a spawned child can't be scheduled in time.
      // Cap the pool to leave CPU headroom for those children, and keep the
      // harness timeout above the adapter ceiling so the real outcome wins.
      testTimeout: 60_000,
      hookTimeout: 60_000,
      maxWorkers: 4,
      watch: false,
    },
  });
}
