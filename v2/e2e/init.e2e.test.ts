import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("crew init", () => {
  it("writes a minimal valid global config", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "groundcrew-v2-init-"));
    const configHome = join(temporaryDirectory, "config");
    const developmentDirectory = join(temporaryDirectory, "dev");

    const result = await execFileAsync(process.execPath, ["bin/run.js", "init", "--yes"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: temporaryDirectory,
        XDG_CONFIG_HOME: configHome,
      },
    });

    const config = await readFile(join(configHome, "groundcrew", "crew.config.jsonc"), "utf8");
    expect(result.stdout).toContain("Created");
    expect(config).toContain(`"baseDirectory": "${developmentDirectory}"`);
    expect(config).toContain('"kind": "linear"');
    expect(config).not.toContain('LINEAR_API_KEY":');
    expect(config).not.toContain('GROUNDCREW_LINEAR_API_KEY":');
  });

  it("preserves an existing config unless --yes is passed", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "groundcrew-v2-init-existing-"));
    const configHome = join(temporaryDirectory, "config");
    const configPath = join(configHome, "groundcrew", "crew.config.jsonc");
    await mkdir(join(configHome, "groundcrew"), { recursive: true });
    await writeFile(configPath, "existing config\n");

    await expect(
      execFileAsync(process.execPath, ["bin/run.js", "init"], {
        cwd: process.cwd(),
        env: { ...process.env, HOME: temporaryDirectory, XDG_CONFIG_HOME: configHome },
      }),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("already exists; pass --yes to replace it"),
    });

    expect(await readFile(configPath, "utf8")).toBe("existing config\n");

    await execFileAsync(process.execPath, ["bin/run.js", "init", "--yes"], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: temporaryDirectory, XDG_CONFIG_HOME: configHome },
    });

    expect(await readFile(configPath, "utf8")).toContain('"kind": "linear"');
  });

  it("prints help with a successful exit code", async () => {
    const result = await execFileAsync(process.execPath, ["bin/run.js", "--help"], {
      cwd: process.cwd(),
    });

    expect(result.stdout).toContain("Usage: crew");
    expect(result.stderr).toBe("");
  });
});
