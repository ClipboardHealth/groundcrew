# Groundcrew v2 implementation contracts

Fixed cross-module contracts for the v2 build. The [design doc](../../docs/spec/v2-design.md) and
[E2E scenario catalog](../../docs/spec/e2e-scenario-catalog.md) are the spec; this document pins the
concrete shapes the spec leaves open so the e2e suite (black-box) and the implementation (white-box)
agree without importing each other. The e2e suite parses these files read-only; changing any shape
here is a spec change, not a refactor.

## 1. Identity and naming

- **Canonical task id**: `<sourceName>:<sourceLocalId>` (e.g. `fixture:TASK-1`, `linear:DEVOP-123`).
  Source name defaults to the bundle's manifest `name` (which defaults to its directory name).
- **Task slug**: canonical id lowercased, every run of characters outside `[a-z0-9]` collapsed to a
  single `-`, trimmed of leading/trailing `-` (`fixture:TASK-1` → `fixture-task-1`,
  `fixture:TASK_1.x` → `fixture-task-1-x`). Reference implementation: `e2e/harness/identity.ts`;
  core must match it. Used in paths, branches, and session names.
- **Task branch** (uniform across every worktree of the task): `<branchPrefix>/<taskSlug>`;
  `git.branchPrefix` defaults to `crew`. Example: `crew/fixture-task-1`.
- **Presenter session name**: `crew-<taskSlug>`. One session per task.
- **Run id**: `r_` + 8 lowercase hex chars, unique per claim.

## 2. Directory layout (XDG, overridable via environment)

| Thing | Path |
| --- | --- |
| Global config | `$XDG_CONFIG_HOME/groundcrew/crew.config.jsonc` (fallback `~/.config/...`); project-local `./crew.config.jsonc` wins; `$GROUNDCREW_CONFIG` overrides both |
| User source bundles | `$XDG_CONFIG_HOME/groundcrew/task-sources/<name>/` |
| Package source bundles | `<package>/task-sources/<name>/` |
| Secrets file (optional) | `$XDG_CONFIG_HOME/groundcrew/secrets.env` (doctor warns unless mode 0600) |
| State root | `$XDG_STATE_HOME/groundcrew/` (fallback `~/.local/state/groundcrew/`) |
| Run records | `<stateRoot>/runs/<taskSlug>.json` |
| Dispatch skip verdicts | `<stateRoot>/dispatch.json` |
| Log file | `<stateRoot>/groundcrew.jsonl` (config `logging.file` overrides) |
| Per-source scratch | `<stateRoot>/source-scratch/<sourceName>/` |
| Workspaces root | config `workspace.worktreeDirectory`, default `<baseDirectory>/.groundcrew/worktrees` |
| Task workspace | `<workspacesRoot>/<taskSlug>/` |
| Worktree for repo | `<workspacesRoot>/<taskSlug>/<repoName>/` |
| Workspace marker | `<workspacesRoot>/<taskSlug>/.groundcrew/task.json` |

## 3. State file schemas (all JSON, versioned, read by the e2e suite)

### 3.1 Run record — `runs/<taskSlug>.json`

```jsonc
{
  "version": 1,
  "taskId": "fixture:TASK-1",
  "runId": "r_8f3a9c21",
  "source": "fixture",
  "agentProfile": "scripted",
  "state": "running",            // provisioning | running | paused | complete
  "outcome": "delivered",        // only when state=complete: delivered | failed | stopped
  "reason": "launch",            // optional detail for failed outcomes (e.g. "launch")
  "resumeCount": 0,
  "sessionName": "crew-fixture-task-1",
  "sessionId": "abc123",         // captured harness session id, when the profile exposes one
  "workspaceDirectory": "/…/worktrees/fixture-task-1",
  "repos": ["alpha"],            // worktrees provisioned (dispatch-time + runtime-acquired)
  "artifacts": [                  // agent-reported, append-only
    { "kind": "pr", "locator": "https://github.com/o/r/pull/1", "title": "…", "repo": "alpha" }
  ],
  "events": [                     // append-only event history {ts, event, detail?}
    { "ts": "2026-07-17T00:00:00.000Z", "event": "claimed" },
    { "ts": "…", "event": "state_running" },
    { "ts": "…", "event": "artifact_reported", "detail": "pr https://…" },
    { "ts": "…", "event": "writeback_completed", "detail": "delivered" }
  ]
}
```

State machine (design doc §3): `provisioning → running ⇄ paused → complete{outcome}`.
The record exists only for started (claimed) work and lingers after completion until cleanup/reap.

### 3.2 Workspace marker — `.groundcrew/task.json`

```jsonc
{
  "version": 1,
  "taskId": "fixture:TASK-1",
  "branch": "crew/fixture-task-1",
  "repos": ["alpha"]             // maintained by provisioning and `crew repo add`
}
```

