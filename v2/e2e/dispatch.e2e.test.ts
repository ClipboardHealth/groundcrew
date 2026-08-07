import { execFile } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("crew start", () => {
  beforeAll(async () => {
    await chmod("e2e/fixtures/fake-bin/cmux", 0o755);
  });

  it("claims, provisions, and launches a ready task exactly once", async () => {
    const fixture = await createDispatchFixture();

    const result = await execFileAsync(process.execPath, ["bin/run.js", "start"], {
      cwd: process.cwd(),
      env: fixture.environment,
    });

    const run = JSON.parse(
      await readFile(join(fixture.runsDirectory, "fixture-eng-123.json"), "utf8"),
    );
    const marker = JSON.parse(
      await readFile(join(fixture.workspaceDirectory, ".groundcrew", "task.json"), "utf8"),
    );
    const updates = (await readFile(fixture.updatesPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const calls = (await readFile(fixture.cmuxCallsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(result.stdout).toContain("Started fixture:ENG-123");
    expect(run.state).toBe("running");
    expect(run.runId).toMatch(/^r_[0-9a-f]{8}$/);
    expect(marker).toEqual({
      branch: "crew/fixture-eng-123",
      canonicalTaskId: "fixture:ENG-123",
      repositories: ["sample"],
      version: 1,
    });
    expect(updates).toEqual([{ event: { runId: run.runId, type: "claimed" }, id: "ENG-123" }]);
    expect(calls.filter((call) => call.arguments[0] === "new-workspace")).toHaveLength(1);
    expect(calls.at(-1).arguments).toContain("running");
    const launchArguments = calls.find((call) => call.arguments[0] === "new-workspace").arguments;
    const command = launchArguments[launchArguments.indexOf("--command") + 1];
    expect(command).toContain("codex");
    expect(command).toContain('model_reasoning_effort="high"');
    expect(command).toContain("Task: fixture:ENG-123");
    expect(launchArguments).toContain("GROUNDCREW_TASK_ID=fixture:ENG-123");
    expect(
      await readFile(
        join(dirname(fixture.workspaceDirectory), "..", "codex", "config.toml"),
        "utf8",
      ),
    ).toContain('trust_level = "trusted"');
  });

  it("records artifacts, completes, reports truth layers, and safely cleans up", async () => {
    const fixture = await createDispatchFixture();
    await runCrew({ arguments: ["start"], environment: fixture.environment });

    await runCrew({
      arguments: [
        "artifact",
        "add",
        "https://github.com/example/pull/1",
        "--kind",
        "pr",
        "--task",
        "ENG-123",
      ],
      environment: fixture.environment,
    });
    await runCrew({ arguments: ["done", "--task", "ENG-123"], environment: fixture.environment });
    const statusResult = await runCrew({
      arguments: ["status", "ENG-123", "--json"],
      environment: fixture.environment,
    });
    const status = JSON.parse(statusResult.stdout);

    expect(status.tasks[0].observed.repositories[0].dirtyPaths).toEqual([]);
    expect(status.tasks[0].reported).toMatchObject({
      artifacts: [{ kind: "pr", locator: "https://github.com/example/pull/1" }],
      outcome: "delivered",
    });
    const updates = (await readFile(fixture.updatesPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(updates[1]).toMatchObject({
      event: {
        artifacts: [{ kind: "pr", locator: "https://github.com/example/pull/1" }],
        outcome: "delivered",
        type: "completed",
      },
      id: "ENG-123",
    });

    await runCrew({ arguments: ["cleanup", "ENG-123"], environment: fixture.environment });
    await expect(stat(fixture.workspaceDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(fixture.runsDirectory, "fixture-eng-123.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("persists a missing-repository verdict without creating a partial workspace", async () => {
    const fixture = await createDispatchFixture({ repository: "missing" });

    await expect(
      runCrew({ arguments: ["start", "ENG-123"], environment: fixture.environment }),
    ).rejects.toMatchObject({ code: 2 });

    const dispatch = JSON.parse(
      await readFile(join(dirname(fixture.runsDirectory), "dispatch.json"), "utf8"),
    );
    expect(dispatch["fixture:ENG-123"]).toMatchObject({
      detail: "missing",
      reason: "repo-not-on-disk",
    });
    await expect(stat(fixture.workspaceDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("launches an empty workspace and acquires a repository at runtime", async () => {
    const fixture = await createDispatchFixture({ repositories: [] });
    await runCrew({ arguments: ["start"], environment: fixture.environment });

    await runCrew({
      arguments: ["repo", "add", "sample", "--task", "ENG-123"],
      environment: fixture.environment,
    });

    const marker = JSON.parse(
      await readFile(join(fixture.workspaceDirectory, ".groundcrew", "task.json"), "utf8"),
    );
    expect(marker.repositories).toEqual(["sample"]);
    expect(await readFile(join(fixture.workspaceDirectory, "sample", "README.md"), "utf8")).toBe(
      "sample\n",
    );
  });

  it("refuses delivered completion and cleanup while a worktree is dirty", async () => {
    const fixture = await createDispatchFixture();
    await runCrew({ arguments: ["start"], environment: fixture.environment });
    await writeFile(join(fixture.workspaceDirectory, "sample", "dirty.txt"), "uncommitted\n");

    await expect(
      runCrew({ arguments: ["done", "--task", "ENG-123"], environment: fixture.environment }),
    ).rejects.toMatchObject({ code: 1 });
    await expect(
      runCrew({ arguments: ["cleanup", "ENG-123"], environment: fixture.environment }),
    ).rejects.toMatchObject({ code: 1 });

    await runCrew({
      arguments: ["cleanup", "ENG-123", "--allow-dirty"],
      environment: fixture.environment,
    });
    await expect(stat(fixture.workspaceDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("dispatches urgent tasks first and records the concurrency verdict", async () => {
    const fixture = await createDispatchFixture({
      tasks: [
        task({ id: "LOW-1", priority: 4, repositories: [] }),
        task({ id: "URGENT-1", priority: 1, repositories: [] }),
      ],
    });

    const result = await runCrew({ arguments: ["start"], environment: fixture.environment });
    const dispatch = JSON.parse(
      await readFile(join(dirname(fixture.runsDirectory), "dispatch.json"), "utf8"),
    );

    expect(result.stdout).toContain("Started fixture:URGENT-1");
    expect(dispatch["fixture:LOW-1"].reason).toBe("slots-full");
  });

  it("removes the provisional run and records a rejected claim", async () => {
    const fixture = await createDispatchFixture({ rejectClaim: "ENG-123" });

    await runCrew({ arguments: ["start"], environment: fixture.environment });

    const dispatch = JSON.parse(
      await readFile(join(dirname(fixture.runsDirectory), "dispatch.json"), "utf8"),
    );
    expect(dispatch["fixture:ENG-123"].reason).toBe("claim-rejected");
    await expect(stat(join(fixture.runsDirectory, "fixture-eng-123.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

interface DispatchFixture {
  readonly cmuxCallsPath: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly runsDirectory: string;
  readonly updatesPath: string;
  readonly workspaceDirectory: string;
}

async function createDispatchFixture(
  options: {
    readonly repository?: string | undefined;
    readonly repositories?: readonly string[] | undefined;
    readonly tasks?: ReadonlyArray<Record<string, unknown>> | undefined;
    readonly rejectClaim?: string | undefined;
  } = {},
): Promise<DispatchFixture> {
  const root = await mkdtemp(join(tmpdir(), "groundcrew-v2-dispatch-"));
  const configHome = join(root, "config");
  const stateHome = join(root, "state");
  const baseDirectory = join(root, "dev");
  const worktreeDirectory = join(root, "worktrees");
  const tasksPath = join(root, "tasks.json");
  const updatesPath = join(root, "updates.jsonl");
  const cmuxStatePath = join(root, "cmux-state.json");
  const cmuxCallsPath = join(root, "cmux-calls.jsonl");
  const fakeBin = join(process.cwd(), "e2e", "fixtures", "fake-bin");
  const sourceDirectory = join(configHome, "groundcrew", "task-sources", "fixture");
  await Promise.all([
    mkdir(dirname(sourceDirectory), { recursive: true }),
    mkdir(baseDirectory, { recursive: true }),
    writeFile(cmuxStatePath, '{"workspaces":[]}'),
    writeFile(cmuxCallsPath, ""),
    writeFile(updatesPath, ""),
  ]);
  await cp("e2e/fixtures/source", sourceDirectory, { recursive: true });
  await createRepository({ baseDirectory, root });
  await writeFile(
    tasksPath,
    JSON.stringify(
      options.tasks ?? [
        task({ repositories: options.repositories ?? [options.repository ?? "sample"] }),
      ],
    ),
  );
  const configPath = join(root, "crew.config.jsonc");
  await writeFile(
    configPath,
    JSON.stringify({
      agents: { default: "codex", profiles: { codex: { effort: "high", kind: "codex" } } },
      orchestrator: { maximumInProgress: 1 },
      sources: [{ kind: "fixture" }],
      workspace: { baseDirectory, worktreeDirectory },
    }),
  );
  return {
    cmuxCallsPath,
    environment: {
      ...process.env,
      CODEX_HOME: join(root, "codex"),
      FAKE_CMUX_CALLS: cmuxCallsPath,
      FAKE_CMUX_STATE: cmuxStatePath,
      FIXTURE_TASKS: tasksPath,
      FIXTURE_UPDATES: updatesPath,
      FIXTURE_REJECT_CLAIMS: options.rejectClaim,
      GROUNDCREW_CONFIG: configPath,
      PATH: `${fakeBin}:${process.env["PATH"]}`,
      XDG_CONFIG_HOME: configHome,
      XDG_STATE_HOME: stateHome,
    },
    runsDirectory: join(stateHome, "groundcrew", "runs"),
    updatesPath,
    workspaceDirectory: join(worktreeDirectory, "fixture-eng-123"),
  };
}

function task(input: {
  readonly id?: string | undefined;
  readonly priority?: number | undefined;
  readonly repositories: readonly string[];
}): Record<string, unknown> {
  return {
    agentProfile: "codex",
    blocked: false,
    description: "Implement the requested change.",
    id: input.id ?? "ENG-123",
    priority: input.priority ?? 1,
    repositories: input.repositories,
    terminal: false,
    title: "Ready task",
  };
}

async function runCrew(input: {
  readonly arguments: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
}): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return await execFileAsync(process.execPath, ["bin/run.js", ...input.arguments], {
    cwd: process.cwd(),
    env: input.environment,
  });
}

async function createRepository(input: {
  readonly baseDirectory: string;
  readonly root: string;
}): Promise<void> {
  const remote = join(input.root, "sample.git");
  const repository = join(input.baseDirectory, "sample");
  await runGit({ arguments: ["init", "--bare", remote], cwd: input.root });
  await runGit({ arguments: ["clone", remote, repository], cwd: input.root });
  await writeFile(join(repository, "README.md"), "sample\n");
  await runGit({ arguments: ["add", "README.md"], cwd: repository });
  await runGit({
    arguments: [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "initial",
    ],
    cwd: repository,
  });
  await runGit({ arguments: ["branch", "-M", "main"], cwd: repository });
  await runGit({ arguments: ["push", "-u", "origin", "main"], cwd: repository });
  await runGit({ arguments: ["symbolic-ref", "HEAD", "refs/heads/main"], cwd: remote });
}

async function runGit(input: {
  readonly arguments: readonly string[];
  readonly cwd: string;
}): Promise<void> {
  await execFileAsync("git", [...input.arguments], { cwd: input.cwd });
}
