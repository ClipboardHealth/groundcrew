# Groundcrew v2 acceptance suite

The black-box acceptance suite for groundcrew v2. It spawns the built `crew`
binary and observes the world; it never imports `src/`. Any implementation that
passes this suite is conformant (design doc §1, catalog §1.1). dependency-cruiser
enforces the `e2e ↛ src` boundary — the suite has no other way to reach the
implementation than the binary and the files it writes.

This document describes the harness. The scenarios themselves (one `*.e2e.test.ts`
per catalog ID) are added on top of it.

## Layout

```text
e2e/
  harness/            the reusable harness (this is what the self-tests cover)
    scenario.ts         per-scenario hermetic environment (HOME/XDG/PATH/tmux socket)
    bindings.ts         catalog operations → `crew` invocations + computed paths/expectations
    gitFixtures.ts      local bare repos, working clones, git observation
    tmuxObservation.ts  session exists/alive/exited on the scenario's tmux socket
    stateObservation.ts read-only parsers for run records, dispatch.json, markers, the JSONL log
    fixtureSource.ts    installs the fixture source; reads its task store + call journal
    scriptedAgent.ts    installs the scripted agent; writes step scripts; heartbeat sync
    fakeBin.ts          reads the fake `gh` call log; failing/recording shim generators
    schemas.ts          zod transcription of contracts §3–§4 (state files, protocol)
    logSchema.ts        zod transcription of the log line format (contracts §6)
    identity.ts         slug / branch / session-name computations (contracts §1)
    poll.ts             poll-with-timeout (the only sanctioned synchronization)
    exec.ts             execa wrapper capturing stdout/stderr/exitCode
    index.ts            the public harness API — scenarios import from here
    *.test.ts           harness self-tests (catalog §1.5); run with no `crew` binary
  fixtures/           committed executables that stand in for the real world
    fixture-source/     protocol-1 bundle (source.json + list/get/update scripts)
    scripted-agent/     the scripted agent executable
    fake-bin/           the fake `gh`
```

## The observation surface

Assertions target what `crew` does to the world, never its stdout prose
(catalog §1.2). The harness exposes exactly these channels:

- exit codes — from every binding call (`RunResult.exitCode`)
- worktrees, branches, commits, dirty state — `gitFixtures.ts`
- run/task state on disk — `stateObservation.ts`, validated against `schemas.ts`
- tmux sessions on the isolated socket — `tmuxObservation.ts`
- source interactions — the fixture source's `calls.jsonl` journal
- structured logs — `readLogLines`, validated against `logSchema.ts`
- `status` / `doctor` stdout — loose substring matching only

## How bindings map to catalog operations

`configure({ scenario, config })` writes `crew.config.jsonc`, installs the
fixture source(s) and the scripted agent, and returns a `Bindings` object. The
catalog operations (catalog §1.3) are its methods:

- `configure(fixture)` → `configure({ scenario, config })`
- `seedSource(tasks)` → `bindings.seedSource(tasks)`
- `tick()` → `bindings.tick()` (`crew start`, one-shot)
- `start(task, { force?, agent? })` → `bindings.start(taskId, options)`
- `pause` / `resume` / `cleanup` / `status` / `doctor` → the same-named methods
- `killOrchestrator()` / `restart()` → `bindings.startWatch()`, then
  `bindings.killOrchestrator()` / `bindings.restart()`
- `paths.{worktreeFor,workspaceFor,stateFor,logFile,…}` → `bindings.paths.*`
- `expect.{branchFor,sessionFor}` → `bindings.expect.*`

Paths and expectations are computed from the contracts (slug rules in
`identity.ts`), never read back out of the tool — that is what makes them
assertions.

## Writing a scenario

Every scenario runs inside `withScenario`, which owns a fresh tmpdir and
guarantees cleanup (tmux server killed, tmpdir removed) even on failure. A
worked example — the DISPATCH-01 shape:

```ts
import { describe, expect, it } from "vitest";

import {
  branchExists,
  configure,
  createRepo,
  readRunRecord,
  waitForSession,
  withScenario,
  worktreeList,
} from "./harness/index.js";

describe("DISPATCH-01", () => {
  it("provisions a worktree, branch, and session for a single-repo task", async () => {
    await withScenario(async (scenario) => {
      await createRepo({ scenario, name: "alpha" });

      const crew = configure({ scenario });
      crew.seedSource([
        { id: "TASK-1", title: "Do the thing", agent: "scripted", repos: ["alpha"] },
      ]);

      const result = await crew.tick();
      expect(result.exitCode).toBe(0);

      const taskId = "fixture:TASK-1";
      await waitForSession({ scenario, name: crew.expect.sessionFor(taskId) });

      const clone = `${scenario.baseDirectory}/alpha`;
      expect(await branchExists({ scenario, repoDirectory: clone, branch: crew.expect.branchFor(taskId) })).toBe(true);
      expect(await worktreeList({ scenario, repoDirectory: clone })).toHaveLength(2);

      const record = readRunRecord({ path: crew.paths.stateFor(taskId) });
      expect(record.state).toBe("running");
    });
  });
});
```

Synchronize with `waitForSession`, `waitForHeartbeat`, and the other
`pollUntil`-based helpers — never a fixed `sleep`. The scripted agent's `sleep`
step is the one exception, because it is part of the system under test.

## Running

```sh
cd v2
npx vitest run --config vitest.e2e.config.ts
```

The harness self-tests run without any `crew` binary. Scenario tests spawn the
binary at `node v2/bin/run.js` by default; set `GROUNDCREW_E2E_CREW_BIN` to point
elsewhere.

## Contract assumptions

Two things this harness assumes that the pinned contracts do not spell out; both
are flagged in `bindings.ts` for core implementers:

- Core forwards a config source's `environment` to the source process (the
  fixture source reads `FIXTURE_STORE` from it). Contracts §4.1/§5 support this.
- Core injects an agent profile's `environment` into the launched session (the
  scripted agent reads `GROUNDCREW_TEST_AGENT_SCRIPT` from it). Contracts §5 does
  not show an `environment` key on agent profiles; if core wires the script
  another way, only `configure` changes.

The task-slug rule (contracts §1) is read as "collapse each run of non-`[a-z0-9]`
to a single `-`". See the note in `identity.ts`; the two readings agree for every
id without consecutive separators.
