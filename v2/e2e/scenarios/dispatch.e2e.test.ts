/**
 * Acceptance scenarios A: Dispatch & happy paths (catalog §3.A, DISPATCH-01..09).
 *
 * Black-box (catalog §1.1): every assertion targets the observation surface —
 * git worktrees/branches, run records and dispatch.json on disk, tmux on the
 * scenario socket, the fixture source's `calls.jsonl` journal, and the JSONL
 * log. Stdout is matched only loosely and only where the output is the behavior
 * (`status`). These are written to pass once v2 meets the spec and to be red
 * against the current placeholder binary — each failing as an assertion or a
 * poll timeout about missing crew behavior, never a harness crash.
 */

import * as fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  branchExists,
  commitSubjects,
  configure,
  createRepo,
  currentBranch,
  listSessionNames,
  pollForValue,
  readDispatchVerdicts,
  readLogLines,
  readRunRecord,
  run,
  runRecordExists,
  sessionExists,
  waitForHeartbeat,
  waitForLaunchRecord,
  waitForSession,
  withScenario,
  worktreeList,
  writeAgentScript,
  writeAndCommit,
} from "../harness/index.js";
import type {
  DispatchVerdicts,
  FixtureSource,
  FixtureStore,
  LogLine,
  RunRecord,
  Scenario,
  SourceCall,
} from "../harness/index.js";

// --- shared helpers --------------------------------------------------------

