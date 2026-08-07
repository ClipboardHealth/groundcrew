# Groundcrew implementation specification

Groundcrew is a personal TypeScript CLI that dispatches tasks from configured sources to local AI coding agents. Each task gets one workspace containing zero or more Git worktrees, one presented agent process, and one run record. Claude Code and Codex run in their native auto modes with the user's existing configuration and host permissions.

This document is the complete implementation contract. Build the `v2/` workspace from it without depending on v1 code or prior planning documents.

## 1. Product contract

- Target macOS, Node.js 24 or newer, Git, and cmux.
- Ship an ESM TypeScript package with the `crew` executable.
- Live in the groundcrew repository as a top-level `v2/` workspace beside v1, with its own `package.json`. Run the CLI from the built checkout (for example a shell alias to `v2/bin/run.js`); never publish it, so the globally installed v1 `crew` stays untouched.
- Run one local interactive agent per task. Ship cmux as the only presenter.
- Ship no pause or resume machinery. The presented workspace outlives the agent process; recovery is the harness's native resume command (for example `claude --resume`) run manually inside the workspace.
- Store configuration and runtime state in standard XDG directories.
- Keep task sources pluggable through a versioned process protocol. Ship Linear as the only source.
- Keep presenters pluggable through a TypeScript interface with serializable inputs and outputs. Ship the cmux adapter in core.
- Support Claude Code and Codex through named profiles. Groundcrew supplies the prompt, working directory, model, and effort; each CLI owns permissions and tool execution through its native auto mode.
- Treat the local machine as trusted. Child processes inherit the user's environment and permissions.
- Keep the CLI, state files, and module interfaces small enough to understand from this document and `crew --help`.

## 2. Domain model

Use four domain nouns consistently:

- **Task**: normalized work from a configured source.
- **Workspace**: the per-task directory containing the task marker and its Git worktrees. A workspace may contain no worktrees.
- **Run**: one claim and execution attempt for a task. A run owns the presenter workspace name, agent profile, state, events, and reported artifacts.
- **Artifact**: an output reported by the agent, such as a pull request, branch, document, file, or ticket.

Canonical task identity is `<sourceName>:<sourceLocalId>`. Derive a task slug by lowercasing the canonical identity, replacing each run of non-alphanumeric characters with `-`, and trimming leading or trailing `-`.

Use the slug consistently:

- branch: `<branchPrefix>/<taskSlug>`, where `branchPrefix` defaults to `crew`
- presented workspace: `crew-<taskSlug>`
- task workspace: `<workspacesRoot>/<taskSlug>`
- run record: `<stateRoot>/runs/<taskSlug>.json`

A run has this state machine:

```text
provisioning -> running -> complete
```

A complete run has one outcome: `delivered`, `failed`, or `stopped`. A task has at most one run record until cleanup removes it. Starting the task again after cleanup creates a new run ID.

## 3. Task sources

A task source is a directory bundle containing `source.json` and executable commands. Discover package bundles under `<packageRoot>/task-sources/<kind>/` and user bundles under `$XDG_CONFIG_HOME/groundcrew/task-sources/<kind>/`. A user bundle with the same kind replaces the package bundle.

Ship one package bundle: **Linear**. It reads issues assigned to the authenticated user, opted in with an `agent-<profile>` label, and outside backlog or triage. Only unstarted issues without open blockers or children are dispatchable. Completed, canceled, and duplicate issues are terminal.

`source.json` defines the process contract:

```jsonc
{
  "name": "linear",
  "protocolVersion": 1,
  "commands": {
    "list": "./list",
    "get": "./get",
    "update": "./update",
  },
  "secrets": ["LINEAR_API_KEY"],
  "environment": {},
  "prerequisites": [],
}
```

`name` defaults to the bundle directory name. `list` is required; `get` and `update` are optional capabilities. When `get` is absent, core resolves a task from the latest `list` result. `protocolVersion` is a required integer, and the initial implementation accepts only `1`. An invalid manifest is skipped with a warning. A valid manifest with an unsupported version is an actionable error in `doctor`, `start`, and `status`.

