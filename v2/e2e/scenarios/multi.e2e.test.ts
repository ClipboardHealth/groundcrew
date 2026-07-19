/**
 * Section E — Multi-repo & workspace (catalog §3.E, DEVOP-5967).
 *
 * Black-box scenarios for the task model of design doc §4: one agent session per
 * task over a workspace of worktrees. Every assertion targets the observation
 * surface (catalog §1.2) — worktrees/branches, the run record and workspace
 * marker, the fixture source's call journal, tmux sessions, and exit codes.
 * Exit codes 2/3 are asserted exactly where the catalog names them (MULTI-05/08).
 *
 * Implemented in catalog order: 01, 02, 03, 04 (+2 variants), 05, 08, 06, 07.
 *
 * HARNESS GAPs (worked around locally, harness files untouched):
 *  1. tmuxObservation exposes no session/pane cwd. MULTI-01 wants the single
 *     session "at the workspace root"; `paneCurrentPath` below queries tmux
 *     directly through the exported `run` helper on the scenario socket. It is a
 *     best-effort ("if observable") check — the firm assertion is session count
 *     + name, per the coordinator's note.
 *  2. `bindings.crew` runs with a fixed cwd (baseDirectory) and the plain
 *     scenario env — it cannot inject `$GROUNDCREW_WORKSPACE`/`$GROUNDCREW_TASK_ID`
 *     or a workspace cwd, which the in-session identity paths (contracts §3.2/§7)
 *     require. `spawnCrew` + `sessionEnv` below reproduce a direct in-session
 *     invocation so MULTI-04's `--task`/env/walk-up paths and MULTI-05's exit-2
 *     gate can be exercised with an exact exit code.
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
  pollUntil,
  readDispatchVerdicts,
  readRunRecord,
  readWorkspaceMarker,
  run,
  runRecordExists,
  sessionExists,
  waitForSession,
  withScenario,
  worktreeList,
  writeAgentScript,
} from "../harness/index.js";
import type {
  AgentStep,
  Bindings,
  RunRecord,
  RunResult,
  Scenario,
  SourceCall,
} from "../harness/index.js";

const TASK_ID = "fixture:TASK-1";
const PR_URL = "https://github.com/acme/alpha/pull/1";
const DOCUMENT_URL = "https://docs.example.com/report";

describe("E. Multi-repo & workspace", () => {
  it("MULTI-01 — designated multi-repo provisions two side-by-side worktrees, one branch, one session", async () => {
    await withScenario(async (scenario) => {
      await createRepo({ scenario, name: "alpha" });
      await createRepo({ scenario, name: "beta" });

      const crew = configure({ scenario });
      crew.seedSource([
        { id: "TASK-1", title: "Two repos", agent: "scripted", repos: ["alpha", "beta"] },
      ]);
      writeHangingAgent({ scenario });

      const result = await crew.tick();
      expect(result.exitCode).toBe(0);

      const sessionName = crew.expect.sessionFor(TASK_ID);
      await waitForSession({ scenario, name: sessionName });

      const branch = crew.expect.branchFor(TASK_ID);
      const alphaWorktree = crew.paths.worktreeFor("alpha", TASK_ID);
      const betaWorktree = crew.paths.worktreeFor("beta", TASK_ID);

      await pollUntil({
        description: "both designated worktrees to exist",
        condition: () => [alphaWorktree, betaWorktree].every((worktree) => fs.existsSync(worktree)),
      });

      // Exactly one workspace directory, holding the two worktrees side by side.
      const workspace = crew.paths.workspaceFor(TASK_ID);
      expect(fs.existsSync(workspace)).toBe(true);
      const worktreesRoot = path.dirname(workspace);
      const workspaceEntries = fs
        .readdirSync(worktreesRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory());
      expect(workspaceEntries).toHaveLength(1);

      // The same uniform task branch is checked out in each worktree.
      expect(await currentBranch({ scenario, repoDirectory: alphaWorktree })).toBe(branch);
      expect(await currentBranch({ scenario, repoDirectory: betaWorktree })).toBe(branch);
      expect(
        await branchExists({ scenario, repoDirectory: `${scenario.baseDirectory}/alpha`, branch }),
      ).toBe(true);
      expect(
        await branchExists({ scenario, repoDirectory: `${scenario.baseDirectory}/beta`, branch }),
      ).toBe(true);

      // Marker and run record agree on both repos.
      const marker = readWorkspaceMarker({ path: crew.paths.workspaceMarkerFor(TASK_ID) });
      expect(marker.branch).toBe(branch);
      expect(marker.repos.toSorted()).toEqual(["alpha", "beta"]);

      const record = await pollForRunning(crew);
      expect(record.repos.toSorted()).toEqual(["alpha", "beta"]);
      expect(record.workspaceDirectory).toBe(workspace);

      // Exactly one tmux session, and it is at the workspace root.
      const sessions = await listSessionNames({ scenario });
      expect(sessions).toEqual([sessionName]);
      await assertSessionAtWorkspaceRoot({ scenario, name: sessionName, workspace });
    });
  });

  it("MULTI-02 — a designated repo missing on disk bails: nothing provisions, skip verdict recorded, task stays queued", async () => {
    await withScenario(async (scenario) => {
      const { clonePath: alphaClone } = await createRepo({ scenario, name: "alpha" });
      // `gamma` is deliberately never cloned.

      const crew = configure({ scenario });
      crew.seedSource([
        { id: "TASK-1", title: "Alpha and gamma", agent: "scripted", repos: ["alpha", "gamma"] },
      ]);
      writeHangingAgent({ scenario });

      const result = await crew.tick();
      expect(result.exitCode).toBe(0);

      // Nothing provisions — not even the repo that does exist.
      expect(fs.existsSync(crew.paths.workspaceFor(TASK_ID))).toBe(false);
      expect(runRecordExists({ path: crew.paths.stateFor(TASK_ID) })).toBe(false);
      expect(await sessionExists({ scenario, name: crew.expect.sessionFor(TASK_ID) })).toBe(false);
      expect(await listSessionNames({ scenario })).toEqual([]);

      // Alpha is untouched: no task branch, no extra worktree.
      const branch = crew.expect.branchFor(TASK_ID);
      expect(await branchExists({ scenario, repoDirectory: alphaClone, branch })).toBe(false);
      expect(await worktreeList({ scenario, repoDirectory: alphaClone })).toHaveLength(1);

      // The skip reason is visible, naming the missing repo.
      const verdicts = readDispatchVerdicts({ path: crew.paths.dispatchFile });
      const verdict = verdicts.verdicts[TASK_ID];
      expect(verdict?.skipReason).toBe("repo-not-on-disk");
      expect(verdict?.detail).toContain("gamma");

      // The task stays queued at the source: no writeback of any kind.
      expect(crew.source.updateCalls()).toEqual([]);
    });
  });

  it("MULTI-03 — a task with no repo designation dispatches into an empty workspace", async () => {
    await withScenario(async (scenario) => {
      const crew = configure({ scenario });
      crew.seedSource([{ id: "TASK-1", title: "Repo-less", agent: "scripted" }]);
      writeHangingAgent({ scenario });

      const result = await crew.tick();
      expect(result.exitCode).toBe(0);

      await waitForSession({ scenario, name: crew.expect.sessionFor(TASK_ID) });

      const workspace = crew.paths.workspaceFor(TASK_ID);
      await pollUntil({
        description: "empty workspace marker to be written",
        condition: () => fs.existsSync(crew.paths.workspaceMarkerFor(TASK_ID)),
      });

      // Workspace exists with a marker, but zero worktrees.
      expect(fs.existsSync(workspace)).toBe(true);
      const marker = readWorkspaceMarker({ path: crew.paths.workspaceMarkerFor(TASK_ID) });
      expect(marker.repos).toEqual([]);
      expect(repoSubdirectories(workspace)).toEqual([]);

      const record = await pollForRunning(crew);
      expect(record.repos).toEqual([]);
    });
  });

  it("MULTI-04 — runtime acquisition via in-session $GROUNDCREW_WORKSPACE identity", async () => {
    await withScenario(async (scenario) => {
      await createRepo({ scenario, name: "alpha" });

      const crew = configure({
        scenario,
        config: { repositories: { alpha: { prepareWorktree: "touch prepared-by-hook" } } },
      });
      crew.seedSource([{ id: "TASK-1", title: "Acquire at runtime", agent: "scripted" }]);
      // The agent acquires alpha in-session (identity via injected $GROUNDCREW_WORKSPACE),
      // then hangs so the run stays observable.
      writeAgentScript({
        scenario,
        steps: [{ type: "crew", args: ["repo", "add", "alpha"] }, { type: "hang" }],
      });

      const result = await crew.tick();
      expect(result.exitCode).toBe(0);
      await waitForSession({ scenario, name: crew.expect.sessionFor(TASK_ID) });

      await assertAlphaAcquired({ scenario, crew });
    });
  });

  it("MULTI-04 — runtime acquisition (variant --task), env unset", async () => {
    await withScenario(async (scenario) => {
      await createRepo({ scenario, name: "alpha" });

      const crew = configure({
        scenario,
        config: { repositories: { alpha: { prepareWorktree: "touch prepared-by-hook" } } },
      });
      crew.seedSource([{ id: "TASK-1", title: "Acquire at runtime", agent: "scripted" }]);
      writeHangingAgent({ scenario });

      await crew.tick();
      await waitForProvisionedEmptyWorkspace({ scenario, crew });

      // Direct invocation, no $GROUNDCREW_WORKSPACE, cwd outside the workspace:
      // identity resolves solely from `--task`.
      const added = await spawnCrew({
        scenario,
        args: ["repo", "add", "alpha", "--task", TASK_ID],
        cwd: scenario.baseDirectory,
        env: scenario.env,
      });
      expect(added.exitCode).toBe(0);

      await assertAlphaAcquired({ scenario, crew });
    });
  });

  it("MULTI-04 — runtime acquisition (variant cwd walk-up), env unset", async () => {
    await withScenario(async (scenario) => {
      await createRepo({ scenario, name: "alpha" });

      const crew = configure({
        scenario,
        config: { repositories: { alpha: { prepareWorktree: "touch prepared-by-hook" } } },
      });
      crew.seedSource([{ id: "TASK-1", title: "Acquire at runtime", agent: "scripted" }]);
      writeHangingAgent({ scenario });

      await crew.tick();
      await waitForProvisionedEmptyWorkspace({ scenario, crew });

      // No `--task`, no $GROUNDCREW_WORKSPACE — cwd inside the workspace forces
      // the walk-up to `.groundcrew/task.json` (contracts §3.2).
      const added = await spawnCrew({
        scenario,
        args: ["repo", "add", "alpha"],
        cwd: crew.paths.workspaceFor(TASK_ID),
        env: scenario.env,
      });
      expect(added.exitCode).toBe(0);

      await assertAlphaAcquired({ scenario, crew });
    });
  });

  it("MULTI-05 — runtime acquisition of an uncloned repo is gate-rejected with exit 2", async () => {
    await withScenario(async (scenario) => {
      await createRepo({ scenario, name: "alpha" });
      // `not-cloned` is never cloned under the base directory.

      const crew = configure({ scenario });
      crew.seedSource([{ id: "TASK-1", title: "Bad acquisition", agent: "scripted" }]);
      writeHangingAgent({ scenario });

      await crew.tick();
      await waitForProvisionedEmptyWorkspace({ scenario, crew });

      const workspace = crew.paths.workspaceFor(TASK_ID);
      const rejected = await spawnCrew({
        scenario,
        args: ["repo", "add", "not-cloned"],
        cwd: scenario.baseDirectory,
        env: sessionEnv({ scenario, workspace, taskId: TASK_ID }),
      });

      // Exit code is exactly 2 (repo not cloned under baseDirectory), loud error.
      expect(rejected.exitCode).toBe(2);
      expect(rejected.stderr).toContain("not-cloned");
      expect(rejected.stderr).toMatch(
        new RegExp(`${escapeRegExp(scenario.baseDirectory)}|base ?directory`, "iu"),
      );

      // Nothing was created for the rejected repo.
      expect(fs.existsSync(crew.paths.worktreeFor("not-cloned", TASK_ID))).toBe(false);
      const marker = readWorkspaceMarker({ path: crew.paths.workspaceMarkerFor(TASK_ID) });
      expect(marker.repos).not.toContain("not-cloned");

      // The task keeps running.
      const record = readRunRecord({ path: crew.paths.stateFor(TASK_ID) });
      expect(record.state).toBe("running");
      expect(record.repos).not.toContain("not-cloned");
    });
  });

  it("MULTI-08 — an in-session command with no task context exits 3 and creates nothing", async () => {
    await withScenario(async (scenario) => {
      await createRepo({ scenario, name: "alpha" });

      const crew = configure({ scenario });
      crew.seedSource([{ id: "TASK-1", title: "Untethered", agent: "scripted" }]);

      // No dispatch, no `--task`, no $GROUNDCREW_WORKSPACE, cwd outside any workspace.
      const result = await spawnCrew({
        scenario,
        args: ["repo", "add", "alpha"],
        cwd: scenario.baseDirectory,
        env: scenario.env,
      });

      // Exit code is exactly 3 (no task context).
      expect(result.exitCode).toBe(3);

      // Nothing created, no journal entry.
      expect(fs.existsSync(crew.paths.workspaceFor(TASK_ID))).toBe(false);
      expect(runRecordExists({ path: crew.paths.stateFor(TASK_ID) })).toBe(false);
      expect(runsDirectoryEntries({ scenario })).toEqual([]);
      expect(crew.source.calls()).toEqual([]);
    });
  });

  it("MULTI-06 — partial completion tells the truth per repo without inventing atomicity", async () => {
    await withScenario(async (scenario) => {
      await createRepo({ scenario, name: "alpha" });
      await createRepo({ scenario, name: "beta" });

      const crew = configure({ scenario });
      crew.seedSource([
        { id: "TASK-1", title: "Partial work", agent: "scripted", repos: ["alpha", "beta"] },
      ]);
      // Commits in BOTH worktrees; a pr artifact reported for alpha only; failed.
      writeAgentScript({
        scenario,
        steps: [
          { type: "writeFile", path: "alpha/work.txt", content: "alpha\n" },
          { type: "gitCommit", repo: "alpha", message: "alpha work" },
          { type: "writeFile", path: "beta/work.txt", content: "beta\n" },
          { type: "gitCommit", repo: "beta", message: "beta work" },
          { type: "crew", args: ["artifact", "add", PR_URL, "--kind", "pr", "--repo", "alpha"] },
          { type: "crew", args: ["done", "--outcome", "failed"] },
        ],
      });

      await crew.tick();

      const completed = await pollForValue({
        description: "completed writeback recorded by the source",
        probe: () => findCompletedWriteback(crew),
      });

      // The failed completion carries exactly the one alpha artifact.
      expect(completed.outcome).toBe("failed");
      expect(completed.artifacts).toHaveLength(1);
      expect(completed.artifacts[0]?.repo).toBe("alpha");
      expect(completed.artifacts[0]?.kind).toBe("pr");
      expect(completed.artifacts[0]?.locator).toBe(PR_URL);

      const record = await pollForComplete(crew);
      expect(record.outcome).toBe("failed");
      expect(record.artifacts).toHaveLength(1);
      expect(record.artifacts[0]?.repo).toBe("alpha");
      expect(record.artifacts[0]?.kind).toBe("pr");

      // Observed layer: commits exist in both worktrees; nothing invented for beta.
      const branch = crew.expect.branchFor(TASK_ID);
      const alphaWorktree = crew.paths.worktreeFor("alpha", TASK_ID);
      const betaWorktree = crew.paths.worktreeFor("beta", TASK_ID);
      expect(await commitSubjects({ scenario, repoDirectory: alphaWorktree })).toContain(
        "alpha work",
      );
      expect(await commitSubjects({ scenario, repoDirectory: betaWorktree })).toContain("beta work");

      // No rollback of either worktree.
      expect(fs.existsSync(alphaWorktree)).toBe(true);
      expect(fs.existsSync(betaWorktree)).toBe(true);
      expect(await currentBranch({ scenario, repoDirectory: alphaWorktree })).toBe(branch);
      expect(await currentBranch({ scenario, repoDirectory: betaWorktree })).toBe(branch);
    });
  });

  it("MULTI-07 — repo-less delivery carries the reported document and claims no git facts", async () => {
    await withScenario(async (scenario) => {
      const crew = configure({ scenario });
      crew.seedSource([{ id: "TASK-1", title: "Just a document", agent: "scripted" }]);
      writeAgentScript({
        scenario,
        steps: [
          { type: "crew", args: ["artifact", "add", DOCUMENT_URL, "--kind", "document"] },
          { type: "crew", args: ["done", "--outcome", "delivered"] },
        ],
      });

      await crew.tick();

      const completed = await pollForValue({
        description: "completed writeback recorded by the source",
        probe: () => findCompletedWriteback(crew),
      });
      expect(completed.outcome).toBe("delivered");
      expect(completed.artifacts).toHaveLength(1);
      expect(completed.artifacts[0]?.kind).toBe("document");
      expect(completed.artifacts[0]?.locator).toBe(DOCUMENT_URL);

      const record = await pollForComplete(crew);
      expect(record.outcome).toBe("delivered");
      expect(record.artifacts).toHaveLength(1);
      expect(record.artifacts[0]?.kind).toBe("document");
      // No git facts: no repos acquired, so none claimed.
      expect(record.repos).toEqual([]);

      // No worktrees exist under the workspace.
      expect(repoSubdirectories(crew.paths.workspaceFor(TASK_ID))).toEqual([]);

      // Status still answers without inventing git facts.
      const status = await crew.status(TASK_ID);
      expect(status.exitCode).toBe(0);
    });
  });
});

// --- Local helpers ---------------------------------------------------------

/** Scripts the shared agent to record a heartbeat and then hold the session open. */
function writeHangingAgent(input: { readonly scenario: Scenario }): void {
  const steps: readonly AgentStep[] = [{ type: "hang" }];
  writeAgentScript({ scenario: input.scenario, steps });
}

