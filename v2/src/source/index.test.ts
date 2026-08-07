import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SourceRegistry } from "./index.js";

describe("SourceRegistry", () => {
  it("rejects update routing when configured source names collide", async () => {
    const root = await mkdtemp(join(tmpdir(), "groundcrew-v2-source-duplicate-"));
    const bundleDirectory = join(root, "task-sources", "fixture");
    const updatesPath = join(root, "updates.jsonl");
    await mkdir(bundleDirectory, { recursive: true });
    await writeFile(
      join(bundleDirectory, "source.json"),
      JSON.stringify({
        commands: { list: "./list", update: "./update" },
        environment: {},
        prerequisites: [],
        protocolVersion: 1,
        secrets: [],
      }),
    );
    await writeFile(
      join(bundleDirectory, "list"),
      '#!/bin/sh\nprintf \'%s\\n\' \'{"ok":true,"data":{"tasks":[]}}\'\n',
      { mode: 0o755 },
    );
    await writeFile(
      join(bundleDirectory, "update"),
      '#!/bin/sh\ncat >> "$FIXTURE_UPDATES"\nprintf \'%s\\n\' \'{"ok":true,"data":{"result":"ok"}}\'\n',
      { mode: 0o755 },
    );
    const registry = await SourceRegistry.create({
      configHome: join(root, "config"),
      environment: { ...process.env, FIXTURE_UPDATES: updatesPath },
      instances: [
        { environment: {}, kind: "fixture", name: "same" },
        { environment: {}, kind: "fixture", name: "same" },
      ],
      packageRoot: root,
    });

    const result = await registry.update({
      canonicalTaskId: "same:ENG-123",
      event: { runId: "r_12345678", type: "claimed" },
    });

    expect(result).toEqual({
      error: { message: "duplicate configured source name 'same'" },
      ok: false,
    });
    await expect(readFile(updatesPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
