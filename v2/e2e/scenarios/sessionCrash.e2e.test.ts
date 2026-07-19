/**
 * Acceptance scenarios C (session lifecycle) and D (crash & recovery) from the
 * E2E scenario catalog (docs/spec/e2e-scenario-catalog.md §3.C SESSION-01..03,
 * §3.D CRASH-01..05). Black-box: every assertion targets the observation surface
 * (catalog §1.2) — git worktrees/branches, run records on disk, tmux sessions on
 * the scenario socket, the source call journal, and the JSONL log. `status`
 * stdout is matched only loosely, and only where the output *is* the behavior.
 *
 * These are written before v2 exists, so they are RED against the placeholder
 * `crew` (which exits 0 and touches nothing) and go GREEN once v2 meets the spec
 * (design doc §10.5 reconcile/reaping, §9.2 run/session nouns; contracts §1–§3).
 *
 * HARNESS GAP (tmux mutation): the harness exports read-only tmux observation
 * (`sessionExists`, `waitForSessionGone`, …) but no helper to *kill* a session
 * or *create* a stray one on the scenario socket. SESSION-03 needs both, so this
 * file drives `tmux -L <socket> …` through the exported `run` primitive exactly
 * as the harness's own tmuxObservation self-test does. Reported to the harness
 * owner as a candidate addition (`killSession` / `newSession`).
 */

import * as fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  branchExists,
  canonicalTaskId,
  configure,
  createRepo,
  isDirty,
  listSessionNames,
  makeFailingShim,
  pollUntil,
  readLogLines,
  readRunRecord,
  run,
  runRecordExists,
  sessionExists,
  taskSlug,
  waitForHeartbeat,
  waitForResume,
  waitForSession,
  waitForSessionGone,
  withScenario,
  worktreeList,
  writeAgentScript,
} from "../harness/index.js";
import type { AgentStep, Bindings, Scenario } from "../harness/index.js";

const SOURCE = "fixture";

/** Seeds one task, scripts its agent, dispatches it, and blocks until it is running. */
async function dispatchRunning(input: {
  readonly crew: Bindings;
  readonly localId: string;
  readonly repos?: readonly string[];
  readonly agentSteps?: readonly AgentStep[];
}): Promise<{ readonly taskId: string; readonly workspaceDirectory: string }> {
  const { crew, localId } = input;
  const taskId = canonicalTaskId({ sourceName: SOURCE, localId });
  const steps = input.agentSteps ?? [{ type: "hang" }];

  writeAgentScript({ scenario: crew.scenario, steps: [...steps] });
  crew.seedSource([
    {
      id: localId,
      title: `Task ${localId}`,
      agent: "scripted",
      ...(input.repos === undefined ? {} : { repos: [...input.repos] }),
    },
  ]);

  const ticked = await crew.tick();
  expect(ticked.exitCode).toBe(0);

  await waitForSession({ scenario: crew.scenario, name: crew.expect.sessionFor(taskId) });
  const workspaceDirectory = crew.paths.workspaceFor(taskId);
  await waitForHeartbeat({ workspaceDirectory });

  return { taskId, workspaceDirectory };
}

/** Count of live worktrees carrying the task's uniform branch (contracts §1). */
async function taskWorktreeCount(input: {
  readonly crew: Bindings;
  readonly clonePath: string;
  readonly taskId: string;
}): Promise<number> {
  const branch = input.crew.expect.branchFor(input.taskId);
  const entries = await worktreeList({
    scenario: input.crew.scenario,
    repoDirectory: input.clonePath,
  });
  return entries.filter((entry) => entry.branch === branch).length;
}

/** HARNESS GAP workaround: kill a session on the scenario socket via raw tmux. */
async function killSession(input: {
  readonly scenario: Scenario;
  readonly name: string;
}): Promise<void> {
  await run({
    command: "tmux",
    args: ["-L", input.scenario.tmuxSocket, "kill-session", "-t", input.name],
    env: input.scenario.env,
  });
}

/** HARNESS GAP workaround: create a detached stray session on the scenario socket. */
async function newSession(input: {
  readonly scenario: Scenario;
  readonly name: string;
}): Promise<void> {
  await run({
    command: "tmux",
    args: ["-L", input.scenario.tmuxSocket, "new-session", "-d", "-s", input.name, "sleep 300"],
    env: input.scenario.env,
  });
}

