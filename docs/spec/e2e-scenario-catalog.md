# E2E scenario catalog (draft prototype — DEVOP-5974)

The executable half of the groundcrew v2 spec: the black-box scenarios the acceptance suite must cover, plus the harness shape that makes them hermetic. The suite is written **before v2 code exists** and brings v2 up red→green; it is v2's system-level TDD loop and the language-agnostic escape hatch (any implementation that passes is conformant).

**Iteration 1 changes:** the green-on-v1 gate is dropped — v2 breaks too much of v1's surface for v1 scenarios to pay for themselves; that budget moves to migration easing (map fog item). Suite trustworthiness comes from harness self-tests instead (§1.5). The v1 reviewer loop (poll `gh`, advance in-review/done) does not survive into v2: the completion model (§2) is agent-reported, forge-blind, and lingers for human review.

## 1. Suite architecture

### 1.1 Black-box rules

- The suite spawns the `crew` binary and observes the world. It never imports groundcrew code, reads groundcrew internals, or mocks in-process.
- Assertions target the **observation surface** (§1.2), not stdout prose. Stdout/exit codes are asserted only where the output _is_ the behavior (`status`, `doctor`, loud errors), and then loosely (key substrings, not full-text golden files).

### 1.2 Observation surface

Everything a scenario may assert on:

| Channel                | How observed                                                                                                     |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Exit codes             | direct                                                                                                           |
| Worktrees & branches   | `git worktree list`, `git branch`, `git log`/`status` in the scenario tmpdir                                     |
| Run/task state on disk | v2's state files (path + schema fixed by the spec; suite parses them read-only)                                  |
| Terminal sessions      | real tmux on an isolated socket (`tmux -L <scenario-id>`) — session exists / alive / exited                      |
| Source interactions    | the fixture source's **call journal** (§1.4): every command invocation with args + stdin, appended as JSON lines |
| Structured logs        | JSON-line log file under the scenario's state dir                                                                |
| Human-facing output    | `status` / `doctor` stdout, loose match                                                                          |

### 1.3 Command binding

