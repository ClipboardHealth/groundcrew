# Groundcrew v2 design

The implementation handoff for groundcrew v2, assembled from the [Groundcrew v2 spec wayfinder map](https://linear.app/clipboardhealth/issue/DEVOP-5966) (DEVOP-5966). Every decision below was resolved on that map; the [decision record](#13-decision-record) links each section to its ticket, where the full resolution and its rationale live. Where resolutions conflicted, later amendments win and are marked.

This document and the [E2E scenario catalog](./e2e-scenario-catalog.md) together are the spec. **The first implementation task is building the acceptance suite red-first from the catalog — before any v2 code exists.** The suite brings v2 up red-to-green; harness self-tests carry the suite's trustworthiness (the green-on-v1 gate was dropped: v2 breaks too much of v1's surface for v1 scenarios to pay for themselves).

## 1. Destination and locked constraints

Groundcrew dispatches task backlogs to local, interactive AI coding agents — one workspace per task, sandboxed by default. v2 is a rewrite of that product with a smaller, sharper surface.

Locked constraints, not to be re-litigated during implementation:

- **TypeScript.** The language-agnostic escape hatch is the black-box acceptance suite (any implementation that passes is conformant), not a new language.
- **Free to break v1** — config, CLI, conventions — easing migration opportunistically (section 11).
- **Sandboxed and secure by default**; interactive sessions are the baseline.
- **Pluggable agent harnesses** with model and effort-level selection.
- **Structured logs; minimal CLI surface; sane defaults with minimal required config; install/setup script.**
- **E2E-first confidence**: the black-box acceptance suite exists red-first before v2 code starts.

## 2. Verdict: rewrite

