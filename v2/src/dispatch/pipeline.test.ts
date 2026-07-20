import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Task, UpdateResult, WritebackEvent } from "../acquisition/index.js";
import type { LogEventInput } from "../logging/index.js";
import { loadRun, runRecordPath, type RunRecord } from "../run/index.js";
import type { Presenter, PresenterOpenSpec, PresenterProbe } from "../session/index.js";
import { taskSlug, type WorkspaceConfig } from "../workspace/index.js";
import { planTick, startTask, tick } from "./pipeline.js";
import { dispatchStatePath, readDispatchState } from "./state.js";
import type { DispatchDeps, DispatchSource } from "./types.js";

// oxlint-disable-next-line node/no-process-env -- the launch gate resolves the agent binary on the ambient PATH
const PATH_ENV = process.env["PATH"] ?? "";

/** True when a warn-level log line's event or message matches `pattern` (kept out of the test body). */
function hasWarnLog(logs: LogEventInput[], pattern: RegExp): boolean {
  return logs.some((line) => line.level === "warn" && pattern.test(`${line.event} ${line.msg ?? ""}`));
}

// --- in-memory collaborators ----------------------------------------------

/**
 * A faithful in-memory {@link Presenter}: `open` records a live surface, `probe`
 * reports them, `close` drops one. Nothing is executed — the launch gate already
 * proved the command runnable before `open` is reached.
 */
class FakePresenter implements Presenter {
  public readonly opened: PresenterOpenSpec[] = [];
  private readonly live = new Map<string, boolean>();
  public probeAvailable = true;

  public async open(spec: PresenterOpenSpec): Promise<void> {
    this.opened.push(spec);
    this.live.set(spec.name, true);
  }

  public async probe(): Promise<PresenterProbe> {
    return {
      available: this.probeAvailable,
      sessions: [...this.live.entries()].map(([name, alive]) => ({ name, alive })),
    };
  }

  public async close(name: string): Promise<void> {
    this.live.delete(name);
  }

  public async accessHint(): Promise<string | undefined> {
    return undefined;
  }

  public sessionNames(): string[] {
    return [...this.live.keys()].toSorted();
  }
}

/** An in-memory {@link SourceHandle}: a task list, a claim-rejection set, a call journal. */
class FakeSource {
  public readonly name: string;
  public readonly readOnly: boolean;
  public readonly sandboxOptOut = false;
  public readonly missingSecrets: readonly string[] = [];
  public tasks: Task[];
  public readonly rejectClaims: Set<string>;
  public readonly claimed: Array<{ id: string; runId: string }> = [];
  public readonly completed: Array<{ id: string; event: WritebackEvent }> = [];
  public updateCallCount = 0;

  public constructor(input: {
    name?: string;
    tasks?: Task[];
    readOnly?: boolean;
    rejectClaims?: string[];
  }) {
    this.name = input.name ?? "fixture";
    this.tasks = input.tasks ?? [];
    this.readOnly = input.readOnly ?? false;
    this.rejectClaims = new Set(input.rejectClaims ?? []);
  }

  public async list(): Promise<Task[]> {
    return [...this.tasks];
  }

  public async get(id: string): Promise<Task> {
    const task = this.tasks.find((entry) => entry.id === id);
    if (task === undefined) {
      throw new Error(`no such task ${id}`);
    }

    return task;
  }

  public async update(id: string, event: WritebackEvent): Promise<UpdateResult> {
    if (this.readOnly) {
      return { result: "ok" }; // read-only: silent no-op, no journal (COMPLETE-05)
    }

    this.updateCallCount += 1;
    if (event.type === "claimed") {
      this.claimed.push({ id, runId: event.runId });
      return this.rejectClaims.has(id)
        ? { result: "rejected", reason: "contended" }
        : { result: "ok" };
    }

    if (event.type === "completed") {
      this.completed.push({ id, event });
    }

    return { result: "ok" };
  }
}

// --- filesystem + git fixtures --------------------------------------------

interface World {
  root: string;
  baseDirectory: string;
  worktreeDirectory: string;
  stateRoot: string;
  logs: LogEventInput[];
}

let world: World;

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crew-dispatch-"));
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

function git(cwd: string, args: string[]): void {
  execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" });
}

