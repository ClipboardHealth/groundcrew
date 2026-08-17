import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("TypeScript configuration", () => {
  it("checks source test files only with the test project", async () => {
    const [productionConfig, testConfig] = await Promise.all([
      execFileAsync(
        process.execPath,
        [
          join(process.cwd(), "node_modules/typescript/bin/tsc"),
          "--showConfig",
          "--project",
          "tsconfig.json",
        ],
        { cwd: process.cwd() },
      ),
      execFileAsync(
        process.execPath,
        [
          join(process.cwd(), "node_modules/typescript/bin/tsc"),
          "--showConfig",
          "--project",
          "tsconfig.test.json",
        ],
        { cwd: process.cwd() },
      ),
    ]);

    expect(productionConfig.stdout).not.toContain("src/run/index.test.ts");
    expect(testConfig.stdout).toContain("src/run/index.test.ts");
  });

  it("rejects Vitest globals in production source files", async () => {
    const fixtureRoot = await mkdtemp(join(process.cwd(), ".typescript-config-"));

    try {
      await writeFile(join(fixtureRoot, "source.ts"), "export const value = vi.fn();\n");
      await writeFile(
        join(fixtureRoot, "tsconfig.json"),
        JSON.stringify({
          extends: join(process.cwd(), "tsconfig.json"),
          compilerOptions: { composite: false, rootDir: "." },
          include: ["source.ts"],
        }),
      );

      await expect(
        execFileAsync(
          process.execPath,
          [join(process.cwd(), "node_modules/typescript/bin/tsc"), "--project", fixtureRoot],
          { cwd: process.cwd() },
        ),
      ).rejects.toMatchObject({
        stdout: expect.stringContaining("Cannot find name 'vi'"),
      });
    } finally {
      await rm(fixtureRoot, { force: true, recursive: true });
    }
  });

  it("provides Vitest globals to test files", async () => {
    const fixtureRoot = await mkdtemp(join(process.cwd(), ".typescript-config-"));

    try {
      await writeFile(join(fixtureRoot, "test.ts"), "export const value = vi.fn();\n");
      await writeFile(
        join(fixtureRoot, "tsconfig.json"),
        JSON.stringify({
          extends: join(process.cwd(), "tsconfig.test.json"),
          compilerOptions: { composite: false, rootDir: "." },
          include: ["test.ts"],
        }),
      );

      await expect(
        execFileAsync(
          process.execPath,
          [join(process.cwd(), "node_modules/typescript/bin/tsc"), "--project", fixtureRoot],
          { cwd: process.cwd() },
        ),
      ).resolves.toMatchObject({ stderr: "", stdout: "" });
    } finally {
      await rm(fixtureRoot, { force: true, recursive: true });
    }
  });
});
