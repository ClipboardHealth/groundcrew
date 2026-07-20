import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { LogEventInput } from "../logging/index.js";
import { createRun, runRecordPath, type Run } from "../run/index.js";
import { sessionNameFor, type Presenter, type PresenterProbe } from "../session/index.js";
import {
  provisionWorkspace,
  taskSlug,
  workspacePath,
  type WorkspaceConfig,
} from "../workspace/index.js";
import { reconcile } from "./reconcile.js";

/** A presenter whose probe is seeded per test: which surfaces are alive, and availability. */
class SeededPresenter implements Presenter {
  private readonly live = new Set<string>();
  private readonly dead = new Set<string>();
  public available = true;
  public readonly closed: string[] = [];

  public alive(name: string): this {
    this.live.add(name);
    return this;
  }

  public deadSurface(name: string): this {
    this.dead.add(name);
    return this;
  }

  public async open(): Promise<void> {
    // unused
  }

  public async probe(): Promise<PresenterProbe> {
    return {
      available: this.available,
      sessions: [
        ...[...this.live].map((name) => ({ name, alive: true })),
        ...[...this.dead].map((name) => ({ name, alive: false })),
      ],
    };
  }

  public async close(name: string): Promise<void> {
    this.closed.push(name);
    this.live.delete(name);
    this.dead.delete(name);
  }

  public async accessHint(): Promise<string | undefined> {
    return undefined;
  }
}

interface World {
  root: string;
  baseDirectory: string;
  worktreeDirectory: string;
  stateRoot: string;
  logs: LogEventInput[];
}

let world: World;

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crew-reconcile-"));
  world = {
    root,
    baseDirectory: path.join(root, "repos"),
    worktreeDirectory: path.join(root, "worktrees"),
    stateRoot: path.join(root, "state"),
    logs: [],
  };
  fs.mkdirSync(world.baseDirectory, { recursive: true });
});

afterEach(() => {
  fs.rmSync(world.root, { recursive: true, force: true });
});

const logger = { log: (event: LogEventInput): void => void world.logs.push(event) };

function config(): WorkspaceConfig {
  return {
    baseDirectory: world.baseDirectory,
    worktreeDirectory: world.worktreeDirectory,
    branchPrefix: "crew",
    remote: "origin",
    defaultBranch: "main",
  };
}

function createRepo(name: string): void {
  const directory = path.join(world.baseDirectory, name);
  fs.mkdirSync(directory, { recursive: true });
  execFileSync("git", ["init", "-b", "main", directory], { stdio: "pipe" });
  execFileSync("git", ["-C", directory, "config", "user.email", "t@e.com"], { stdio: "pipe" });
  execFileSync("git", ["-C", directory, "config", "user.name", "T"], { stdio: "pipe" });
  fs.writeFileSync(path.join(directory, "README.md"), "seed\n");
  execFileSync("git", ["-C", directory, "add", "."], { stdio: "pipe" });
  execFileSync("git", ["-C", directory, "commit", "-m", "init"], { stdio: "pipe" });
}

/** Builds a run record in `state`, optionally provisioning its workspace on disk. */
async function makeRun(input: {
  taskId: string;
  state: "provisioning" | "running" | "paused" | "complete";
  repos?: string[];
  provision?: boolean;
}): Promise<Run> {
  const repos = input.repos ?? [];
  if (input.provision === true) {
    await provisionWorkspace({ config: config(), taskId: input.taskId, repos });
  }

  const run = await createRun({
    stateRoot: world.stateRoot,
    taskSlug: taskSlug({ taskId: input.taskId }),
    taskId: input.taskId,
    source: "fixture",
    agentProfile: "scripted",
    sessionName: sessionNameFor({ taskId: input.taskId }),
    workspaceDirectory: workspacePath({ config: config(), taskId: input.taskId }),
    repos,
  });

  if (input.state === "running" || input.state === "paused" || input.state === "complete") {
    await run.markRunning();
  }

  if (input.state === "paused") {
    await run.pause();
  }

  if (input.state === "complete") {
    await run.complete({ outcome: "delivered" });
  }

  return run;
}

function recordExists(taskId: string): boolean {
  return fs.existsSync(runRecordPath({ stateRoot: world.stateRoot, taskSlug: taskSlug({ taskId }) }));
}

function reconcileInput(presenter: Presenter): Parameters<typeof reconcile>[0] {
  return { stateRoot: world.stateRoot, workspaceConfig: config(), presenter, logger };
}

function eventNames(): string {
  return world.logs.map((line) => `${line.event} ${line.msg ?? ""}`).join(" | ");
}

/** True when a warn-level log line's event matches `pattern` (kept out of the test body). */
function hasWarnEvent(pattern: RegExp): boolean {
  return world.logs.some((line) => line.level === "warn" && pattern.test(line.event));
}