A configured source instance selects a bundle kind and may supply an instance name, a default agent profile, and non-secret environment values. Instance environment values replace manifest defaults with the same key. Source processes inherit the ambient environment; `secrets` declares the variables that `doctor` requires for that bundle.

Invoke each command from the bundle directory with one JSON object on stdin. Read one result object from stdout; treat stderr as diagnostics. A nonzero exit or invalid stdout becomes the same failure shape:

```text
success: { "ok": true, "data": ... }
failure: { "ok": false, "error": { "message": "..." } }
```

Command payloads:

| Command  | stdin                 | Successful `data`                                                    |
| -------- | --------------------- | -------------------------------------------------------------------- |
| `list`   | `{}`                  | `{ "tasks": SourceTask[] }`                                          |
| `get`    | `{ "id": "ENG-123" }` | `{ "task": SourceTask }`                                             |
| `update` | `{ "id", "event" }`   | `{ "result": "ok" }` or `{ "result": "rejected", "reason"?: "..." }` |

`SourceTask` has the `Task` fields below except `sourceName`; core adds that field from the configured source instance.

Normalize successful source output to this shape:

```typescript
interface Task {
  readonly sourceName: string;
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  /** Source-native rank; lower dispatches first (Linear: 1=Urgent … 4=Low). Omit for no priority. */
  readonly priority?: number;
  readonly blocked: boolean;
  readonly terminal: boolean;
  readonly agentProfile?: string;
  readonly repositories: readonly string[];
}
```

The source module hides discovery and process invocation behind three operations:

```typescript
interface SourceRegistry {
  list(): Promise<readonly Task[]>;
  get(input: { canonicalTaskId: string }): Promise<Task>;
  update(input: { canonicalTaskId: string; event: SourceEvent }): Promise<SourceUpdateResult>;
}
```

`SourceEvent` has two variants:

- `claimed`: includes the run ID; Linear may reject the claim when concurrent ownership changed.
- `completed`: includes the outcome, artifacts, and an optional message.

The Linear bundle comments on claims and completion, moves a claimed issue to the configured in-progress state, and moves a delivered issue to the configured review state. It emits Linear's native priority numbers and omits `priority` for `0` (no priority). A source without `update` is read-only; claim and completion writeback become successful no-ops. Expected source failures return typed results; unexpected failures retain native stack traces.

`crew doctor` lists every discovered source with its origin and protocol version, validates its manifest and prerequisites, resolves declared secrets from the inherited environment, and runs a live `list` probe. Adding a source requires only a conforming bundle and configuration entry; it does not require a core import.

## 4. Dispatch

`crew start` performs one dispatch tick. `crew start --watch` repeats the same tick every `pollIntervalMilliseconds` until interrupted.

Each tick:

1. Reconcile local run and presenter state.
2. Poll all configured sources.
3. Reap clean workspaces whose source task is terminal.
4. Sort eligible tasks by ascending priority value with missing priority last, then stable source order.
5. For each open slot, claim one task, create its provisioning run record, provision its workspace, and launch its agent through the presenter.
6. Persist a verdict for every task that was visible but not dispatched.

A task is eligible when it is not terminal, is unblocked, has no active or lingering run, resolves to an installed agent profile, and all designated repositories exist under `baseDirectory`.

`crew start <task>` resolves one task and dispatches it. Accept a canonical task ID, or a source-local ID when it matches exactly one configured source. Agent routing is `--agent`, task profile, source default profile, then `agents.default`. `--force` bypasses blocked status and the concurrency limit. It still requires agent routing, prevents a duplicate active run, and enforces designated repository presence.

Persist the latest skipped-task verdict in `<stateRoot>/dispatch.json` with a timestamp, reason, and detail. Reasons are `blocked`, `slots-full`, `claim-rejected`, `repo-not-on-disk`, `agent-unavailable`, and `run-exists`.