/** Creates a local clone under the base directory with one commit on `main`. */
function createRepo(name: string): string {
  const directory = path.join(world.baseDirectory, name);
  fs.mkdirSync(directory, { recursive: true });
  execFileSync("git", ["init", "-b", "main", directory], { stdio: "pipe" });
  git(directory, ["config", "user.email", "test@example.com"]);
  git(directory, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(directory, "README.md"), "seed\n");
  git(directory, ["add", "."]);
  git(directory, ["commit", "-m", "initial commit"]);
  return directory;
}

function workspaceConfig(): WorkspaceConfig {
  return {
    baseDirectory: world.baseDirectory,
    worktreeDirectory: world.worktreeDirectory,
    branchPrefix: "crew",
    remote: "origin",
    defaultBranch: "main",
  };
}

const collectLogger = { log: (event: LogEventInput): void => void world.logs.push(event) };

function deps(input: {
  sources: DispatchSource[];
  maximumInProgress?: number;
  agentCommand?: string;
  defaultAgent?: string;
  profiles?: Record<string, { command: string }>;
}): DispatchDeps & { presenter: FakePresenter } {
  const presenter = new FakePresenter();
  const profiles = input.profiles ?? {
    scripted: { command: input.agentCommand ?? "true {{prompt}}" },
  };
  return {
    stateRoot: world.stateRoot,
    workspaceConfig: workspaceConfig(),
    presenter,
    sources: input.sources,
    agents: { default: input.defaultAgent ?? "scripted", profiles },
    maximumInProgress: input.maximumInProgress ?? 4,
    environment: { PATH: PATH_ENV },
    logger: collectLogger,
  };
}

function source(input: {
  name?: string;
  tasks?: Task[];
  readOnly?: boolean;
  rejectClaims?: string[];
}): { handle: FakeSource; entry: DispatchSource } {
  const handle = new FakeSource(input);
  return { handle, entry: { handle } };
}

function recordPath(taskId: string): string {
  return runRecordPath({ stateRoot: world.stateRoot, taskSlug: taskSlug({ taskId }) });
}

function readRecord(taskId: string): RunRecord {
  return JSON.parse(fs.readFileSync(recordPath(taskId), "utf8")) as RunRecord;
}

function recordExists(taskId: string): boolean {
  return fs.existsSync(recordPath(taskId));
}

function verdictFor(taskId: string): { skipReason: string; detail?: string } | undefined {
  const state = readDispatchState({ path: dispatchStatePath({ stateRoot: world.stateRoot }) });
  return state.verdicts[taskId];
}

function worktreeDir(taskId: string, repo: string): string {
  return path.join(world.worktreeDirectory, taskSlug({ taskId }), repo);
}

// --- scenarios -------------------------------------------------------------