describe("C. Session lifecycle", () => {
  it("SESSION-01 — pause keeps work: session closed, worktree and branch intact, state paused", async () => {
    await withScenario(async (scenario) => {
      const { clonePath } = await createRepo({ scenario, name: "alpha" });
      const crew = configure({ scenario });

      const { taskId } = await dispatchRunning({ crew, localId: "TASK-1", repos: ["alpha"] });

      const before = readRunRecord({ path: crew.paths.stateFor(taskId) });
      expect(before.state).toBe("running");
      expect(before.resumeCount).toBe(0);

      const paused = await crew.pause(taskId);
      expect(paused.exitCode).toBe(0);

      // Session closed.
      await waitForSessionGone({ scenario, name: crew.expect.sessionFor(taskId) });

      // Worktree and branch survive the pause.
      expect(await taskWorktreeCount({ crew, clonePath, taskId })).toBe(1);
      expect(
        await branchExists({ scenario, repoDirectory: clonePath, branch: crew.expect.branchFor(taskId) }),
      ).toBe(true);
      expect(fs.existsSync(crew.paths.workspaceFor(taskId))).toBe(true);

      // State paused; a pause is not a resume, so the count is untouched.
      const after = readRunRecord({ path: crew.paths.stateFor(taskId) });
      expect(after.state).toBe("paused");
      expect(after.resumeCount).toBe(0);
    });
  });

  it("SESSION-02 — resume reopens the same run, never recreates", async () => {
    // First part: resume a paused task reopens the same run and session.
    await withScenario(async (scenario) => {
      const { clonePath } = await createRepo({ scenario, name: "alpha" });
      const crew = configure({ scenario });

      const { taskId, workspaceDirectory } = await dispatchRunning({
        crew,
        localId: "TASK-1",
        repos: ["alpha"],
      });

      const beforePause = readRunRecord({ path: crew.paths.stateFor(taskId) });
      const workspaceField = beforePause.workspaceDirectory;

      await crew.pause(taskId);
      await waitForSessionGone({ scenario, name: crew.expect.sessionFor(taskId) });

      const resumed = await crew.resume(taskId);
      expect(resumed.exitCode).toBe(0);

      // Session live again under the same name (one session per task, contracts §1).
      await waitForSession({ scenario, name: crew.expect.sessionFor(taskId) });
      await waitForHeartbeat({ workspaceDirectory });
      // The `resume` command path ran (the agent recorded a --resume), not a fresh dispatch.
      const resumes = await waitForResume({ workspaceDirectory });
      expect(resumes.length).toBeGreaterThanOrEqual(1);

      const after = readRunRecord({ path: crew.paths.stateFor(taskId) });
      expect(after.state).toBe("running");
      expect(after.resumeCount).toBe(1);
      // Same worktree, not a recreated one.
      expect(after.workspaceDirectory).toBe(workspaceField);
      expect(await taskWorktreeCount({ crew, clonePath, taskId })).toBe(1);
      // Resume never re-claims: exactly one claimed writeback across the run.
      expect(claimedCount(crew)).toBe(1);
    });

    // Second part: resume on a task with no worktree is a hard error that creates nothing.
    await withScenario(async (scenario) => {
      const crew = configure({ scenario });
      // Never dispatched: no run record, no workspace, no session.
      const taskId = canonicalTaskId({ sourceName: SOURCE, localId: "GHOST-1" });
      crew.seedSource([{ id: "GHOST-1", title: "Ghost", agent: "scripted" }]);

      const resumed = await crew.resume(taskId);
      expect(resumed.exitCode).not.toBe(0);

      expect(runRecordExists({ path: crew.paths.stateFor(taskId) })).toBe(false);
      expect(fs.existsSync(crew.paths.workspaceFor(taskId))).toBe(false);
      expect(await sessionExists({ scenario, name: crew.expect.sessionFor(taskId) })).toBe(false);
    });
  });

  it("SESSION-03 — status tells the truth about strays", async () => {
    // First part: state says running but the session was killed externally.
    await withScenario(async (scenario) => {
      await createRepo({ scenario, name: "alpha" });
      const crew = configure({ scenario });

      const { taskId } = await dispatchRunning({ crew, localId: "TASK-1", repos: ["alpha"] });

      // State still says running; kill the session out from under it.
      await killSession({ scenario, name: crew.expect.sessionFor(taskId) });
      await waitForSessionGone({ scenario, name: crew.expect.sessionFor(taskId) });

      const status = await crew.status(taskId);
      const output = status.stdout + status.stderr;
      expect(output).toMatch(/stray|dead|orphan|gone|not running|missing|disagree/i);
      // status may render the task by canonical id or by slug; either identifies it.
      const flagsTask = [taskId, taskSlug({ taskId })].some((id) => output.includes(id));
      expect(flagsTask).toBe(true);
    });

    // Second part: no run record, but a live session matching the naming scheme.
    await withScenario(async (scenario) => {
      const crew = configure({ scenario });
      crew.seedSource([]);

      // A live session matching the naming scheme, with no run record behind it.
      const strayTaskId = canonicalTaskId({ sourceName: SOURCE, localId: "STRAY-1" });
      const strayName = crew.expect.sessionFor(strayTaskId);
      await newSession({ scenario, name: strayName });
      await waitForSession({ scenario, name: strayName });

      expect(runRecordExists({ path: crew.paths.stateFor(strayTaskId) })).toBe(false);

      const status = await crew.status();
      const output = status.stdout + status.stderr;
      expect(output).toMatch(/stray|orphan|unexpected|unknown|no run|untracked/i);
      // status may render the stray by full session name or by slug; either identifies it.
      const flagsStray = [strayName, taskSlug({ taskId: strayTaskId })].some((id) =>
        output.includes(id),
      );
      expect(flagsStray).toBe(true);
    });
  });
});

