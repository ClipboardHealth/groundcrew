import { execFile } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("crew start", () => {
  beforeAll(async () => {
    await Promise.all(
      ["claude", "cmux", "codex"].map(
        async (executable) => await chmod(`e2e/fixtures/fake-bin/${executable}`, 0o755),
      ),
    );
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
    const logs = (await readFile(join(dirname(fixture.runsDirectory), "groundcrew.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(logs.map((entry) => entry.event)).toEqual(
      expect.arrayContaining([
        "run_started",
        "artifact_added",
        "writeback_completed",
        "run_completed",
        "cleanup_completed",
      ]),
    );
    expect(
      logs
        .filter((entry) => entry.canonicalTaskId === "fixture:ENG-123")
        .every((entry) => entry.runId === runIdFrom(logs)),
    ).toBe(true);
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

  it("uses source get when an explicitly requested task is absent from list", async () => {
    const fixture = await createDispatchFixture({ listedTasks: [], repositories: [] });

    const result = await runCrew({
      arguments: ["start", "ENG-123"],
      environment: fixture.environment,
    });

    expect(result.stdout).toContain("Started fixture:ENG-123");
  });

  it("preserves and reports a dirty partial worktree when initial prepare fails", async () => {
    const fixture = await createDispatchFixture({
      prepareWorktree: "touch prepare-output.txt; exit 23",
    });

    await expect(
      runCrew({ arguments: ["start"], environment: fixture.environment }),
    ).rejects.toMatchObject({
      code: 1,
    });

    const status = JSON.parse(
      (
        await runCrew({
          arguments: ["status", "ENG-123", "--json"],
          environment: fixture.environment,
        })
      ).stdout,
    );
    expect(status.tasks[0].observed.repositories).toMatchObject([
      { dirtyPaths: ["prepare-output.txt"], repository: "sample" },
    ]);
    await expect(
      runCrew({ arguments: ["cleanup", "ENG-123"], environment: fixture.environment }),
    ).rejects.toMatchObject({ code: 1 });
    await runCrew({
      arguments: ["cleanup", "ENG-123", "--allow-dirty"],
      environment: fixture.environment,
    });
    await expect(stat(fixture.workspaceDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves and reports a dirty partial worktree when repo add prepare fails", async () => {
    const fixture = await createDispatchFixture({
      prepareWorktree: "touch prepare-output.txt; exit 23",
      repositories: [],
    });
    await runCrew({ arguments: ["start"], environment: fixture.environment });

    await expect(
      runCrew({
        arguments: ["repo", "add", "sample", "--task", "ENG-123"],
        environment: fixture.environment,
      }),
    ).rejects.toMatchObject({ code: 1 });

    const status = JSON.parse(
      (
        await runCrew({
          arguments: ["status", "ENG-123", "--json"],
          environment: fixture.environment,
        })
      ).stdout,
    );
    expect(status.tasks[0].observed.repositories).toMatchObject([
      { dirtyPaths: ["prepare-output.txt"], repository: "sample" },
    ]);
    expect(status.tasks[0].run).toMatchObject({
      outcome: "failed",
      reason: expect.stringContaining("touch prepare-output.txt; exit 23"),
      state: "complete",
    });
    await expect(
      runCrew({ arguments: ["cleanup", "ENG-123"], environment: fixture.environment }),
    ).rejects.toMatchObject({ code: 1 });
  });

  it("rejects artifact and repository mutations after completion", async () => {
    const fixture = await createDispatchFixture({ repositories: [] });
    await runCrew({ arguments: ["start"], environment: fixture.environment });
    await runCrew({ arguments: ["done", "--task", "ENG-123"], environment: fixture.environment });

    await expect(
      runCrew({
        arguments: ["artifact", "add", "late-output", "--task", "ENG-123"],
        environment: fixture.environment,
      }),
    ).rejects.toMatchObject({ code: 1 });
    await expect(
      runCrew({
        arguments: ["repo", "add", "sample", "--task", "ENG-123"],
        environment: fixture.environment,
      }),
    ).rejects.toMatchObject({ code: 1 });

    const run = JSON.parse(
      await readFile(join(fixture.runsDirectory, "fixture-eng-123.json"), "utf8"),
    );
    const marker = JSON.parse(
      await readFile(join(fixture.workspaceDirectory, ".groundcrew", "task.json"), "utf8"),
    );
    expect(run.artifacts).toEqual([]);
    expect(run.repositories).toEqual([]);
    expect(marker.repositories).toEqual([]);
  });

  it("does not overwrite a terminal outcome when done is repeated", async () => {
    const fixture = await createDispatchFixture({ repositories: [] });
    await runCrew({ arguments: ["start"], environment: fixture.environment });
    await runCrew({ arguments: ["done", "--task", "ENG-123"], environment: fixture.environment });

    await expect(
      runCrew({
        arguments: ["done", "--outcome", "failed", "--task", "ENG-123"],
        environment: fixture.environment,
      }),
    ).rejects.toMatchObject({ code: 1 });

    expect(
      JSON.parse(await readFile(join(fixture.runsDirectory, "fixture-eng-123.json"), "utf8")),
    ).toMatchObject({ outcome: "delivered", state: "complete" });
  });

  it("does not hold a stealable run lock while a repository prepare command runs", async () => {
    const fixture = await createDispatchFixture({
      prepareWorktree:
        "touch ../repo-add-started; while [ ! -f ../repo-add-release ]; do sleep 0.05; done",
      repositories: [],
    });
    await runCrew({ arguments: ["start"], environment: fixture.environment });

    const acquisition = runCrew({
      arguments: ["repo", "add", "sample", "--task", "ENG-123"],
      environment: fixture.environment,
    });
    await waitForPath(join(fixture.workspaceDirectory, "repo-add-started"));

    await expect(stat(join(fixture.runsDirectory, "fixture-eng-123.lock"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      runCrew({ arguments: ["done", "--task", "ENG-123"], environment: fixture.environment }),
    ).rejects.toMatchObject({ code: 1 });
    expect(
      JSON.parse(await readFile(join(fixture.runsDirectory, "fixture-eng-123.json"), "utf8")),
    ).toMatchObject({ state: "running" });
    await writeFile(join(fixture.workspaceDirectory, "repo-add-release"), "release\n");
    await acquisition;
  });

  it("persists a terminal verdict for a visible task", async () => {
    const fixture = await createDispatchFixture({
      tasks: [task({ repositories: [], terminal: true })],
    });

    const result = await runCrew({ arguments: ["start"], environment: fixture.environment });
    const status = JSON.parse(
      (
        await runCrew({
          arguments: ["status", "ENG-123", "--json"],
          environment: fixture.environment,
        })
      ).stdout,
    );

    expect(result.stdout).toContain("Skipped fixture:ENG-123");
    expect(status.tasks[0].verdict).toMatchObject({ reason: "terminal" });
  });

  it("fetches before provisioning and safely moves a reusable branch to the fetched tip", async () => {
    const fixture = await createDispatchFixture();
    const repository = join(fixture.baseDirectory, "sample");
    await runGit({ arguments: ["branch", "crew/fixture-eng-123"], cwd: repository });
    await writeFile(join(repository, "README.md"), "fetched tip\n");
    await runGit({ arguments: ["add", "README.md"], cwd: repository });
    await runGit({
      arguments: [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "-m",
        "advance main",
      ],
      cwd: repository,
    });
    await runGit({ arguments: ["push", "origin", "main"], cwd: repository });

    await runCrew({ arguments: ["start"], environment: fixture.environment });

    expect(await readFile(join(fixture.workspaceDirectory, "sample", "README.md"), "utf8")).toBe(
      "fetched tip\n",
    );
    const [head, remoteHead] = await Promise.all([
      gitOutput({
        arguments: ["rev-parse", "HEAD"],
        cwd: join(fixture.workspaceDirectory, "sample"),
      }),
      gitOutput({ arguments: ["rev-parse", "origin/main"], cwd: repository }),
    ]);
    expect(head).toBe(remoteHead);
  });

  it("refuses a task branch with commits absent from the remote default branch", async () => {
    const fixture = await createDispatchFixture();
    const repository = join(fixture.baseDirectory, "sample");
    await runGit({ arguments: ["switch", "-c", "crew/fixture-eng-123"], cwd: repository });
    await writeFile(join(repository, "unique.txt"), "preserve me\n");
    await runGit({ arguments: ["add", "unique.txt"], cwd: repository });
    await runGit({
      arguments: [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "-m",
        "unique task work",
      ],
      cwd: repository,
    });
    const uniqueTip = await gitOutput({ arguments: ["rev-parse", "HEAD"], cwd: repository });
    await runGit({ arguments: ["switch", "main"], cwd: repository });

    await expect(
      runCrew({ arguments: ["start"], environment: fixture.environment }),
    ).rejects.toMatchObject({
      code: 1,
    });

    expect(
      await gitOutput({ arguments: ["rev-parse", "crew/fixture-eng-123"], cwd: repository }),
    ).toBe(uniqueTip);
    await expect(stat(fixture.workspaceDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("routes two profiles sharing Codex and preserves existing trust configuration", async () => {
    const fixture = await createDispatchFixture({
      maximumInProgress: 2,
      profiles: {
        "codex-max": { effort: "max", kind: "codex", model: "model-max" },
        "codex-low": { effort: "low", kind: "codex", model: "model-low" },
      },
      tasks: [
        task({ agentProfile: "codex-low", id: "LOW-1", repositories: [] }),
        task({ agentProfile: "codex-max", id: "MAX-1", repositories: [] }),
      ],
    });
    const codexConfig = join(fixture.root, "codex", "config.toml");
    await mkdir(dirname(codexConfig), { recursive: true });
    await writeFile(codexConfig, '[notice]\nvalue = "keep"\n');

    await runCrew({ arguments: ["start"], environment: fixture.environment });

    const calls = (await readFile(fixture.cmuxCallsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const commands = calls
      .filter((call) => call.arguments[0] === "new-workspace")
      .map((call) => call.arguments[call.arguments.indexOf("--command") + 1]);
    expect(commands).toEqual(
      expect.arrayContaining([
        expect.stringContaining("--model' 'model-low"),
        expect.stringContaining('model_reasoning_effort="low"'),
        expect.stringContaining("--model' 'model-max"),
        expect.stringContaining('model_reasoning_effort="max"'),
      ]),
    );
    const trust = await readFile(codexConfig, "utf8");
    expect(trust).toContain('[notice]\nvalue = "keep"');
    expect(trust.match(/trust_level = "trusted"/g)).toHaveLength(2);
  });

  it("composes Claude model and effort arguments while preserving trust entries", async () => {
    const fixture = await createDispatchFixture({
      profiles: { opus: { effort: "xhigh", kind: "claude", model: "opus" } },
      repositories: [],
      tasks: [task({ agentProfile: "opus", repositories: [] })],
    });
    fixture.environment["HOME"] = fixture.root;
    await writeFile(
      join(fixture.root, ".claude.json"),
      JSON.stringify({ preserved: true, projects: { "/existing": { keep: "yes" } } }),
    );

    await runCrew({ arguments: ["start"], environment: fixture.environment });

    const calls = (await readFile(fixture.cmuxCallsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const launch = calls.find((call) => call.arguments[0] === "new-workspace");
    const command = launch.arguments[launch.arguments.indexOf("--command") + 1];
    expect(command).toContain("'claude' '--permission-mode' 'auto'");
    expect(command).toContain("'--model' 'opus' '--effort' 'xhigh'");
    const trust = JSON.parse(await readFile(join(fixture.root, ".claude.json"), "utf8"));
    expect(trust).toMatchObject({ preserved: true, projects: { "/existing": { keep: "yes" } } });
    expect(trust.projects[fixture.workspaceDirectory]).toMatchObject({
      hasCompletedProjectOnboarding: true,
      hasTrustDialogAccepted: true,
    });
  });

  it("records a diagnosable failed run when the presenter cannot open", async () => {
    const fixture = await createDispatchFixture({ failPresenterOpen: true, repositories: [] });

    await expect(
      runCrew({ arguments: ["start"], environment: fixture.environment }),
    ).rejects.toMatchObject({
      code: 1,
    });

    const run = JSON.parse(
      await readFile(join(fixture.runsDirectory, "fixture-eng-123.json"), "utf8"),
    );
    expect(run).toMatchObject({ outcome: "failed", state: "complete" });
    expect(run.reason).toContain("fake cmux open failure");
  });

  it("records agent-unavailable without claiming when the profile harness is absent", async () => {
    const fixture = await createDispatchFixture({
      profiles: { missing: { effort: "high", kind: "claude" } },
      repositories: [],
      tasks: [task({ agentProfile: "missing", repositories: [] })],
    });
    fixture.environment["PATH"] = [dirname(process.execPath), "/usr/bin", "/bin"].join(":");

    await runCrew({ arguments: ["start"], environment: fixture.environment });

    const verdicts = JSON.parse(
      await readFile(join(dirname(fixture.runsDirectory), "dispatch.json"), "utf8"),
    );
    expect(verdicts["fixture:ENG-123"]).toMatchObject({
      detail: "missing harness executable claude",
      reason: "agent-unavailable",
    });
    expect(await readFile(fixture.updatesPath, "utf8")).toBe("");
    await expect(stat(join(fixture.runsDirectory, "fixture-eng-123.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("fails a running run when its presented workspace disappears", async () => {
    const fixture = await createDispatchFixture({ repositories: [] });
    await runCrew({ arguments: ["start"], environment: fixture.environment });
    await writeFile(fixture.cmuxStatePath, '{"workspaces":[]}');

    await runCrew({ arguments: ["status", "ENG-123", "--json"], environment: fixture.environment });

    const run = JSON.parse(
      await readFile(join(fixture.runsDirectory, "fixture-eng-123.json"), "utf8"),
    );
    expect(run).toMatchObject({
      outcome: "failed",
      reason: "workspace-missing",
      state: "complete",
    });
    expect(await stat(fixture.workspaceDirectory)).toBeDefined();
  });

  it("reconciles a missing workspace before delivered completion", async () => {
    const fixture = await createDispatchFixture({ repositories: [] });
    await runCrew({ arguments: ["start"], environment: fixture.environment });
    await writeFile(fixture.cmuxStatePath, '{"workspaces":[]}');

    await expect(
      runCrew({ arguments: ["done", "--task", "ENG-123"], environment: fixture.environment }),
    ).rejects.toMatchObject({ code: 1 });

    expect(
      JSON.parse(await readFile(join(fixture.runsDirectory, "fixture-eng-123.json"), "utf8")),
    ).toMatchObject({ outcome: "failed", reason: "workspace-missing", state: "complete" });
  });

  it("resolves interrupted provisioning from presenter workspace existence", async () => {
    const fixture = await createDispatchFixture({ repositories: [] });
    await runCrew({ arguments: ["start"], environment: fixture.environment });
    const runPath = join(fixture.runsDirectory, "fixture-eng-123.json");
    const run = JSON.parse(await readFile(runPath, "utf8"));
    await writeFile(runPath, JSON.stringify({ ...run, state: "provisioning" }));

    await runCrew({ arguments: ["status", "ENG-123", "--json"], environment: fixture.environment });

    expect(JSON.parse(await readFile(runPath, "utf8"))).toMatchObject({ state: "running" });
  });

  it("fails interrupted provisioning when no presenter workspace exists", async () => {
    const fixture = await createDispatchFixture({ repositories: [] });
    await runCrew({ arguments: ["start"], environment: fixture.environment });
    const runPath = join(fixture.runsDirectory, "fixture-eng-123.json");
    const run = JSON.parse(await readFile(runPath, "utf8"));
    await writeFile(runPath, JSON.stringify({ ...run, state: "provisioning" }));
    await writeFile(fixture.cmuxStatePath, '{"workspaces":[]}');

    await runCrew({ arguments: ["status", "ENG-123", "--json"], environment: fixture.environment });

    expect(JSON.parse(await readFile(runPath, "utf8"))).toMatchObject({
      outcome: "failed",
      reason: "provisioning-interrupted",
      state: "complete",
    });
  });

  it("removes a clean worktree but preserves its branch when it has unique commits", async () => {
    const fixture = await createDispatchFixture();
    await runCrew({ arguments: ["start"], environment: fixture.environment });
    const worktree = join(fixture.workspaceDirectory, "sample");
    await writeFile(join(worktree, "delivered.txt"), "committed output\n");
    await runGit({ arguments: ["add", "delivered.txt"], cwd: worktree });
    await runGit({
      arguments: [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "-m",
        "delivered work",
      ],
      cwd: worktree,
    });
    const uniqueTip = await gitOutput({ arguments: ["rev-parse", "HEAD"], cwd: worktree });
    await runCrew({ arguments: ["done", "--task", "ENG-123"], environment: fixture.environment });

    const result = await runCrew({
      arguments: ["cleanup", "ENG-123"],
      environment: fixture.environment,
    });

    expect(result.stdout).toContain("Preserved branch sample:crew/fixture-eng-123");
    expect(
      await gitOutput({
        arguments: ["rev-parse", "crew/fixture-eng-123"],
        cwd: join(fixture.baseDirectory, "sample"),
      }),
    ).toBe(uniqueTip);
    await expect(stat(fixture.workspaceDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reaps terminal tasks only while their worktrees are clean", async () => {
    const fixture = await createDispatchFixture();
    await runCrew({ arguments: ["start"], environment: fixture.environment });
    await writeFile(join(fixture.workspaceDirectory, "sample", "dirty.txt"), "keep me\n");
    await writeFile(
      fixture.listedTasksPath,
      JSON.stringify([task({ repositories: ["sample"], terminal: true })]),
    );

    await runCrew({ arguments: ["start"], environment: fixture.environment });
    expect(await stat(fixture.workspaceDirectory)).toBeDefined();
    await writeFile(join(fixture.workspaceDirectory, "sample", "dirty.txt"), "");
    await runGit({
      arguments: ["clean", "-f"],
      cwd: join(fixture.workspaceDirectory, "sample"),
    });

    await runCrew({ arguments: ["start"], environment: fixture.environment });
    await expect(stat(fixture.workspaceDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

interface DispatchFixture {
  readonly baseDirectory: string;
  readonly cmuxCallsPath: string;
  readonly cmuxStatePath: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly listedTasksPath: string;
  readonly root: string;
  readonly runsDirectory: string;
  readonly updatesPath: string;
  readonly workspaceDirectory: string;
}

async function createDispatchFixture(
  options: {
    readonly repository?: string | undefined;
    readonly repositories?: readonly string[] | undefined;
    readonly listedTasks?: ReadonlyArray<Record<string, unknown>> | undefined;
    readonly tasks?: ReadonlyArray<Record<string, unknown>> | undefined;
    readonly rejectClaim?: string | undefined;
    readonly prepareWorktree?: string | undefined;
    readonly failPresenterOpen?: boolean | undefined;
    readonly maximumInProgress?: number | undefined;
    readonly profiles?: Readonly<Record<string, Record<string, unknown>>> | undefined;
  } = {},
): Promise<DispatchFixture> {
  const root = await mkdtemp(join(tmpdir(), "groundcrew-v2-dispatch-"));
  const configHome = join(root, "config");
  const stateHome = join(root, "state");
  const baseDirectory = join(root, "dev");
  const worktreeDirectory = join(root, "worktrees");
  const tasksPath = join(root, "tasks.json");
  const listedTasksPath = join(root, "listed-tasks.json");
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
  await writeFile(
    listedTasksPath,
    JSON.stringify(
      options.listedTasks ??
        options.tasks ?? [
          task({ repositories: options.repositories ?? [options.repository ?? "sample"] }),
        ],
    ),
  );
  const configPath = join(root, "crew.config.jsonc");
  await writeFile(
    configPath,
    JSON.stringify({
      agents: {
        default: Object.keys(options.profiles ?? { codex: {} })[0],
        profiles: options.profiles ?? { codex: { effort: "high", kind: "codex" } },
      },
      orchestrator: { maximumInProgress: options.maximumInProgress ?? 1 },
      sources: [{ kind: "fixture" }],
      workspace: {
        baseDirectory,
        prepareWorktree: options.prepareWorktree,
        worktreeDirectory,
      },
    }),
  );
  return {
    baseDirectory,
    cmuxCallsPath,
    cmuxStatePath,
    environment: {
      ...process.env,
      CODEX_HOME: join(root, "codex"),
      FAKE_CMUX_CALLS: cmuxCallsPath,
      FAKE_CMUX_FAIL_OPEN: options.failPresenterOpen ? "1" : undefined,
      FAKE_CMUX_STATE: cmuxStatePath,
      FIXTURE_TASKS: tasksPath,
      FIXTURE_LIST_TASKS: listedTasksPath,
      FIXTURE_UPDATES: updatesPath,
      FIXTURE_REJECT_CLAIMS: options.rejectClaim,
      GROUNDCREW_CONFIG: configPath,
      PATH: `${fakeBin}:${process.env["PATH"]}`,
      XDG_CONFIG_HOME: configHome,
      XDG_STATE_HOME: stateHome,
    },
    listedTasksPath,
    root,
    runsDirectory: join(stateHome, "groundcrew", "runs"),
    updatesPath,
    workspaceDirectory: join(worktreeDirectory, "fixture-eng-123"),
  };
}

function task(input: {
  readonly agentProfile?: string | undefined;
  readonly id?: string | undefined;
  readonly priority?: number | undefined;
  readonly repositories: readonly string[];
  readonly terminal?: boolean | undefined;
}): Record<string, unknown> {
  return {
    agentProfile: input.agentProfile ?? "codex",
    blocked: false,
    description: "Implement the requested change.",
    id: input.id ?? "ENG-123",
    priority: input.priority ?? 1,
    repositories: input.repositories,
    terminal: input.terminal ?? false,
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

async function gitOutput(input: {
  readonly arguments: readonly string[];
  readonly cwd: string;
}): Promise<string> {
  return (await execFileAsync("git", [...input.arguments], { cwd: input.cwd })).stdout.trim();
}

async function waitForPath(path: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      await stat(path);
      return;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
    // The child process must reach its prepare command before the assertion runs.
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error(`timed out waiting for ${path}`);
}

function runIdFrom(logs: ReadonlyArray<Record<string, unknown>>): unknown {
  return logs.find((entry) => entry["event"] === "run_started")?.["runId"];
}
