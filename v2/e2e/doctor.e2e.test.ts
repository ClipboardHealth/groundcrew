import { execFile } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("crew doctor", () => {
  beforeAll(async () => {
    await Promise.all([
      chmod("e2e/fixtures/source/list", 0o755),
      chmod("e2e/fixtures/source/get", 0o755),
      chmod("e2e/fixtures/source/update", 0o755),
    ]);
  });

  it("discovers and probes a user source bundle", async () => {
    const fixture = await createFixture();

    const result = await execFileAsync(process.execPath, ["bin/run.js", "doctor"], {
      cwd: process.cwd(),
      env: fixture.environment,
    });

    expect(result.stdout).toContain("fixture (user, protocol 1)");
    expect(result.stdout).toContain("live list probe");
    expect(result.stdout).toContain("healthy");
  });

  it("names missing secrets and unsupported protocol versions", async () => {
    const fixture = await createFixture({
      protocolVersion: 2,
      secrets: ["FIXTURE_REQUIRED_TOKEN"],
    });

    await expect(
      execFileAsync(process.execPath, ["bin/run.js", "doctor"], {
        cwd: process.cwd(),
        env: fixture.environment,
      }),
    ).rejects.toMatchObject({
      code: 1,
      stdout: expect.stringContaining("missing secret FIXTURE_REQUIRED_TOKEN"),
    });
  });

  it("accepts a read-only source with no get or update capability", async () => {
    const fixture = await createFixture({ commands: { list: "./list" } });

    const result = await execFileAsync(process.execPath, ["bin/run.js", "doctor"], {
      cwd: process.cwd(),
      env: fixture.environment,
    });

    expect(result.stdout).toContain("live list probe: healthy");
  });
});

async function createFixture(
  options: {
    readonly commands?: Readonly<Record<string, string>> | undefined;
    readonly protocolVersion?: number | undefined;
    readonly secrets?: readonly string[] | undefined;
  } = {},
): Promise<{ readonly environment: NodeJS.ProcessEnv }> {
  const root = await mkdtemp(join(tmpdir(), "groundcrew-v2-doctor-"));
  const configHome = join(root, "config");
  const sourceDirectory = join(configHome, "groundcrew", "task-sources", "fixture");
  const tasksPath = join(root, "tasks.json");
  const updatesPath = join(root, "updates.jsonl");
  await mkdir(dirname(sourceDirectory), { recursive: true });
  await cp("e2e/fixtures/source", sourceDirectory, { recursive: true });
  if (Object.keys(options).length > 0) {
    await writeFile(
      join(sourceDirectory, "source.json"),
      JSON.stringify({
        commands: options.commands ?? { get: "./get", list: "./list", update: "./update" },
        environment: {},
        name: "fixture",
        prerequisites: [],
        protocolVersion: options.protocolVersion ?? 1,
        secrets: options.secrets ?? [],
      }),
    );
  }
  await writeFile(tasksPath, "[]\n");
  const configPath = join(root, "crew.config.jsonc");
  await writeFile(
    configPath,
    JSON.stringify({
      agents: { default: "codex", profiles: { codex: { kind: "codex" } } },
      sources: [{ kind: "fixture" }],
      workspace: { baseDirectory: join(root, "dev") },
    }),
  );
  return {
    environment: {
      ...process.env,
      FIXTURE_TASKS: tasksPath,
      FIXTURE_UPDATES: updatesPath,
      GROUNDCREW_CONFIG: configPath,
      XDG_CONFIG_HOME: configHome,
      XDG_STATE_HOME: join(root, "state"),
    },
  };
}

function dirname(path: string): string {
  return path.slice(0, path.lastIndexOf("/"));
}