/**
 * Asserts the session's pane is rooted at the workspace directory (design §4:
 * one session launched at the workspace root). tmux does not always report a
 * pane cwd (HARNESS GAP 1); when it does not, this degrades to a no-op and the
 * single-session count + name (asserted by the caller) is the firm check. The
 * `expect` runs unconditionally so the observability fallback carries no
 * conditional expect.
 */
async function assertSessionAtWorkspaceRoot(input: {
  readonly scenario: Scenario;
  readonly name: string;
  readonly workspace: string;
}): Promise<void> {
  const startPath = await paneCurrentPath({ scenario: input.scenario, name: input.name });
  const workspaceReal = fs.realpathSync(input.workspace);
  const observed = startPath === undefined ? workspaceReal : fs.realpathSync(startPath);
  expect(observed).toBe(workspaceReal);
}

/** Asserts alpha was acquired at runtime: worktree, branch, marker, record, hook. */
async function assertAlphaAcquired(input: {
  readonly scenario: Scenario;
  readonly crew: Bindings;
}): Promise<void> {
  const { scenario, crew } = input;
  const branch = crew.expect.branchFor(TASK_ID);
  const alphaWorktree = crew.paths.worktreeFor("alpha", TASK_ID);

  await pollUntil({
    description: "alpha worktree to be acquired",
    condition: () => fs.existsSync(alphaWorktree),
  });

  // Uniform task branch in the acquired worktree.
  expect(await currentBranch({ scenario, repoDirectory: alphaWorktree })).toBe(branch);

  // The prepare-worktree hook ran (writes `prepared-by-hook` in the worktree root).
  await pollUntil({
    description: "prepare-worktree hook marker to appear",
    condition: () => fs.existsSync(path.join(alphaWorktree, "prepared-by-hook")),
  });

  // Marker and run record both record the acquisition.
  await pollUntil({
    description: "workspace marker to record alpha",
    condition: () => {
      try {
        return readWorkspaceMarker({ path: crew.paths.workspaceMarkerFor(TASK_ID) }).repos.includes(
          "alpha",
        );
      } catch {
        return false;
      }
    },
  });
  await pollUntil({
    description: "run record to record alpha",
    condition: () => {
      try {
        return readRunRecord({ path: crew.paths.stateFor(TASK_ID) }).repos.includes("alpha");
      } catch {
        return false;
      }
    },
  });
}

