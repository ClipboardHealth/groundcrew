import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { RunModule, seedWorkspaceTrust, withFileLock } from "./index.js";

describe("RunModule lifecycle", () => {
  it("owns failure transitions and preserves the first terminal outcome", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "groundcrew-v2-run-lifecycle-"));
    const runs = new RunModule({
      environment: process.env,
      presenterName: "cmux",
      stateRoot,
    });
    const provisioning = await runs.beginDispatch({
      agentProfile: "codex",
      canonicalTaskId: "fixture:ENG-123",
      repositories: ["sample"],
      workspaceDirectory: join(stateRoot, "workspace"),
    });

    const failed = await provisioning.fail({ reason: "prepare-failed:sample" });
    const repeated = await provisioning.fail({ reason: "workspace-missing" });

    expect(failed).toMatchObject({
      run: {
        record: {
          canonicalTaskId: "fixture:ENG-123",
          outcome: "failed",
          reason: "prepare-failed:sample",
          state: "complete",
          version: 1,
          writebackPending: true,
        },
        state: "complete",
      },
      transitioned: true,
    });
    expect(failed.run.record.events.map(({ event }) => event)).toEqual([
      "provisioning",
      "complete:failed",
    ]);
    expect(repeated).toMatchObject({
      run: { record: { reason: "prepare-failed:sample" }, state: "complete" },
      transitioned: false,
    });
  });

  it("launches the presented workspace before returning a running Run", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "groundcrew-v2-run-launch-"));
    const presentedWorkspaceStatePath = join(stateRoot, "presented-workspaces.json");
    const presenterCallsPath = join(stateRoot, "presenter-calls.jsonl");
    const fakeBin = join(process.cwd(), "e2e", "fixtures", "fake-bin");
    await Promise.all([
      writeFile(presentedWorkspaceStatePath, '{"workspaces":[]}'),
      writeFile(presenterCallsPath, ""),
    ]);
    const environment = {
      ...process.env,
      FAKE_CMUX_CALLS: presenterCallsPath,
      FAKE_CMUX_STATE: presentedWorkspaceStatePath,
      HOME: stateRoot,
      PATH: `${fakeBin}:${process.env["PATH"]}`,
    };
    const workspaceDirectory = join(stateRoot, "workspace");
    await mkdir(workspaceDirectory);
    const runs = new RunModule({ environment, presenterName: "cmux", stateRoot });
    const provisioning = await runs.beginDispatch({
      agentProfile: "codex",
      canonicalTaskId: "fixture:ENG-123",
      repositories: [],
      workspaceDirectory,
    });

    const launched = await provisioning.launch({
      acquiredRepositories: [],
      branch: "agent/fixture-eng-123",
      profile: { effort: "high", kind: "codex" },
      task: {
        canonicalTaskId: "fixture:ENG-123",
        repositories: [],
        title: "Deepen the Run module",
      },
    });

    expect(launched).toMatchObject({
      run: { record: { state: "running" }, state: "running" },
      transitioned: true,
    });
    expect(launched.run.record.events.map(({ event }) => event)).toEqual([
      "provisioning",
      "running",
    ]);
    expect(await readFile(presenterCallsPath, "utf8")).toContain("new-workspace");
  });

  it("owns reported Artifacts, completion, and writeback acknowledgement", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "groundcrew-v2-run-completion-"));
    const presentedWorkspaceStatePath = join(stateRoot, "presented-workspaces.json");
    const presenterCallsPath = join(stateRoot, "presenter-calls.jsonl");
    const fakeBin = join(process.cwd(), "e2e", "fixtures", "fake-bin");
    await Promise.all([
      writeFile(presentedWorkspaceStatePath, '{"workspaces":[]}'),
      writeFile(presenterCallsPath, ""),
    ]);
    const workspaceDirectory = join(stateRoot, "workspace");
    await mkdir(workspaceDirectory);
    const runs = new RunModule({
      environment: {
        ...process.env,
        FAKE_CMUX_CALLS: presenterCallsPath,
        FAKE_CMUX_STATE: presentedWorkspaceStatePath,
        HOME: stateRoot,
        PATH: `${fakeBin}:${process.env["PATH"]}`,
      },
      presenterName: "cmux",
      stateRoot,
    });
    const provisioning = await runs.beginDispatch({
      agentProfile: "codex",
      canonicalTaskId: "fixture:ENG-123",
      repositories: [],
      workspaceDirectory,
    });
    const launched = await provisioning.launch({
      acquiredRepositories: [],
      branch: "agent/fixture-eng-123",
      profile: { effort: "high", kind: "codex" },
      task: {
        canonicalTaskId: "fixture:ENG-123",
        repositories: [],
        title: "Deepen the Run module",
      },
    });

    const withArtifact = await launched.run.reportArtifact({
      artifact: { kind: "pull-request", locator: "https://example.test/pull/123" },
    });
    let assertedWorkspaceIdle = false;
    const completed = await withArtifact.finish({
      assertWorkspaceIdle: async (record) => {
        assertedWorkspaceIdle = record.workspaceDirectory === workspaceDirectory;
      },
      message: "Shipped",
      outcome: "delivered",
    });
    const completion = completed.record.events.at(-1);
    if (completion === undefined) {
      throw new Error("completion event missing");
    }

    await expect(
      completed.acknowledgeSourceWriteback({
        expectedCompletionTimestamp: "stale",
        expectedRunId: completed.record.runId,
      }),
    ).rejects.toThrow("stale source writeback acknowledgement");
    const acknowledged = await completed.acknowledgeSourceWriteback({
      expectedCompletionTimestamp: completion.timestamp,
      expectedRunId: completed.record.runId,
    });

    expect(assertedWorkspaceIdle).toBe(true);
    expect(completed.record).toMatchObject({
      artifacts: [{ kind: "pull-request", locator: "https://example.test/pull/123" }],
      message: "Shipped",
      outcome: "delivered",
      state: "complete",
      writebackPending: true,
    });
    expect(completed.record.events.map(({ event }) => event)).toEqual([
      "provisioning",
      "running",
      "artifact-added",
      "complete:delivered",
    ]);
    expect(acknowledged.record.writebackPending).toBe(false);
  });

  it("stops for cleanup and removes only an acknowledged completed Run", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "groundcrew-v2-run-cleanup-"));
    const runs = new RunModule({
      environment: process.env,
      presenterName: "cmux",
      stateRoot,
    });
    const provisioning = await runs.beginDispatch({
      agentProfile: "codex",
      canonicalTaskId: "fixture:ENG-123",
      repositories: [],
      workspaceDirectory: join(stateRoot, "workspace"),
    });

    const stopped = await provisioning.stopForCleanup({
      assertWorkspaceIdle: async () => {},
    });
    const repeated = await provisioning.stopForCleanup({
      assertWorkspaceIdle: async () => {},
    });
    await expect(stopped.run.remove()).rejects.toThrow("source writeback is pending");
    const completion = stopped.run.record.events.at(-1);
    if (completion === undefined) {
      throw new Error("completion event missing");
    }
    const acknowledged = await stopped.run.acknowledgeSourceWriteback({
      expectedCompletionTimestamp: completion.timestamp,
      expectedRunId: stopped.run.record.runId,
    });
    await acknowledged.remove();

    expect(stopped).toMatchObject({
      run: { record: { outcome: "stopped", writebackPending: true }, state: "complete" },
      transitioned: true,
    });
    expect(repeated).toMatchObject({
      run: { record: { outcome: "stopped" }, state: "complete" },
      transitioned: false,
    });
    await expect(runs.findBySlug({ slug: "fixture-eng-123" })).resolves.toBeUndefined();
  });

  it("discards an unclaimed Run after recovery already completed it", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "groundcrew-v2-run-rejected-race-"));
    const runs = new RunModule({
      environment: process.env,
      presenterName: "cmux",
      stateRoot,
    });
    const provisioning = await runs.beginDispatch({
      agentProfile: "codex",
      canonicalTaskId: "fixture:ENG-123",
      repositories: [],
      workspaceDirectory: join(stateRoot, "workspace"),
    });
    await provisioning.fail({ reason: "provisioning-interrupted" });

    await expect(provisioning.discardUnclaimed()).resolves.toBeUndefined();
    await expect(runs.findBySlug({ slug: "fixture-eng-123" })).resolves.toBeUndefined();
  });

  it("reconciles Run state from one presented Workspace probe", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "groundcrew-v2-run-reconcile-"));
    const presentedWorkspaceStatePath = join(stateRoot, "presented-workspaces.json");
    const presenterCallsPath = join(stateRoot, "presenter-calls.jsonl");
    const fakeBin = join(process.cwd(), "e2e", "fixtures", "fake-bin");
    await Promise.all([
      writeFile(
        presentedWorkspaceStatePath,
        JSON.stringify({
          workspaces: [
            {
              description: "groundcrew:fixture:ENG-123",
              id: "workspace-1",
              title: "eng-123",
            },
          ],
        }),
      ),
      writeFile(presenterCallsPath, ""),
    ]);
    const runs = new RunModule({
      environment: {
        ...process.env,
        FAKE_CMUX_CALLS: presenterCallsPath,
        FAKE_CMUX_STATE: presentedWorkspaceStatePath,
        PATH: `${fakeBin}:${process.env["PATH"]}`,
      },
      presenterName: "cmux",
      stateRoot,
    });
    const provisioning = await runs.beginDispatch({
      agentProfile: "codex",
      canonicalTaskId: "fixture:ENG-123",
      repositories: [],
      workspaceDirectory: join(stateRoot, "workspace"),
    });

    const started = await runs.reconcilePresentedWorkspace({
      run: provisioning,
      snapshot: await runs.capturePresentedWorkspaces(),
    });
    await writeFile(presentedWorkspaceStatePath, '{"workspaces":[]}');
    if (started?.type !== "running") {
      throw new Error("provisioning run was not reconciled");
    }
    const failed = await runs.reconcilePresentedWorkspace({
      run: started.run,
      snapshot: await runs.capturePresentedWorkspaces(),
    });

    expect(started).toMatchObject({
      run: { record: { state: "running" }, state: "running" },
      type: "running",
    });
    expect(failed).toMatchObject({
      reason: "workspace-missing",
      run: {
        record: { outcome: "failed", state: "complete", writebackPending: true },
        state: "complete",
      },
      type: "failed",
    });
  });

  it("treats a reconciliation-won launch transition as unchanged", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "groundcrew-v2-run-launch-race-"));
    const presentedWorkspaceStatePath = join(stateRoot, "presented-workspaces.json");
    const presenterCallsPath = join(stateRoot, "presenter-calls.jsonl");
    const fakeBin = join(process.cwd(), "e2e", "fixtures", "fake-bin");
    await Promise.all([
      writeFile(
        presentedWorkspaceStatePath,
        JSON.stringify({
          workspaces: [
            {
              description: "groundcrew:fixture:ENG-123",
              id: "workspace-1",
              title: "eng-123",
            },
          ],
        }),
      ),
      writeFile(presenterCallsPath, ""),
    ]);
    const workspaceDirectory = join(stateRoot, "workspace");
    await mkdir(workspaceDirectory);
    const runs = new RunModule({
      environment: {
        ...process.env,
        FAKE_CMUX_CALLS: presenterCallsPath,
        FAKE_CMUX_STATE: presentedWorkspaceStatePath,
        HOME: stateRoot,
        PATH: `${fakeBin}:${process.env["PATH"]}`,
      },
      presenterName: "cmux",
      stateRoot,
    });
    const provisioning = await runs.beginDispatch({
      agentProfile: "codex",
      canonicalTaskId: "fixture:ENG-123",
      repositories: [],
      workspaceDirectory,
    });
    await runs.reconcilePresentedWorkspace({
      run: provisioning,
      snapshot: await runs.capturePresentedWorkspaces(),
    });

    const launched = await provisioning.launch({
      acquiredRepositories: [],
      branch: "agent/fixture-eng-123",
      profile: { effort: "high", kind: "codex" },
      task: {
        canonicalTaskId: "fixture:ENG-123",
        repositories: [],
        title: "Deepen the Run module",
      },
    });

    expect(launched).toMatchObject({
      run: { record: { state: "running" }, state: "running" },
      transitioned: false,
    });
    expect(launched.run.record.events.map(({ event }) => event)).toEqual([
      "provisioning",
      "running",
    ]);
    expect(await readFile(presenterCallsPath, "utf8")).not.toContain("new-workspace");
  });
});