describe("tick — dispatch & ordering", () => {
  it("provisions a single-repo happy path: worktree, session, running record, claimed runId", async () => {
    createRepo("alpha");
    const { handle, entry } = source({
      tasks: [{ id: "TASK-1", title: "Do it", agent: "scripted", repos: ["alpha"] }],
    });
    const dependencies = deps({ sources: [entry] });

    const report = await tick(dependencies);

    const taskId = "fixture:TASK-1";
    expect(report.dispatched).toEqual([taskId]);
    expect(dependencies.presenter.sessionNames()).toEqual(["crew-fixture-task-1"]);
    expect(fs.existsSync(worktreeDir(taskId, "alpha"))).toBe(true);

    const record = readRecord(taskId);
    expect(record.state).toBe("running");
    expect(record.repos).toContain("alpha");
    expect(record.runId).toMatch(/^r_[0-9a-f]{8}$/u);
    expect(record.events.some((event) => event.event === "claimed")).toBe(true);
    // The claimed writeback carried the run id.
    expect(handle.claimed).toEqual([{ id: "TASK-1", runId: record.runId }]);
  });

  it("respects the slot limit: one provisions, the other is skipped slots-full", async () => {
    createRepo("alpha");
    const { entry } = source({
      tasks: [
        { id: "TASK-1", title: "First", agent: "scripted", repos: ["alpha"] },
        { id: "TASK-2", title: "Second", agent: "scripted", repos: ["alpha"] },
      ],
    });

    const report = await tick(deps({ sources: [entry], maximumInProgress: 1 }));

    expect(report.dispatched).toEqual(["fixture:TASK-1"]);
    expect(recordExists("fixture:TASK-2")).toBe(false);
    expect(verdictFor("fixture:TASK-2")?.skipReason).toBe("slots-full");
  });

  it("orders by priority descending regardless of list order", async () => {
    createRepo("alpha");
    const { handle, entry } = source({
      tasks: [
        { id: "TASK-LOW", title: "Low", agent: "scripted", repos: ["alpha"], priority: 1 },
        { id: "TASK-HIGH", title: "High", agent: "scripted", repos: ["alpha"], priority: 5 },
      ],
    });

    const report = await tick(deps({ sources: [entry], maximumInProgress: 1 }));

    expect(report.dispatched).toEqual(["fixture:TASK-HIGH"]);
    expect(recordExists("fixture:TASK-LOW")).toBe(false);
    expect(verdictFor("fixture:TASK-LOW")?.skipReason).toBe("slots-full");
    // Only the high-priority task was ever claimed.
    expect(handle.claimed.map((call) => call.id)).toEqual(["TASK-HIGH"]);
  });

  it("skips a blocked task, then dispatches it once unblocked, clearing the verdict", async () => {
    createRepo("alpha");
    const { handle, entry } = source({
      tasks: [{ id: "TASK-1", title: "Blocked", agent: "scripted", repos: ["alpha"], blocked: true }],
    });
    const dependencies = deps({ sources: [entry] });

    await tick(dependencies);
    expect(recordExists("fixture:TASK-1")).toBe(false);
    expect(verdictFor("fixture:TASK-1")?.skipReason).toBe("ineligible");
    expect(handle.claimed).toHaveLength(0);

    handle.tasks = [{ id: "TASK-1", title: "Blocked", agent: "scripted", repos: ["alpha"] }];
    await tick(dependencies);

    expect(readRecord("fixture:TASK-1").state).toBe("running");
    // Verdict cleared on the successful poll.
    expect(verdictFor("fixture:TASK-1")).toBeUndefined();
    expect(handle.claimed).toHaveLength(1);
  });

  it("records ineligible for an unrouted task and never claims it", async () => {
    createRepo("alpha");
    const { handle, entry } = source({
      tasks: [{ id: "TASK-1", title: "Unrouted", repos: ["alpha"] }],
    });
    // No source or config routing.
    const dependencies: DispatchDeps = {
      ...deps({ sources: [entry] }),
      agents: { profiles: { scripted: { command: "true {{prompt}}" } } },
    };

    await tick(dependencies);

    expect(recordExists("fixture:TASK-1")).toBe(false);
    expect(verdictFor("fixture:TASK-1")?.skipReason).toBe("ineligible");
    expect(handle.claimed).toHaveLength(0);
  });

  it("bails on a designated repo not on disk: no claim, no provision, visible verdict + log", async () => {
    createRepo("alpha");
    const { handle, entry } = source({
      tasks: [
        { id: "TASK-1", title: "Missing repo", agent: "scripted", repos: ["alpha", "gamma"] },
      ],
    });
    const dependencies = deps({ sources: [entry] });

    await tick(dependencies);

    expect(recordExists("fixture:TASK-1")).toBe(false);
    expect(fs.existsSync(worktreeDir("fixture:TASK-1", "alpha"))).toBe(false);
    expect(handle.claimed).toHaveLength(0);

    const verdict = verdictFor("fixture:TASK-1");
    expect(verdict?.skipReason).toBe("repo-not-on-disk");
    expect(verdict?.detail).toBe("gamma");
    // A log line names the skip (design doc §10.4 / DISPATCH-06).
    expect(world.logs.some((line) => JSON.stringify(line).includes("repo-not-on-disk"))).toBe(true);
  });

  it("records claim-rejected and provisions nothing when the source rejects the claim", async () => {
    createRepo("alpha");
    const { handle, entry } = source({
      tasks: [{ id: "TASK-3", title: "Contended", agent: "scripted", repos: ["alpha"] }],
      rejectClaims: ["TASK-3"],
    });
    const dependencies = deps({ sources: [entry] });

    await tick(dependencies);

    expect(recordExists("fixture:TASK-3")).toBe(false);
    expect(fs.existsSync(worktreeDir("fixture:TASK-3", "alpha"))).toBe(false);
    expect(dependencies.presenter.sessionNames()).toEqual([]);
    // Exactly one claim was offered and answered rejected.
    expect(handle.claimed).toHaveLength(1);
    expect(verdictFor("fixture:TASK-3")?.skipReason).toBe("claim-rejected");
  });

  it("provisions two side-by-side worktrees for a multi-repo designation", async () => {
    createRepo("alpha");
    createRepo("beta");
    const { entry } = source({
      tasks: [{ id: "TASK-1", title: "Two repos", agent: "scripted", repos: ["alpha", "beta"] }],
    });

    await tick(deps({ sources: [entry] }));

    const taskId = "fixture:TASK-1";
    expect(fs.existsSync(worktreeDir(taskId, "alpha"))).toBe(true);
    expect(fs.existsSync(worktreeDir(taskId, "beta"))).toBe(true);
    expect(readRecord(taskId).repos.toSorted()).toEqual(["alpha", "beta"]);
  });

  it("dispatches a repo-less task into an empty workspace", async () => {
    const { entry } = source({ tasks: [{ id: "TASK-1", title: "Repo-less", agent: "scripted" }] });

    await tick(deps({ sources: [entry] }));

    const taskId = "fixture:TASK-1";
    expect(readRecord(taskId).repos).toEqual([]);
    expect(fs.existsSync(path.join(world.worktreeDirectory, taskSlug({ taskId }), ".groundcrew")))
      .toBe(true);
  });
});