**Rewrite, not evolve.** ([Rewrite vs evolve](https://linear.app/clipboardhealth/issue/DEVOP-5978))

- The locked decisions kill or fundamentally reshape most of v1 (~21K source lines, ~38K test lines): `config.ts` dies with the TS-config format, the reviewer PR-polling loop dies, clearance/safehouse/sbx die, several commands die, and the core nouns are redefined. Every external surface breaks: config, CLI, source contract, sandbox posture, completion model.
- Evolve's safety-net premise was stale: the acceptance suite never runs against v1 (green-on-v1 dropped), so in-place evolution gets zero protection from it. "Evolve" would be the same rewrite executed as a thousand PRs fighting 38K test lines that assert dying behavior.
- Roughly 15–25% of v1 survives recognizably (srtPolicy/srtLaunch, the cleaner, tmux/git plumbing, doctor pieces, usage, completions). Surviving code is **ported file-by-file with its unit tests**; `git mv` preserves history.

**Repo strategy: same repo, isolated `v2/` workspace.** v2 grows on `main` under a top-level `v2/` with its own `package.json`, flat `src/<module>` layout, and its own `CLAUDE.md`/`AGENTS.md`/`CONTEXT.md` carrying the v2 ubiquitous language. v1 and v2 use the same nouns with contradictory meanings ("Workspace" means a terminal pane in v1 and a per-task directory of worktrees in v2), so sharing one `src/` was rejected — it would contaminate agent-driven work. dependency-cruiser forbids cross-tree imports in both directions. **Flip condition:** if v2-building agents keep tripping over v1 despite the boundary, escalate mid-build to a new repo initialized from a full clone, then rename old → `groundcrew-v1`, new → `groundcrew`.

**Package strategy.** Keep `@clipboard-health/groundcrew` and the `crew` bin; the release is **5.0.0** (v1 is at 4.47.x). No npm publish until the E2E suite is green — the team dogfoods from the repo. v1 goes **fixes-only** once v2 construction starts. Cutover: cut a `4.x` maintenance branch, flatten `v2/` to the repo root, delete the v1 tree; later v1 patches publish from `4.x` under a `v4` dist-tag.

**Release-automation wrinkle (must be handled before v2 commits land):** `main`'s Nx Release automation would treat v2 conventional commits as 4.x releases — it needs a path filter or commit-scope exclusion so v2 commits don't trigger 4.x publishes.

## 3. Flow model

([Flow model](https://linear.app/clipboardhealth/issue/DEVOP-5968), informed by the [prior-art research](https://linear.app/clipboardhealth/issue/DEVOP-5969): symmetric source/sink type systems are where Concourse and Tekton died, so the generalization is asymmetric.)

What exists: **sources, agent profiles, tasks, artifact records.** Two things deliberately do not exist:

- **Sinks dissolve.** Every task output happens through the agent's own tools (it opens PRs with `gh`, writes docs, files tickets — it has the credentials and the judgment) or the source's writeback. No typed sink stage; "produce a PR" is the default writeback pattern for repo work, not a privileged path.
- **Flows dissolve.** Config declares sources and agent profiles; each task carries its routing (an agent designation); a source-level default agent covers the common case. No pipeline/flow config object.

**Artifact record: plural, kind-tagged, agent-reported — no exceptions.** Per task: `{status, logs, artifacts: []}`, each artifact `{kind, locator, title?, repo?}` with an open kind set (`pr | branch | document | file | ticket | …`). All artifacts are reported by the agent via in-session `crew artifact add`. Groundcrew observes only what it owns — workspace-local git facts (branches, commits, dirty state), readable without credentials. **The core knows nothing about GitHub or any forge.** Status renders both layers ("3 commits _observed_; PR _reported_"); a forgotten report is a missing link, never a lie.

**Source contract** — `list`, `get`, `update`, capability by omission:

- `list` (poll for ready tasks) and `get` are required; a source without `update` is legal and read-only (writeback no-ops).
- `update(task, event)` is the single callback verb. Events: `claimed` (ack; may return _rejected_ where the source arbitrates contention — the remote-runner door, open but unbuilt), `progress` (note), `completed{outcome, artifacts, message}`. Errors are `outcome: failed`, not a separate channel.
- `create` is dropped; tasks are created in the tracker or file directly.

**Run states** (core-owned, recorded only for started work; the queue stays derived from source polls):

```text
provisioning → running ⇄ paused → complete{outcome: delivered | failed | stopped}
```

v1's `resumed` collapses into `running` (resumeCount is a field), `interrupted` → `paused`, `failed-to-launch` → `complete{failed, reason: launch}`. Bail (designated repo not on disk) never enters the machine — the task stays queued at the source with a visible skip reason. `input-required` is **not** a state: in interactive mode the terminal is the input surface; the extensible event set is the seam if headless needs it later.

**Recurring tasks are a source concern.** A source that re-lists a task on a schedule is indistinguishable from a human re-creating it; core ships no recurrence machinery.

## 4. Task model: workspaces of worktrees

([Multi-repo task model](https://linear.app/clipboardhealth/issue/DEVOP-5967))

**One agent session per task, over a workspace of worktrees.** Groundcrew provisions worktrees side by side under a single task workspace directory; one agent session launches at the workspace root and coordinates all repos itself. One terminal surface per task, N PRs out. The session can start before any worktree exists — an empty workspace is legal. The capable agent is the coordinator; there are no federated sessions or relay pipelines.

**Repo resolution — two modes, one mechanism:**

- **Designated:** the task carries a `Repos:` designation. Groundcrew resolves each name against what is actually cloned under the configured base directory and provisions those worktrees up front. Any designated repo not found on disk → **bail**: skip the task with a visible "repo not found" status, provision nothing (not even the repos that do exist).
- **Not designated:** dispatch anyway, into an empty workspace. The ticket's prose decides what happens: the agent discovers repos and acquires worktrees at runtime, or never touches a repo at all. Repo-less tasks are legal.
- There is no `Repos: discover` marker, and v1's prose-inference (scanning descriptions for repo mentions) is dropped: explicit designation or nothing.

**`knownRepositories` dies.** The repo universe is the disk under the base directory. Groundcrew never clones — provisioning is always worktree-from-local-clone. (The agent may clone repos itself if the sandbox policy allows; that is the sandbox's jurisdiction.) Accepted tradeoff, recorded honestly: the gate widens from "repos listed in config" to "anything cloned under the base directory" — mitigated by sandboxing; an optional allowlist can be layered on later without redesign.

**Runtime acquisition:** the agent runs `crew repo add <repo>` in-session. The CLI applies the disk-presence gate, creates the worktree from the local clone on the uniform task branch, runs the repo's prepare-worktree hook, and records the addition in task state. Provisioning stays groundcrew's job with all guarantees intact — only the trigger moves from dispatch-time to agent-runtime.

**Branch/PR topology:** a uniform task-derived branch name across every acquired worktree — the correlation key that keeps status/resume/cleanup trivial; one PR per repo as the default writeback, cross-linked to each other and the task; one artifact record per repo. A repo that needs no change simply produces no PR.

**Partial failure: groundcrew does nothing but tell the truth.** Cross-repo atomicity is an explicit non-goal. Per-repo artifact records show exactly how far each repo got; merge outcomes are human/CI territory; recovery is a human action. The uniform branch plus cross-linked PRs guarantee the full blast radius is reconstructible from any one artifact.

Single-repo tasks stay dead simple as the degenerate case: one designated repo, one worktree, one branch, one PR — exactly v1's shape.

## 5. Completion model

(Codified in the [E2E scenario catalog](https://linear.app/clipboardhealth/issue/DEVOP-5974); full statement in [the catalog, section 2](./e2e-scenario-catalog.md#2-completion-model-codified-from-iteration-1).)

- **Core never polls a destination for done-ness.** No forge calls, no tracker reads to infer completion. v1's reviewer (merged-PR polling via `gh`) dies.
- Status = **observed** workspace git facts plus **agent-reported** events and artifacts; humans judge from the agent's report.
- `completed{outcome}` **frees the dispatch slot immediately** — a finished task never blocks the queue.
- **The workspace lingers after completion, with two exits:** a human runs `cleanup`, or polling observes the _source_ reporting the task terminal — v1's cleaner survives unchanged because it watches the source, never the forge (this is how Linear cleanup actually worked in v1: Linear's GitHub integration moves the issue; the poll observes it). Dirty worktrees are never auto-reaped — loud skip, left for a human.

## 6. Plugin boundary: task sources

([Plugin packaging and review isolation](https://linear.app/clipboardhealth/issue/DEVOP-5973), informed by the [plugin-distribution research](https://linear.app/clipboardhealth/issue/DEVOP-5971): in-process npm plugins deliver no sandboxing and no real review isolation; the models that work — Terraform providers, MCP — use a versioned process boundary.)

**"Plugin" means exactly one thing in v2: a task source.** Everything else that looked pluggable is config or core:

- **Agent harnesses are declarative config**, not plugins: `cmd`, resume args, sandbox preferences, plus first-class `model`/`effort` fields. `cmd`-points-at-your-script is the escape hatch for odd agents.
- **Sandbox runners are core-only**, explicitly not pluggable — a pluggable sandbox is a contradiction under sandboxed-by-default. **v2 ships exactly one runner: srt** (`sandbox-exec` on macOS, bubblewrap on Linux). Safehouse, clearance, and sbx die, including the `crew-clearance-ensure` bin.
- **No in-process plugin class exists.** The internal `TaskSource` interface survives only as core's private representation of a discovered manifest.

**Packaging:** a plugin is a **directory bundle** — `source.json` plus scripts — discovered under `~/.config/groundcrew/task-sources/<name>/` (user) or bundled in the package (first-party). The directory is the plugin: language-agnostic, no runtime loading. Distribution is deliberately not groundcrew's problem (git clone, `curl | tar`, npm postinstall). No registry or catalog in v2.0; provenance tiers collapse to `package | user`. Review isolation is met structurally: third-party code never enters the core repo and never runs in the core process.

**Versioning:** `source.json` carries a required integer `protocolVersion: 1` naming the contract generation, bumped only on breaking change — capability-by-omission carries all additive change (no version sniffing: `update` absent means read-only). Parseable-but-unsupported version → explicit actionable error in discovery/doctor/status, never a silent skip; unparseable manifests keep skip-plus-warn. Core declares a supported set; v2.0 ships `{1}`. No v1 command aliases.

**Sources are sandboxed by default**, under the same srt machinery as agents: deny-by-default; a source gets its install dir (read), declared secret files, declared env, stdout/stderr, and a per-source scratch dir. The manifest gains a **network egress allowlist** (e.g. `network: ["api.linear.app"]`) alongside `secrets`/`env`/`prerequisites`. Uniform across origins — bundled first-party sources run under the same policy. Per-source opt-out (`sandbox: false`) is loud in status/doctor.

**Batteries included, kernel-pure code paths:** `linear`, `jira`, and `todo-txt` ship as manifest bundles crossing the same process boundary as third-party sources — first-party sources are the protocol's permanent conformance tests. The generic `shell` config-block adapter dies: bring-your-own-scripts is just a user-dir manifest.

## 7. CLI surface and config

([CLI surface](https://linear.app/clipboardhealth/issue/DEVOP-5975); prototype with rendered `--help` for every command on branch [`prototype/devop-5975-cli-surface`](https://github.com/ClipboardHealth/groundcrew/tree/prototype/devop-5975-cli-surface), `node --run proto:cli2 -- --tour`. Amended by [Headless extension point](https://linear.app/clipboardhealth/issue/DEVOP-5976): config field `multiplexer` → `presenter`.)

### 7.1 Commands — 14 leaves (v1 had ~20)

| Group      | Command                                                       | Notes                                                                                                                                                                                                                |
| ---------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Operate    | `start [task]`                                                | Merged v1 `run`+`start`. No task = poll and dispatch eligible (`--watch` continuous); with task = dispatch that one (`--force` bypasses eligibility but never the repo-on-disk gate; `--agent` override).            |
| Operate    | `status [task]`                                               | Absorbs `task list`/`get`. Renders **observed** git facts vs **reported** agent claims as separate layers; is the "why" affordance (section 10.4).                                                                   |
| Operate    | `pause` / `resume`                                            | v1 `stop` renamed. `resume` reopens the _same conversation_ via captured `{{sessionId}}` where the harness exposes one (Claude Code and Codex do); falls back to `resumeArguments`; `--fresh` = new session.         |
| Operate    | `cleanup [task\|--all]`                                       | An uncompleted task completes as `stopped`.                                                                                                                                                                          |
| In-session | `repo add <repo>`                                             | Runtime acquisition (section 4). Renamed from `workspace add` to dodge the cmux "workspace" collision.                                                                                                               |
| In-session | `artifact add <locator> [--kind\|--title\|--repo]`            | Agent-reported artifacts (section 3).                                                                                                                                                                                |
| In-session | `done [--outcome delivered\|failed\|stopped] [--allow-dirty]` | Replaces `$GROUNDCREW_COMPLETE` — the prompt just says "run `crew done`". Dirty-worktree guard refuses with the dirt named unless `--allow-dirty`.                                                                   |
| Setup      | `init`                                                        | Interactive 5-step: baseDirectory, agent detection, source pick, write config, run doctor. Detects a v1 `crew.config.ts` and converts it, printing every dropped/renamed key. Global by default; `--local`, `--yes`. |
| Setup      | `doctor` / `upgrade` / `completions`                          | `doctor` is the health-check verb everywhere: `crew doctor`, `crew source doctor` (absorbs `source verify` + `task validate`).                                                                                       |

In-session commands are ordinary subcommands (no separate namespace). **Task identity resolution:** `--task` flag → `$GROUNDCREW_WORKSPACE` env (injected at launch) → walk up from cwd to `.groundcrew/task.json`. Exit codes: **2** = repo not cloned under `baseDirectory`, **3** = no task context.

**Killed:** `open`, `task create`, `task list/get/validate`, `source install`, `source verify`, `interrupt`, `sandbox`, `setup`, the `crew-clearance-ensure` bin. No `progress` command in v2.0 (the protocol event exists; add a CLI if the need shows up). No `crew migrate` — `init`'s conversion is the migration aid.

**Verb families locked:** lifecycle `start → pause → resume → done`; health checks are `doctor`.

### 7.2 Config — `crew.config.jsonc`

- **JSONC plus a published JSON Schema** (generated from zod, referenced via `$schema`). TS config dies: a global config can't resolve the package import for its types, so it was ceremony without safety. One filename, one location rule: `~/.config/groundcrew/`, or project-local.
- **Principle 1 — omitted = detected, specified = exactly yours, never merged.** `sources` omitted → `[{ "kind": "todo-txt" }]`; `agents` omitted → presets for CLIs on PATH (claude > codex > cursor); `presenter` omitted → first of cmux/tmux/zellij found. Listing anything replaces the detected set — disabling = not listing.
- **Principle 2 — no secrets, structurally.** No schema field accepts a token value; manifests declare secret _names_, resolved from the parent environment, a `secrets.env` (doctor warns unless 0600), or `op run`. `GROUNDCREW_LINEAR_API_KEY` dies; the linear bundle declares `LINEAR_API_KEY` like any source. Doctor flags credential-looking strings in config.
- Minimal legal config: `{ "workspace": { "baseDirectory": "~/dev" } }`. Worktrees default to `<baseDirectory>/.groundcrew/worktrees`. No abbreviations anywhere (`maximumInProgress`, `pollIntervalMilliseconds`, `sessionLimitPercentage`, `readOnlyDirectories`, `workingDirectory`).
- Agent profiles get first-class `model` / `effort` / `resume` fields; presets map them to CLI flags; `{{model}}` / `{{sessionId}}` placeholders for custom commands. Per-harness session-id capture mechanics are an implementation detail under this shape.

### 7.3 Setup

`curl -fsSL …/install.sh | sh` → node ≥ 24 check, global npm install, exec `crew init` (`--yes` for CI/dotfiles). Deliberately manual forever: cloning repos, minting API keys, installing agent CLIs.

## 8. Session presenter

([Headless extension point](https://linear.app/clipboardhealth/issue/DEVOP-5976))

**The seam is a standalone core interface: the session presenter** — presentation-only, deciding where a local, already-sandbox-wrapped agent process runs and how a human reaches it. Remote execution is permanently outside this seam: a remote runner enters via the source-contract door (`claimed` → _rejected_ arbitration), never as a presenter.

**Contract — born serializable.** JSON in/out, nothing in-process, which outlaws v1's real leak (cmux `set-progress` hooks injected through the launch layer) by construction:

- `open(spec)` — spec = `{name, displayName?, cwd, command, status?}`; `command` arrives fully composed, sandbox wrap included. Nesting is **presenter → sandbox → agent**; the presenter never knows about sandboxing.
- `probe()` — live workspace list; "unavailable" is never treated as "empty".
- `close(name)`.
- `accessHint(name)` — how a human attaches, or nothing.
- `setStatus(name, {text, color?, icon?})` — **optional, capability by omission** (cmux implements; tmux/zellij omit). Driven by core's run-state machine, not agent-internal hooks. v1's cmux/Claude in-sandbox hook plumbing dies with no replacement.

**Packaging:** cmux/tmux/zellij ship in-core for v2.0; sources remain the only v2.0 plugin kind. Presenter _bundles_ are pre-committed as an additive v2.x kind — same manifest/process-boundary mechanics as sources but an explicitly different trust posture: presenters are inherently unsandboxable (their job is spawning the agent's pane on the host, launch command in hand), so a presenter bundle is **host-trusted like an agent CLI**, never sandbox-defaulted.

**Headless = a future "detached" presenter** implementing the same contract (`open` spawns directly, `probe` is process liveness, `accessHint` returns nothing, `setStatus` omitted). v2.0 ships no detached presenter — one of cmux/tmux/zellij on PATH stays required (doctor checks). **Subagent panes: same seam, deferred** — a future presenter verb plus an in-session command routed through core; nothing outside the presenter may ever talk to a multiplexer.

The fate of v1's tmux-shaped env toggles (`GROUNDCREW_TMUX_SESSION_PER_TASK`, `GROUNDCREW_KEEP_DEAD_WINDOWS`) is presenter-internal implementation detail.

## 9. Architecture: one context, seven modules

([Bounded-context layout](https://linear.app/clipboardhealth/issue/DEVOP-5977))

### 9.1 Single bounded context

One root `CONTEXT.md`, no `CONTEXT-MAP.md`. v2's real boundaries are **process seams** — the source protocol, the presenter contract, the sandbox wrap — and each carries the _same_ language across it; a source bundle translating tracker-speak into protocol-speak is an anticorruption layer living outside the repo. One team, one deployable, one language ⇒ one context.

### 9.2 The core noun triple

- **Workspace** — the per-task directory set: the worktrees (possibly zero) a task's agent works over. Filesystem/git facts only. v1's "Workspace = terminal pane" dies.
- **Run** — the core-owned execution lifecycle of a claimed task: the state machine of section 3, resumeCount. One claim = one run.
- **Session** — one live occupancy of a run: the harness process in a presenter surface, with its captured harness session-id. A run spans sessions (`pause`/`resume`; `--fresh` = new session, same run).

Consequences: the session presenter presents sessions, not runs; `status` renders runs; `resume` reopens a session within a run.

### 9.3 Modules

| Module          | Responsibility                                                                                                                                                                             | Owns                                                           |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| **Acquisition** | Source bundle discovery, the versioned `list`/`get`/`update` process protocol, source sandboxing                                                                                           | the **source-protocol contract seam**                          |
| **Dispatch**    | Per-tick picker: poll, eligibility, claim, provision, terminal-status sweep; persists per-task skip verdicts (section 10.4)                                                                | wiring the Writeback adapter into Run                          |
| **Run**         | The run record: state machine, **reported layer** (`artifact add`/`done` intake), outcomes, writeback point                                                                                | the **Writeback port** (consumer-owned, defined in `src/run/`) |
| **Workspace**   | Worktrees, branches, **observed layer** (credential-free git facts), `.groundcrew/task.json` and the task-identity resolver; typed errors that Shell maps to exit codes 2/3                | the workspace marker-file format                               |
| **Session**     | Harness profiles (declarative), launch composition (presenter → sandbox → agent), pause/resume and session-id capture; cmux/tmux/zellij adapters in-core                                   | the **presenter contract seam**                                |
| **Sandbox**     | Pure library: `wrap(command, policy) → command`; srt mechanics hidden; no lifecycle ownership                                                                                              | nothing pluggable — core-only by decision                      |
| **Shell**       | commander wiring, routing (`repo add` → Workspace; `artifact add`/`done` → Run), rendering, error→exit-code mapping; `status` = read model joining Run (reported) and Workspace (observed) | —                                                              |

The flow model's central invariant gets one owner per layer — **observed = Workspace, reported = Run** — so a lie or missing link is always attributable to exactly one module. Sandbox has two real callers (Session wraps agents, Acquisition wraps sources): a real seam, and the one place that keeps "sandbox runners are not pluggable" enforceable.

### 9.4 Dependency graph

```text
Shell ──▶ everything (thin)
Dispatch ──▶ Acquisition · Workspace · Session · Run
Run ──▶ Writeback port only (Dispatch injects the adapter closed over the source)
Session ──▶ Sandbox        Acquisition ──▶ Sandbox
Workspace ──▶ git only     Sandbox ──▶ nothing
```

Load-bearing properties: **(a)** Run never sees Acquisition — a read-only source is a no-op handle, and Run's tests never touch discovery; **(b)** each edge module owns exactly one published contract seam; **(c)** acyclic, nothing calls upward — sources are spawned processes that answer; agents talk back only via in-session Shell commands routed downward.

### 9.5 Layout

```text
CONTEXT.md            ← the one glossary
docs/adr/             ← wayfinder resolutions seed the first ADRs
src/
  acquisition/ dispatch/ run/ workspace/ session/ sandbox/ shell/
task-sources/
  linear/ jira/ todo-txt/   ← shipped bundles, OUTSIDE src/ — no import path
e2e/                  ← black-box suite (spawns the built binary only)
```

Conventions: **a module's interface is its `index.ts`** — the only importable path from outside; flat `src/<module>/` so path = glossary noun; colocated `*.test.ts` are intra-module and free.

### 9.6 Enforcement — the graph as CI rules

Extend v1's `config/dependencyCruiser.cjs` (already wired as `architecture:check`), keeping `no-circular`/`no-orphans` and adding:

1. **Entry-point boundary** — imports into `src/<module>/` from outside must target `index.ts`.
2. **The section 9.4 graph as an allowlist** — one `forbidden` rule per module encoding exactly the ratified edges; an undeclared edge fails CI naming the violated seam. The spec diagram and lint config cannot drift silently.
3. **Process-boundary rules** — `src ↛ task-sources`, `task-sources ↛ src`, `e2e ↛ src` (the suite stays black-box).

Validation step: prove the rules bite with one deliberate deep import and one undeclared edge, watch both fail, revert.

### 9.7 Glossary seed for v2 `CONTEXT.md`

Task · Source · Bundle · Workspace · Worktree · Run · Session · Presenter · Agent profile · Sandbox · Artifact · Writeback · Observed/Reported · Reconcile · Skip verdict — with the triple from 9.2 as the anchor definitions.

## 10. Observability

([Observability design](https://linear.app/clipboardhealth/issue/DEVOP-5982))

**Root fork: logs are diagnostics; the run record is the truth.** "Why did/didn't X happen" is answered from the run record plus observed git facts, never by parsing logs. The run record gains a compact, versioned, append-only event history `{ts, event, detail}` covering state transitions and writeback events. Logs stay freely deletable; no log line is a compatibility surface beyond the line format itself.

### 10.1 Topology

One global JSON-lines file (config `logging.file`), size-based rotation (~10 MB × 3). Runs interleave; run-less events (poll ticks, reconcile, claim-rejected, doctor) share the stream. Correlation ids are the filter mechanism — no per-run files, no sink routing.

### 10.2 Line schema

```json
{
  "ts": "…Z",
  "level": "info",
  "module": "dispatch",
  "event": "task_claimed",
  "msg": "claimed DEVOP-123 from linear",
  "taskId": "DEVOP-123",
  "runId": "r_8f3a",
  "source": "linear"
}
```

- `ts` ISO-8601 UTC; `level` ∈ `debug|info|warn|error` (four, no trace/fatal); `module` ∈ the seven ratified modules — all three on every line.
- `event`: required snake_case name, unique per call site; no dotted module prefix.
- Correlation ids **flat at top level**, present when known: `taskId`, `runId`, `sessionId`, plus `source`/`repo` where relevant. Extra fields flat too; reserved keys enforced by the logging lib's types. `msg` optional (human lines only).
- The cross-cutting logging lib (no eighth module) **exports a zod schema for the line format**; the E2E suite validates every emitted line against it.

### 10.3 Console rendering

The file sink gets everything, always. Console: `info`+ by default, human-rendered; `--verbose` = debug threshold. Raw JSON never hits the console — the file is the only JSON surface.

### 10.4 The "why" affordance — no 15th command

`crew status <task>` is the why affordance. It must answer three situations:

1. **Ran / running** — run-record event history merged chronologically with observed git facts, observed-vs-reported layering explicit, ending with a log pointer (file path plus a ready-made jq filter on the run id).
2. **Queued, never starts** — **spec commitment:** Dispatch persists its last-poll verdict per task id (`{skipReason, ts}` — repo missing / slots full / claim rejected) in a small dispatch-owned state map, making the flow model's "visible skip reason" promise renderable. No run record exists for unclaimed tasks, so this is the only home.
3. **Finished / lingering** — terminal outcome, delivered vs merely observed, what `cleanup` would do.

### 10.5 Reconcile and reaping

**Active sweep yes, TTL no.** srt sandboxes are process-scoped — nothing standing to reap except a live agent process, and the interactive baseline forbids killing those on a timer.

- **Reconcile is an idempotent library routine with two callers**: startup (the crash-safety guarantee — on-disk git/tmux/sandbox state is the source of truth, compared against expected task state; `using`/signal handlers are the graceful path only) and the dispatcher tick (every Nth poll cycle).
- Auto-GC only the provably dead: presenter surfaces whose process exited, stale run records, clean worktrees of source-terminal tasks (the cleaner, section 5).
- **Never auto-kill a live agent process.** Orphaned-but-running sessions are reported loudly — `warn` line plus a prominent `status` flag — and left to the human.

### 10.6 Live activity finer than run-state

Nothing finer ships in v2.0. Run-state drives presenter `setStatus`; the observed layer is the truthful on-demand activity signal for free. The seam is documented, not built: a future in-session `crew progress <note>` routed to Run, fanning out to presenter `setStatus` and the source `progress` event — fully additive.

## 11. Migration

([Migration easing](https://linear.app/clipboardhealth/issue/DEVOP-5981))

**Migration easing is deferred to post-v2 handoff work** — designing conversion details against a spec that will shift during implementation is waste. The spec carries exactly two commitments:

1. **5.0.0 release blocker — the `crew upgrade` ambush.** v1's `upgrade` self-updates to `@latest`; the moment 5.0.0 hits the `latest` dist-tag, every v1 user who runs `crew upgrade` gets silently major-bumped. Before publishing 5.0.0, decide a dist-tag strategy or a first-run v1 guard. (No publish happens until the E2E suite is green, so this fires late — it must not be forgotten.)
2. **v2 fails loudly on v1-only config.** When v2 finds a v1 config (`crew.config.ts` et al.) and no v2 config, it errors with a migration pointer — never silently falls back to defaults.

Everything else — `crew init` conversion detail, killed-command stubs, the migration doc, 5.0.0 release notes — moves to the handoff backlog, gated on a working v2.

## 12. Implementation stack and handoff

### 12.1 Stack

**Plain TypeScript** ([Effect vs plain TypeScript](https://linear.app/clipboardhealth/issue/DEVOP-5972), informed by the [Effect research](https://linear.app/clipboardhealth/issue/DEVOP-5970)). Effect was rejected for now: v4-beta churn with the platform/CLI layers least stable, span-based-not-stack-based debugging against "dead simple to know what happened", and function coloring as a contributor/AI filter against pluggability.

- **Public plugin/source boundary: result-shaped protocol data on one channel.** Authors emit a structured response; expected failure is a failure variant in it; a process crash or nonzero exit is mapped by the core into the _same_ failure shape.
- **Internals: plain exceptions plus typed error classes** (native stack traces). The adapter layer is the single seam converting caught exception / nonzero exit → protocol failure. No code anywhere handles both models. neverthrow dies.
- **Crash safety = reconcile-on-startup** (section 10.5), strictly stronger than in-process finalizers since it survives SIGKILL/OOM/power loss.

| Capability             | Choice                                                    |
| ---------------------- | --------------------------------------------------------- |
| Retry / backoff        | p-retry                                                   |
| Concurrency and cancel | p-limit plus AbortSignal (cooperative)                    |
| Process spawning       | execa (deletes most of v1's 325-line `commandRunner.ts`)  |
| Schema / config        | zod 4                                                     |
| CLI parsing            | commander plus `@commander-js/extra-typings`              |
| Logs                   | JSON-lines via the cross-cutting logging lib (section 10) |

If Effect is ever reconsidered: gate on v4-stable, follow the opencode pattern (Effect core plus platform, skip `@effect/cli`), mandate `Effect.fn` spans from day one.

### 12.2 Handoff sequence

1. **Build the acceptance suite red-first from the [E2E scenario catalog](./e2e-scenario-catalog.md)** — the `e2e/` package, fixture source, scripted agent, fake `gh`, harness self-tests. This is the entry point; no v2 code before it.
2. Fix `main`'s release automation (path/scope filter) so v2 commits don't trigger 4.x publishes (section 2).
3. Scaffold the `v2/` workspace: seven-module skeleton, dependency-cruiser rules (section 9.6) proven to bite, `CONTEXT.md` from the glossary seed, ADRs seeded from the wayfinder resolutions.
4. Bring the suite green module by module, porting the surviving v1 code (srtPolicy/srtLaunch, cleaner, tmux/git plumbing, doctor pieces) file-by-file with its tests.
5. Before publishing 5.0.0: resolve the `crew upgrade` ambush (section 11) and execute the cutover (section 2).

Post-v2 handoff backlog (deferred by decision): migration easing detail (section 11); presenter bundles and their trust posture (section 8); `crew progress` (section 10.6); an optional repo allowlist (section 4).

## 13. Decision record

Every map decision, in resolution order. Full rationale lives in the linked tickets.

| Decision                                                                                     | Outcome                                                                                                                | Section |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------- |
| [Prior-art research](https://linear.app/clipboardhealth/issue/DEVOP-5969)                    | Symmetric source/sink abstractions die in practice; generalize asymmetrically (branch `research/agent-flow-prior-art`) | 3       |
| [Plugin-distribution research](https://linear.app/clipboardhealth/issue/DEVOP-5971)          | Versioned process boundary, not in-process npm plugins (branch `research/plugin-distribution-models`)                  | 6       |
| [Effect research](https://linear.app/clipboardhealth/issue/DEVOP-5970)                       | Effect's costs cut against the locked constraints (branch `research/effect-for-cli-orchestrator`)                      | 12.1    |
| [Multi-repo task model](https://linear.app/clipboardhealth/issue/DEVOP-5967)                 | One session per task over a workspace of worktrees                                                                     | 4       |
| [Flow model](https://linear.app/clipboardhealth/issue/DEVOP-5968)                            | Sinks and flows dissolve; `list`/`get`/`update` source contract; run-state machine                                     | 3       |
| [Effect vs plain TypeScript](https://linear.app/clipboardhealth/issue/DEVOP-5972)            | Plain TypeScript; exceptions inside, result-shaped protocol at the boundary; reconcile-on-startup                      | 12.1    |
| [Plugin packaging and review isolation](https://linear.app/clipboardhealth/issue/DEVOP-5973) | Task sources are the only plugin kind; directory bundles; `protocolVersion`; sandboxed by default; srt only            | 6       |
| [CLI surface](https://linear.app/clipboardhealth/issue/DEVOP-5975)                           | 14 commands; `crew.config.jsonc`; install.sh → `crew init`                                                             | 7       |
| [E2E scenario catalog](https://linear.app/clipboardhealth/issue/DEVOP-5974)                  | v2-only red-first suite; harness self-tests; completion model codified (amends the destination)                        | 5       |
| [Headless extension point](https://linear.app/clipboardhealth/issue/DEVOP-5976)              | Session-presenter seam; headless = future detached presenter (amends CLI config: `multiplexer` → `presenter`)          | 8       |
| [Bounded-context layout](https://linear.app/clipboardhealth/issue/DEVOP-5977)                | One context, seven modules, graph enforced by dependency-cruiser                                                       | 9       |
| [Rewrite vs evolve](https://linear.app/clipboardhealth/issue/DEVOP-5978)                     | Rewrite in `v2/` on `main`; ships as 5.0.0                                                                             | 2       |
| [Migration easing](https://linear.app/clipboardhealth/issue/DEVOP-5981)                      | Deferred post-v2; two spec commitments carried                                                                         | 11      |
| [Observability design](https://linear.app/clipboardhealth/issue/DEVOP-5982)                  | Run record is the truth; one JSON-lines file; `status` is the why affordance; active sweep, no TTL                     | 10      |
