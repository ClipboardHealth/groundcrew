import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SourceRegistry } from "./index.js";

const fixtureRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    fixtureRoots.splice(0).map(async (root) => await rm(root, { force: true, recursive: true })),
  );
});

describe("SourceRegistry", () => {
  it("uses the effective source environment for secret health checks", async () => {
    const root = await mkdtemp(join(tmpdir(), "groundcrew-v2-source-health-"));
    fixtureRoots.push(root);
    const bundleDirectory = join(root, "task-sources", "fixture");
    await mkdir(bundleDirectory, { recursive: true });
    await writeFile(
      join(bundleDirectory, "source.json"),
      JSON.stringify({
        commands: { list: "./list" },
        environment: { FIXTURE_MANIFEST_TOKEN: "manifest-token" },
        prerequisites: [],
        protocolVersion: 1,
        secrets: ["FIXTURE_REQUIRED_TOKEN", "FIXTURE_MANIFEST_TOKEN"],
      }),
    );
    await writeFile(
      join(bundleDirectory, "list"),
      [
        "#!/bin/sh",
        'if [ "$FIXTURE_REQUIRED_TOKEN" != "instance-token" ]; then',
        '  printf \'%s\\n\' \'{"ok":false,"error":{"message":"token unavailable"}}\'',
        "  exit 0",
        "fi",
        'if [ "$FIXTURE_MANIFEST_TOKEN" != "manifest-token" ]; then',
        '  printf \'%s\\n\' \'{"ok":false,"error":{"message":"manifest token unavailable"}}\'',
        "  exit 0",
        "fi",
        'printf \'%s\\n\' \'{"ok":true,"data":{"tasks":[]}}\'',
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const registry = await SourceRegistry.create({
      configHome: join(root, "config"),
      environment: process.env,
      instances: [
        {
          environment: { FIXTURE_REQUIRED_TOKEN: "instance-token" },
          kind: "fixture",
        },
      ],
      packageRoot: root,
    });

    const result = await registry.health();

    expect(result).toEqual([
      {
        errors: [],
        kind: "fixture",
        name: "fixture",
        origin: "package",
        probe: { data: { taskCount: 0 }, ok: true },
        protocolVersion: 1,
      },
    ]);
  });

  it("rejects update routing when configured source names collide", async () => {
    const root = await mkdtemp(join(tmpdir(), "groundcrew-v2-source-duplicate-"));
    fixtureRoots.push(root);
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