In-session task identity resolution (CLI): `--task` flag → `$GROUNDCREW_WORKSPACE` env (path to the
workspace directory) → walk up from cwd to `.groundcrew/task.json`. Exit code 3 when none resolves.
Identity resolution runs BEFORE any other gate: `crew repo add` with no task context exits 3 even
when the repo argument is also not on disk (exit 2 is only reachable with task context resolved).
The `prepareWorktree` hook runs with cwd set to the just-created worktree root (v1 behavior).

### 3.3 Dispatch verdicts — `dispatch.json`

```jsonc
{
  "version": 1,
  "verdicts": {
    "fixture:TASK-2": { "skipReason": "repo-not-on-disk", "detail": "gamma", "ts": "…Z" }
  }
}
```

`skipReason` ∈ `repo-not-on-disk | slots-full | claim-rejected | ineligible`. Overwritten per poll;
`status` renders it for queued tasks (the "why" affordance, design doc §10.4).

## 4. Source protocol v1 (process boundary)

### 4.1 Manifest — `source.json` in the bundle directory

```jsonc
{
  "name": "fixture",             // optional; defaults to directory name
  "protocolVersion": 1,           // required integer; core supports {1}
  "commands": {                   // paths relative to the bundle dir; executables
    "list": "./list",
    "get": "./get",              // optional
    "update": "./update"         // optional; absent ⇒ read-only source, writeback no-ops
  },
  "secrets": ["LINEAR_API_KEY"], // env names resolved by core, never values
  "environment": { "SOME_KEY": "non-secret-value" },
  "network": ["api.linear.app"], // egress allowlist for the source sandbox
  "prerequisites": ["jq"]         // binaries doctor checks on PATH
}
```

