import { mkdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
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
  const packageRoot = dirname(fileURLToPath(importMetaUrl));
  const workspaceRoot = resolve(packageRoot, "../..");
  const directory = relative(workspaceRoot, packageRoot);
  const coverageDirectory = join(packageRoot, "test-output", "vitest", "coverage");

  mkdirSync(join(coverageDirectory, ".tmp"), { recursive: true });

  return defineConfig({
    cacheDir: join(workspaceRoot, "node_modules", ".vite", directory),
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
      watch: false,
    },
  });
}