## 5. Workspaces and Git

Resolve a repository name to `<baseDirectory>/<repositoryName>` after stripping an optional `owner/` prefix from the task designation. The resolved directory must be a local Git checkout. This direct-child rule keeps repository identity deterministic.

For a task with designated repositories:

1. Resolve every repository before creating anything.
2. If any repository is missing, record `repo-not-on-disk` and leave the filesystem unchanged.
3. Run `git fetch --prune <remote> <defaultBranch>` in every repository. A failed fetch creates no worktrees.
4. Inspect an existing task branch before reuse. If another worktree has it checked out, or it contains any commit absent from the freshly fetched `<remote>/<defaultBranch>`, stop provisioning without resetting or rebasing it. Otherwise move it to the fetched tip.
5. Create sibling worktrees under the task workspace, with the uniform task branch at the freshly fetched `<remote>/<defaultBranch>` tip.
6. Run the configured prepare command from each new worktree.
7. Write the task marker only after provisioning succeeds.

A task without designated repositories starts in an empty workspace. The agent may add a repository later with `crew repo add <repo>`. That command fetches the configured remote default branch immediately before creating the worktree, applies the same safe branch-reuse rule, creates the worktree from the fetched tip, runs the prepare command, then updates the marker and run record atomically.

The task marker is `<taskWorkspace>/.groundcrew/task.json`:

```jsonc
{
  "version": 1,
  "canonicalTaskId": "linear:ENG-123",
  "branch": "crew/linear-eng-123",
  "repositories": ["groundcrew"],
}
```

Prepare command precedence is repository override, then workspace default. Run the configured string with `/bin/zsh -lc`, the new worktree as its working directory, and the agent's inherited environment. A prepare failure completes the run through the standard failed-completion path, records the failing repository and command, and preserves created worktrees for inspection.

Groundcrew never clones repositories. The running agent may clone or otherwise modify the host because it runs with the user's permissions.

## 6. Agent launch and presenter

The presenter decides where a local agent process runs and how the user reaches it. Its interface is serializable and contains no agent-specific behavior:

```typescript
interface Presenter {
  open(input: {
    readonly name: string;
    readonly displayName?: string;
    readonly workingDirectory: string;
    readonly command: readonly string[];
    readonly environment: Readonly<Record<string, string>>;
    readonly status?: string;
  }): Promise<void>;
  probe(): Promise<{
    readonly available: boolean;
    readonly workspaces: readonly PresentedWorkspace[];
  }>;
  close(input: { readonly name: string }): Promise<void>;
  accessHint(input: { readonly name: string }): Promise<string | undefined>;
  setStatus?(input: {
    readonly name: string;
    readonly text: string;
    readonly color?: string;
  }): Promise<void>;
}

interface PresentedWorkspace {
  readonly name: string;
  readonly description?: string;
}
```

Presenters report workspace existence, not process liveness: `probe()` cannot say whether an agent is still running inside an open workspace.

Presenter adapters are in-process TypeScript modules registered by name. The presenter module registers only the cmux adapter. Adding another presenter means implementing this interface, registering its name, and adding conformance tests.

The cmux adapter uses stable workspace references returned by `cmux --json list-workspaces`. Stamp the canonical task ID into the workspace description so reconciliation does not depend on the display name. `probe()` returns `available: false` when cmux cannot be reached; callers must not treat that result as an empty workspace list.

The cmux CLI covers the whole adapter surface: `new-workspace` accepts `--name`, `--description`, `--cwd`, and `--command`; `close-workspace` takes a workspace id; `set-progress --label` backs `setStatus`; `--json list-workspaces` returns each workspace's id, title, directory, and description.

The run module owns agent command composition and calls the configured presenter through this interface.

Launching a run:

