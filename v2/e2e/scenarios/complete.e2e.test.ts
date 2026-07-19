/**
 * Section B of the catalog — Completion & writeback (COMPLETE-01..08).
 *
 * Black-box: every assertion targets the observation surface (catalog §1.2) —
 * run records on disk, the fixture source's call journal, tmux sessions, git
 * facts, the JSONL log, and (only where the output *is* the behavior) loose
 * `status` substrings. These tests are RED until v2 implements the completion
 * model (catalog §2, contracts §3–§4): forge-blind, agent-reported, lingering
 * until cleanup or source-terminal auto-reap.
 */

import * as fs from "node:fs";

import { describe, expect, it } from "vitest";

import {
  type Artifact,
  type Bindings,
  branchExists,
  configure,
  createRepo,
  type FixtureSource,
  isDirty,
  pollForValue,
  pollUntil,
  readGhCalls,
  readLogLines,
  readRunRecord,
  runRecordExists,
  type RunOutcome,
  type RunRecord,
  type Scenario,
  waitForSession,
  waitForSessionGone,
  withScenario,
  worktreeList,
  type WritebackEvent,
  writebackEventSchema,
  writeAgentScript,
} from "../harness/index.js";

const TASK = "fixture:TASK-1";
const PR_URL = "https://github.com/acme/alpha/pull/7";

// --- shared helpers --------------------------------------------------------

/** The run record at `statePath` once it is `complete`, else `undefined`. */
function completeRunRecord(statePath: string): RunRecord | undefined {
  const record = runRecordExists({ path: statePath })
    ? readRunRecord({ path: statePath })
    : undefined;
  return record?.state === "complete" ? record : undefined;
}

/** Polls the run record until it reaches `complete`, returning it. */
async function waitForRunComplete(statePath: string): Promise<RunRecord> {
  return await pollForValue({
    description: `run record at ${statePath} to reach complete`,
    probe: () => completeRunRecord(statePath),
  });
}

/**
 * The single `completed` writeback the source received. Throws unless there is
 * exactly one, so callers assert "exactly one completed event" without a
 * conditional in the test body.
 */
function soleCompletedWriteback(source: FixtureSource): CompletedWriteback {
  const completed = completedWritebacks(source);
  const [only, ...rest] = completed;
  if (only === undefined || rest.length > 0) {
    throw new Error(
      `expected exactly one completed writeback, saw ${String(completed.length)}`,
    );
  }

  return only;
}

/** A completed writeback's artifacts, normalized to an array. */
function artifactsOf(writeback: CompletedWriteback): Artifact[] {
  return writeback.artifacts ?? [];
}

/** True when the source received a `claimed` writeback. */
function hasClaimedWriteback(source: FixtureSource): boolean {
  return writebacks(source).some((event) => event.type === "claimed");
}

/** True when the source received a `completed` writeback with `outcome`. */
function hasCompletedWriteback(source: FixtureSource, outcome: RunOutcome): boolean {
  return completedWritebacks(source).some((event) => event.outcome === outcome);
}

/**
 * Marks a task terminal in the fixture store while keeping it visible to
 * `list` (the store's `list` drops completed ids), so the terminal flag drives
 * the auto-reap sweep (catalog COMPLETE-07).
 */
function markTaskTerminal(source: FixtureSource, localId: string): void {
  source.patch((store) => ({
    ...store,
    completedTaskIds: (store.completedTaskIds ?? []).filter((id) => id !== localId),
    tasks: store.tasks.map((task) =>
      task.id === localId ? { ...task, terminal: true } : task,
    ),
  }));
}

/** True when a warn-level log line's event or message matches `pattern`. */
function hasWarnLogLine(logFile: string, pattern: RegExp): boolean {
  return readLogLines({ path: logFile }).some(
    (line) => line.level === "warn" && (pattern.test(line.event) || pattern.test(line.msg ?? "")),
  );
}

/** Blocks until a warn-level log line matches `pattern`, or fails with a timeout. */
async function waitForWarnLogLine(logFile: string, pattern: RegExp): Promise<void> {
  await pollUntil({
    description: `a warn-level log line matching ${String(pattern)}`,
    condition: () => hasWarnLogLine(logFile, pattern),
  });
}

