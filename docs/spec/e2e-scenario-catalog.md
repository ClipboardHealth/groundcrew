# E2E scenario catalog (draft prototype — DEVOP-5974)

The executable half of the groundcrew v2 spec: the black-box scenarios the compat suite must cover, plus the harness shape that makes them hermetic. The suite gets built against **v1 first** (the Bun lesson) — it must run green on v1 before any v2 code exists — yet the v2 decisions deliberately break v1's config shape, CLI surface, and source contract. The catalog resolves that tension with a **driver seam** and **two tiers**.

## 1. Suite architecture

### Black-box rules

- The suite spawns the `crew` binary and observes the world. It never imports groundcrew code, reads groundcrew internals, or mocks in-process. This is the language-agnostic escape hatch: any implementation that passes is conformant.
- Assertions target the **observation surface** (§1.2), not stdout prose. Stdout/exit codes are asserted only where the output _is_ the behavior (`status`, `doctor`, loud errors), and then loosely (key substrings, not full-text golden files).

### Observation surface

Everything a scenario may assert on:

| Channel                | How observed                                                                                                     |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Exit codes             | direct                                                                                                           |
| Worktrees & branches   | `git worktree list`, `git branch`, `git log`/`status` in the sandbox tmpdir                                      |
| Run/task state on disk | the version's state files (driver exposes the path + a normalized parse)                                         |
| Terminal sessions      | real tmux on an isolated socket (`tmux -L <scenario-id>`) — session exists / alive / exited                      |
| Source interactions    | the fixture source's **call journal** (§1.4): every command invocation with args + stdin, appended as JSON lines |
| Structured logs        | JSON-line log file under the scenario's state dir                                                                |
| Human-facing output    | `status` / `doctor` stdout, loose match                                                                          |

### Driver seam (v1 vs v2)

Scenarios are written against a small `CrewDriver` interface; one thin driver per major version maps abstract operations to concrete commands, config files, and paths. The driver is part of the suite, not the product — it is the only place that knows `knownRepositories` (v1) vs base-dir discovery (v2), or `crew run` (v1) vs whatever DEVOP-5975 names the poll command.

Driver operations (proposed):

```text
configure(fixture)            // write version-appropriate config into the scenario tmpdir
seedSource(tasks[])           // load the fixture source's task store
tick()                        // one poll/dispatch cycle (v1: crew run)
start(taskId)                 // immediate dispatch (v1: crew start)
stop(taskId) / resume(taskId) / cleanup(taskId, {force}) / status(taskId?) / doctor()
killDaemon() / restart()      // crash scenarios
paths: { worktreeFor(repo, task), stateFor(task), logFile }
expect: { branchFor(task), sessionFor(task) }
```

A scenario that needs an operation only one version has (e.g. `crew workspace add`) is tiered accordingly.

### Tiers and lanes