1. Render the initial prompt from the normalized task and available in-session commands.
2. Resolve the selected built-in agent profile.
3. Compose the command using argument arrays, not an interpolated shell command.
4. Seed harness trust for the task workspace directory so the first-run trust prompt cannot stall an unattended launch.
5. Ask the presenter to create `crew-<taskSlug>` at the task workspace root.
6. Start the agent with `GROUNDCREW_WORKSPACE` and `GROUNDCREW_TASK_ID` in its environment.
7. Set the presenter status to `running` when supported and persist the run transition.

Neither CLI accepts an interactive-session flag that pre-accepts its folder-trust prompt, so seed the trust store directly with the usual temporary-sibling-and-rename write. For Claude, merge `hasTrustDialogAccepted: true` and `hasCompletedProjectOnboarding: true` into `projects["<workspaceDirectory>"]` in `~/.claude.json`. For Codex, set `trust_level = "trusted"` in the `[projects."<workspaceDirectory>"]` table of `$CODEX_HOME/config.toml` (default `~/.codex/config.toml`). Preserve every existing key and never remove entries.

Profile names are routing identifiers, independent of the harness kind. Multiple profiles may use the same harness with different models or effort. For example, `claude-fable` and `claude-opus` both use the Claude harness while selecting different models; a task labeled `agent-claude-opus` routes to the latter profile.

The Claude harness invokes `claude` with `--permission-mode auto`, `--model <model>`, and `--effort <effort>` (levels `low` through `max`). The Codex harness invokes `codex` with `--model <model>` and `-c model_reasoning_effort="<effort>"` — it has no dedicated effort flag — while preserving the user's Codex approval and execution configuration. Both harnesses start an interactive session with the rendered task prompt.

The default prompt must include:

- canonical task ID, title, and full description
- designated and currently acquired repositories
- the workspace path and branch name
- `crew repo add`, `crew artifact add`, and `crew done` usage
- an instruction to inspect repository instructions before changing code
- an instruction to report each durable output before completing

When reconciliation finds a running run whose presented workspace no longer exists, it completes the run as failed with reason `workspace-missing` and preserves the task workspace on disk. An agent process that exits inside a still-open workspace is invisible to Groundcrew: the run stays `running` and holds its slot until the user acts — relaunch the harness with its native resume command (for example `claude --resume`) from the workspace and finish with `crew done`, or run `crew cleanup`. In-session commands work in a manually resumed session because task resolution reads the task marker, not the launching process.

## 7. Completion and cleanup

`crew artifact add` appends an artifact to the active run:

```typescript
interface Artifact {
  readonly kind: string;
  readonly locator: string;
  readonly title?: string;
  readonly repository?: string;
}
```

`crew done` persists completion locally, frees the concurrency slot immediately, sets the presenter status when supported, and writes the source completion event. It defaults to `delivered`. If source writeback fails, set `writebackPending`, return an actionable error, and retry it as an idempotent operation during reconciliation.

Before delivered completion, inspect every worktree. Refuse completion when any worktree is dirty and list the dirty paths. `--allow-dirty` explicitly overrides the guard. Failed and stopped outcomes may preserve dirty work without an override.

Completed workspaces remain available for inspection. `crew cleanup` closes the presenter workspace and removes clean worktrees and local task state. It refuses dirty worktrees unless `--allow-dirty` is present. Cleaning a running task first completes it as `stopped` and writes that outcome to its source. Preserve the run record while source writeback is pending so reconciliation can retry it.

After removing a repository's worktree, delete the task branch when it holds no unique work: every branch commit is reachable from the remote default branch's remote-tracking ref, or the branch tip equals its own remote counterpart `<remote>/<branch>`. Otherwise preserve the branch and name it in the output; `--allow-dirty` deletes it regardless. Without this deletion a completed task could never start again, because provisioning refuses task branches that contain unique commits.

The dispatch reconciliation sweep performs the same cleanup automatically only when the source reports the task terminal and every worktree is clean. It never removes dirty work and never force-deletes a branch.

## 8. CLI surface

