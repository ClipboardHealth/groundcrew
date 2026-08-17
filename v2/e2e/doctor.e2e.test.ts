import { execFile, spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const fixtureRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    fixtureRoots.splice(0).map(async (root) => await rm(root, { force: true, recursive: true })),
  );
});

describe("crew doctor", () => {
  it("discovers and probes a user source bundle", async () => {
    const fixture = await createFixture();

    const result = await execFileAsync("bin/run.js", ["doctor"], {
      cwd: process.cwd(),
      env: fixture.environment,
    });

    expect(result.stdout).toContain("fixture (user, protocol 1)");
    expect(result.stdout).toContain("live list probe");
    expect(result.stdout).toContain("healthy");
  });

  it("shows prerequisite checks while live source probes are still running", async () => {
    const fixture = await createFixture({ waitForListRelease: true });
    const child = spawn("bin/run.js", ["doctor"], {
      cwd: process.cwd(),
      env: fixture.environment,
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    const completed = new Promise<number | null>((resolvePromise, reject) => {
      child.once("error", reject);
      child.once("close", resolvePromise);
    });

    try {
      await waitForOutput({ expected: "waiting for live source probes", read: () => stdout });

      expect(child.exitCode).toBeNull();
      expect(stdout).toContain("✓ Node.js 24+");
      expect(stdout).toContain("✓ git: available");
      expect(stdout).not.toContain("live list probe: healthy");
    } finally {
      await writeFile(fixture.listReleasePath, "release\n");
    }

    const exitCode = await completed;
    expect(exitCode).toBe(0);
    expect(stdout).toContain("live list probe: healthy");
  });

  it("names missing secrets and unsupported protocol versions", async () => {
    const fixture = await createFixture({
      protocolVersion: 2,
      secrets: ["FIXTURE_REQUIRED_TOKEN"],
    });

    await expect(
      execFileAsync("bin/run.js", ["doctor"], {
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

    const result = await execFileAsync("bin/run.js", ["doctor"], {
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
      execFileAsync("bin/run.js", ["doctor"], {
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

    const result = await execFileAsync("bin/run.js", ["doctor"], {
      cwd: process.cwd(),
      env: fixture.environment,
    });

    expect(result.stdout).toContain("linear (user, protocol 1)");
    expect(result.stdout).toContain("live list probe: healthy");
  });

  it("rejects duplicate source names before dispatch", async () => {
    const fixture = await createFixture({ duplicateSourceName: true });

    await expect(
      execFileAsync("bin/run.js", ["start"], {
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

    const result = await execFileAsync("bin/run.js", ["doctor"], {
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
    readonly waitForListRelease?: boolean | undefined;
  } = {},
): Promise<{ readonly environment: NodeJS.ProcessEnv; readonly listReleasePath: string }> {
  const root = await mkdtemp(join(tmpdir(), "groundcrew-v2-doctor-"));
  fixtureRoots.push(root);
  const configHome = join(root, "config");
  const kind = options.kind ?? "fixture";
  const sourceDirectory = join(configHome, "groundcrew", "task-sources", kind);
  const tasksPath = join(root, "tasks.json");
  const listReleasePath = join(root, "list-release");
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
      ...(options.waitForListRelease === true ? { FIXTURE_LIST_RELEASE: listReleasePath } : {}),
      GROUNDCREW_CONFIG: configPath,
      PATH: `${fakeBin}:${process.env["PATH"]}`,
      XDG_CONFIG_HOME: configHome,
      XDG_STATE_HOME: join(root, "state"),
    },
    listReleasePath,
  };
}

async function waitForOutput(input: {
  readonly expected: string;
  readonly read: () => string;
}): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!input.read().includes(input.expected)) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for output: ${input.expected}`);
    }
    await new Promise((resolvePromise) => {
      setTimeout(resolvePromise, 10);
    });
  }
}