- **Tier A — shared behavioral core.** Runs green against v1 _and_ v2 through the drivers. This is the compat guarantee: the behaviors v2 must not regress.
- **Tier B — v2-only.** New contract behavior (multi-repo workspaces, runtime acquisition, artifact reporting, protocol versioning, source sandboxing). Written now, red until v2 exists; they double as v2's acceptance tests.
- Orthogonally, two **lanes**: the **core lane** (hermetic, no sandbox runner, runs anywhere including CI) and the **sandbox lane** (real srt; platform-gated to macOS `sandbox-exec` / Linux bubblewrap; asserts denial behavior that can't be faked honestly).

### Fakes

| Real thing                  | Stand-in                                                                                                                                                                                                                                                                                                               | Notes                                                                                                                                                                |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linear / Jira / any tracker | **Fixture source**: a manifest task-source bundle backed by a JSON task store in the scenario tmpdir. Every invocation appends `{command, args, stdin, timestamp}` to `calls.jsonl` — the writeback assertion point. Two thin manifests over one implementation: v1's shell-source contract, v2's protocol-1 contract. | First-party sources are conformance tests of the boundary (DEVOP-5973); the fixture source is the suite's conformance test of the same boundary from the other side. |
| Agent CLI (claude/codex/…)  | **Scripted agent**: an executable that reads a per-scenario script (env-pointed file) and deterministically acts — sleep, write files, `git commit`, invoke in-session `crew` commands (Tier B), report artifacts, exit 0/1. Both versions support `cmd`-points-at-your-script, so this is honest.                     | Also emits a heartbeat file so scenarios can synchronize on "agent is running" without sleeps.                                                                       |
| GitHub / forge              | **v1 lane only**: fake `gh` on PATH backed by a JSON PR fixture (v1's reviewer observes PRs via `gh`). **v2 needs no forge fake** — core observes only local git facts; PRs are agent-_reported_ artifacts.                                                                                                            | The asymmetry is itself a spec assertion: v2 core makes zero forge calls (fake `gh` records any invocation → fail).                                                  |
| Git remotes                 | Local bare repos (`file://` remotes) under the scenario tmpdir; `origin/main` seeded with a few commits.                                                                                                                                                                                                               | Real git throughout.                                                                                                                                                 |
| tmux                        | Real tmux, isolated per scenario via `-L <socket>`.                                                                                                                                                                                                                                                                    | Real seam, cheap, deterministic enough.                                                                                                                              |
| Host env                    | Per-scenario tmpdir owning `HOME`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME`; PATH prepended with the fakes dir; no network in the core lane.                                                                                                                                                                                |                                                                                                                                                                      |

### Scenario format

Each entry: **ID · tier · lane · Given** (source store, config, disk, scripts) · **When** (driver ops) · **Then** (observation-surface assertions). IDs are stable; the suite implements one test per ID.

## 2. The catalog

### A. Dispatch & happy paths

- **DISPATCH-01** (A, core) — _Single-repo happy path._ Given one todo task designating repo `alpha` and agent `scripted`, repo `alpha` cloned under the base dir. When `tick()`. Then: worktree exists at `paths.worktreeFor(alpha, task)` on branch `expect.branchFor(task)` cut from `origin/main`; tmux session alive; state records running; journal shows the source was told the task started (v1 `markInProgress`, v2 `update:claimed` + progress).
- **DISPATCH-02** (A, core) — _Slot limit respected._ Given max-in-progress 1 and two eligible tasks. When `tick()`. Then exactly one provisions; the other stays queued (no worktree, no session, no writeback).
- **DISPATCH-03** (A, core) — _Priority ordering._ Given two eligible tasks with different priorities and one slot. Then the higher-priority task is the one provisioned.
- **DISPATCH-04** (A, core) — _Blocked task skipped, dispatched when unblocked._ Given a task with an open blocker. When `tick()`: nothing provisions. When the fixture marks the blocker done and `tick()` again: it provisions.
- **DISPATCH-05** (A, core) — _Ineligible task ignored._ Given a task with no agent routing. When `tick()`. Then no provisioning, no writeback, task still listed as queued.
- **DISPATCH-06** (A, core) — _Designated repo unavailable → visible skip, nothing provisioned._ Given a task designating a repo not present (v1: not in `knownRepositories`; v2: not cloned under base dir). When `tick()`. Then no worktree/branch/session/state; the task stays queued at the source; the skip reason is visible (log line + status). (v2 "bail", DEVOP-5967 §2.)
- **DISPATCH-07** (A, core) — _Manual start bypasses eligibility._ Given an unlabeled/no-agent task. When `start(task)`. Then it provisions exactly as DISPATCH-01.
- **DISPATCH-08** (A, core) — _Branch reuse._ Given a prior local branch `expect.branchFor(task)` with a commit. When dispatched. Then the worktree re-attaches to that branch (prior commit present), not a fresh one.
- **DISPATCH-09** (A, core) — _Recurrence is a source concern._ Given a fixture source that re-lists a completed task per its recurrence rule. When the task completes and `tick()` runs after re-listing. Then a fresh dispatch occurs; core has no recurrence machinery to observe. (DEVOP-5968 §6.)

### B. Completion & writeback

- **COMPLETE-01** (A, core) — _Work published → source reaches in-review._ Scripted agent commits and publishes (v1: fake `gh` gains an open PR for the branch; v2: agent runs `crew artifact add <pr-url> --kind pr` and emits progress). Then: journal shows the source moved to in-review (v1 `markInReview`) / received the artifact-bearing update (v2); slot freed for the next tick (v1 semantics — see Open question 3).
- **COMPLETE-02** (A, core) — _Task done → source told, workspace torn down._ v1: fake `gh` marks the PR merged; next tick → journal shows `markDone`, worktree removed, run state deleted. v2: scripted agent ends with `completed {outcome: delivered, artifacts}`; journal shows the completed event; teardown per DEVOP-5975's call (see Open question 3). Shared assertion: source told exactly once; final state is terminal.
- **COMPLETE-03** (A, core) — _Launch failure is truthful and rolled back._ Given an agent whose `cmd` doesn't exist. When `start(task)`. Then state records the launch failure (v1 `failed-to-launch`; v2 `complete{failed, reason: launch}`); worktree and branch rolled back; source not told the task is in progress — or if already claimed, the failure lands in the journal.
- **COMPLETE-04** (A, core) — _Writeback unsupported → skip, never crash._ Given a fixture source without done-writeback (v1: no `markDone` command; v2: no `update` at all — read-only). When completion occurs. Then the writeback is a logged no-op; nothing errors; local teardown still proceeds.
- **COMPLETE-05** (B, core) — _Agent failure is truth-told._ Scripted agent ends `completed {outcome: failed, message}`. Then journal carries the failure event with the message; state is `complete{failed}`; no artifact records invented.

### C. Session lifecycle

- **SESSION-01** (A, core) — _Stop keeps work._ Given a running task. When `stop(task)`. Then session closed, worktree and branch intact, state paused/interrupted, resumable.
- **SESSION-02** (A, core) — _Resume reopens, never recreates._ When `resume(task)` on a stopped task: session live again, same worktree, resume count incremented. When `resume` on a task with no worktree: hard error, nothing created.
- **SESSION-03** (A, core) — _Status tells the truth about strays._ Given state says running but the tmux session was killed externally. Then `status` flags the disagreement (stray/dead). Given no state but a live session matching a task: `status` flags the stray session.

### D. Crash & recovery

- **CRASH-01** (A, core) — _SIGKILL mid-run, restart reconciles._ Given a running task. When the orchestrator is SIGKILLed and restarted with `tick()`. Then no duplicate worktree/session/dispatch; state agrees with disk; the running task is still running. (v2: reconcile-on-startup is the guarantee, DEVOP-5972.)
- **CRASH-02** (A, core) — _Orphan worktree directory._ Given a directory at the expected worktree path but absent from `git worktree list`. Then `cleanup --force` removes it only when the path exactly matches the expected shape; a non-matching path is refused.
- **CRASH-03** (A, core) — _Dirty worktree is a data-loss guard._ Given a worktree with uncommitted changes. When `cleanup(task)`: refused, names the dirt. When `cleanup(task, {force})`: removed.
- **CRASH-04** (A, core) — _Stale state, no disk._ Given a state file for a task with no worktree and no session. Then cleanup clears it; if the session probe is unavailable, everything is left intact.
- **CRASH-05** (B, core) — _Reconcile GCs the full triple._ After SIGKILL during provisioning (worktree half-created, session never launched), restart reconciles worktrees **and** tmux **and** sandbox state against expected task state; orphans of each kind GC'd; a journal/log line records each GC action.

### E. Multi-repo & workspace (v2-only — DEVOP-5967)

- **MULTI-01** (B, core) — _Designated multi-repo._ Given `Repos: alpha, beta`, both cloned. Then one workspace directory with two worktrees side by side, the **same** task branch in each, **one** tmux session at the workspace root.
- **MULTI-02** (B, core) — _Designated-and-missing → bail._ Given `Repos: alpha, gamma`, `gamma` not cloned. Then nothing provisions (not even `alpha`), visible "repo not found" skip, task stays queued.
- **MULTI-03** (B, core) — _Empty-workspace dispatch._ Given a task with no repo designation. Then the session launches in an empty workspace; zero worktrees; state running.
- **MULTI-04** (B, core) — _Runtime acquisition, allowed._ Scripted agent runs `crew workspace add alpha` in-session (task identity via workspace state/env). Then a worktree for `alpha` appears under the workspace on the uniform task branch; the addition is recorded in task state; prepare-worktree hook ran.
- **MULTI-05** (B, core) — _Runtime acquisition, gate-rejected._ Agent runs `crew workspace add not-cloned`. Then a loud error, nothing created, exit nonzero in-session; task keeps running.
- **MULTI-06** (B, core) — _Partial completion truth-telling._ Agent commits in `alpha` and `beta`, reports a pr artifact for `alpha` only, completes `{outcome: failed}`. Then per-repo records show exactly that (alpha: artifact reported + commits observed; beta: commits observed, nothing reported); no invented atomicity, no rollback.
- **MULTI-07** (B, core) — _Repo-less delivery._ Agent in an empty workspace reports `{kind: document, locator: <url>}` and completes delivered. Then the completed event carries the artifact; no git facts exist or are claimed.

### F. Artifacts & source contract (v2-only — DEVOP-5968)

- **FLOW-01** (B, core) — _Reported vs observed are separate layers._ Agent commits but reports nothing. Then status shows commits _observed_ and no artifact _reported_ — a missing link, never a lie.
- **FLOW-02** (B, core) — _Mixed artifact kinds round-trip._ Agent reports `pr`, `ticket`, and `file` artifacts. Then `completed.artifacts` in the journal carries all three, kinds and locators intact.
- **FLOW-03** (B, core) — _Read-only source end-to-end._ Given a fixture manifest with no `update` command. Then dispatch, run, completion all succeed; journal shows zero update calls; status labels the source read-only.
- **FLOW-04** (B, core) — _Claim rejected._ Given the fixture source answers `claimed` with _rejected_. Then no provisioning, no session; task remains listed; the rejection is visible in log/status. (The remote-runner door.)
- **FLOW-05** (B, core) — _Progress events flow._ Agent emits progress notes. Then journal shows `update:progress` with the notes, in order.
- **FLOW-06** (B, core) — _Core is forge-blind._ Across MULTI/FLOW scenarios, the fake `gh` (and any recorded network attempt in the core lane) shows **zero** invocations by the core process. Agent-initiated calls don't count.

### G. Source packaging & protocol (v2-only — DEVOP-5973)

- **PLUGIN-01** (B, core) — _User-dir source discovery._ Given a bundle at `~/.config/groundcrew/task-sources/fixture/` (`source.json` + scripts). Then it lists in `source list`, verifies, and serves dispatch.
- **PLUGIN-02** (B, core) — _Name collision: user dir wins._ Given a package-shipped bundle and a user-dir bundle with the same name. Then the user's is used; the override is visible in `source list`/doctor.
- **PLUGIN-03** (B, core) — _Protocol mismatch is loud._ Given `protocolVersion: 99`. Then discovery/doctor/status emit an explicit, actionable error naming the version and the supported set; the source is not silently skipped; other sources unaffected.
- **PLUGIN-04** (B, core) — _Unparseable manifest: skip + warn._ Given malformed `source.json`. Then a warning names the file; everything else proceeds.
- **PLUGIN-05** (B, core) — _Capability by omission._ Given a manifest omitting `update`. Then no version sniffing, no error: the source is treated read-only (= FLOW-03's mechanism, asserted at discovery level).

### H. Sandbox posture (sandbox lane, platform-gated)

- **SANDBOX-01** (A, sandbox) — _Agent contained by default._ Scripted agent writes inside the worktree (succeeds) and outside `HOME`-scoped allowed paths (fails). Both outcomes observed via marker files.
- **SANDBOX-02** (A, sandbox) — _Agent network egress allowlisted._ Agent curls an allowlisted host (loopback fixture; succeeds) and a non-allowlisted one (fails).
- **SANDBOX-03** (B, sandbox) — _Sources sandboxed by default._ Fixture source's `list` script attempts undeclared egress and an out-of-scope write → both denied; declared scratch dir + install dir (read) work. (Manifest `network` allowlist, DEVOP-5973 §4.)
- **SANDBOX-04** (B, sandbox) — _`sandbox: false` opt-out is loud._ Given the fixture source configured with `sandbox: false`. Then it runs unsandboxed (undeclared write succeeds) **and** status/doctor visibly flag the opt-out.

### I. Surface & diagnostics

- **SURFACE-01** (A, core) — _Init → doctor green._ On a healthy fixture host, the version's init flow produces a config that `doctor` passes and DISPATCH-01 runs against unmodified.
- **SURFACE-02** (A, core) — _Doctor catches broken hosts._ Missing agent binary; unreachable/failing source verify; missing base dir — each produces a failing doctor with the cause named, exit 1.
- **SURFACE-03** (A, core) — _Status degrades gracefully._ Given the fixture source errors on list. Then `status` still prints local truth (worktrees, sessions, state) and marks the queue unavailable with the reason; exit 0.
- **SURFACE-04** (A, core) — _Structured logs are parseable._ After DISPATCH-01 + COMPLETE-02, every line of the log file parses as JSON and carries the task id on task-scoped events. (Deeper schema assertions belong to the observability design — fog.)

## 3. Open questions (for reaction)

1. **Tier A "green on v1" definition.** Proposed: Tier A must pass on v1 via the v1 driver before any v2 code lands, and the v2 driver reuses the same scenario bodies verbatim. Accepting a scenario into Tier A is therefore a compat promise — is this list (A/B/C/D + SURFACE) the right promise, or should any of it be demoted to v1-only pinning?
2. **v1's in-review/done loop is forge-coupled; v2 dropped the forge.** v1 advances in-review/done by polling `gh` for PR state. v2 core is forge-blind, so nothing in core can observe "merged." COMPLETE-01/02 assume the v2 path is agent-reported (artifact add → completed). That leaves a real gap: a merged-later PR no longer advances the source to done. Is "done = agent says done (or human `task done`)" the intended v2 semantics, with tracker automation (e.g. Linear's GitHub integration) owning merge-driven transitions?
3. **Teardown trigger in v2.** v1 tears down on observed merge. If v2 completion is agent-reported, does `completed{delivered}` tear down immediately, or does the worktree linger for human review until `cleanup`? COMPLETE-02 currently leaves this to DEVOP-5975; the suite needs one answer.
4. **Suite repo/harness stack.** Proposed: suite lives in the groundcrew repo as a separate package (`e2e/`), plain TypeScript + vitest, spawning the built binary; fixture source + scripted agent are committed executables. Objections?
5. **Sandbox lane scope.** SANDBOX-01/02 as Tier A means proving v1's safehouse/srt posture in CI too, which may be flaky on shared runners. Alternative: sandbox lane is v2-only (Tier B), and v1 keeps only its existing unit-level coverage. Which?