These are the complete commands:

| Command                                                                                                 | Behavior                                                                                          |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `crew start [task] [--watch] [--force] [--agent <profile>]`                                             | Poll and dispatch, or dispatch one task.                                                          |
| `crew status [task] [--json]`                                                                           | Show queued verdicts, active runs, completed runs, artifacts, Git observations, and log pointers. |
| `crew cleanup [task] [--all] [--allow-dirty]`                                                           | Close the presenter workspace and remove task state and clean worktrees.                          |
| `crew repo add <repo> [--task <task>]`                                                                  | Add a worktree to the current task.                                                               |
| `crew artifact add <locator> [--kind <kind>] [--title <title>] [--repo <repo>] [--task <task>]`         | Report one durable output.                                                                        |
| `crew done [--outcome <delivered\|failed\|stopped>] [--message <text>] [--allow-dirty] [--task <task>]` | Complete the current run.                                                                         |
| `crew init [--yes]`                                                                                     | Detect local prerequisites and write the initial config.                                          |
| `crew doctor`                                                                                           | Validate config, directories, Git, presenter, agents, and every discovered source.                |

In-session task resolution order is `--task`, then `GROUNDCREW_WORKSPACE`, then walking upward for `.groundcrew/task.json`.

Exit codes:

- `0`: success
- `1`: generic failure or failed health check
- `2`: designated repository is not present under `baseDirectory`
- `3`: an in-session command has no task context

Every command supports `--verbose`. Human output goes to stdout, actionable errors go to stderr, and `status --json` emits one stable JSON object without decorative text.

## 9. Configuration and paths

Use JSONC validated by Zod and publish a generated JSON Schema. Configuration precedence is `GROUNDCREW_CONFIG`, project-local `crew.config.jsonc`, then `$XDG_CONFIG_HOME/groundcrew/crew.config.jsonc`. A project-local file replaces the global file rather than merging with it.

Omitting `presenter` selects `cmux`. Source entries select discovered bundle kinds. Agent profile names are arbitrary routing identifiers; `kind` selects the built-in Claude or Codex harness, while `model` and `effort` select its capability.

Minimal configuration:

```jsonc
{
  "$schema": "file:///path/to/groundcrew/schema.json",
  "workspace": { "baseDirectory": "~/dev" },
  "sources": [{ "kind": "linear" }],
}
```

Full shape:

```jsonc
{
  "workspace": {
    "baseDirectory": "~/dev",
    "worktreeDirectory": "~/dev/.groundcrew/worktrees",
    "prepareWorktree": "node --run setup",
    "repositories": {
      "groundcrew": { "prepareWorktree": "npm ci" },
    },
  },
  "sources": [
    {
      "kind": "linear",
      "name": "linear",
      "agentProfile": "claude-fable",
      "environment": {
        "LINEAR_GROUNDCREW_LABEL_PREFIX": "agent-",
        "LINEAR_STATUS_IN_PROGRESS": "In Progress",
        "LINEAR_STATUS_IN_REVIEW": "In Review",
      },
    },
  ],
  "agents": {
    "default": "claude-fable",
    "profiles": {
      "claude-fable": { "kind": "claude", "model": "fable", "effort": "high" },
      "claude-opus": { "kind": "claude", "model": "opus", "effort": "high" },
      "codex": { "kind": "codex", "effort": "high" },
    },
  },
  "orchestrator": {
    "maximumInProgress": 4,
    "pollIntervalMilliseconds": 120000,
  },
  "git": { "remote": "origin", "defaultBranch": "main", "branchPrefix": "crew" },
  "presenter": "cmux",
  "logging": { "file": "~/.local/state/groundcrew/groundcrew.jsonl" },
}
```

`crew init` writes `$schema` as an absolute file URL to the schema in the checkout. Manifests declare secret environment-variable names; configuration never stores secret values. Child processes inherit the ambient environment. `crew doctor` names missing variables without printing their values.