/** The writeback events the fixture source received, parsed from its journal. */
function writebacks(source: FixtureSource): WritebackEvent[] {
  return source.updateCalls().flatMap((call) => {
    const parsed = writebackEventSchema.safeParse(call.stdin["event"]);
    return parsed.success ? [parsed.data] : [];
  });
}

type CompletedWriteback = Extract<WritebackEvent, { type: "completed" }>;

/** Just the `completed` writebacks (catalog §2 — one per finished run). */
function completedWritebacks(source: FixtureSource): CompletedWriteback[] {
  return writebacks(source).filter(
    (event): event is CompletedWriteback => event.type === "completed",
  );
}

/**
 * Dispatches a single-repo task whose scripted agent commits its work cleanly
 * and reports `delivered`, then waits for the lingering completion. The common
 * "delivered linger" precondition for the cleanup/reap scenarios.
 */
async function provisionDeliveredClean(input: {
  readonly scenario: Scenario;
  readonly crew: Bindings;
  readonly repo: string;
}): Promise<void> {
  const { scenario, crew, repo } = input;
  writeAgentScript({
    scenario,
    taskId: TASK,
    steps: [
      { type: "writeFile", path: `${repo}/work.txt`, content: "done\n" },
      { type: "gitCommit", repo, message: "feat: implement the widget" },
      { type: "crew", args: ["done", "--outcome", "delivered"] },
    ],
  });
  await crew.start(TASK);
  await waitForRunComplete(crew.paths.stateFor(TASK));
}

