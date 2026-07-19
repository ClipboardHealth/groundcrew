/**
 * FLOW (catalog §3.F — DEVOP-5968) and PLUGIN (catalog §3.G — DEVOP-5973)
 * acceptance scenarios: the artifact/source contract (reported vs observed
 * layers, forge-blindness, claim rejection, done-ness is not core's business)
 * and source packaging/protocol (discovery, precedence, version handling,
 * capability-by-omission).
 *
 * Black-box: every assertion targets the observation surface (catalog §1.2) —
 * run records, dispatch verdicts, the fixture source's call journal, the fake
 * `gh` log, git facts, and loosely-matched `status`/`source list`/`doctor`
 * output where the human-facing text *is* the behavior. Written before v2 code
 * exists: RED now, GREEN once v2 meets the spec.
 */

import * as fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  commitSubjects,
  configure,
  createRepo,
  pollForValue,
  readDispatchVerdicts,
  readGhCalls,
  readRunRecord,
  runRecordExists,
  sessionExists,
  waitForSession,
  withScenario,
  writeAgentScript,
} from "../harness/index.js";
import type { RunRecord, SourceCall } from "../harness/index.js";

/** The completed writeback event as it lands on the source's `update` stdin (contracts §4.4). */
interface CompletedEvent {
  readonly type: "completed";
  readonly outcome: string;
  readonly artifacts?: ReadonlyArray<{
    readonly kind: string;
    readonly locator: string;
    readonly title?: string;
    readonly repo?: string;
  }>;
  readonly message?: string;
}

/** Reads the `event` payload off a recorded `update` call, if present. */
function eventOf(call: SourceCall): Record<string, unknown> {
  const stdin = call.stdin as { event?: Record<string, unknown> };
  return stdin.event ?? {};
}

/** The single `completed` writeback event the source received, or undefined. */
function completedEvent(calls: readonly SourceCall[]): CompletedEvent | undefined {
  for (const call of calls) {
    if (call.command === "update" && eventOf(call)["type"] === "completed") {
      return eventOf(call) as unknown as CompletedEvent;
    }
  }

  return undefined;
}

/** Artifacts carried by the completed writeback (empty when none/absent). */
function completedArtifacts(
  calls: readonly SourceCall[],
): ReadonlyArray<{ readonly kind: string; readonly locator: string }> {
  return completedEvent(calls)?.artifacts ?? [];
}

/**
 * Index of the last `completed` update in the journal, or -1. Module-scope so
 * the FLOW-05 test body stays free of conditionals (vitest/no-conditional-in-test).
 */
function lastCompletedIndex(calls: readonly SourceCall[]): number {
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const call = calls[index]!;
    if (call.command === "update" && eventOf(call)["type"] === "completed") {
      return index;
    }
  }

  return -1;
}

/** `list`/`get` calls the source received after the last completed writeback (should be none). */
function readsAfterCompletion(calls: readonly SourceCall[]): SourceCall[] {
  return calls
    .slice(lastCompletedIndex(calls) + 1)
    .filter((call) => call.command === "list" || call.command === "get");
}

/** Kind+locator projection, sorted, for order-insensitive artifact equality. */
function kindLocators(
  artifacts: ReadonlyArray<{ readonly kind: string; readonly locator: string }> | undefined,
): Array<{ kind: string; locator: string }> {
  return (artifacts ?? [])
    .map((artifact) => ({ kind: artifact.kind, locator: artifact.locator }))
    .toSorted((left, right) =>
      `${left.kind}:${left.locator}`.localeCompare(`${right.kind}:${right.locator}`),
    );
}

/** Polls the run record at `path` until it reaches `state: complete` (poll defaults ⇒ fail fast). */
async function waitForComplete(input: { readonly path: string }): Promise<RunRecord> {
  return await pollForValue({
    description: `run record ${input.path} to reach state=complete`,
    probe: () => {
      const record = runRecordExists({ path: input.path })
        ? readRunRecord({ path: input.path })
        : undefined;
      return record?.state === "complete" ? record : undefined;
    },
  });
}