Config may set per-source `sandbox: false` (loud in status/doctor). Unparseable manifest ⇒
skip + warn. Parseable but unsupported `protocolVersion` ⇒ explicit actionable error, never silent.
Config `sources[].environment` (non-secret) is merged over the manifest's `environment` and both are
set in the source process env, alongside resolved secrets (fixture bundles use this to receive
their task-store path; under the sandbox lane a writable store belongs in the source's scratch dir).
Core pre-creates `<stateRoot>/source-scratch/<sourceName>/` before any source invocation, grants it
read-write in the source sandbox, and passes it as `GROUNDCREW_SOURCE_SCRATCH` in the source env.

### 4.2 Invocation

Core spawns `<command>` with a single JSON object on **stdin** and expects a single JSON object on
**stdout** (result-shaped, one channel — design doc §12.1). stderr is diagnostics, logged only.
Nonzero exit or unparseable stdout is mapped by core to the same failure shape.

```text
success: { "ok": true, "data": … }
failure: { "ok": false, "error": { "message": "…" } }
```

| Command | stdin | data |
| --- | --- | --- |
| `list` | `{}` | `{ "tasks": [Task…] }` — the ready/queued view, including terminal flags for reaping |
| `get` | `{ "id": "TASK-1" }` | `{ "task": Task }` |
| `update` | `{ "id": "TASK-1", "event": Event }` | `{ "result": "ok" }`; for `claimed` may be `{ "result": "rejected", "reason"?: "…" }` |

### 4.3 Task shape (protocol)

```jsonc
{
  "id": "TASK-1",                // source-local id
  "title": "Do the thing",
  "description": "prose…",       // optional
  "priority": 2,                  // optional; higher number = dispatched first
  "blocked": false,               // optional; true ⇒ not eligible this poll
  "agent": "scripted",           // optional agent designation; falls back to source default, then config default
  "repos": ["alpha", "beta"],   // optional designation; absent ⇒ empty-workspace dispatch
  "terminal": false               // true ⇒ source considers the task done/canceled (cleaner input)
}
```

### 4.4 Events (writeback)

```jsonc
{ "type": "claimed", "runId": "r_…" }
{ "type": "progress", "note": "…" }                      // protocol-only in v2.0 (no CLI emitter)
{ "type": "completed", "outcome": "delivered",           // delivered | failed | stopped
  "artifacts": [{ "kind": "pr", "locator": "…", "title": "…", "repo": "…" }],
  "message": "…" }
```

## 5. Config — `crew.config.jsonc`

Zod-validated; published JSON Schema referenced via `$schema`. Principles (design doc §7.2):
omitted = detected / specified = exactly yours, never merged; no secret values structurally.

```jsonc
{
  "$schema": "…/schema.json",
  "workspace": {
    "baseDirectory": "~/dev",                    // the only required key in the file
    "worktreeDirectory": "~/scratch/worktrees",  // default: <baseDirectory>/.groundcrew/worktrees
    "repositories": {                             // per-repo overrides only
      "alpha": { "workingDirectory": "packages/api", "prepareWorktree": "npm ci" }
    }
  },
  "sources": [                                    // omitted → [{ "kind": "todo-txt" }]
    { "kind": "fixture", "name": "fixture", "agent": "scripted", "sandbox": true,
      "environment": { "NON_SECRET": "x" } }
  ],
  "agents": {                                     // omitted → presets for CLIs on PATH (claude > codex > cursor)
    "default": "scripted",
    "profiles": {
      "claude": {},                               // pure preset
      "scripted": { "command": "scripted-agent {{prompt}}",
                     "resume": "scripted-agent --resume {{sessionId}}",
                     "model": "m1", "effort": "high",
                     "environment": { "MY_AGENT_VAR": "value" } }  // injected into the agent session env at launch
    }
  },
  "orchestrator": { "maximumInProgress": 4, "pollIntervalMilliseconds": 120000,
                     "sessionLimitPercentage": 85 },
  "git": { "remote": "origin", "defaultBranch": "main", "branchPrefix": "crew" },
  "presenter": "tmux",                            // cmux | tmux | zellij; omitted → first found
  "sandbox": { "readOnlyDirectories": ["~/.config/tfenv"],
                "network": ["api.github.com"] },   // agent-session egress allowlist (sources declare theirs in manifests)
  "prompts": { "initial": "…" },                  // or { "promptFile": "…" }
  "logging": { "file": "~/.local/state/groundcrew/groundcrew.jsonl" }
}
```

v2 fails loudly (with a migration pointer) when it finds only a v1 config (`crew.config.ts` et al).

## 6. Log line schema (design doc §10.2)

JSON lines; every line carries `ts` (ISO-8601 UTC), `level` ∈ `debug|info|warn|error`, `module` ∈
the seven module names, `event` (snake_case, unique per call site). Correlation ids flat at top
level when known: `taskId`, `runId`, `sessionId`, `source`, `repo`. `msg` optional. The logging lib
exports the zod schema; the e2e suite validates every emitted line against the published shape.
Reserved reconcile GC event names (design doc §10.5 — one line per GC action): `reconcile_gc_worktree`,
`reconcile_gc_session`, `reconcile_gc_run_record`, `reconcile_gc_sandbox`.
Console: human-rendered `info`+ (`--verbose` ⇒ `debug`); raw JSON never on the console.

## 7. CLI exit codes and env

- Exit `0` success; `1` generic/doctor failure; `2` repo not cloned under `baseDirectory`
  (applies to `crew repo add` and to single-task `crew start <task>` whose designation bails);
  `3` no task context for an in-session command.
- **Eligibility**: a task is eligible when not blocked, not already claimed-and-live, a slot is
  free, and agent routing resolves (`task.agent` → `sources[].agent` → `agents.default`).
  `crew start <task> --force` bypasses blocked/slots/eligibility but never the repo-on-disk gate;
  agent resolution still applies (`--agent` overrides). An empty-string agent anywhere in config is
  a schema error, not "unrouted" — unrouted means the fields are absent, and yields skip verdict
  `ineligible`.
- Env kept: `GROUNDCREW_CONFIG`, `GROUNDCREW_VERBOSE`. Injected into agent sessions:
  `GROUNDCREW_WORKSPACE` (workspace dir), `GROUNDCREW_TASK_ID` (canonical id).
- **`GROUNDCREW_SANDBOX=off`** — process-level sandbox kill-switch: no srt wrapping of agent
  sessions or source processes. Exactly as loud as per-source `sandbox: false` (status and doctor
  surface it). Exists for test harnesses (the e2e core lane sets it per scenario; the sandbox lane
  does not) and unsupported hosts. Any other value (or unset) = sandboxing on, the default. The
  wrap decision is a single policy: env kill-switch → per-source `sandbox: false` → wrap.
- Presenter-internal (tmux adapter): `GROUNDCREW_TMUX_SOCKET` — when set, every tmux call uses
  `-L <socket>`. This is what keeps the e2e suite hermetic.

## 8. Presenter contract (in-core seam, design doc §8)

```ts
interface Presenter {
  open(spec: { name: string; displayName?: string; cwd: string; command: string;
               environment?: Record<string, string>; status?: string }): Promise<void>;
  probe(): Promise<{ available: boolean; sessions: Array<{ name: string; alive: boolean }> }>;
  close(name: string): Promise<void>;
  accessHint(name: string): Promise<string | undefined>;
  setStatus?(name: string, status: { text: string; color?: string; icon?: string }): Promise<void>; // capability by omission
}
```

`command` arrives fully composed (sandbox wrap included): presenter → sandbox → agent.
`probe()` with `available: false` is never treated as "no sessions".

## 9. Agent launch composition

1. Shell/dispatch resolves the agent profile → command string (placeholders `{{model}}`,
   `{{prompt}}`, `{{sessionId}}` substituted; presets map `model`/`effort` to real CLI flags).
2. Sandbox wraps: `wrap(command, policy) → command` (srt; `sandbox-exec` on macOS, bubblewrap on
   Linux). Policy: workspace read-write, `readOnlyDirectories`, network per config.
3. Presenter `open()` runs the wrapped command at the workspace root with the injected env.

Agent session environment = the orchestrator's own environment (PATH etc. inherited), overlaid with
the profile's `environment`, overlaid with the injected `GROUNDCREW_WORKSPACE`/`GROUNDCREW_TASK_ID`.
The sandbox confines filesystem/network, not env visibility.

The default initial prompt ends by instructing the agent to run `crew done` when finished.