describe("B. Completion & writeback", () => {
  it("COMPLETE-01 — publishing work is reporting it (artifact rides the completed writeback)", async () => {
    await withScenario(async (scenario) => {
      await createRepo({ scenario, name: "alpha" });
      const crew = configure({ scenario });
      crew.seedSource([
        { id: "TASK-1", title: "Ship the widget", agent: "scripted", repos: ["alpha"] },
      ]);

      writeAgentScript({
        scenario,
        taskId: TASK,
        steps: [
          { type: "writeFile", path: "alpha/widget.ts", content: "export const widget = 1;\n" },
          { type: "gitCommit", repo: "alpha", message: "feat: wire up the widget" },
          { type: "crew", args: ["artifact", "add", PR_URL, "--kind", "pr"] },
          { type: "crew", args: ["done", "--outcome", "delivered"] },
        ],
      });

      await crew.start(TASK);
      const record = await waitForRunComplete(crew.paths.stateFor(TASK));

      // The reported artifact appears in the run record.
      expect(record.artifacts).toContainEqual(
        expect.objectContaining({ kind: "pr", locator: PR_URL }),
      );

      // …and rides the completed writeback into the source journal.
      const completed = soleCompletedWriteback(crew.source);
      expect(artifactsOf(completed)).toContainEqual(
        expect.objectContaining({ kind: "pr", locator: PR_URL }),
      );

      // status shows the two layers separately: reported PR + observed commit.
      const status = await crew.status(TASK);
      expect(status.exitCode).toBe(0);
      expect(status.stdout).toContain("pull/7");
      expect(status.stdout).toContain("widget");

      // Core is forge-blind: it made no `gh` call (the agent made none either).
      expect(readGhCalls({ scenario })).toHaveLength(0);
    });
  });

  it("COMPLETE-02 — delivered frees the slot immediately while the workspace lingers", async () => {
    await withScenario(async (scenario) => {
      await createRepo({ scenario, name: "alpha" });
      const crew = configure({ scenario, config: { maximumInProgress: 1 } });
      crew.seedSource([
        { id: "TASK-1", title: "First", agent: "scripted", repos: ["alpha"] },
      ]);

      writeAgentScript({
        scenario,
        taskId: TASK,
        steps: [
          { type: "writeFile", path: "alpha/first.txt", content: "first\n" },
          { type: "gitCommit", repo: "alpha", message: "feat: first" },
          { type: "crew", args: ["artifact", "add", PR_URL, "--kind", "pr"] },
          { type: "crew", args: ["done", "--outcome", "delivered"] },
        ],
      });

      await crew.tick();
      const record = await waitForRunComplete(crew.paths.stateFor(TASK));

      // Exactly one completed event, artifacts intact.
      const completed = soleCompletedWriteback(crew.source);
      expect(completed.outcome).toBe("delivered");
      expect(artifactsOf(completed)).toContainEqual(
        expect.objectContaining({ kind: "pr", locator: PR_URL }),
      );

      // State is complete{delivered}; the session ended.
      expect(record.state).toBe("complete");
      expect(record.outcome).toBe("delivered");
      await waitForSessionGone({ scenario, name: crew.expect.sessionFor(TASK) });

      // Worktree, branch, and run record all still on disk (the linger).
      const clone = `${scenario.baseDirectory}/alpha`;
      expect(fs.existsSync(crew.paths.worktreeFor("alpha", TASK))).toBe(true);
      expect(await branchExists({ scenario, repoDirectory: clone, branch: crew.expect.branchFor(TASK) })).toBe(true);
      expect(runRecordExists({ path: crew.paths.stateFor(TASK) })).toBe(true);

      // Slot freed: a newly-queued task dispatches on the next tick, the
      // delivered workspace still lingering beside it.
      const nextTask = "fixture:TASK-2";
      writeAgentScript({ scenario, taskId: nextTask, steps: [{ type: "hang" }] });
      crew.source.patch((store) => ({
        ...store,
        tasks: [...store.tasks, { id: "TASK-2", title: "Second", agent: "scripted", repos: ["alpha"] }],
      }));

      await crew.tick();
      await waitForSession({ scenario, name: crew.expect.sessionFor(nextTask) });
      expect(fs.existsSync(crew.paths.worktreeFor("alpha", nextTask))).toBe(true);
      // The delivered workspace is untouched by the new dispatch.
      expect(fs.existsSync(crew.paths.worktreeFor("alpha", TASK))).toBe(true);
      expect(runRecordExists({ path: crew.paths.stateFor(TASK) })).toBe(true);
    });
  });

  it("COMPLETE-03 — launch failure is truthful and rolled back", async () => {
    await withScenario(async (scenario) => {
      await createRepo({ scenario, name: "alpha" });
      const crew = configure({
        scenario,
        config: {
          defaultAgent: "scripted",
          agentProfiles: {
            scripted: {},
            broken: { command: "no-such-agent-binary-xyz {{prompt}}" },
          },
        },
      });
      crew.seedSource([
        { id: "TASK-1", title: "Broken launch", agent: "broken", repos: ["alpha"] },
      ]);

      await crew.start(TASK);
      const record = await waitForRunComplete(crew.paths.stateFor(TASK));

      // Truthful: complete{failed, reason: launch}.
      expect(record.outcome).toBe("failed");
      expect(record.reason).toBe("launch");

      // Rolled back: worktree and branch are gone; no session came up.
      const clone = `${scenario.baseDirectory}/alpha`;
      expect(fs.existsSync(crew.paths.worktreeFor("alpha", TASK))).toBe(false);
      expect(await branchExists({ scenario, repoDirectory: clone, branch: crew.expect.branchFor(TASK) })).toBe(false);
      expect(await worktreeList({ scenario, repoDirectory: clone })).toHaveLength(1);

      // The failure appears in the journal because the task was claimed first.
      expect(hasClaimedWriteback(crew.source)).toBe(true);
      expect(hasCompletedWriteback(crew.source, "failed")).toBe(true);
    });
  });

  it("COMPLETE-04 — agent failure is truth-told, artifacts uninvented, workspace lingers", async () => {
    await withScenario(async (scenario) => {
      await createRepo({ scenario, name: "alpha" });
      const crew = configure({ scenario });
      crew.seedSource([
        { id: "TASK-1", title: "Will fail", agent: "scripted", repos: ["alpha"] },
      ]);

      writeAgentScript({
        scenario,
        taskId: TASK,
        steps: [
          { type: "crew", args: ["done", "--outcome", "failed", "--message", "could not finish"] },
        ],
      });

      await crew.start(TASK);
      const record = await waitForRunComplete(crew.paths.stateFor(TASK));

      // Journal carries the failure with its message.
      const completed = soleCompletedWriteback(crew.source);
      expect(completed.outcome).toBe("failed");
      expect(completed.message).toBe("could not finish");

      // State is complete{failed}; no artifacts invented.
      expect(record.state).toBe("complete");
      expect(record.outcome).toBe("failed");
      expect(record.artifacts).toHaveLength(0);

      // Workspace lingers for inspection.
      const clone = `${scenario.baseDirectory}/alpha`;
      expect(fs.existsSync(crew.paths.worktreeFor("alpha", TASK))).toBe(true);
      expect(await branchExists({ scenario, repoDirectory: clone, branch: crew.expect.branchFor(TASK) })).toBe(true);
      expect(runRecordExists({ path: crew.paths.stateFor(TASK) })).toBe(true);
    });
  });

  it("COMPLETE-05 — a read-only source runs end-to-end with zero update calls", async () => {
    await withScenario(async (scenario) => {
      await createRepo({ scenario, name: "alpha" });
      const crew = configure({
        scenario,
        config: { sources: [{ name: "fixture", readOnly: true, agent: "scripted" }] },
      });
      crew.seedSource([
        { id: "TASK-1", title: "Read-only end to end", agent: "scripted", repos: ["alpha"] },
      ]);

      await provisionDeliveredClean({ scenario, crew, repo: "alpha" });

      // Dispatch, run, and completion all succeeded.
      const record = readRunRecord({ path: crew.paths.stateFor(TASK) });
      expect(record.state).toBe("complete");
      expect(record.outcome).toBe("delivered");

      // The read-only source's `update` was never invoked (no writeback).
      expect(crew.source.updateCalls()).toHaveLength(0);

      // status labels the source read-only.
      const status = await crew.status();
      expect(status.exitCode).toBe(0);
      expect(status.stdout.toLowerCase()).toMatch(/read.?only/u);
    });
  });

  it("COMPLETE-08 — crew done honors the dirty-worktree guard", async () => {
    // HARNESS GAP: the scripted agent runs each `crew` step via execFileSync
    // with no try/catch, so a *nonzero* `crew done` (the refused case) aborts
    // the agent before any later step, and it records no per-step exit code.
    // "Refuse, then rerun with --allow-dirty" is therefore not expressible as
    // two agent steps. Workaround: the agent writes an uncommitted change and
    // hangs (keeping the run alive), and the scenario drives `crew done`
    // directly via `--task` (contracts §3.2 identity resolution), which lets it
    // assert the nonzero exit and the named dirt on the observation surface.
    await withScenario(async (scenario) => {
      await createRepo({ scenario, name: "alpha" });
      const crew = configure({ scenario });
      crew.seedSource([
        { id: "TASK-1", title: "Dirty guard", agent: "scripted", repos: ["alpha"] },
      ]);

      writeAgentScript({
        scenario,
        taskId: TASK,
        steps: [
          { type: "writeFile", path: "alpha/dirty.txt", content: "uncommitted\n" },
          { type: "hang" },
        ],
      });

      await crew.start(TASK);
      await waitForSession({ scenario, name: crew.expect.sessionFor(TASK) });
      const worktree = crew.paths.worktreeFor("alpha", TASK);
      await pollUntil({
        description: "the alpha worktree to be dirty",
        condition: async () => await isDirty({ scenario, repoDirectory: worktree }),
      });

      // Refused: dirty `crew done` exits nonzero and names the dirt.
      const refused = await crew.crew(["done", "--task", TASK, "--outcome", "delivered"]);
      expect(refused.exitCode).not.toBe(0);
      const refusedOutput = `${refused.stdout}${refused.stderr}`;
      expect(refusedOutput.toLowerCase()).toContain("dirty");
      expect(refusedOutput).toContain("dirty.txt");

      // The task stays running; no completed event was written back.
      expect(readRunRecord({ path: crew.paths.stateFor(TASK) }).state).toBe("running");
      expect(completedWritebacks(crew.source)).toHaveLength(0);

      // Rerun with --allow-dirty: completes normally.
      const allowed = await crew.crew([
        "done",
        "--task",
        TASK,
        "--outcome",
        "delivered",
        "--allow-dirty",
      ]);
      expect(allowed.exitCode).toBe(0);

      const record = await waitForRunComplete(crew.paths.stateFor(TASK));
      expect(record.outcome).toBe("delivered");
      expect(completedWritebacks(crew.source)).toHaveLength(1);
    });
  });

  it("COMPLETE-06 — manual cleanup ends the linger and the source hears nothing new", async () => {
    await withScenario(async (scenario) => {
      await createRepo({ scenario, name: "alpha" });
      const crew = configure({ scenario });
      crew.seedSource([
        { id: "TASK-1", title: "To clean up", agent: "scripted", repos: ["alpha"] },
      ]);

      await provisionDeliveredClean({ scenario, crew, repo: "alpha" });
      const updateCallsBeforeCleanup = crew.source.updateCalls().length;

      const clone = `${scenario.baseDirectory}/alpha`;
      const cleanup = await crew.cleanup(TASK);
      expect(cleanup.exitCode).toBe(0);

      // Worktree removed, branch deleted, run record gone.
      expect(fs.existsSync(crew.paths.worktreeFor("alpha", TASK))).toBe(false);
      expect(await worktreeList({ scenario, repoDirectory: clone })).toHaveLength(1);
      expect(await branchExists({ scenario, repoDirectory: clone, branch: crew.expect.branchFor(TASK) })).toBe(false);
      expect(runRecordExists({ path: crew.paths.stateFor(TASK) })).toBe(false);

      // Cleanup issued no writeback: the source's journal is unchanged.
      expect(crew.source.updateCalls()).toHaveLength(updateCallsBeforeCleanup);
    });
  });

  it("COMPLETE-07 — source-terminal auto-reap removes a clean lingering workspace", async () => {
    await withScenario(async (scenario) => {
      await createRepo({ scenario, name: "alpha" });
      const crew = configure({ scenario });
      crew.seedSource([
        { id: "TASK-1", title: "Auto-reap me", agent: "scripted", repos: ["alpha"] },
      ]);

      await provisionDeliveredClean({ scenario, crew, repo: "alpha" });
      const clone = `${scenario.baseDirectory}/alpha`;
      expect(await isDirty({ scenario, repoDirectory: crew.paths.worktreeFor("alpha", TASK) })).toBe(false);

      // The source now reports the task terminal (tracker moved to Done).
      markTaskTerminal(crew.source, "TASK-1");

      await crew.tick();
      await pollUntil({
        description: "the lingering workspace to be reaped",
        condition: () => !runRecordExists({ path: crew.paths.stateFor(TASK) }),
      });

      // The full triple is reaped.
      expect(fs.existsSync(crew.paths.worktreeFor("alpha", TASK))).toBe(false);
      expect(await worktreeList({ scenario, repoDirectory: clone })).toHaveLength(1);
      expect(await branchExists({ scenario, repoDirectory: clone, branch: crew.expect.branchFor(TASK) })).toBe(false);

      // The reap is logged.
      const reaped = readLogLines({ path: crew.paths.logFile }).some((line) =>
        /reap/u.test(line.event),
      );
      expect(reaped).toBe(true);
    });
  });

  it("COMPLETE-07 (variant) — auto-reap skips a dirty lingering workspace with a warning", async () => {
    await withScenario(async (scenario) => {
      await createRepo({ scenario, name: "alpha" });
      const crew = configure({ scenario });
      crew.seedSource([
        { id: "TASK-1", title: "Dirty linger", agent: "scripted", repos: ["alpha"] },
      ]);

      // Delivered, but the worktree is left dirty (completed via --allow-dirty).
      writeAgentScript({
        scenario,
        taskId: TASK,
        steps: [
          { type: "writeFile", path: "alpha/work.txt", content: "done\n" },
          { type: "gitCommit", repo: "alpha", message: "feat: implement" },
          { type: "writeFile", path: "alpha/scratch.txt", content: "uncommitted\n" },
          { type: "crew", args: ["done", "--outcome", "delivered", "--allow-dirty"] },
        ],
      });
      await crew.start(TASK);
      await waitForRunComplete(crew.paths.stateFor(TASK));
      const clone = `${scenario.baseDirectory}/alpha`;
      expect(await isDirty({ scenario, repoDirectory: crew.paths.worktreeFor("alpha", TASK) })).toBe(true);

      markTaskTerminal(crew.source, "TASK-1");

      await crew.tick();

      // A warning names the skip; nothing is reaped.
      await waitForWarnLogLine(crew.paths.logFile, /reap|skip|dirty/u);

      // Everything stays on disk.
      expect(fs.existsSync(crew.paths.worktreeFor("alpha", TASK))).toBe(true);
      expect(await worktreeList({ scenario, repoDirectory: clone })).toHaveLength(2);
      expect(await branchExists({ scenario, repoDirectory: clone, branch: crew.expect.branchFor(TASK) })).toBe(true);
      expect(runRecordExists({ path: crew.paths.stateFor(TASK) })).toBe(true);
    });
  });
});