describe("tick — completion model interplay", () => {
  it("rolls back on launch failure to complete{failed, launch}, keeping the truthful record", async () => {
    createRepo("alpha");
    const { handle, entry } = source({
      tasks: [{ id: "TASK-1", title: "Broken launch", agent: "broken", repos: ["alpha"] }],
    });
    const dependencies = deps({
      sources: [entry],
      profiles: {
        scripted: { command: "true {{prompt}}" },
        broken: { command: "no-such-agent-binary-xyz {{prompt}}" },
      },
    });

    await tick(dependencies);

    const taskId = "fixture:TASK-1";
    const record = readRecord(taskId);
    expect(record.state).toBe("complete");
    expect(record.outcome).toBe("failed");
    expect(record.reason).toBe("launch");
    // Rolled back: worktree gone, branch deleted in the clone.
    expect(fs.existsSync(worktreeDir(taskId, "alpha"))).toBe(false);
    expect(branchExists("alpha", "crew/fixture-task-1")).toBe(false);
    // Claimed first, then the failure was written back.
    expect(handle.claimed).toHaveLength(1);
    expect(handle.completed.some((call) => call.event.type === "completed")).toBe(true);
  });

  it("is truthful when provisioning fails after the claim: complete{failed, provision} + rollback", async () => {
    // A plain directory passes the on-disk gate but is not a git repo, so the
    // worktree add throws inside provisioning (after the claim succeeded).
    fs.mkdirSync(path.join(world.baseDirectory, "notrepo"), { recursive: true });
    const { handle, entry } = source({
      tasks: [{ id: "TASK-1", title: "Broken provision", agent: "scripted", repos: ["notrepo"] }],
    });

    await tick(deps({ sources: [entry] }));

    const taskId = "fixture:TASK-1";
    const record = readRecord(taskId);
    expect(record.state).toBe("complete");
    expect(record.outcome).toBe("failed");
    expect(record.reason).toBe("provision");
    expect(handle.claimed).toHaveLength(1); // it was claimed before provisioning
    expect(fs.existsSync(worktreeDir(taskId, "notrepo"))).toBe(false);
    expect(world.logs.some((line) => line.event === "provision_failed")).toBe(true);
  });

  it("frees the slot after completion so a queued task dispatches next tick", async () => {
    createRepo("alpha");
    const { handle, entry } = source({
      tasks: [{ id: "TASK-1", title: "First", agent: "scripted", repos: ["alpha"] }],
    });
    const dependencies = deps({ sources: [entry], maximumInProgress: 1 });

    await tick(dependencies);
    expect(readRecord("fixture:TASK-1").state).toBe("running");

    // Complete the first run (as `crew done` would), freeing the slot. The source
    // drops the completed task from `list` and offers a new one.
    const run = await loadRun({ stateRoot: world.stateRoot, taskSlug: "fixture-task-1" });
    await run.complete({ outcome: "delivered" });
    handle.tasks = [{ id: "TASK-2", title: "Second", agent: "scripted", repos: ["alpha"] }];

    const report = await tick(dependencies);
    expect(report.dispatched).toEqual(["fixture:TASK-2"]);
    // The delivered workspace lingers untouched.
    expect(fs.existsSync(worktreeDir("fixture:TASK-1", "alpha"))).toBe(true);
    expect(recordExists("fixture:TASK-1")).toBe(true);
  });

  it("re-dispatches a completed-but-relisted task fresh with a new run id (recurrence)", async () => {
    createRepo("alpha");
    const { entry } = source({
      tasks: [{ id: "TASK-1", title: "Recurring", agent: "scripted", repos: ["alpha"] }],
    });
    const dependencies = deps({ sources: [entry] });

    await tick(dependencies);
    const first = readRecord("fixture:TASK-1").runId;
    const run = await loadRun({ stateRoot: world.stateRoot, taskSlug: "fixture-task-1" });
    await run.complete({ outcome: "delivered" });

    // Still listed (not terminal): the next tick dispatches afresh.
    await tick(dependencies);
    const second = readRecord("fixture:TASK-1");
    expect(second.runId).not.toBe(first);
    expect(second.state).toBe("running");
  });

  it("runs a read-only source end-to-end with zero update calls", async () => {
    createRepo("alpha");
    const { handle, entry } = source({
      tasks: [{ id: "TASK-1", title: "Read only", agent: "scripted", repos: ["alpha"] }],
      readOnly: true,
    });

    await tick(deps({ sources: [entry] }));

    expect(readRecord("fixture:TASK-1").state).toBe("running");
    expect(handle.updateCallCount).toBe(0);
  });
});