Paths:

| Data                | Path                                                             |
| ------------------- | ---------------------------------------------------------------- |
| Global config       | `$XDG_CONFIG_HOME/groundcrew/crew.config.jsonc`                  |
| User source bundles | `$XDG_CONFIG_HOME/groundcrew/task-sources/<kind>/`               |
| State root          | `$XDG_STATE_HOME/groundcrew/`                                    |
| Run records         | `<stateRoot>/runs/<taskSlug>.json`                               |
| Dispatch verdicts   | `<stateRoot>/dispatch.json`                                      |
| Structured log      | `<stateRoot>/groundcrew.jsonl`                                   |
| Workspaces          | configured path, default `<baseDirectory>/.groundcrew/worktrees` |

Fall back to `~/.config` and `~/.local/state` when the XDG variables are unset. Expand `~` before validation. Write all state files atomically with a temporary sibling and rename. In-session commands and the watch loop are separate processes whose read-modify-write cycles on the same run record can lose artifacts or state transitions, so guard every run-record mutation with a per-task lock: atomically create `<stateRoot>/runs/<taskSlug>.lock` with `mkdir`, retry with short backoff, and steal locks older than 30 seconds.

## 10. Run records, status, and logs

The run record is the source of truth for Groundcrew-owned state. Git supplies observed workspace facts. Task sources supply queue and terminal facts. Logs are diagnostics.

```jsonc
{
  "version": 1,
  "canonicalTaskId": "linear:ENG-123",
  "runId": "r_8f3a9c21",
  "agentProfile": "claude-opus",
  "state": "complete",
  "outcome": "delivered",
  "writebackPending": false,
  "presenter": "cmux",
  "presentedWorkspaceName": "crew-linear-eng-123",
  "workspaceDirectory": "/Users/me/dev/.groundcrew/worktrees/linear-eng-123",
  "repositories": ["groundcrew"],
  "artifacts": [
    {
      "kind": "pr",
      "locator": "https://github.com/example/repo/pull/1",
      "repository": "groundcrew",
    },
  ],
  "events": [
    { "timestamp": "2026-08-06T12:00:00.000Z", "event": "claimed" },
    { "timestamp": "2026-08-06T12:00:01.000Z", "event": "running" },
    { "timestamp": "2026-08-06T12:15:00.000Z", "event": "completed" },
  ],
}
```

Omit `outcome`, `reason`, and `writebackPending` when they do not apply. Keep event history append-only. Generate run IDs as `r_` plus eight lowercase hexadecimal characters.

`crew status` must answer:

1. Why a visible task did not start, using the persisted dispatch verdict.
2. What an active agent is doing at the run-state level and how to reach its presented workspace.
3. What Git changes exist in each worktree, clearly labeled as observed facts.
4. What artifacts and outcome the agent reported.
5. What cleanup would remove or why cleanup would refuse.

Append one JSON object per line to the log. Every line contains `timestamp`, `level`, `module`, and `event`; add `canonicalTaskId`, `runId`, `sourceName`, and `repository` when known. Log levels are `debug`, `info`, `warn`, and `error`. Console output is human-readable at `info` and above; `--verbose` includes debug. Rotate at 10 MB and retain three files.

Reconciliation runs at startup and before every dispatch tick. It compares run records with presenter and Git state, repairs safe derived state, fails running runs whose presented workspace disappeared, and reports ambiguous or dirty state without destroying it.

## 11. Architecture

Use six modules with one importable interface each:

| Module      | Responsibility                                                                                              |
| ----------- | ----------------------------------------------------------------------------------------------------------- |
| `shell`     | Commander wiring, config loading, rendering, and exit-code mapping.                                         |
| `core`      | The application interface for every CLI operation, dispatch policy, reconciliation, and status read models. |
| `source`    | Bundle discovery and versioned `list`, `get`, and `update` process invocation.                              |
| `workspace` | Repository resolution, worktree lifecycle, task markers, and observed Git facts.                            |
| `run`       | Run persistence, artifact and completion intake, and agent command composition.                             |
| `presenter` | The presenter interface, adapter registry, and cmux implementation.                                         |