describe("reconcile", () => {
  it("leaves a running run whose session is alive (never touch a live agent)", async () => {
    createRepo("alpha");
    const taskId = "fixture:TASK-1";
    await makeRun({ taskId, state: "running", repos: ["alpha"], provision: true });
    const presenter = new SeededPresenter().alive(sessionNameFor({ taskId }));

    const report = await reconcile(reconcileInput(presenter));

    expect(report.gc.runRecords).toEqual([]);
    expect(recordExists(taskId)).toBe(true);
    expect(fs.existsSync(workspacePath({ config: config(), taskId }))).toBe(true);
  });

  it("GCs the full triple for a crashed provisioning run with no live session", async () => {
    createRepo("alpha");
    const taskId = "fixture:TASK-1";
    await makeRun({ taskId, state: "provisioning", repos: ["alpha"], provision: true });
    const presenter = new SeededPresenter(); // no session

    const report = await reconcile(reconcileInput(presenter));

    expect(recordExists(taskId)).toBe(false);
    expect(fs.existsSync(workspacePath({ config: config(), taskId }))).toBe(false);
    expect(report.gc.worktrees).toContain(taskId);
    expect(report.gc.runRecords).toContain(taskId);
    expect(report.gc.sessions).toContain(taskId);
    // The sweep's three legs are each logged (design doc §10.5, contracts §6).
    const text = eventNames();
    expect(text).toMatch(/worktree/i);
    expect(text).toMatch(/session|tmux|presenter/i);
    expect(text).toMatch(/record|state|sandbox/i);
    expect(world.logs.map((line) => line.event)).toContain("reconcile_gc_run_record");
  });

  it("deletes a stale complete record with no workspace on disk", async () => {
    const taskId = "fixture:TASK-1";
    await makeRun({ taskId, state: "complete", repos: [], provision: false });
    // A repo-less complete run has a workspace directory (empty). Remove it to make it stale.
    fs.rmSync(workspacePath({ config: config(), taskId }), { recursive: true, force: true });

    const report = await reconcile(reconcileInput(new SeededPresenter()));

    expect(recordExists(taskId)).toBe(false);
    expect(report.gc.runRecords).toContain(taskId);
  });

  it("leaves a completed run that is still lingering on disk", async () => {
    createRepo("alpha");
    const taskId = "fixture:TASK-1";
    await makeRun({ taskId, state: "complete", repos: ["alpha"], provision: true });

    const report = await reconcile(reconcileInput(new SeededPresenter()));

    expect(recordExists(taskId)).toBe(true);
    expect(report.gc.runRecords).toEqual([]);
  });

  it("does nothing destructive when the probe is unavailable", async () => {
    createRepo("alpha");
    const taskId = "fixture:TASK-1";
    await makeRun({ taskId, state: "provisioning", repos: ["alpha"], provision: true });
    const presenter = new SeededPresenter();
    presenter.available = false;

    const report = await reconcile(reconcileInput(presenter));

    expect(report.available).toBe(false);
    // The would-be-GC'd provisioning run is untouched.
    expect(recordExists(taskId)).toBe(true);
    expect(fs.existsSync(workspacePath({ config: config(), taskId }))).toBe(true);
  });

  it("reports a running run whose session died without auto-GCing it", async () => {
    createRepo("alpha");
    const taskId = "fixture:TASK-1";
    await makeRun({ taskId, state: "running", repos: ["alpha"], provision: true });
    // Probe available, but the session is gone.
    const report = await reconcile(reconcileInput(new SeededPresenter()));

    expect(report.orphanedRunning).toContain(taskId);
    expect(recordExists(taskId)).toBe(true); // real work may live here — never auto-GC
    expect(fs.existsSync(workspacePath({ config: config(), taskId }))).toBe(true);
    expect(hasWarnEvent(/orphan/u)).toBe(true);
  });

  it("leaves a paused run alone (its session is legitimately down)", async () => {
    createRepo("alpha");
    const taskId = "fixture:TASK-1";
    await makeRun({ taskId, state: "paused", repos: ["alpha"], provision: true });

    const report = await reconcile(reconcileInput(new SeededPresenter()));

    expect(report.orphanedRunning).toEqual([]);
    expect(report.gc.runRecords).toEqual([]);
    expect(recordExists(taskId)).toBe(true);
  });

  it("reports a stray live managed session with no record, never closing it", async () => {
    const strayName = sessionNameFor({ taskId: "fixture:STRAY-1" });
    const presenter = new SeededPresenter().alive(strayName);

    const report = await reconcile(reconcileInput(presenter));

    expect(report.straySessions).toContain(strayName);
    expect(presenter.closed).toEqual([]); // never auto-killed
    expect(hasWarnEvent(/stray/u)).toBe(true);
  });

  it("closes a dead managed surface with no record", async () => {
    const deadName = sessionNameFor({ taskId: "fixture:DEAD-1" });
    const presenter = new SeededPresenter().deadSurface(deadName);

    const report = await reconcile(reconcileInput(presenter));

    expect(report.gc.sessions).toContain(deadName);
    expect(presenter.closed).toContain(deadName);
  });

  it("GCs an orphaned workspace directory with a marker but no run record", async () => {
    createRepo("alpha");
    const taskId = "fixture:ORPHAN-1";
    await provisionWorkspace({ config: config(), taskId, repos: ["alpha"] });
    // No run record was ever written.
    expect(recordExists(taskId)).toBe(false);

    const report = await reconcile(reconcileInput(new SeededPresenter()));

    expect(report.gc.worktrees).toContain(taskId);
    expect(fs.existsSync(workspacePath({ config: config(), taskId }))).toBe(false);
  });
});