describe("tick — terminal sweep", () => {
  it("reaps a clean lingering workspace of a source-terminal task", async () => {
    createRepo("alpha");
    const { handle, entry } = source({
      tasks: [{ id: "TASK-1", title: "Reap me", agent: "scripted", repos: ["alpha"] }],
    });
    const dependencies = deps({ sources: [entry] });

    await tick(dependencies);
    const run = await loadRun({ stateRoot: world.stateRoot, taskSlug: "fixture-task-1" });
    await run.complete({ outcome: "delivered" });

    // The source now reports the task terminal (still listed for the sweep).
    handle.tasks = [{ id: "TASK-1", title: "Reap me", agent: "scripted", repos: ["alpha"], terminal: true }];
    const report = await tick(dependencies);

    expect(report.reaped).toEqual(["fixture:TASK-1"]);
    expect(recordExists("fixture:TASK-1")).toBe(false);
    expect(fs.existsSync(worktreeDir("fixture:TASK-1", "alpha"))).toBe(false);
    expect(world.logs.some((line) => /reap/u.test(line.event))).toBe(true);
  });

  it("skips reaping a dirty terminal workspace with a warning, leaving everything", async () => {
    createRepo("alpha");
    const { handle, entry } = source({
      tasks: [{ id: "TASK-1", title: "Dirty linger", agent: "scripted", repos: ["alpha"] }],
    });
    const dependencies = deps({ sources: [entry] });

    await tick(dependencies);
    const run = await loadRun({ stateRoot: world.stateRoot, taskSlug: "fixture-task-1" });
    await run.complete({ outcome: "delivered" });
    // Leave an uncommitted file in the worktree.
    fs.writeFileSync(path.join(worktreeDir("fixture:TASK-1", "alpha"), "scratch.txt"), "dirt\n");

    handle.tasks = [{ id: "TASK-1", title: "Dirty linger", agent: "scripted", repos: ["alpha"], terminal: true }];
    const report = await tick(dependencies);

    expect(report.reaped).toEqual([]);
    expect(recordExists("fixture:TASK-1")).toBe(true);
    expect(fs.existsSync(worktreeDir("fixture:TASK-1", "alpha"))).toBe(true);
    expect(hasWarnLog(world.logs, /reap|skip|dirty/u)).toBe(true);
  });
});

describe("tick — resilience", () => {
  it("survives a source whose list fails, still serving the healthy source", async () => {
    createRepo("alpha");
    const broken: DispatchSource = {
      handle: {
        name: "broken",
        readOnly: false,
        sandboxOptOut: false,
        missingSecrets: [],
        async list(): Promise<Task[]> {
          throw new Error("list boom");
        },
        async get(): Promise<Task> {
          throw new Error("no");
        },
        async update() {
          return { result: "ok" as const };
        },
      },
    };
    const { entry } = source({
      name: "healthy",
      tasks: [{ id: "TASK-1", title: "Healthy", agent: "scripted", repos: ["alpha"] }],
    });

    const report = await tick(deps({ sources: [broken, entry] }));

    expect(report.dispatched).toEqual(["healthy:TASK-1"]);
    expect(world.logs.some((line) => line.event === "source_list_failed")).toBe(true);
  });
});