describe("RunModule concurrency", () => {
  it("reserves dispatch without colliding with a matching task lock name", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "groundcrew-v2-run-admission-lock-"));
    const runs = new RunModule({
      environment: process.env,
      presenterName: "cmux",
      stateRoot,
    });
    const currentTime = Date.now();
    const mockDateNow = vi.spyOn(Date, "now").mockReturnValue(currentTime + 31_000);

    try {
      const reservation = await runs.reserveDispatch({
        agentProfile: "codex",
        canonicalTaskId: "dispatch:admission",
        force: false,
        maximumInProgress: 1,
        repositories: [],
        workspaceDirectory: join(stateRoot, "workspace"),
      });

      expect(reservation).toMatchObject({ type: "reserved" });
      expect(mockDateNow).not.toHaveBeenCalled();
    } finally {
      mockDateNow.mockRestore();
    }
  });

  it("creates one durable run when initial writers race", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "groundcrew-v2-run-race-"));
    const runs = new RunModule({
      environment: process.env,
      presenterName: "cmux",
      stateRoot,
    });

    const results = await Promise.allSettled(
      Array.from(
        { length: 20 },
        async () =>
          await runs.beginDispatch({
            agentProfile: "codex",
            canonicalTaskId: "fixture:ENG-123",
            repositories: [],
            workspaceDirectory: join(stateRoot, "workspace"),
          }),
      ),
    );

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect({ fulfilled: fulfilled.length, rejected: rejected.length }).toEqual({
      fulfilled: 1,
      rejected: 19,
    });
    const stored = await runs.findBySlug({ slug: "fixture-eng-123" });
    expect(stored?.record.runId).toBe(fulfilled[0]?.value.record.runId);
  });

  it("allows concurrent cleanup removals to converge", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "groundcrew-v2-run-remove-race-"));
    const runs = new RunModule({
      environment: process.env,
      presenterName: "cmux",
      stateRoot,
    });
    const provisioning = await runs.beginDispatch({
      agentProfile: "codex",
      canonicalTaskId: "fixture:ENG-123",
      repositories: [],
      workspaceDirectory: join(stateRoot, "workspace"),
    });
    const stopped = await provisioning.stopForCleanup({ assertWorkspaceIdle: async () => {} });
    const completion = stopped.run.record.events.at(-1);
    if (completion === undefined) {
      throw new Error("completion event missing");
    }
    const acknowledged = await stopped.run.acknowledgeSourceWriteback({
      expectedCompletionTimestamp: completion.timestamp,
      expectedRunId: stopped.run.record.runId,
    });

    await expect(Promise.all([acknowledged.remove(), acknowledged.remove()])).resolves.toEqual([
      undefined,
      undefined,
    ]);
  });

  it("does not repair repositories on a replacement Run", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "groundcrew-v2-run-repair-race-"));
    const runs = new RunModule({
      environment: process.env,
      presenterName: "cmux",
      stateRoot,
    });
    const first = await runs.beginDispatch({
      agentProfile: "codex",
      canonicalTaskId: "fixture:ENG-123",
      repositories: ["old"],
      workspaceDirectory: join(stateRoot, "old-workspace"),
    });
    await first.discardUnclaimed();
    const replacement = await runs.beginDispatch({
      agentProfile: "codex",
      canonicalTaskId: "fixture:ENG-123",
      repositories: ["replacement"],
      workspaceDirectory: join(stateRoot, "replacement-workspace"),
    });

    const repaired = await runs.repairRepositories({
      canonicalTaskId: first.record.canonicalTaskId,
      expectedRunId: first.record.runId,
      repositories: ["stale"],
    });

    expect(repaired).toMatchObject({
      run: {
        record: { repositories: ["replacement"], runId: replacement.record.runId },
      },
      transitioned: false,
    });
  });
});

describe("withFileLock", () => {
  it("preserves the operation failure when releasing the lock also fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "groundcrew-v2-lock-release-"));
    const lockPath = join(root, "run.lock");
    const operationError = new Error("operation failed");

    try {
      await expect(
        withFileLock({
          path: lockPath,
          operation: async () => {
            await rm(join(lockPath, "owner"));
            await mkdir(join(lockPath, "owner"));
            throw operationError;
          },
        }),
      ).rejects.toBe(operationError);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

describe("seedWorkspaceTrust", () => {
  it("preserves every Claude project when launches race", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "groundcrew-v2-claude-trust-race-"));
    const workspaces = Array.from({ length: 20 }, (_, index) => `/workspace/${index}`);

    await Promise.all(
      workspaces.map(
        async (workspaceDirectory) =>
          await seedWorkspaceTrust({
            environment: { HOME: homeDirectory },
            kind: "claude",
            workspaceDirectory,
          }),
      ),
    );

    const configuration = JSON.parse(await readFile(join(homeDirectory, ".claude.json"), "utf8"));
    expect(Object.keys(configuration.projects).toSorted()).toEqual(workspaces.toSorted());
  });
});