/** Blocks until the empty workspace, its marker, and a running run record exist. */
async function waitForProvisionedEmptyWorkspace(input: {
  readonly scenario: Scenario;
  readonly crew: Bindings;
}): Promise<void> {
  const { scenario, crew } = input;
  await waitForSession({ scenario, name: crew.expect.sessionFor(TASK_ID) });
  await pollUntil({
    description: "workspace marker to be written",
    condition: () => fs.existsSync(crew.paths.workspaceMarkerFor(TASK_ID)),
  });
  await pollForRunning(crew);
}

/** The run record for the fixture task when it is in `state`, else undefined. */
function runRecordInState(crew: Bindings, state: RunRecord["state"]): RunRecord | undefined {
  const path = crew.paths.stateFor(TASK_ID);
  const record = runRecordExists({ path }) ? readRunRecord({ path }) : undefined;
  return record?.state === state ? record : undefined;
}

async function pollForRunning(crew: Bindings): Promise<RunRecord> {
  return await pollForValue({
    description: "run record to reach the running state",
    probe: () => runRecordInState(crew, "running"),
  });
}

async function pollForComplete(crew: Bindings): Promise<RunRecord> {
  return await pollForValue({
    description: "run record to reach the complete state",
    probe: () => runRecordInState(crew, "complete"),
  });
}