describe("startTask", () => {
  it("throws when no configured source owns the task id", async () => {
    const { entry } = source({ tasks: [] });
    await expect(
      startTask({ ...deps({ sources: [entry] }), taskId: "unknown:TASK-1" }),
    ).rejects.toThrow(/no configured source/u);
  });

  it("records a claim-rejected verdict for a single-task start", async () => {
    createRepo("alpha");
    const { entry } = source({
      tasks: [{ id: "TASK-1", title: "Contended", agent: "scripted", repos: ["alpha"] }],
      rejectClaims: ["TASK-1"],
    });

    const report = await startTask({ ...deps({ sources: [entry] }), taskId: "fixture:TASK-1" });
    expect(report.dispatched).toBe(false);
    expect(report.verdict?.skipReason).toBe("claim-rejected");
    expect(verdictFor("fixture:TASK-1")?.skipReason).toBe("claim-rejected");
  });

  it("skips slots-full without --force, and reports already-running for a live task", async () => {
    createRepo("alpha");
    const { entry } = source({
      tasks: [{ id: "TASK-1", title: "T", agent: "scripted", repos: ["alpha"] }],
    });
    const dependencies = deps({ sources: [entry], maximumInProgress: 1 });

    // First start goes live.
    await startTask({ ...dependencies, taskId: "fixture:TASK-1" });
    // A second start of the same task reports already-running (never duplicates).
    const again = await startTask({ ...dependencies, taskId: "fixture:TASK-1", force: true });
    expect(again.dispatched).toBe(false);
    expect(again.verdict?.detail).toBe("already-running");
  });

  it("forced start bypasses blocked and dispatches (repo present)", async () => {
    createRepo("alpha");
    const { entry } = source({
      tasks: [{ id: "TASK-1", title: "Forced", agent: "scripted", repos: ["alpha"], blocked: true }],
    });
    const dependencies = deps({ sources: [entry] });

    // A plain tick leaves it queued (blocked).
    await tick(dependencies);
    expect(recordExists("fixture:TASK-1")).toBe(false);

    const report = await startTask({ ...dependencies, taskId: "fixture:TASK-1", force: true });
    expect(report.dispatched).toBe(true);
    expect(readRecord("fixture:TASK-1").state).toBe("running");
  });

  it("forced start never bypasses the repo-on-disk gate (throws for exit 2 mapping)", async () => {
    const { entry } = source({
      tasks: [{ id: "TASK-1", title: "Forced missing repo", agent: "scripted", repos: ["gamma"] }],
    });
    const dependencies = deps({ sources: [entry] });

    await expect(
      startTask({ ...dependencies, taskId: "fixture:TASK-1", force: true }),
    ).rejects.toMatchObject({ name: "RepoNotOnDiskError" });
    expect(recordExists("fixture:TASK-1")).toBe(false);
  });

  it("honors an --agent override", async () => {
    createRepo("alpha");
    const { entry } = source({
      tasks: [{ id: "TASK-1", title: "Override", repos: ["alpha"] }],
    });
    const dependencies = deps({
      sources: [entry],
      defaultAgent: "scripted",
      profiles: {
        scripted: { command: "true {{prompt}}" },
        special: { command: "true {{prompt}}" },
      },
    });

    const report = await startTask({ ...dependencies, taskId: "fixture:TASK-1", agent: "special" });
    expect(report.dispatched).toBe(true);
    expect(readRecord("fixture:TASK-1").agentProfile).toBe("special");
  });
});