describe("D. Crash & recovery", () => {
  it("CRASH-01 — SIGKILL mid-run then reconcile: no duplicate worktree, session, or claim", async () => {
    await withScenario(async (scenario) => {
      const { clonePath } = await createRepo({ scenario, name: "alpha" });
      const crew = configure({ scenario, config: { pollIntervalMilliseconds: 200 } });

      writeAgentScript({ scenario, steps: [{ type: "hang" }] });
      crew.seedSource([{ id: "TASK-1", title: "Task", agent: "scripted", repos: ["alpha"] }]);

      const taskId = canonicalTaskId({ sourceName: SOURCE, localId: "TASK-1" });
      const workspaceDirectory = crew.paths.workspaceFor(taskId);

      const orchestrator = crew.startWatch();
      await waitForSession({ scenario, name: crew.expect.sessionFor(taskId) });
      await waitForHeartbeat({ workspaceDirectory });

      // Hard crash: the tmux session (agent) survives an orchestrator SIGKILL.
      crew.killOrchestrator();
      await orchestrator.whenExited();

      // Reconcile-on-startup (design doc §10.5, DEVOP-5972): a fresh one-shot poll.
      const ticked = await crew.tick();
      expect(ticked.exitCode).toBe(0);

      // No duplicate worktree, no second session, no re-claim.
      expect(await taskWorktreeCount({ crew, clonePath, taskId })).toBe(1);
      expect(sessionsNamed(await listSessionNames({ scenario }), crew.expect.sessionFor(taskId))).toBe(1);
      expect(claimedCount(crew)).toBe(1);

      // Run record still running and consistent with disk.
      const record = readRunRecord({ path: crew.paths.stateFor(taskId) });
      expect(record.state).toBe("running");
      expect(record.repos).toContain("alpha");
      expect(fs.existsSync(record.workspaceDirectory)).toBe(true);
    });
  });

  it("CRASH-02 — cleanup --force removes an orphan worktree dir only when its path matches the expected shape", async () => {
    await withScenario(async (scenario) => {
      await createRepo({ scenario, name: "alpha" });
      const crew = configure({ scenario });
      const taskId = canonicalTaskId({ sourceName: SOURCE, localId: "TASK-1" });

      // An orphan directory at the task's expected workspace path — never a git worktree.
      const orphan = crew.paths.workspaceFor(taskId);
      fs.mkdirSync(orphan, { recursive: true });
      fs.writeFileSync(path.join(orphan, "leftover.txt"), "stale\n");

      // A sibling with a name that is not this task's shape — must be left alone.
      const sibling = path.join(path.dirname(orphan), "unrelated-directory");
      fs.mkdirSync(sibling, { recursive: true });
      fs.writeFileSync(path.join(sibling, "keep.txt"), "keep\n");

      const cleaned = await crew.cleanup(taskId, { force: true });
      expect(cleaned.exitCode).toBe(0);

      // The matching orphan is gone; the non-matching sibling is untouched.
      expect(fs.existsSync(orphan)).toBe(false);
      expect(fs.existsSync(sibling)).toBe(true);
    });
  });

  it("CRASH-03 — cleanup refuses a dirty worktree by name, then removes it under --force", async () => {
    await withScenario(async (scenario) => {
      const { clonePath } = await createRepo({ scenario, name: "alpha" });
      const crew = configure({ scenario });

      // Agent leaves an uncommitted file in the alpha worktree, then hangs.
      const { taskId } = await dispatchRunning({
        crew,
        localId: "TASK-1",
        repos: ["alpha"],
        agentSteps: [
          { type: "writeFile", path: "alpha/dirt.txt", content: "uncommitted work" },
          { type: "hang" },
        ],
      });

      const worktree = crew.paths.worktreeFor("alpha", taskId);
      await pollUntil({
        description: "the alpha worktree to become dirty",
        condition: async () => await isDirty({ scenario, repoDirectory: worktree }),
      });

      // Close the session so cleanup contends only with the dirt, not a live agent.
      await crew.pause(taskId);
      await waitForSessionGone({ scenario, name: crew.expect.sessionFor(taskId) });

      // Refused: data-loss guard names the dirt, everything stays on disk.
      const refused = await crew.cleanup(taskId);
      expect(refused.exitCode).not.toBe(0);
      expect(refused.stdout + refused.stderr).toMatch(/dirty|uncommitted|changes|unsaved/i);
      expect(fs.existsSync(worktree)).toBe(true);
      expect(await isDirty({ scenario, repoDirectory: worktree })).toBe(true);
      expect(await taskWorktreeCount({ crew, clonePath, taskId })).toBe(1);

      // Force overrides the guard.
      const forced = await crew.cleanup(taskId, { force: true });
      expect(forced.exitCode).toBe(0);
      expect(fs.existsSync(worktree)).toBe(false);
      expect(runRecordExists({ path: crew.paths.stateFor(taskId) })).toBe(false);
    });
  });

  it("CRASH-04 — stale state, no disk: cleared when empty, kept when the probe is unavailable", async () => {
    // First part: a stale record with no worktree and no session is cleared.
    await withScenario(async (scenario) => {
      const crew = configure({ scenario });
      const taskId = canonicalTaskId({ sourceName: SOURCE, localId: "TASK-1" });

      writeStaleRunRecord({ crew, taskId });
      expect(runRecordExists({ path: crew.paths.stateFor(taskId) })).toBe(true);

      const cleaned = await crew.cleanup(taskId);
      expect(cleaned.exitCode).toBe(0);
      expect(runRecordExists({ path: crew.paths.stateFor(taskId) })).toBe(false);
    });

    // Second part: an unavailable session probe is never treated as empty.
    await withScenario(async (scenario) => {
      const crew = configure({ scenario });
      const taskId = canonicalTaskId({ sourceName: SOURCE, localId: "TASK-1" });

      writeStaleRunRecord({ crew, taskId });

      // Shadow tmux with a failing shim: probe() reports available:false, which
      // contracts §8 forbids reading as "no sessions". Cleanup cannot prove the
      // session is dead, so it must not clear the record.
      makeFailingShim({ scenario, name: "tmux" });

      await crew.cleanup(taskId);
      expect(runRecordExists({ path: crew.paths.stateFor(taskId) })).toBe(true);
    });
  });

  it("CRASH-05 — reconcile GCs the full triple after a crash mid-provisioning, then dispatches cleanly", async () => {
    await withScenario(async (scenario) => {
      const { clonePath } = await createRepo({ scenario, name: "alpha" });

      // A prepareWorktree hook that freezes the very first provisioning: it records
      // its pid, writes a marker, and sleeps forever. On any later run (marker
      // present) it exits 0 immediately, so re-dispatch is clean.
      const marker = path.join(scenario.root, "prepare-marker");
      const pidFile = path.join(scenario.root, "prepare-pid");
      const hookScript = path.join(scenario.root, "prepare-worktree.sh");
      fs.writeFileSync(
        hookScript,
        [
          "#!/bin/sh",
          `if [ -f "${marker}" ]; then exit 0; fi`,
          `: > "${marker}"`,
          `echo $$ > "${pidFile}"`,
          "exec sleep 1000000",
          "",
        ].join("\n"),
      );
      fs.chmodSync(hookScript, 0o755);

      const crew = configure({
        scenario,
        config: {
          pollIntervalMilliseconds: 200,
          repositories: { alpha: { prepareWorktree: hookScript } },
        },
      });

      writeAgentScript({ scenario, steps: [{ type: "hang" }] });
      crew.seedSource([{ id: "TASK-1", title: "Task", agent: "scripted", repos: ["alpha"] }]);
      const taskId = canonicalTaskId({ sourceName: SOURCE, localId: "TASK-1" });

      // Freeze mid-provisioning.
      const orchestrator = crew.startWatch();
      await pollUntil({
        description: "the prepareWorktree hook to record its pid",
        condition: () => fs.existsSync(pidFile),
      });

      // Kill the frozen hook process, then SIGKILL the orchestrator.
      // HARNESS GAP: no helper to reap a leaked provisioning child; kill by the
      // pid the hook recorded (precise, no cross-scenario pkill collisions).
      const hookPid = fs.readFileSync(pidFile, "utf8").trim();
      await run({ command: "kill", args: ["-9", hookPid], env: scenario.env });
      crew.killOrchestrator();
      await orchestrator.whenExited();

      // Reconcile only: empty the queue so this tick GCs but does not re-dispatch.
      crew.seedSource([]);
      const reconciled = await crew.tick();
      expect(reconciled.exitCode).toBe(0);

      // The full triple is GC'd: half-created worktree, any session, stale state.
      expect(await taskWorktreeCount({ crew, clonePath, taskId })).toBe(0);
      expect(sessionsNamed(await listSessionNames({ scenario }), crew.expect.sessionFor(taskId))).toBe(0);
      expect(runRecordExists({ path: crew.paths.stateFor(taskId) })).toBe(false);

      // Each GC action is logged (design doc §10.5). Event names are not pinned in
      // contracts §6, so match loosely and assert the triple is represented.
      const gcLines = readLogLines({ path: crew.paths.logFile }).filter((line) =>
        /reconcile|reap|gc|orphan|prune|sweep|remove/i.test(line.event),
      );
      expect(gcLines.length).toBeGreaterThan(0);
      const gcText = [
        gcLines.map((line) => line.event).join(" "),
        gcLines.map((line) => line.msg).join(" "),
      ].join(" ");
      expect(gcText).toMatch(/worktree/i);
      expect(gcText).toMatch(/session|tmux|presenter/i);
      expect(gcText).toMatch(/state|record|sandbox/i);

      // The task now dispatches cleanly — no duplicates from the aborted attempt.
      crew.seedSource([{ id: "TASK-1", title: "Task", agent: "scripted", repos: ["alpha"] }]);
      const redispatched = await crew.tick();
      expect(redispatched.exitCode).toBe(0);
      await waitForSession({ scenario, name: crew.expect.sessionFor(taskId) });
      await waitForHeartbeat({ workspaceDirectory: crew.paths.workspaceFor(taskId) });

      expect(await taskWorktreeCount({ crew, clonePath, taskId })).toBe(1);
      expect(sessionsNamed(await listSessionNames({ scenario }), crew.expect.sessionFor(taskId))).toBe(1);
      const record = readRunRecord({ path: crew.paths.stateFor(taskId) });
      expect(record.state).toBe("running");
    });
  });
});

/** Number of `claimed` writebacks the fixture source recorded (contracts §4.4). */
function claimedCount(crew: Bindings): number {
  return crew.source.updateCalls().filter((call) => {
    const event = call.stdin["event"];
    return isRecord(event) && event["type"] === "claimed";
  }).length;
}

function sessionsNamed(names: readonly string[], target: string): number {
  return names.filter((name) => name === target).length;
}

/** Writes a valid run record whose worktree and session are both absent (CRASH-04). */
function writeStaleRunRecord(input: { readonly crew: Bindings; readonly taskId: string }): void {
  const { crew, taskId } = input;
  const statePath = crew.paths.stateFor(taskId);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });

  const record = {
    version: 1,
    taskId,
    runId: "r_deadbeef",
    source: SOURCE,
    agentProfile: "scripted",
    state: "running",
    resumeCount: 0,
    sessionName: crew.expect.sessionFor(taskId),
    workspaceDirectory: crew.paths.workspaceFor(taskId),
    repos: [],
    artifacts: [],
    events: [{ ts: "2026-07-17T00:00:00.000Z", event: "claimed" }],
  };
  fs.writeFileSync(statePath, JSON.stringify(record, undefined, 2) + "\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