Dependency graph:

```text
shell -> core
core -> source, workspace, run
run -> presenter
source -> source processes and filesystem
workspace -> Git and filesystem
presenter -> cmux
```

Each module exports only through `src/<module>/index.ts`. Tests inject a fixture source bundle and fake presenter through the same interfaces used in production. The shell tests and black-box suite use the same core interface as production.

Layout, as a top-level workspace beside the untouched v1 tree:

```text
v2/
  AGENTS.md
  CONTEXT.md
  package.json
  schema.json
  src/
    shell/
    core/
    source/
    workspace/
    run/
    presenter/
  task-sources/
    linear/
  e2e/
```

Nothing under `v2/` imports from the v1 tree and nothing in v1 imports from `v2/`.

Use plain TypeScript, Zod 4, Commander with `@commander-js/extra-typings`, and execa. Use native promises, `AbortSignal`, and a small concurrency limiter. Expected domain errors use a discriminated result type; unexpected errors throw typed errors with native stack traces.

Enforce the dependency graph, the `index.ts` entry points, and the v1/v2 tree separation in CI. Keep `e2e` black-box: it may spawn the built `crew` executable but may not import `src`.

## 12. Verification and implementation order

Build red-first. The black-box suite uses temporary XDG directories, local Git repositories, a fixture source bundle, a fake presenter, an in-memory HTTP server for Linear, and scripted fake agents.

Cover these behaviors before considering the implementation complete:

1. `init` writes valid minimal configuration and `doctor` reports each missing prerequisite precisely.
2. A ready task is claimed, provisioned, launched once through cmux, and recorded atomically.
3. Missing designated repositories create no partial workspace and appear in `status`.
4. Provisioning and `repo add` fetch the remote default branch immediately before creating each worktree, start from the fetched tip, safely update branches without unique commits, and reject branches containing unique work.
5. A task with no repository launches successfully and can acquire multiple worktrees at runtime.
6. Priority, blocking, profile routing, claim rejection, and concurrency limits select the correct tasks, including two profiles that use the same harness with different models.
7. Claude and Codex command composition passes prompt, model, effort, working directory, and inherited environment correctly, and launch seeds workspace trust in each harness's store without disturbing existing entries.
8. Source discovery, override precedence, protocol-version errors, read-only capability omission, and `doctor` probes work through fixture bundles.
9. Presenter conformance tests exercise cmux and the fake through the same interface.
10. Artifacts are append-only and completion writes the exact outcome and artifacts back to the source.
11. Dirty-worktree guards protect delivered completion and cleanup, and cleanup deletes the task branch only when it holds no unique work — so a cleaned task can be started again.
12. Workspace disappearance, prepare failure, source failure, presenter unavailability, and interrupted state writes preserve diagnosable state.
13. Startup reconciliation repairs safe state, fails runs whose presented workspace disappeared, and leaves ambiguous or dirty state intact.
14. `status` separates observed Git facts from agent-reported artifacts and explains every skipped task.
15. Terminal source tasks reap only clean workspaces.

Implementation order:

1. Scaffold the `v2/` workspace, exclude it from v1's release automation, and set up dependency rules, schemas, and the black-box harness.
2. Implement task identity, configuration, state paths, and atomic persistence.
3. Implement the source protocol, Linear bundle, and workspace module until their acceptance paths pass.
4. Implement the presenter and run modules with a fake presenter and scripted agents.
5. Implement core dispatch, reconciliation, completion, cleanup, and status.
6. Wire the shell and make the complete black-box suite green.
7. Run live smoke tests with cmux, Claude Code, Codex, Linear, and one local repository.

The implementation is complete when the black-box suite passes from a clean checkout and the live smoke test completes a real task through `crew done` without manual state repair.