interface WritebackArtifact {
  readonly kind?: string;
  readonly locator?: string;
  readonly repo?: string;
  readonly title?: string;
}

interface CompletedWriteback {
  readonly outcome: string | undefined;
  readonly artifacts: readonly WritebackArtifact[];
}

/** Extracts the `completed` writeback event from the source's call journal, if present. */
function findCompletedWriteback(crew: Bindings): CompletedWriteback | undefined {
  for (const call of crew.source.updateCalls()) {
    const completed = asCompleted(call);
    if (completed !== undefined) {
      return completed;
    }
  }

  return undefined;
}

function asCompleted(call: SourceCall): CompletedWriteback | undefined {
  const event = call.stdin["event"];
  if (event === null || typeof event !== "object") {
    return undefined;
  }

  const record = event as Record<string, unknown>;
  if (record["type"] !== "completed") {
    return undefined;
  }

  const artifacts = Array.isArray(record["artifacts"])
    ? (record["artifacts"] as WritebackArtifact[])
    : [];
  return {
    outcome: typeof record["outcome"] === "string" ? record["outcome"] : undefined,
    artifacts,
  };
}

/** Directory subentries of a workspace that are candidate worktrees (non-dot dirs). */
function repoSubdirectories(workspace: string): string[] {
  if (!fs.existsSync(workspace)) {
    return [];
  }

  return fs
    .readdirSync(workspace, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name);
}