describe("tick — per-task prompt delivery", () => {
  it("renders the default template with the task's title, description, and repos into the launch command", async () => {
    createRepo("alpha");
    const { entry } = source({
      tasks: [
        {
          id: "TASK-1",
          title: "Fix the widget",
          description: "The widget crashes on load.",
          agent: "scripted",
          repos: ["alpha"],
        },
      ],
    });
    const dependencies = deps({ sources: [entry] });

    await tick(dependencies);

    const command = dependencies.presenter.opened[0]?.command;
    expect(command).toContain("fixture:TASK-1");
    expect(command).toContain("Fix the widget");
    expect(command).toContain("The widget crashes on load.");
    expect(command).toContain("alpha");
  });

  it("renders a configured template, substituting the task placeholders", async () => {
    createRepo("alpha");
    const { entry } = source({
      tasks: [{ id: "TASK-1", title: "Ship it", agent: "scripted", repos: ["alpha"] }],
    });
    const dependencies: DispatchDeps & { presenter: FakePresenter } = {
      ...deps({ sources: [entry] }),
      promptTemplate: "work {{id}} :: {{title}}",
    };

    await tick(dependencies);

    expect(dependencies.presenter.opened[0]?.command).toBe("true 'work fixture:TASK-1 :: Ship it'");
  });

  it("survives a description with newlines, quotes, and backticks (single-layer shell quoting)", async () => {
    createRepo("alpha");
    const description = "line one\nrun `crew done` with 'quotes' and \"doubles\"";
    const { entry } = source({
      tasks: [{ id: "TASK-1", title: "Tricky", description, agent: "scripted", repos: ["alpha"] }],
    });
    const dependencies: DispatchDeps & { presenter: FakePresenter } = {
      ...deps({ sources: [entry] }),
      promptTemplate: "{{description}}",
    };

    await tick(dependencies);

    // shellQuote wraps in single quotes and escapes embedded single quotes; the
    // command is one argv token that a single `sh -c` layer restores verbatim.
    expect(dependencies.presenter.opened[0]?.command).toBe(
      `true 'line one\nrun \`crew done\` with '\\''quotes'\\'' and "doubles"'`,
    );
  });

  it("prepends the crew bin dir to PATH via the launched command", async () => {
    createRepo("alpha");
    const { entry } = source({
      tasks: [{ id: "TASK-1", title: "Do it", agent: "scripted", repos: ["alpha"] }],
    });
    const dependencies: DispatchDeps & { presenter: FakePresenter } = {
      ...deps({ sources: [entry] }),
      environment: { PATH: PATH_ENV },
      crewBinDir: "/opt/crew/bin",
    };

    await tick(dependencies);

    expect(dependencies.presenter.opened[0]?.command.startsWith(`PATH='/opt/crew/bin':"$PATH" `)).toBe(
      true,
    );
  });
});

describe("planTick — dry-run plan (no side effects)", () => {
  it("lists would-dispatch and per-task skip reasons without claiming or provisioning", async () => {
    createRepo("alpha");
    const { handle, entry } = source({
      tasks: [
        { id: "TASK-1", title: "Ready", agent: "scripted", repos: ["alpha"] },
        { id: "TASK-2", title: "Blocked", agent: "scripted", repos: ["alpha"], blocked: true },
        { id: "TASK-3", title: "Missing repo", agent: "scripted", repos: ["gamma"] },
      ],
    });
    const dependencies = deps({ sources: [entry] });

    const plan = await planTick(dependencies);

    expect(plan.wouldDispatch).toEqual(["fixture:TASK-1"]);
    expect(plan.skipped["fixture:TASK-2"]?.skipReason).toBe("ineligible");
    expect(plan.skipped["fixture:TASK-2"]?.detail).toBe("blocked");
    expect(plan.skipped["fixture:TASK-3"]?.skipReason).toBe("repo-not-on-disk");

    // No side effects: nothing claimed, no run records, no session, no verdicts persisted.
    expect(handle.claimed).toHaveLength(0);
    expect(recordExists("fixture:TASK-1")).toBe(false);
    expect(dependencies.presenter.opened).toHaveLength(0);
    expect(verdictFor("fixture:TASK-2")).toBeUndefined();
  });

  it("marks tasks past the slot budget as slots-full", async () => {
    createRepo("alpha");
    const { entry } = source({
      tasks: [
        { id: "TASK-1", title: "First", agent: "scripted", repos: ["alpha"] },
        { id: "TASK-2", title: "Second", agent: "scripted", repos: ["alpha"] },
      ],
    });

    const plan = await planTick(deps({ sources: [entry], maximumInProgress: 1 }));

    expect(plan.wouldDispatch).toEqual(["fixture:TASK-1"]);
    expect(plan.skipped["fixture:TASK-2"]?.skipReason).toBe("slots-full");
  });
});

// --- local helpers ---------------------------------------------------------

function branchExists(repo: string, branch: string): boolean {
  try {
    execFileSync(
      "git",
      ["-C", path.join(world.baseDirectory, repo), "rev-parse", "--verify", `refs/heads/${branch}`],
      { stdio: "pipe" },
    );
    return true;
  } catch {
    return false;
  }
}