// HARNESS GAP: there is no binding to author a source manifest with a chosen
// `protocolVersion` or a deliberately-malformed `source.json` (PLUGIN-03/04).
// The fixture installer always writes the committed protocol-1 manifest. These
// helpers rewrite the *installed* manifest inside the scenario tmpdir (test
// data, not a harness source file) as the sanctioned workaround.
function rewriteManifest(input: {
  readonly bundleDirectory: string;
  readonly mutate: (manifest: Record<string, unknown>) => Record<string, unknown>;
}): void {
  const manifestPath = path.join(input.bundleDirectory, "source.json");
  const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  fs.writeFileSync(manifestPath, JSON.stringify(input.mutate(parsed), undefined, 2) + "\n");
}

function corruptManifest(input: { readonly bundleDirectory: string }): void {
  const manifestPath = path.join(input.bundleDirectory, "source.json");
  fs.writeFileSync(manifestPath, "{ this is not valid json,,, \n");
}

describe("F. Artifacts & source contract", () => {
  it("FLOW-01 — reported and observed are separate layers (a missing report is never a lie)", async () => {
    await withScenario(async (scenario) => {
      await createRepo({ scenario, name: "alpha" });

      const crew = configure({ scenario });
      const taskId = "fixture:TASK-1";
      crew.seedSource([{ id: "TASK-1", title: "Do the thing", agent: "scripted", repos: ["alpha"] }]);

      // Agent commits real work but reports NO artifact, then completes delivered.
      writeAgentScript({
        scenario,
        steps: [
          { type: "writeFile", path: "alpha/work.txt", content: "flow-01\n" },
          { type: "gitCommit", repo: "alpha", message: "flow-01: work" },
          { type: "crew", args: ["done", "--outcome", "delivered"] },
        ],
      });

      await crew.tick();
      const record = await waitForComplete({ path: crew.paths.stateFor(taskId) });

      // The commit is observable in the lingering worktree (the observed layer)…
      const subjects = await commitSubjects({
        scenario,
        repoDirectory: crew.paths.worktreeFor("alpha", taskId),
      });
      expect(subjects).toContain("flow-01: work");

      // …but nothing was reported: run record and completed writeback carry zero artifacts.
      expect(record.outcome).toBe("delivered");
      expect(record.artifacts).toHaveLength(0);
      expect(completedArtifacts(crew.source.calls())).toHaveLength(0);

      // status renders the layering (design doc §3: "commits observed").
      const status = await crew.status(taskId);
      expect(status.exitCode).toBe(0);
      expect(status.stdout).toMatch(/observed/i);
    });
  });

  it("FLOW-02 — mixed artifact kinds round-trip through the completed writeback", async () => {
    await withScenario(async (scenario) => {
      await createRepo({ scenario, name: "alpha" });

      const crew = configure({ scenario });
      const taskId = "fixture:TASK-2";
      crew.seedSource([{ id: "TASK-2", title: "Mixed artifacts", agent: "scripted", repos: ["alpha"] }]);

      const expectedArtifacts = [
        { kind: "pr", locator: "https://github.com/o/r/pull/7" },
        { kind: "ticket", locator: "https://linear.app/x/issue/TASK-77" },
        { kind: "file", locator: "docs/output.md" },
      ];

      writeAgentScript({
        scenario,
        steps: [
          { type: "writeFile", path: "alpha/work.txt", content: "flow-02\n" },
          { type: "gitCommit", repo: "alpha", message: "flow-02: work" },
          { type: "crew", args: ["artifact", "add", expectedArtifacts[0]!.locator, "--kind", "pr"] },
          { type: "crew", args: ["artifact", "add", expectedArtifacts[1]!.locator, "--kind", "ticket"] },
          { type: "crew", args: ["artifact", "add", expectedArtifacts[2]!.locator, "--kind", "file"] },
          { type: "crew", args: ["done", "--outcome", "delivered"] },
        ],
      });

      await crew.tick();
      const record = await waitForComplete({ path: crew.paths.stateFor(taskId) });

      // The reported layer carries all three, kinds+locators intact (order-insensitive).
      expect(kindLocators(record.artifacts)).toEqual(kindLocators(expectedArtifacts));

      // …and they ride the completed writeback to the source unchanged.
      const completed = completedEvent(crew.source.calls());
      expect(completed?.outcome).toBe("delivered");
      expect(kindLocators(completed?.artifacts)).toEqual(kindLocators(expectedArtifacts));
    });
  });

  it("FLOW-03 — a rejected claim provisions nothing and stays visible", async () => {
    await withScenario(async (scenario) => {
      await createRepo({ scenario, name: "alpha" });

      const crew = configure({ scenario });
      const taskId = "fixture:TASK-3";
      // Store knob: the source answers this task's `claimed` writeback with `rejected`.
      crew.seedSource({
        tasks: [{ id: "TASK-3", title: "Contended", agent: "scripted", repos: ["alpha"] }],
        rejectClaims: ["TASK-3"],
      });

      await crew.tick();

      // No provisioning of any kind: no run record, no workspace, no session.
      expect(runRecordExists({ path: crew.paths.stateFor(taskId) })).toBe(false);
      expect(fs.existsSync(crew.paths.workspaceFor(taskId))).toBe(false);
      expect(await sessionExists({ scenario, name: crew.expect.sessionFor(taskId) })).toBe(false);

      // The claim was offered and answered rejected — recorded as the skip verdict.
      const claimed = crew.source
        .updateCalls()
        .filter((call) => eventOf(call)["type"] === "claimed");
      expect(claimed).toHaveLength(1);

      const verdicts = readDispatchVerdicts({ path: crew.paths.dispatchFile });
      expect(verdicts.verdicts[taskId]?.skipReason).toBe("claim-rejected");

      // …and the rejection is visible to a human via status.
      const status = await crew.status(taskId);
      expect(status.stdout).toMatch(/reject/i);
    });
  });

  // FLOW-04 is deferred post-v2.0 (catalog §3.F, iteration-4 log): the "progress
  // events flow" scenario requires an agent-facing progress emitter, and v2.0
  // ships none — `crew progress` is a documented seam, not built (DEVOP-5982
  // §6). The `progress` event stays in protocol 1 (contracts §4.4); this ID is
  // reserved and the scenario activates only when the emitter ships.
  // oxlint-disable-next-line vitest/no-disabled-tests -- catalog §3.F mandates this reserved ID; the skip is intentional, not a forgotten test
  it.skip("FLOW-04 — progress events flow (reserved: no agent-facing progress emitter in v2.0)", () => {
    // Intentionally unimplemented. See the comment above.
  });

  it("FLOW-05 — done-ness is the source's business; core issues no reads to confirm it", async () => {
    await withScenario(async (scenario) => {
      await createRepo({ scenario, name: "alpha" });

      const crew = configure({ scenario });
      const taskId = "fixture:TASK-5";
      const localId = "TASK-5";
      crew.seedSource([{ id: localId, title: "Delivered", agent: "scripted", repos: ["alpha"] }]);

      const prLocator = "https://github.com/o/r/pull/5";
      writeAgentScript({
        scenario,
        steps: [
          { type: "writeFile", path: "alpha/work.txt", content: "flow-05\n" },
          { type: "gitCommit", repo: "alpha", message: "flow-05: work" },
          { type: "crew", args: ["artifact", "add", prLocator, "--kind", "pr"] },
          { type: "crew", args: ["done", "--outcome", "delivered"] },
        ],
      });

      await crew.tick();
      await waitForComplete({ path: crew.paths.stateFor(taskId) });

      // Capture the journal BEFORE any further read-issuing command (status below).
      const calls = crew.source.calls();
      expect(lastCompletedIndex(calls)).toBeGreaterThanOrEqual(0);

      // Core does not poll list/get to "confirm" or reconcile done-ness afterwards.
      expect(readsAfterCompletion(calls)).toHaveLength(0);

      // The source store says whatever its OWN update handler chose — core did not touch it.
      const completions = (crew.source.readStore() as { completions?: Record<string, { outcome: string }> })
        .completions;
      expect(completions?.[localId]?.outcome).toBe("delivered");

      // status renders the agent's report unchanged (the reported artifact is shown).
      const status = await crew.status(taskId);
      expect(status.exitCode).toBe(0);
      expect(status.stdout).toContain(prLocator);
    });
  });

  it("FLOW-06 — core is forge-blind: zero `gh` invocations across a full dispatch→complete cycle", async () => {
    await withScenario(async (scenario) => {
      await createRepo({ scenario, name: "alpha" });

      const crew = configure({ scenario });
      const taskId = "fixture:TASK-6";
      crew.seedSource([{ id: "TASK-6", title: "Forge-blind", agent: "scripted", repos: ["alpha"] }]);

      // A clean cycle that never touches `gh`; any recorded call could only be core's.
      writeAgentScript({
        scenario,
        steps: [
          { type: "writeFile", path: "alpha/work.txt", content: "flow-06\n" },
          { type: "gitCommit", repo: "alpha", message: "flow-06: work" },
          { type: "crew", args: ["done", "--outcome", "delivered"] },
        ],
      });

      await crew.tick();
      await waitForComplete({ path: crew.paths.stateFor(taskId) });

      // The fake `gh` records every invocation; the core process must make none.
      expect(readGhCalls({ scenario })).toHaveLength(0);
    });
  });
});