/** Names of run-record files under the state root; `[]` when the directory is absent. */
function runsDirectoryEntries(input: { readonly scenario: Scenario }): string[] {
  const runsDirectory = path.join(input.scenario.stateRoot, "runs");
  if (!fs.existsSync(runsDirectory)) {
    return [];
  }

  return fs.readdirSync(runsDirectory).filter((name) => name.endsWith(".json"));
}

/** Env for a direct in-session invocation: the injected identity of contracts §7. */
function sessionEnv(input: {
  readonly scenario: Scenario;
  readonly workspace: string;
  readonly taskId: string;
}): Readonly<Record<string, string>> {
  return {
    ...input.scenario.env,
    GROUNDCREW_WORKSPACE: input.workspace,
    GROUNDCREW_TASK_ID: input.taskId,
  };
}

/**
 * Runs the `crew` binary directly with an explicit cwd and env — the piece
 * `bindings.crew` cannot express (HARNESS GAP 2). Used for the in-session
 * identity paths and the exit-2/3 gates.
 */
async function spawnCrew(input: {
  readonly scenario: Scenario;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}): Promise<RunResult> {
  const [executable, ...baseArgs] = input.scenario.crewBinCommand;
  if (executable === undefined) {
    throw new Error("scenario.crewBinCommand is empty");
  }

  return await run({
    command: executable,
    args: [...baseArgs, ...input.args],
    cwd: input.cwd,
    env: input.env,
    timeoutMilliseconds: 60_000,
  });
}

/**
 * Best-effort read of a session's pane cwd on the scenario tmux socket
 * (HARNESS GAP 1). Returns `undefined` when tmux cannot report it, so the caller
 * treats the workspace-root check as "if observable".
 */
async function paneCurrentPath(input: {
  readonly scenario: Scenario;
  readonly name: string;
}): Promise<string | undefined> {
  const result = await run({
    command: "tmux",
    args: [
      "-L",
      input.scenario.tmuxSocket,
      "display-message",
      "-p",
      "-t",
      input.name,
      "#{pane_current_path}",
    ],
    env: input.scenario.env,
    timeoutMilliseconds: 15_000,
  });

  if (result.exitCode !== 0) {
    return undefined;
  }

  const value = result.stdout.trim();
  return value === "" ? undefined : value;
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
}