The CLI surface ([DEVOP-5975](https://linear.app/clipboardhealth/issue/DEVOP-5975)) is still open, so scenarios call abstract operations bound in exactly one harness module — the only file that changes when command names land:

```text
configure(fixture)            // write config into the scenario tmpdir
seedSource(tasks[])           // load the fixture source's task store
tick()                        // one poll/dispatch cycle
start(taskId)                 // immediate dispatch, bypassing eligibility
stop(taskId) / resume(taskId) / cleanup(taskId, {force}) / status(taskId?) / doctor()
killOrchestrator() / restart()  // crash scenarios
paths: { worktreeFor(repo, task), workspaceFor(task), stateFor(task), logFile }
expect: { branchFor(task), sessionFor(task) }
```

### 1.4 Fakes

| Real thing                  | Stand-in                                                                                                                                                                                                                                                                                 | Notes                                                                                                                                   |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Linear / Jira / any tracker | **Fixture source**: a protocol-1 manifest bundle backed by a JSON task store in the scenario tmpdir. Every invocation appends `{command, args, stdin, timestamp}` to `calls.jsonl` — the writeback assertion point.                                                                      | First-party sources are conformance tests of the boundary (DEVOP-5973); the fixture source tests the same boundary from the other side. |
| Agent CLI (claude/codex/…)  | **Scripted agent**: an executable that reads a per-scenario script (env-pointed file) and deterministically acts — sleep, write files, `git commit`, invoke in-session `crew` commands, report artifacts, exit 0/1. Agent profiles are declarative config with `cmd`, so this is honest. | Emits a heartbeat file so scenarios synchronize on "agent is running" without sleeps.                                                   |
| GitHub / forge              | **Fake `gh` on PATH that exists only to record calls.** v2 core is forge-blind; any core-process invocation is a failure (FLOW-06). Agent-initiated calls are scripted and allowed.                                                                                                      | The absence of a real forge fake is itself a spec assertion.                                                                            |
| Git remotes                 | Local bare repos (`file://` remotes) under the scenario tmpdir; `origin/main` seeded with a few commits.                                                                                                                                                                                 | Real git throughout.                                                                                                                    |
| tmux                        | Real tmux, isolated per scenario via `-L <socket>`.                                                                                                                                                                                                                                      | Real seam, cheap, deterministic enough.                                                                                                 |
| Host env                    | Per-scenario tmpdir owning `HOME`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME`; PATH prepended with the fakes dir; no network in the core lane.                                                                                                                                                  |                                                                                                                                         |

### 1.5 Harness self-tests

With no working implementation to validate against (green-on-v1 dropped), the harness proves itself directly: the fixture source, scripted agent, journal, and tmux/git observation helpers each get their own tests that run without any `crew` binary. A suite failure during v2 bring-up then points at v2, not at the suite.

### 1.6 Lanes

- **Core lane**: hermetic, no sandbox runner, runs anywhere including CI.
- **Sandbox lane**: real srt (macOS `sandbox-exec` / Linux bubblewrap), platform-gated; asserts denial behavior that can't be faked honestly. v2-only by definition — v1's posture keeps its existing unit-level coverage.

### 1.7 Suite packaging

An `e2e/` package in the groundcrew repo, plain TypeScript + vitest, spawning the built binary; fixture source and scripted agent are committed executables.

## 2. Completion model (codified from iteration 1)

- **Core never polls a destination for done-ness.** No forge calls, no tracker reads to infer task completion. `status` reports what groundcrew knows: **observed** workspace git facts (branches, commits, dirty state) and **agent-reported** events and artifacts. Whether the tracker moves to done is the source's business (its `update` handler) or tracker automation's — humans see the agent's report and judge for themselves.
- **`completed{outcome}` frees the dispatch slot immediately** — a finished task never blocks the queue.
- **The workspace lingers after completion, with two exits.** Worktrees, branches, and the final state record stay on disk until **either** a human runs `cleanup` **or** polling observes the _source_ reporting the task terminal (e.g. the tracker moved to Done after the PR merged) — v1's cleaner, kept as-is because it watches the source, not the forge. The review window holds in practice: the tracker rarely reaches done the instant the agent reports delivered. Auto-reap never removes a dirty worktree; it skips loudly and leaves it for a human.

## 3. The catalog

Each entry: **ID · lane · Given** (source store, config, disk, scripts) · **When** (harness ops) · **Then** (observation-surface assertions). IDs are stable; the suite implements one test per ID.

### A. Dispatch & happy paths

- **DISPATCH-01** (core) — _Single-repo happy path._ Given one todo task designating repo `alpha` and an agent profile, repo `alpha` cloned under the base dir. When `tick()`. Then: worktree exists at `paths.worktreeFor(alpha, task)` on branch `expect.branchFor(task)` cut from `origin/main`; tmux session alive; state records running; journal shows `update:claimed` acknowledged.
- **DISPATCH-02** (core) — _Slot limit respected._ Given max-in-progress 1 and two eligible tasks. When `tick()`. Then exactly one provisions; the other stays queued (no worktree, no session, no writeback).
- **DISPATCH-03** (core) — _Priority ordering._ Given two eligible tasks with different priorities and one slot. Then the higher-priority task is the one provisioned.
- **DISPATCH-04** (core) — _Blocked task skipped, dispatched when unblocked._ Given a task with an open blocker. When `tick()`: nothing provisions. When the fixture marks the blocker done and `tick()` again: it provisions.
- **DISPATCH-05** (core) — _Ineligible task ignored._ Given a task with no agent routing. When `tick()`. Then no provisioning, no writeback, task still listed as queued.
- **DISPATCH-06** (core) — _Designated repo not on disk → bail._ Given a task designating a repo not cloned under the base dir. When `tick()`. Then no worktree/branch/session/state; the task stays queued at the source; the skip reason is visible (log line + status). (DEVOP-5967 §2.)
- **DISPATCH-07** (core) — _Manual start bypasses eligibility._ Given an unlabeled/no-agent task. When `start(task)`. Then it provisions exactly as DISPATCH-01.
- **DISPATCH-08** (core) — _Branch reuse._ Given a prior local branch `expect.branchFor(task)` with a commit. When dispatched. Then the worktree re-attaches to that branch (prior commit present), not a fresh one.
- **DISPATCH-09** (core) — _Recurrence is a source concern._ Given a fixture source that re-lists a completed task per its recurrence rule. When the task completes and `tick()` runs after re-listing. Then a fresh dispatch occurs; core has no recurrence machinery to observe. (DEVOP-5968 §6.)

### B. Completion & writeback

- **COMPLETE-01** (core) — _Publishing work is reporting it._ Scripted agent commits, runs `crew artifact add <pr-url> --kind pr`, emits progress. Then: journal shows `update:progress` and the artifact-bearing update; status shows both layers (commits _observed_, PR _reported_); core made no forge call.
- **COMPLETE-02** (core) — _Delivered: slot freed, workspace lingers._ Scripted agent ends `completed {outcome: delivered, artifacts}`. Then: journal carries the completed event exactly once with artifacts intact; state is `complete{delivered}`; session ended; **worktree, branch, and state record still on disk**; next `tick()` dispatches the next queued task (slot freed) while the delivered workspace lingers.
- **COMPLETE-03** (core) — _Launch failure is truthful and rolled back._ Given an agent profile whose `cmd` doesn't exist. When `start(task)`. Then state records `complete{failed, reason: launch}`; worktree and branch rolled back; the failure appears in the journal if the task was already claimed.
- **COMPLETE-04** (core) — _Agent failure is truth-told._ Scripted agent ends `completed {outcome: failed, message}`. Then journal carries the failure event with the message; state is `complete{failed}`; no artifact records invented; workspace lingers for inspection.
- **COMPLETE-05** (core) — _Read-only source end-to-end._ Given a fixture manifest with no `update` command. Then dispatch, run, and completion all succeed; journal shows zero update calls; status labels the source read-only. (Also asserted at discovery level in PLUGIN-05.)
- **COMPLETE-06** (core) — _Manual cleanup ends the linger._ Given a delivered task's lingering workspace. When `cleanup(task)`. Then worktree removed, branch deleted, state record gone; the source hears nothing new.
- **COMPLETE-07** (core) — _Source-terminal auto-reap (v1 cleaner parity)._ Given a delivered task's lingering clean workspace. When the fixture source's store marks the task done and `tick()` runs. Then worktree, branch, and state record reaped automatically; the reap is logged. Variant: if the lingering worktree is dirty, auto-reap skips it with a visible warning and everything stays on disk.

### C. Session lifecycle

- **SESSION-01** (core) — _Stop keeps work._ Given a running task. When `stop(task)`. Then session closed, worktree and branch intact, state paused, resumable.
- **SESSION-02** (core) — _Resume reopens, never recreates._ When `resume(task)` on a paused task: session live again, same worktree, resume count incremented, state running. When `resume` on a task with no worktree: hard error, nothing created.
- **SESSION-03** (core) — _Status tells the truth about strays._ Given state says running but the tmux session was killed externally. Then `status` flags the disagreement (stray/dead). Given no state but a live session matching a task: `status` flags the stray session.

### D. Crash & recovery

- **CRASH-01** (core) — _SIGKILL mid-run, restart reconciles._ Given a running task. When the orchestrator is SIGKILLed and restarted with `tick()`. Then no duplicate worktree/session/dispatch; state agrees with disk; the running task is still running. (Reconcile-on-startup, DEVOP-5972.)
- **CRASH-02** (core) — _Orphan worktree directory._ Given a directory at the expected worktree path but absent from `git worktree list`. Then `cleanup --force` removes it only when the path exactly matches the expected shape; a non-matching path is refused.
- **CRASH-03** (core) — _Dirty worktree is a data-loss guard._ Given a worktree with uncommitted changes. When `cleanup(task)`: refused, names the dirt. When `cleanup(task, {force})`: removed.
- **CRASH-04** (core) — _Stale state, no disk._ Given a state file for a task with no worktree and no session. Then cleanup clears it; if the session probe is unavailable, everything is left intact.
- **CRASH-05** (core) — _Reconcile GCs the full triple._ After SIGKILL during provisioning (worktree half-created, session never launched), restart reconciles worktrees **and** tmux **and** sandbox state against expected task state; orphans of each kind GC'd; a log line records each GC action.

### E. Multi-repo & workspace (DEVOP-5967)

- **MULTI-01** (core) — _Designated multi-repo._ Given `Repos: alpha, beta`, both cloned. Then one workspace directory with two worktrees side by side, the **same** task branch in each, **one** tmux session at the workspace root.
- **MULTI-02** (core) — _Designated-and-missing → bail._ Given `Repos: alpha, gamma`, `gamma` not cloned. Then nothing provisions (not even `alpha`), visible "repo not found" skip, task stays queued.
- **MULTI-03** (core) — _Empty-workspace dispatch._ Given a task with no repo designation. Then the session launches in an empty workspace; zero worktrees; state running.
- **MULTI-04** (core) — _Runtime acquisition, allowed._ Scripted agent runs `crew workspace add alpha` in-session (task identity via workspace state/env). Then a worktree for `alpha` appears under the workspace on the uniform task branch; the addition is recorded in task state; prepare-worktree hook ran.
- **MULTI-05** (core) — _Runtime acquisition, gate-rejected._ Agent runs `crew workspace add not-cloned`. Then a loud error, nothing created, nonzero exit in-session; task keeps running.
- **MULTI-06** (core) — _Partial completion truth-telling._ Agent commits in `alpha` and `beta`, reports a pr artifact for `alpha` only, completes `{outcome: failed}`. Then per-repo records show exactly that (alpha: artifact reported + commits observed; beta: commits observed, nothing reported); no invented atomicity, no rollback.
- **MULTI-07** (core) — _Repo-less delivery._ Agent in an empty workspace reports `{kind: document, locator: <url>}` and completes delivered. Then the completed event carries the artifact; no git facts exist or are claimed.

### F. Artifacts & source contract (DEVOP-5968)

- **FLOW-01** (core) — _Reported vs observed are separate layers._ Agent commits but reports nothing. Then status shows commits _observed_ and no artifact _reported_ — a missing link, never a lie.
- **FLOW-02** (core) — _Mixed artifact kinds round-trip._ Agent reports `pr`, `ticket`, and `file` artifacts. Then `completed.artifacts` in the journal carries all three, kinds and locators intact.
- **FLOW-03** (core) — _Claim rejected._ Given the fixture source answers `claimed` with _rejected_. Then no provisioning, no session; task remains listed; the rejection is visible in log/status. (The remote-runner door.)
- **FLOW-04** (core) — _Progress events flow._ Agent emits progress notes. Then journal shows `update:progress` with the notes, in order.
- **FLOW-05** (core) — _Done-ness is not core's business._ After COMPLETE-02, the source's task store still says whatever its own `update` handler chose; core issues no reads to confirm or reconcile it, and status renders the agent's report unchanged.
- **FLOW-06** (core) — _Core is forge-blind._ Across MULTI/FLOW scenarios, the fake `gh` (and any recorded network attempt in the core lane) shows **zero** invocations by the core process. Agent-initiated calls don't count.

### G. Source packaging & protocol (DEVOP-5973)

- **PLUGIN-01** (core) — _User-dir source discovery._ Given a bundle at `~/.config/groundcrew/task-sources/fixture/` (`source.json` + scripts). Then it lists in `source list`, verifies, and serves dispatch.
- **PLUGIN-02** (core) — _Name collision: user dir wins._ Given a package-shipped bundle and a user-dir bundle with the same name. Then the user's is used; the override is visible in `source list`/doctor.
- **PLUGIN-03** (core) — _Protocol mismatch is loud._ Given `protocolVersion: 99`. Then discovery/doctor/status emit an explicit, actionable error naming the version and the supported set; the source is not silently skipped; other sources unaffected.
- **PLUGIN-04** (core) — _Unparseable manifest: skip + warn._ Given malformed `source.json`. Then a warning names the file; everything else proceeds.
- **PLUGIN-05** (core) — _Capability by omission._ Given a manifest omitting `update`. Then no version sniffing, no error: the source is treated read-only (COMPLETE-05's mechanism, asserted at discovery level).

### H. Sandbox posture (sandbox lane, platform-gated)

- **SANDBOX-01** (sandbox) — _Agent contained by default._ Scripted agent writes inside the worktree (succeeds) and outside `HOME`-scoped allowed paths (fails). Both outcomes observed via marker files.
- **SANDBOX-02** (sandbox) — _Agent network egress allowlisted._ Agent curls an allowlisted host (loopback fixture; succeeds) and a non-allowlisted one (fails).
- **SANDBOX-03** (sandbox) — _Sources sandboxed by default._ Fixture source's `list` script attempts undeclared egress and an out-of-scope write → both denied; declared scratch dir + install dir (read) work. (Manifest `network` allowlist, DEVOP-5973 §4.)
- **SANDBOX-04** (sandbox) — _`sandbox: false` opt-out is loud._ Given the fixture source configured with `sandbox: false`. Then it runs unsandboxed (undeclared write succeeds) **and** status/doctor visibly flag the opt-out.

### I. Surface & diagnostics

- **SURFACE-01** (core) — _Init → doctor green._ On a healthy fixture host, the init flow produces a config that `doctor` passes and DISPATCH-01 runs against unmodified.
- **SURFACE-02** (core) — _Doctor catches broken hosts._ Missing agent binary; unreachable/failing source verify; missing base dir — each produces a failing doctor with the cause named, exit 1.
- **SURFACE-03** (core) — _Status degrades gracefully._ Given the fixture source errors on list. Then `status` still prints local truth (worktrees, sessions, state) and marks the queue unavailable with the reason; exit 0.
- **SURFACE-04** (core) — _Structured logs are parseable._ After DISPATCH-01 + COMPLETE-02, every line of the log file parses as JSON and carries the task id on task-scoped events. (Deeper schema assertions belong to the observability design — fog.)

## 4. Iteration log

- **Iteration 1** (2026-07-16): green-on-v1 gate dropped in favor of harness self-tests plus a migration-easing budget; completion model codified (forge-blind, agent-reported, linger-until-cleanup); suite stack confirmed (`e2e/` package, TS + vitest); sandbox lane confirmed v2-only. Tier A/B structure and the v1 driver removed accordingly.
- **Iteration 2** (2026-07-16): linger gets two exits — manual `cleanup` or source-terminal auto-reap (v1's cleaner kept: it watches the source, never the forge; v1's merged-PR reviewer path dies). COMPLETE-07 added; dirty worktrees are never auto-reaped.
