import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const execFileAsync = promisify(execFile);

describe("Groundcrew configuration schema", () => {
  it("rejects invalid nested agent settings in the schema and runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "groundcrew-v2-config-"));
    const configPath = join(root, "crew.config.jsonc");
    const invalidConfig = {
      agents: {
        default: "broken",
        profiles: { broken: { effort: "extreme", kind: "invalid" } },
      },
      sources: [{ kind: "fixture" }],
      workspace: { baseDirectory: join(root, "dev") },
    };
    await writeFile(configPath, JSON.stringify(invalidConfig));
    const publishedSchema = JSON.parse(await readFile("schema.json", "utf8"));
    const schemaValidator = z.fromJSONSchema(publishedSchema);

    expect(schemaValidator.safeParse(invalidConfig).success).toBe(false);
    await expect(
      execFileAsync(process.execPath, ["bin/run.js", "doctor"], {
        cwd: process.cwd(),
        env: { ...process.env, GROUNDCREW_CONFIG: configPath },
      }),
    ).rejects.toMatchObject({ code: 1 });
  });
});
