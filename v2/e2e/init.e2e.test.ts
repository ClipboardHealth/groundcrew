import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
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
  });
});