describe("G. Source packaging & protocol", () => {
  it("PLUGIN-01 — user-dir source discovery: lists and serves a dispatch", async () => {
    await withScenario(async (scenario) => {
      await createRepo({ scenario, name: "alpha" });

      const crew = configure({ scenario });
      // Keep the session alive so the dispatch is observable without a completion race.
      writeAgentScript({ scenario, steps: [{ type: "hang" }] });

      const list = await crew.sourceList();
      expect(list.exitCode).toBe(0);
      expect(list.stdout).toMatch(/fixture/);
      expect(list.stdout).toMatch(/user/i); // provenance tier (design doc §6)
      expect(list.stdout).toMatch(/\b1\b/); // protocolVersion 1
      expect(list.stdout).toMatch(/update/i); // write capability advertised

      const taskId = "fixture:TASK-1";
      crew.seedSource([{ id: "TASK-1", title: "Served", agent: "scripted", repos: ["alpha"] }]);
      await crew.tick();

      await waitForSession({ scenario, name: crew.expect.sessionFor(taskId) });
      expect(fs.existsSync(crew.paths.worktreeFor("alpha", taskId))).toBe(true);
      const record = readRunRecord({ path: crew.paths.stateFor(taskId) });
      expect(record.events.some((event) => event.event === "claimed")).toBe(true);
    });
  });

  it("PLUGIN-02 — name collision: the user-dir bundle wins and the override is visible", async () => {
    await withScenario(async (scenario) => {
      await createRepo({ scenario, name: "alpha" });

      // A user-dir bundle named `todo-txt` — the same name the package ships.
      // HARNESS GAP / dependency: this collision is only real once v2 ships a
      // package bundle at `task-sources/todo-txt/` (today it is a `.gitkeep`
      // placeholder). Until then the override marker cannot appear and this
      // stays red; that matches "green once v2 meets spec".
      const crew = configure({
        scenario,
        config: { sources: [{ name: "todo-txt", kind: "todo-txt", agent: "scripted" }] },
      });
      writeAgentScript({ scenario, steps: [{ type: "hang" }] });

      const list = await crew.sourceList();
      expect(list.exitCode).toBe(0);
      expect(list.stdout).toMatch(/todo-txt/);
      expect(list.stdout).toMatch(/user/i);
      expect(list.stdout).toMatch(/override|overrides|overrid|shadow/i);

      // The user's bundle is the one that actually serves the dispatch: proven by
      // its own call journal recording the poll (the package bundle writes elsewhere).
      const taskId = "todo-txt:TASK-1";
      crew.seedSource([{ id: "TASK-1", title: "Served by user bundle", agent: "scripted", repos: ["alpha"] }]);
      await crew.tick();

      await waitForSession({ scenario, name: crew.expect.sessionFor(taskId) });
      expect(crew.source.calls().length).toBeGreaterThan(0);
    });
  });

  it("PLUGIN-03 — protocol mismatch is loud and does not take down healthy sources", async () => {
    await withScenario(async (scenario) => {
      await createRepo({ scenario, name: "alpha" });

      const crew = configure({
        scenario,
        config: {
          sources: [
            { name: "broken", kind: "broken", agent: "scripted" },
            { name: "healthy", kind: "healthy", agent: "scripted" },
          ],
        },
      });
      writeAgentScript({ scenario, steps: [{ type: "hang" }] });

      const [broken, healthy] = crew.sources;
      rewriteManifest({
        bundleDirectory: broken!.bundleDirectory,
        mutate: (manifest) => ({ ...manifest, protocolVersion: 99 }),
      });

      // The error names the offending version and the supported set, and does
      // not silently drop the source (its name still appears).
      const list = await crew.sourceList();
      const listText = list.stdout + list.stderr;
      expect(listText).toMatch(/99/);
      expect(listText).toMatch(/\b1\b/);
      expect(listText).toMatch(/broken/);

      // doctor surfaces the same failure and exits nonzero.
      const doctor = await crew.doctor();
      expect(doctor.exitCode).toBe(1);
      expect(doctor.stdout + doctor.stderr).toMatch(/99/);

      // The healthy source is unaffected: it lists and serves a dispatch.
      const taskId = "healthy:TASK-1";
      healthy!.seed({ tasks: [{ id: "TASK-1", title: "Healthy", agent: "scripted", repos: ["alpha"] }] });
      await crew.tick();
      await waitForSession({ scenario, name: crew.expect.sessionFor(taskId) });
      expect(fs.existsSync(crew.paths.worktreeFor("alpha", taskId))).toBe(true);
    });
  });

  it("PLUGIN-04 — an unparseable manifest is skipped with a warning; discovery proceeds", async () => {
    await withScenario(async (scenario) => {
      await createRepo({ scenario, name: "alpha" });

      const crew = configure({
        scenario,
        config: {
          sources: [
            { name: "broken", kind: "broken", agent: "scripted" },
            { name: "healthy", kind: "healthy", agent: "scripted" },
          ],
        },
      });
      writeAgentScript({ scenario, steps: [{ type: "hang" }] });

      const [broken, healthy] = crew.sources;
      corruptManifest({ bundleDirectory: broken!.bundleDirectory });

      // `source list` still succeeds (exit 0) and warns, naming the file.
      const list = await crew.sourceList();
      expect(list.exitCode).toBe(0);
      expect(list.stdout + list.stderr).toMatch(/source\.json/i);

      // The other source is entirely unaffected: it lists and serves.
      const taskId = "healthy:TASK-1";
      healthy!.seed({ tasks: [{ id: "TASK-1", title: "Healthy", agent: "scripted", repos: ["alpha"] }] });
      await crew.tick();
      await waitForSession({ scenario, name: crew.expect.sessionFor(taskId) });
      expect(fs.existsSync(crew.paths.worktreeFor("alpha", taskId))).toBe(true);
    });
  });

  it("PLUGIN-05 — capability by omission: a source without `update` is read-only, no error", async () => {
    await withScenario(async (scenario) => {
      const crew = configure({
        scenario,
        config: { sources: [{ name: "fixture", readOnly: true, agent: "scripted" }] },
      });
      writeAgentScript({ scenario, steps: [{ type: "hang" }] });

      // Omitting `update` is legal: no version sniffing, no error — read-only.
      const list = await crew.sourceList();
      expect(list.exitCode).toBe(0);
      expect(list.stdout).toMatch(/read-?only/i);
      expect(list.stdout).toMatch(/\b1\b/); // protocol is still 1
      expect(list.stdout + list.stderr).not.toMatch(/unsupported|protocol.*(mismatch|error)/i);
    });
  });
});