const SEEDED_SUBJECTS = ["second commit", "initial commit"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Every recorded `update:claimed` writeback, across all tasks. */
function claimedUpdates(source: FixtureSource): SourceCall[] {
  return source.updateCalls().filter((call) => {
    const event = call.stdin["event"];
    return isRecord(event) && event["type"] === "claimed";
  });
}

/** The `claimed` writeback for a given source-local id, if any. */
function claimedFor(source: FixtureSource, localId: string): SourceCall | undefined {
  return claimedUpdates(source).find((call) => call.stdin["id"] === localId);
}

/** The runId carried by a `claimed` writeback, if it is well-formed. */
function claimedRunId(call: SourceCall | undefined): unknown {
  const event = call?.stdin["event"];
  return isRecord(event) ? event["runId"] : undefined;
}

/** A store mutation that clears the `blocked` flag on one task (DISPATCH-04). */
function unblock(localId: string): (store: FixtureStore) => FixtureStore {
  return (store) => ({
    ...store,
    tasks: store.tasks.map((task) =>
      task.id === localId ? { ...task, blocked: false } : task,
    ),
  });
}

/** Installs a default agent script that keeps the session alive until killed. */
function scriptHang(scenario: Scenario): void {
  writeAgentScript({ scenario, steps: [{ type: "hang" }] });
}

/** Installs a default agent script that reports a clean delivered completion. */
function scriptDone(scenario: Scenario): void {
  writeAgentScript({
    scenario,
    steps: [{ type: "crew", args: ["done", "--outcome", "delivered"] }],
  });
}

/** Polls a run record until `until` holds; fails as a clean poll timeout otherwise. */
async function waitForRunRecord(input: {
  readonly path: string;
  readonly until: (record: RunRecord) => boolean;
  readonly description: string;
}): Promise<RunRecord> {
  return await pollForValue({
    description: input.description,
    probe: () => {
      const record = runRecordExists({ path: input.path })
        ? readRunRecord({ path: input.path })
        : undefined;
      return record !== undefined && input.until(record) ? record : undefined;
    },
  });
}

/** Polls dispatch.json until a verdict for `taskId` appears. */
async function waitForVerdict(input: {
  readonly path: string;
  readonly taskId: string;
}): Promise<DispatchVerdicts["verdicts"][string]> {
  return await pollForValue({
    description: `dispatch verdict for ${input.taskId}`,
    probe: () =>
      fs.existsSync(input.path)
        ? readDispatchVerdicts({ path: input.path }).verdicts[input.taskId]
        : undefined,
  });
}

/** Polls the JSONL log until a line matches `match`. */
async function waitForLogLine(input: {
  readonly path: string;
  readonly match: (line: LogLine) => boolean;
  readonly description: string;
}): Promise<LogLine> {
  return await pollForValue({
    description: input.description,
    probe: () =>
      fs.existsSync(input.path)
        ? readLogLines({ path: input.path }).find(input.match)
        : undefined,
  });
}

/** Polls until a filesystem path exists. */
async function waitForPath(input: {
  readonly path: string;
  readonly description: string;
}): Promise<void> {
  await pollForValue({
    description: input.description,
    probe: () => (fs.existsSync(input.path) ? true : undefined),
  });
}

// --- scenarios -------------------------------------------------------------

describe("A. Dispatch & happy paths", () => {
  it("DISPATCH-01 — single-repo happy path provisions worktree, branch, session, state", async () => {
    await withScenario(async (scenario) => {
      const { clonePath } = await createRepo({ scenario, name: "alpha" });

      const crew = configure({ scenario });
      scriptHang(scenario);
      crew.seedSource([{ id: "TASK-1", title: "Do the thing", agent: "scripted", repos: ["alpha"] }]);

      const taskId = "fixture:TASK-1";
      const result = await crew.tick();
      expect(result.exitCode).toBe(0);

      // tmux session alive.
      await waitForSession({ scenario, name: crew.expect.sessionFor(taskId) });
      await waitForHeartbeat({ workspaceDirectory: crew.paths.workspaceFor(taskId) });

      // worktree cut from origin/main on the task branch.
      const branch = crew.expect.branchFor(taskId);
      expect(await branchExists({ scenario, repoDirectory: clonePath, branch })).toBe(true);
      const worktrees = await worktreeList({ scenario, repoDirectory: clonePath });
      expect(worktrees).toHaveLength(2);
      expect(worktrees.some((entry) => entry.branch === branch)).toBe(true);

      const worktreePath = crew.paths.worktreeFor("alpha", taskId);
      expect(fs.existsSync(worktreePath)).toBe(true);
      expect(await currentBranch({ scenario, repoDirectory: worktreePath })).toBe(branch);
      expect(await commitSubjects({ scenario, repoDirectory: worktreePath })).toEqual(SEEDED_SUBJECTS);

      // state records running with the run identity.
      const record = await waitForRunRecord({
        path: crew.paths.stateFor(taskId),
        until: (value) => value.state === "running",
        description: "run record in state running",
      });
      expect(record.taskId).toBe(taskId);
      expect(record.repos).toContain("alpha");
      expect(record.runId).toMatch(/^r_[0-9a-f]{8}$/u);
      expect(record.events.some((event) => event.event === "claimed")).toBe(true);

      // journal shows update:claimed acknowledged (core recorded it and carried the runId).
      const claimed = claimedFor(crew.source, "TASK-1");
      expect(claimed).toBeDefined();
      expect(claimedRunId(claimed)).toBe(record.runId);
    });
  });

  it("DISPATCH-01b — the launched agent receives its task context, and PATH resolves crew", async () => {
    await withScenario(async (scenario) => {
      await createRepo({ scenario, name: "alpha" });

      const crew = configure({ scenario });
      scriptHang(scenario);
      // A description with a newline, backticks, and single quotes: it must
      // survive tmux → sh → node argv quoting intact (contracts §9, finding #5).
      const description = "Reproduce with `npm test`\nthen fix the 'off-by-one' bug.";
      crew.seedSource([
        { id: "TASK-1", title: "Fix the widget", description, agent: "scripted", repos: ["alpha"] },
      ]);

      const taskId = "fixture:TASK-1";
      const result = await crew.tick();
      expect(result.exitCode).toBe(0);

      const launch = await waitForLaunchRecord({
        workspaceDirectory: crew.paths.workspaceFor(taskId),
      });

      // The prompt argv carries the full task context — id, title, description.
      const prompt = launch.argv.join("\n");
      expect(prompt).toContain(taskId);
      expect(prompt).toContain("Fix the widget");
      expect(prompt).toContain(description);
      expect(launch.env.GROUNDCREW_TASK_ID).toBe(taskId);

      // The session PATH is prepended with the launching crew's bin dir, so
      // in-session `crew` resolves to this installation (contracts §9).
      const crewResolvesOnPath = launch.env.PATH.split(path.delimiter).some((directory) =>
        fs.existsSync(path.join(directory, "crew")),
      );
      expect(crewResolvesOnPath).toBe(true);
    });
  });

  it("DISPATCH-02 — slot limit respected: one provisions, the other stays queued", async () => {
    await withScenario(async (scenario) => {
      await createRepo({ scenario, name: "alpha" });

      const crew = configure({ scenario, config: { maximumInProgress: 1 } });
      scriptHang(scenario);
      crew.seedSource([
        { id: "TASK-1", title: "First", agent: "scripted", repos: ["alpha"] },
        { id: "TASK-2", title: "Second", agent: "scripted", repos: ["alpha"] },
      ]);

      const first = "fixture:TASK-1";
      const second = "fixture:TASK-2";
      const result = await crew.tick();
      expect(result.exitCode).toBe(0);

      // exactly one session, for the first task.
      await waitForSession({ scenario, name: crew.expect.sessionFor(first) });
      expect(await listSessionNames({ scenario })).toEqual([crew.expect.sessionFor(first)]);
      await waitForRunRecord({
        path: crew.paths.stateFor(first),
        until: (value) => value.state === "running",
        description: "first task running",
      });

      // the second task provisioned nothing and was not claimed.
      expect(runRecordExists({ path: crew.paths.stateFor(second) })).toBe(false);
      expect(await sessionExists({ scenario, name: crew.expect.sessionFor(second) })).toBe(false);
      expect(fs.existsSync(crew.paths.worktreeFor("alpha", second))).toBe(false);
      expect(claimedFor(crew.source, "TASK-2")).toBeUndefined();

      // and the skip is recorded as slots-full.
      const verdict = await waitForVerdict({ path: crew.paths.dispatchFile, taskId: second });
      expect(verdict.skipReason).toBe("slots-full");
    });
  });

  it("DISPATCH-03 — priority ordering: the higher-priority task is the one provisioned", async () => {
    await withScenario(async (scenario) => {
      await createRepo({ scenario, name: "alpha" });

      const crew = configure({ scenario, config: { maximumInProgress: 1 } });
      scriptHang(scenario);
      // Low listed first, so list order alone would pick the wrong one.
      crew.seedSource([
        { id: "TASK-LOW", title: "Low", agent: "scripted", repos: ["alpha"], priority: 1 },
        { id: "TASK-HIGH", title: "High", agent: "scripted", repos: ["alpha"], priority: 5 },
      ]);

      const low = "fixture:TASK-LOW";
      const high = "fixture:TASK-HIGH";
      const result = await crew.tick();
      expect(result.exitCode).toBe(0);

      await waitForSession({ scenario, name: crew.expect.sessionFor(high) });
      expect(await listSessionNames({ scenario })).toEqual([crew.expect.sessionFor(high)]);
      await waitForRunRecord({
        path: crew.paths.stateFor(high),
        until: (value) => value.state === "running",
        description: "high-priority task running",
      });

      expect(runRecordExists({ path: crew.paths.stateFor(low) })).toBe(false);
      expect(await sessionExists({ scenario, name: crew.expect.sessionFor(low) })).toBe(false);
      expect(claimedFor(crew.source, "TASK-LOW")).toBeUndefined();
      const verdict = await waitForVerdict({ path: crew.paths.dispatchFile, taskId: low });
      expect(verdict.skipReason).toBe("slots-full");
    });
  });

  it("DISPATCH-04 — blocked task skipped, then dispatched once unblocked", async () => {
    await withScenario(async (scenario) => {
      await createRepo({ scenario, name: "alpha" });

      const crew = configure({ scenario });
      scriptHang(scenario);
      crew.seedSource([
        { id: "TASK-1", title: "Blocked", agent: "scripted", repos: ["alpha"], blocked: true },
      ]);

      const taskId = "fixture:TASK-1";

      // blocked: nothing provisions.
      const first = await crew.tick();
      expect(first.exitCode).toBe(0);
      expect(runRecordExists({ path: crew.paths.stateFor(taskId) })).toBe(false);
      expect(await sessionExists({ scenario, name: crew.expect.sessionFor(taskId) })).toBe(false);
      expect(claimedFor(crew.source, "TASK-1")).toBeUndefined();

      // unblock at the source, tick again: it provisions.
      crew.source.patch(unblock("TASK-1"));

      const second = await crew.tick();
      expect(second.exitCode).toBe(0);
      await waitForSession({ scenario, name: crew.expect.sessionFor(taskId) });
      await waitForRunRecord({
        path: crew.paths.stateFor(taskId),
        until: (value) => value.state === "running",
        description: "unblocked task running",
      });
      expect(claimedFor(crew.source, "TASK-1")).toBeDefined();
    });
  });

  it("DISPATCH-05 — ineligible task (no agent routing) is ignored", async () => {
    await withScenario(async (scenario) => {
      await createRepo({ scenario, name: "alpha" });

      // No agent routing anywhere: `null` omits `agents.default` and the source's
      // `agent` key entirely (unrouted = key absent, per contracts §4.3/§5).
      const crew = configure({ scenario, config: { defaultAgent: null, sources: [{ agent: null }] } });
      crew.seedSource([{ id: "TASK-1", title: "Unrouted", repos: ["alpha"] }]);

      const taskId = "fixture:TASK-1";
      const result = await crew.tick();
      expect(result.exitCode).toBe(0);

      // no provisioning, no writeback.
      expect(runRecordExists({ path: crew.paths.stateFor(taskId) })).toBe(false);
      expect(await sessionExists({ scenario, name: crew.expect.sessionFor(taskId) })).toBe(false);
      expect(fs.existsSync(crew.paths.worktreeFor("alpha", taskId))).toBe(false);
      expect(claimedFor(crew.source, "TASK-1")).toBeUndefined();

      // recorded ineligible, and still queued at the source.
      const verdict = await waitForVerdict({ path: crew.paths.dispatchFile, taskId });
      expect(verdict.skipReason).toBe("ineligible");
      const status = await crew.status();
      expect(status.stdout).toContain("TASK-1");
    });
  });

  it("DISPATCH-06 — designated repo not on disk → bail with a visible reason", async () => {
    await withScenario(async (scenario) => {
      // gamma is never cloned under the base directory.
      const crew = configure({ scenario });
      scriptHang(scenario);
      crew.seedSource([{ id: "TASK-1", title: "Missing repo", agent: "scripted", repos: ["gamma"] }]);

      const taskId = "fixture:TASK-1";
      const result = await crew.tick();
      expect(result.exitCode).toBe(0);

      // nothing provisioned, task stays queued at the source.
      expect(runRecordExists({ path: crew.paths.stateFor(taskId) })).toBe(false);
      expect(await sessionExists({ scenario, name: crew.expect.sessionFor(taskId) })).toBe(false);
      expect(fs.existsSync(crew.paths.worktreeFor("gamma", taskId))).toBe(false);
      expect(claimedFor(crew.source, "TASK-1")).toBeUndefined();

      // skip verdict on disk, in the log, and in status.
      const verdict = await waitForVerdict({ path: crew.paths.dispatchFile, taskId });
      expect(verdict.skipReason).toBe("repo-not-on-disk");
      expect(verdict.detail).toBe("gamma");

      await waitForLogLine({
        path: crew.paths.logFile,
        match: (line) => JSON.stringify(line).includes("repo-not-on-disk"),
        description: "log line naming the repo-not-on-disk skip",
      });

      const status = await crew.status();
      expect(status.stdout).toMatch(/gamma/iu);
    });
  });

  it("DISPATCH-07 — forced start bypasses eligibility (repo present)", async () => {
    await withScenario(async (scenario) => {
      const { clonePath } = await createRepo({ scenario, name: "alpha" });

      const crew = configure({ scenario });
      scriptHang(scenario);
      // Blocked ⇒ auto-dispatch skips it; force is the human override.
      crew.seedSource([
        { id: "TASK-1", title: "Forced", agent: "scripted", repos: ["alpha"], blocked: true },
      ]);

      const taskId = "fixture:TASK-1";

      // tick leaves it queued (ineligible while blocked).
      await crew.tick();
      expect(runRecordExists({ path: crew.paths.stateFor(taskId) })).toBe(false);
      expect(await sessionExists({ scenario, name: crew.expect.sessionFor(taskId) })).toBe(false);

      // forced start provisions exactly as DISPATCH-01.
      const result = await crew.start(taskId, { force: true });
      expect(result.exitCode).toBe(0);

      await waitForSession({ scenario, name: crew.expect.sessionFor(taskId) });
      const branch = crew.expect.branchFor(taskId);
      expect(await branchExists({ scenario, repoDirectory: clonePath, branch })).toBe(true);
      expect(fs.existsSync(crew.paths.worktreeFor("alpha", taskId))).toBe(true);
      const record = await waitForRunRecord({
        path: crew.paths.stateFor(taskId),
        until: (value) => value.state === "running",
        description: "forced task running",
      });
      expect(record.taskId).toBe(taskId);
    });
  });

  it("DISPATCH-07 (variant) — forced start never bypasses the repo-on-disk gate", async () => {
    await withScenario(async (scenario) => {
      // gamma is not cloned; --force must not override the repo gate.
      const crew = configure({ scenario });
      scriptHang(scenario);
      crew.seedSource([{ id: "TASK-1", title: "Forced missing repo", agent: "scripted", repos: ["gamma"] }]);

      const taskId = "fixture:TASK-1";
      const result = await crew.start(taskId, { force: true });

      // exit 2: repo not cloned under the base directory (contracts §7).
      expect(result.exitCode).toBe(2);
      expect(runRecordExists({ path: crew.paths.stateFor(taskId) })).toBe(false);
      expect(await sessionExists({ scenario, name: crew.expect.sessionFor(taskId) })).toBe(false);
      expect(fs.existsSync(crew.paths.worktreeFor("gamma", taskId))).toBe(false);
    });
  });

  it("DISPATCH-08 — branch reuse re-attaches to the prior local branch and commit", async () => {
    await withScenario(async (scenario) => {
      const { clonePath } = await createRepo({ scenario, name: "alpha" });

      const crew = configure({ scenario });
      scriptHang(scenario);
      const taskId = "fixture:TASK-1";
      const branch = crew.expect.branchFor(taskId);

      // Pre-create the task branch with a commit, then restore the clone to main.
      await run({ command: "git", args: ["checkout", "-b", branch], cwd: clonePath, env: scenario.env });
      await writeAndCommit({
        scenario,
        repoDirectory: clonePath,
        files: { "prior.txt": "prior work\n" },
        message: "prior work",
      });
      await run({ command: "git", args: ["checkout", "main"], cwd: clonePath, env: scenario.env });

      crew.seedSource([{ id: "TASK-1", title: "Reuse", agent: "scripted", repos: ["alpha"] }]);

      const result = await crew.tick();
      expect(result.exitCode).toBe(0);

      await waitForSession({ scenario, name: crew.expect.sessionFor(taskId) });
      const worktreePath = crew.paths.worktreeFor("alpha", taskId);
      await waitForPath({ path: worktreePath, description: "reused worktree on disk" });

      // Re-attached to the existing branch, so the prior commit is present —
      // not a fresh cut from origin/main.
      expect(await currentBranch({ scenario, repoDirectory: worktreePath })).toBe(branch);
      const subjects = await commitSubjects({ scenario, repoDirectory: worktreePath });
      expect(subjects).toContain("prior work");
      expect(subjects).toEqual(["prior work", ...SEEDED_SUBJECTS]);
    });
  });

  it("DISPATCH-09 — recurrence is a source concern: a completed task re-dispatches fresh", async () => {
    await withScenario(async (scenario) => {
      await createRepo({ scenario, name: "alpha" });

      const crew = configure({ scenario });
      scriptDone(scenario);
      crew.seedSource({
        tasks: [{ id: "TASK-1", title: "Recurring", agent: "scripted", repos: ["alpha"] }],
        recurringTaskIds: ["TASK-1"],
      });

      const taskId = "fixture:TASK-1";
      const statePath = crew.paths.stateFor(taskId);

      await crew.tick();
      const first = await waitForRunRecord({
        path: statePath,
        until: (value) => value.state === "complete",
        description: "first run completes",
      });
      expect(first.outcome).toBe("delivered");
      const firstRunId = first.runId;

      // Recurrence lives entirely in the source: it recorded the completion and
      // still re-lists the task.
      const store = crew.source.readStore();
      expect(store.completedTaskIds).toContain("TASK-1");
      expect(store.recurringTaskIds).toContain("TASK-1");

      // Next tick sees the re-listed task and dispatches it afresh — new runId,
      // a new claim — with no recurrence machinery of core's own.
      await crew.tick();
      const second = await waitForRunRecord({
        path: statePath,
        until: (value) => value.runId !== firstRunId,
        description: "fresh dispatch with a new runId",
      });
      expect(second.runId).toMatch(/^r_[0-9a-f]{8}$/u);
      expect(second.runId).not.toBe(firstRunId);
      expect(claimedUpdates(crew.source).length).toBeGreaterThanOrEqual(2);
    });
  });
});
