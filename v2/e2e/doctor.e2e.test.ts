import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("crew doctor", () => {
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

  it("reports invalid source manifests with their path and validation error", async () => {
    const fixture = await createFixture({
      manifestContents: JSON.stringify({ commands: {}, protocolVersion: "one" }),
    });

    await expect(
      execFileAsync(process.execPath, ["bin/run.js", "doctor"], {
        cwd: process.cwd(),
        env: fixture.environment,
      }),
    ).rejects.toMatchObject({
      code: 1,
      stdout: expect.stringMatching(/invalid source manifest .*source\.json.*protocolVersion/s),
    });
  });

  it("prefers a user bundle over the package bundle with the same kind", async () => {
    const fixture = await createFixture({ kind: "linear" });

    const result = await execFileAsync(process.execPath, ["bin/run.js", "doctor"], {
      cwd: process.cwd(),
      env: fixture.environment,
    });

    expect(result.stdout).toContain("linear (user, protocol 1)");
    expect(result.stdout).toContain("live list probe: healthy");
  });

  it("rejects duplicate source names before dispatch", async () => {
    const fixture = await createFixture({ duplicateSourceName: true });

    await expect(
      execFileAsync(process.execPath, ["bin/run.js", "start"], {
        cwd: process.cwd(),
        env: fixture.environment,
      }),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("duplicate configured source name 'fixture'"),
    });
  });

  it("resolves prerequisites from the merged source environment", async () => {
    const fixture = await createFixture({ prerequisiteFromManifest: true });

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
    readonly duplicateSourceName?: boolean | undefined;
    readonly manifestContents?: string | undefined;
    readonly kind?: string | undefined;
    readonly prerequisiteFromManifest?: boolean | undefined;
    readonly protocolVersion?: number | undefined;
    readonly secrets?: readonly string[] | undefined;
  } = {},
): Promise<{ readonly environment: NodeJS.ProcessEnv }> {
  const root = await mkdtemp(join(tmpdir(), "groundcrew-v2-doctor-"));
  const configHome = join(root, "config");
  const kind = options.kind ?? "fixture";
  const sourceDirectory = join(configHome, "groundcrew", "task-sources", kind);
  const tasksPath = join(root, "tasks.json");
  const updatesPath = join(root, "updates.jsonl");
  const prerequisiteDirectory = join(root, "prerequisites");
  const fakeBin = join(process.cwd(), "e2e", "fixtures", "fake-bin");
  await mkdir(dirname(sourceDirectory), { recursive: true });
  await cp("e2e/fixtures/source", sourceDirectory, { recursive: true });
  if (options.prerequisiteFromManifest === true) {
    await mkdir(prerequisiteDirectory, { recursive: true });
    await writeFile(join(prerequisiteDirectory, "fixture-prerequisite"), "#!/bin/sh\nexit 0\n", {
      mode: 0o755,
    });
  }
  if (options.manifestContents !== undefined) {
    await writeFile(join(sourceDirectory, "source.json"), options.manifestContents);
  } else if (
    options.commands !== undefined ||
    options.protocolVersion !== undefined ||
    options.prerequisiteFromManifest === true ||
    options.secrets !== undefined
  ) {
    await writeFile(
      join(sourceDirectory, "source.json"),
      JSON.stringify({
        commands: options.commands ?? { get: "./get", list: "./list", update: "./update" },
        environment:
          options.prerequisiteFromManifest === true
            ? { PATH: `${prerequisiteDirectory}:${process.env["PATH"]}` }
            : {},
        name: "fixture",
        prerequisites: options.prerequisiteFromManifest === true ? ["fixture-prerequisite"] : [],
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
      sources: options.duplicateSourceName
        ? [
            { kind, name: kind },
            { kind, name: kind },
          ]
        : [{ kind, name: kind }],
      workspace: { baseDirectory: join(root, "dev") },
    }),
  );
  return {
    environment: {
      ...process.env,
      FIXTURE_TASKS: tasksPath,
      FIXTURE_UPDATES: updatesPath,
      GROUNDCREW_CONFIG: configPath,
      PATH: `${fakeBin}:${process.env["PATH"]}`,
      XDG_CONFIG_HOME: configHome,
      XDG_STATE_HOME: join(root, "state"),
    },
  };
}
