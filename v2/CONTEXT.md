# Groundcrew v2 ubiquitous language

This is the one glossary for groundcrew v2 (design doc §9.1: one bounded context, no
`CONTEXT-MAP.md`). Every term below carries the same meaning across every process seam —
the source protocol, the presenter contract, the sandbox wrap. When code, logs, docs, or
commit messages use these words, they mean exactly what is written here.

> **v1 warning.** v1 and v2 use several of the same nouns with contradictory meanings. Most
> importantly, in v1 a **Workspace** was a terminal pane; in v2 it is a per-task directory of
> worktrees. The `v2/` tree is isolated precisely so this contradiction cannot contaminate
> agent-driven work. Never import v1 meanings here.

## Anchor triple (design doc §9.2)

These three nouns are the spine of the model. Everything else is defined in terms of them.

- **Workspace** — the per-task directory set: the worktrees (possibly zero) a task's agent
  works over. Filesystem and git facts only. A workspace can exist before any worktree does
  (an empty workspace is legal). One workspace per task. This is **not** a terminal pane.
- **Run** — the core-owned execution lifecycle of a claimed task: the state machine
  `provisioning → running ⇄ paused → complete{outcome: delivered | failed | stopped}`, plus
  its `resumeCount`. One claim = one run. The run record — not the logs — is the truth about
  what happened.
- **Session** — one live occupancy of a run: the harness process in a presenter surface,
  carrying its captured harness session-id. A run spans sessions: `pause`/`resume` close and
  reopen a session; `--fresh` starts a new session within the **same** run.

Consequences: the presenter presents **sessions**, `status` renders **runs**, and `resume`
reopens a **session** within a run.

## Terms

- **Task** — a unit of work a source offers: an id, prose, optional priority, optional
  blockers, an optional `Repos:` designation, and an agent designation (its routing). Tasks are
  created in the tracker or file directly; groundcrew never creates them. The queue of ready
  tasks is always derived from source polls, never stored.
- **Source** — an installed task backlog groundcrew can poll and write back to, behind the
  versioned `list` / `get` / `update` process protocol. `list` and `get` are required; `update`
  is optional — a source without it is legal and read-only (writeback no-ops). "Plugin" means
  exactly one thing in v2: a task source. A source is sandboxed by default.
- **Bundle** — the on-disk form of a source: a directory (`source.json` plus scripts)
  discovered under `~/.config/groundcrew/task-sources/<name>/` (user) or shipped in the package
  (first-party). The directory **is** the plugin — language-agnostic, no runtime loading,
  crossing a process boundary. `source.json` carries a required integer `protocolVersion`.
- **Worktree** — one git worktree inside a workspace: a single repo checked out on the uniform
  task branch, created from a local clone under the base directory (groundcrew never clones).
  Worktrees sit side by side under the workspace directory.
- **Presenter** — the session-presentation seam: a core interface deciding **where** a local,
  already-sandbox-wrapped agent process runs and **how** a human reaches it. Verbs: `open`,
  `probe`, `close`, `accessHint`, and optional `setStatus`. Born serializable (JSON in/out,
  nothing in-process). Nesting is **presenter → sandbox → agent**; the presenter never knows
  about sandboxing. cmux/tmux/zellij ship as in-core presenters for v2.0.
- **Agent profile** — declarative config for a harness (not a plugin): `cmd`, resume args,
  sandbox preferences, and first-class `model` / `effort` fields. `{{model}}` / `{{sessionId}}`
  placeholders serve custom commands; `cmd`-points-at-your-script is the escape hatch.
- **Sandbox** — the deny-by-default confinement wrap applied to agents and sources. A pure
  library: `wrap(command, policy) → command`. v2 ships exactly one runner: **srt**
  (`sandbox-exec` on macOS, bubblewrap on Linux). Sandbox runners are core-only, explicitly not
  pluggable. Per-source `sandbox: false` opt-out is loud in status/doctor.
- **Artifact** — an agent-reported output record: `{kind, locator, title?, repo?}` with an open
  kind set (`pr | branch | document | file | ticket | …`). Per task the record is plural and
  kind-tagged: `{status, logs, artifacts: []}`. All artifacts are reported by the agent via
  in-session `crew artifact add` — never observed by the core, which knows nothing about GitHub
  or any forge.
- **Writeback** — a source's `update(task, event)` callback: the single verb by which
  groundcrew tells a source what happened. Events: `claimed` (ack; may return _rejected_),
  `progress` (note), `completed{outcome, artifacts, message}`. Errors are `outcome: failed`, not
  a separate channel. Owned as a port defined in `src/run/`; Dispatch injects the adapter closed
  over the source. Sinks do not exist — every other output happens through the agent's own tools.
- **Observed / Reported** — the two truth layers `status` renders separately.
  **Observed** = credential-free workspace git facts (branches, commits, dirty state), owned by
  **Workspace**. **Reported** = agent-supplied events and artifacts, owned by **Run**. A
  forgotten report is a missing link, never a lie; a lie or missing link is attributable to
  exactly one module.
- **Reconcile** — the idempotent library routine that makes on-disk git/tmux/sandbox state the
  source of truth and compares it against expected task state. Two callers: startup (the
  crash-safety guarantee, stronger than in-process finalizers) and the dispatcher tick (every
  Nth cycle). Auto-GCs only the provably dead (exited presenter surfaces, stale run records,
  clean worktrees of source-terminal tasks). Never auto-kills a live agent process.
- **Skip verdict** — Dispatch's persisted per-task reason a queued task was not started this
  tick (`{skipReason, ts}` — repo missing / slots full / claim rejected), held in a small
  dispatch-owned state map. It makes the flow model's "visible skip reason" promise renderable
  by `crew status` for tasks that have no run record because they never started.
