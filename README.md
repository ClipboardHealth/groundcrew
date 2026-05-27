<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./static/groundcrew-wordmark-dark.svg">
    <img alt="groundcrew" src="./static/groundcrew-wordmark-light.svg" height="96">
  </picture>
</p>

<p align="center">
  Dispatch your Linear backlog to AI coding agents. One git worktree per ticket, sandboxed by default.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@clipboard-health/groundcrew"><img alt="npm" src="https://img.shields.io/npm/v/@clipboard-health/groundcrew?style=flat-square&label=npm&color=77d94e&labelColor=18181b"></a>
  <a href="https://www.npmjs.com/package/@clipboard-health/groundcrew"><img alt="downloads" src="https://img.shields.io/npm/dw/@clipboard-health/groundcrew?style=flat-square&label=downloads&color=18181b&labelColor=18181b"></a>
  <a href="https://github.com/ClipboardHealth/groundcrew/actions/workflows/ci.yml"><img alt="ci" src="https://img.shields.io/github/actions/workflow/status/ClipboardHealth/groundcrew/ci.yml?style=flat-square&label=ci&color=77d94e&labelColor=18181b"></a>
  <a href="./LICENSE"><img alt="license" src="https://img.shields.io/npm/l/@clipboard-health/groundcrew?style=flat-square&label=license&color=18181b&labelColor=18181b"></a>
</p>

```text
$ crew status HRD-446
groundcrew status HRD-446
========================
ticket: hrd-446

Config snapshot
---------------
projectDir: /dev/workspaces
repositories: owner/repo
git: remote=origin; defaultBranch=main
workspaceKind: auto

Worktree state
--------------
- owner/repo host
  branch: rocky-hrd-446
  git: dirty (2 modified, 1 untracked)

Workspace probe
---------------
live: yes

Last Linear status
------------------
In Progress (state.type=started) — Add retry logic to the sync job
```

## Why

- **Linear-native.** Polls issues assigned to the API key's viewer with `agent-*` labels, honors blockers.
- **One worktree per ticket.** Agents work in parallel without stepping on each other.
- **Local-first sandboxing.** Safehouse on macOS, Docker Sandboxes on Linux, or an explicit `none` escape hatch.
- **Multi-agent.** Ships with `claude` and `codex`; bring your own CLI via `crew.config.ts`.

## Quickstart

```bash
# 1. Install Node ≥ 24, git, cmux or tmux, and the agent CLIs you'll use (claude, codex, ...).

# 2. Install groundcrew
npm install -g @clipboard-health/groundcrew

# 3. Scaffold a config and edit workspace.projectDir + workspace.knownRepositories
crew init && $EDITOR crew.config.ts

# 4. Clone the repos referenced in your config
PROJECT_DIR="$HOME/dev/c"
mkdir -p "$PROJECT_DIR/OWNER"
git clone git@github.com:OWNER/REPO.git "$PROJECT_DIR/OWNER/REPO"

# 5. Export your Linear API key
export GROUNDCREW_LINEAR_API_KEY="lin_api_..."

# 6. Verify setup, then dispatch
crew doctor
crew run --watch
```

In Linear, assign tickets to yourself and add an `agent-*` label (`agent-claude`, `agent-codex`, or `agent-any`). Groundcrew picks them up across every team and project your API key can see.

`crew init --global` writes the config into `${XDG_CONFIG_HOME:-$HOME/.config}/groundcrew/` instead of the cwd. Both forms refuse to overwrite — pass `--force` to replace, `--dry-run` to preview.

## Commands

```bash
crew init [--global | --local] [--force] [--dry-run]     # create a crew.config.ts
crew doctor                                              # check setup
crew status [<TICKET>]                                   # inspect current state or one ticket
crew run                                                 # one-shot orchestration
crew run --watch                                         # poll forever
crew start <TICKET>                                      # provision + launch one ticket now
crew stop <TICKET> [--reason <text>]                     # stop workspace, keep worktree
crew resume <TICKET>                                     # reopen a paused ticket
crew cleanup <TICKET>                                    # tear down every worktree for a ticket
crew upgrade [<version>]                                 # reinstall crew globally through npm
```

## Manual repository bootstrap

Groundcrew never clones repositories for you. Clone each `workspace.knownRepositories` entry into `workspace.projectDir` using the same relative path the config uses. For an `OWNER/REPO` entry:

```bash
PROJECT_DIR="$HOME/dev/c"
mkdir -p "$PROJECT_DIR/OWNER"
git clone git@github.com:OWNER/REPO.git "$PROJECT_DIR/OWNER/REPO"
# HTTPS works the same: git clone https://github.com/OWNER/REPO.git "$PROJECT_DIR/OWNER/REPO"
```

Bare-name entries have no owner, so pick the remote URL yourself and clone to `$PROJECT_DIR/<name>`.

## Configuration

Two keys are required; everything else has a default.

| Key                           | What                                                                   |
| ----------------------------- | ---------------------------------------------------------------------- |
| `workspace.projectDir`        | Parent dir for cloned repos and sibling ticket worktrees.              |
| `workspace.knownRepositories` | Repos searched for in ticket descriptions to infer where work belongs. |

The branch prefix (`<prefix>-<TICKET>`) is derived from `os.userInfo().username` and isn't configurable. There is no `linear` config block — groundcrew picks up every issue assigned to your API key's viewer that carries an `agent-*` label across every visible team and project, governed by a single `orchestrator.maximumInProgress` budget.

<details>
<summary>Agent label routing</summary>

- `agent-claude`, `agent-codex`, `agent-<name>` → that model.
- `agent-any` → the model with the most available session capacity.
- Unknown `agent-<name>` → falls back to `models.default` with a warning.
- No `agent-*` label → ignored by `crew run`. Dispatch on demand with `crew start <TICKET>` (also falls back to `models.default`).
- Todo tickets blocked by non-terminal blockers are skipped until their blockers reach a terminal status.

Status classification uses Linear's workflow `state.type` (`unstarted`, `started`, `completed`, `canceled`, `duplicate`), so renamed status columns work without configuration. Parent issues with children are ignored — sub-issues are the work items.

</details>

<details>
<summary>Config discovery</summary>

Resolution order: `GROUNDCREW_CONFIG` → cosmiconfig project-walk from cwd (any of `crew.config.{ts,mjs,js,json}`, `.crewrc{,.json,.ts}`, `.config/crew.config.{ts,json}`, `.config/crewrc{,.json}`) → `${XDG_CONFIG_HOME:-$HOME/.config}/groundcrew/crew.config.ts`. The "Loaded config from …" line at startup tells you which won.

</details>

<details>
<summary>Full configuration reference</summary>

| Key                                     | Default             | What it does                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sources`                               | `[]`                | Additional pluggable ticket sources, dispatched alongside the built-in Linear adapter. Built-in kinds: `shell`, `linear`.                                                                                                                                                                                                                                               |
| `git.remote`                            | `"origin"`          | Remote used for `fetch` and as the worktree base ref.                                                                                                                                                                                                                                                                                                                   |
| `git.defaultBranch`                     | `"main"`            | Branch fetched from `git.remote` and used as the worktree base.                                                                                                                                                                                                                                                                                                         |
| `workspace.projectDir`                  | **required**        | Parent dir for cloned repos and sibling ticket worktrees.                                                                                                                                                                                                                                                                                                               |
| `workspace.knownRepositories`           | **required**        | Repos searched for in ticket descriptions to infer where work belongs. A ticket labeled for groundcrew (`agent-*`) fails fast when no known repo appears; unlabeled tickets are ignored.                                                                                                                                                                                |
| `orchestrator.maximumInProgress`        | `4`                 | Cap on in-progress tickets at once for this `crew` instance.                                                                                                                                                                                                                                                                                                            |
| `orchestrator.pollIntervalMilliseconds` | `120_000`           | Poll interval in `--watch` mode.                                                                                                                                                                                                                                                                                                                                        |
| `orchestrator.sessionLimitPercentage`   | `85`                | Number in `(0, 100]`. A model whose codexbar session window exceeds this percentage is skipped that tick.                                                                                                                                                                                                                                                               |
| `models.default`                        | `"claude"`          | Tiebreak for `agent-any` resolution and fallback for explicit but unknown `agent-*` labels. Also used by `crew start <TICKET>` for unlabeled tickets. `crew run` ignores unlabeled tickets and does not apply this default. Must exist in `models.definitions`.                                                                                                         |
| `models.definitions`                    | `{ claude, codex }` | Agent definitions. Additive merge with shipped defaults.                                                                                                                                                                                                                                                                                                                |
| `models.definitions.<name>.cmd`         | —                   | Shell command launched for the model. Runs in the worktree through the resolved `local.runner`. `{{worktree}}` is replaced before launch; `{{sandbox}}` expands to the sbx sandbox name under the sdx runner and an empty string otherwise.                                                                                                                             |
| `models.definitions.<name>.color`       | —                   | Color for the workspace status pill (cmux only; tmux silently drops it).                                                                                                                                                                                                                                                                                                |
| `models.definitions.<name>.usage`       | optional            | If set, codexbar usage is fetched for this model and gated by `sessionLimitPercentage`. Falls back to default when unset, with gating enabled for known models. When `usage.codexbar.source` is omitted, groundcrew uses `oauth` for Codex/Claude on macOS, `auto` for other macOS providers, and `cli` elsewhere. Set to `{ disabled: true }` to disable usage gating. |
| `models.definitions.<name>.sandbox`     | optional            | Docker Sandboxes binding for the model. Required at launch when `local.runner` resolves to `sdx`. Fields: `agent` (required sbx agent name) and `setupCommand` (override for the inside-sandbox setup script). Groundcrew assumes the `groundcrew-<agent>` sandbox already exists.                                                                                      |
| `models.definitions.<name>.disabled`    | optional            | When set to exactly `true`, drops the named shipped default (`claude` or `codex`). Doctor skips probing it; `agent-<name>` labels fall back to `models.default` with a warning.                                                                                                                                                                                         |
| `prompts.initial`                       | unattended template | First message sent to the agent. Placeholders: `{{ticket}}`, `{{worktree}}`, `{{title}}`, `{{description}}`. Override this from `crew.config.ts` for team-specific statuses, tools, plugins, or review loops.                                                                                                                                                           |
| `workspaceKind`                         | `"auto"`            | Terminal session manager. `"auto"` picks `cmux` when on PATH, else `tmux`. Set to `"cmux"` or `"tmux"` to fail loudly when the chosen backend is missing.                                                                                                                                                                                                               |
| `local.runner`                          | `"auto"`            | Local isolation backend. `"auto"` → `safehouse` on macOS, `sdx` on Linux/WSL. Explicit: `"safehouse"`, `"sdx"`, `"none"`. `"none"` is never picked implicitly.                                                                                                                                                                                                          |
| `logging.file`                          | XDG state path      | Append-mode log file. `log()` / `logEvent()` tee here in addition to stdout. Defaults to `${XDG_STATE_HOME:-$HOME/.local/state}/groundcrew/groundcrew.log`.                                                                                                                                                                                                             |

</details>

## Runners

`local.runner` picks the local isolation backend. `auto` resolves per platform.

| Runner      | Default on  | Backend                                                                                                  |
| ----------- | ----------- | -------------------------------------------------------------------------------------------------------- |
| `safehouse` | macOS       | [Safehouse](https://agent-safehouse.dev/) — fastest local; cannot safely give the agent Docker.          |
| `sdx`       | Linux / WSL | [Docker Sandboxes](https://docs.docker.com/sandboxes/) (`sbx`) — required when the agent needs `docker`. |
| `none`      | —           | Unsandboxed escape hatch. Never picked implicitly; doctor warns when configured.                         |

<details>
<summary>Safehouse clearance allowlist</summary>

Only applies when `local.runner` resolves to `safehouse`. Groundcrew starts `clearance` on `http://127.0.0.1:19999` and runs the agent through the bundled `safehouse-clearance` wrapper. Clearance refuses to start without an allowlist — see [its README](https://github.com/ClipboardHealth/core-utils/tree/main/packages/clearance) for proxy env vars, log paths, and DNS rules. Shortest path:

```bash
CLEARANCE_ALLOW_HOSTS="api.openai.com,auth.openai.com,api.anthropic.com,mcp.linear.app,api.linear.app" \
crew run --watch
```

Groundcrew ships a starter file covering model APIs, Linear, Notion, Slack, Datadog, GitHub, npm, and common dev tooling at `$(npm root -g)/@clipboard-health/groundcrew/clearance-allow-hosts`. Point clearance at it (and optionally a personal file) via `CLEARANCE_ALLOW_HOSTS_FILES`:

```bash
CLEARANCE_ALLOW_HOSTS_FILES="$(npm root -g)/@clipboard-health/groundcrew/clearance-allow-hosts:$HOME/.config/clearance/personal-allow-hosts" \
crew run --watch
```

Watch `${XDG_CACHE_HOME:-$HOME/.cache}/clearance/clearance.log` for `DENY` lines and add only the domains your agents actually need.

`@clipboard-health/clearance` is pulled in transitively when you install groundcrew and provides the `clearance` / `clearance-ensure` bins used by Safehouse runs.

</details>

<details>
<summary>Docker Sandboxes (sdx) setup</summary>

Each model that runs under `sdx` needs a `sandbox: { agent: "<sbx-agent>" }` block in `crew.config.ts`. Groundcrew addresses the sandbox as `groundcrew-<agent>` (e.g. `groundcrew-claude`) and reuses one existing sandbox per agent across repos and tickets.

First-time setup is manual:

```bash
sbx create --name groundcrew-claude claude <projectDir>
sbx exec -it groundcrew-claude claude auth login
sbx exec -it groundcrew-claude gh auth login
```

Replace `claude` with the sbx agent for the model and `<projectDir>` with `workspace.projectDir` from `crew.config.ts`. Manage lifecycle and auth with `sbx` directly (`sbx ls`, `sbx exec`, `sbx rm`). Groundcrew does not create, authenticate, regenerate, list, or remove sandboxes.

</details>

## Inspecting status

`crew status <TICKET>` prints a read-only snapshot for one ticket: resolved config, matching worktrees, workspace probe result, recorded run state, recent log lines for that ticket, and the latest Linear status. It does not fetch, recover, tear down, resume, or mutate any local/remote state.

`crew status` with no ticket prints the current inventory: known worktrees with workspace/run-state presence plus live workspaces reported by the configured backend.

Use `crew cleanup <TICKET>` to tear down stale worktrees and `crew resume <TICKET>` to reopen preserved work. Status is intentionally informational only.

## Doctor

`crew doctor` checks host prerequisites only: config validity, Linear reachability, required binaries on PATH, workspace backend availability, workspace.projectDir, local runner capability, and enabled model commands.

<details>
<summary>Sample ticket status output</summary>

```text
groundcrew status HRD-442
=========================
ticket: hrd-442

Run state
---------
running; model=claude; updated=2026-05-26T00:01:00.000Z; resumes=0

Worktree
--------
- herds-social host
  branch: paul-hrd-442
  dir: /Users/paul/dev/groundcrew-workspaces/herds-social/herds-hrd-442
  git: dirty (0 modified, 1 untracked)

Workspace
---------
live: yes

Last Linear status
------------------
In Progress (state.type=started) — Multi-event extractor: year inference can produce date_start > date_end
```

</details>

### `crew start <TICKET>`

Launches one ticket immediately, bypassing orchestrator eligibility. Use it to dispatch a specific ticket on demand — including unlabeled tickets that `crew run` ignores.

```bash
crew start HRD-442
crew start HRD-442 --dry-run
```

### `crew stop <TICKET>`

Stops a live workspace pane while preserving the ticket worktree and branch. The manual pause button for cases where you need terminal capacity back, want to stop an agent that's going in the wrong direction, or need to inspect the diff before letting another agent continue.

```bash
crew stop HRD-442 --reason "wrong implementation direction"
crew status HRD-442
crew resume HRD-442
```

The command closes the cmux/tmux workspace if present, records local run state, and never tears down the worktree. If the workspace was already gone but the worktree is still present, stop records that fact so status can show the preserved branch.

### `crew resume <TICKET>`

Reopens an existing ticket worktree with a continuation prompt. Resume never creates a new worktree; if none exists it fails and leaves re-dispatch to `crew start <ticket>`.

The resume prompt tells the agent to inspect git status and diff before editing, includes the previous interrupt reason when recorded, and reuses the recorded model, repository, branch, runner, sandbox, and workspace backend. When no run-state file exists but a worktree does, resume falls back to Linear resolution for the model and ticket context.

## Secrets

Groundcrew forwards a small allowlist of build-time secrets from your shell into the setup phase (so `npm install` can authenticate against private registries) and strips them before the agent runs. The agent process never inherits these values.

Recognized names, defined in [`BUILD_SECRET_NAMES`](./src/lib/buildSecrets.ts):

- `NPM_TOKEN`
- `BUF_TOKEN`

Set them in the shell you run `crew` from. Anything not in this list is ignored.

<details>
<summary>How the secret shuttle works</summary>

For each ticket:

1. If any recognized var is set and non-empty, groundcrew writes `secrets.env` (mode `0600`) into the ticket's temp prompt dir as `KEY='value'` lines — see `stageBuildSecrets` in [`src/commands/setupWorkspace.ts`](./src/commands/setupWorkspace.ts).
2. The launch script sources `secrets.env` with `set -a` so the values are exported into the setup phase only (and under `sdx`, forwarded into the sandbox via `-e KEY` flags).
3. After setup completes, the script `unset`s every name in `BUILD_SECRET_NAMES` and then `rm -rf`s the entire prompt dir (including `secrets.env`) before `exec`'ing the agent. See `sourceSecretsLine` / `unsetSecretsLine` and the `rm -rf` / `exec` lines in [`src/lib/launchCommand.ts`](./src/lib/launchCommand.ts). The rollback path on setup failure ([`src/commands/setupWorkspace.ts`](./src/commands/setupWorkspace.ts)) wipes the prompt dir too.

Net effect: by the time the agent process exists, the values are gone from the environment and the file is gone from disk.

</details>

## Per-repo setup hook

If `.groundcrew/setup.sh` exists in the repo root, groundcrew runs `bash .groundcrew/setup.sh --deps-only` before each agent launch; otherwise nothing runs. Same convention applies inside the sdx sandbox (overridable per-model via `models.definitions.<name>.sandbox.setupCommand`). No implicit `npm install`, `uv sync`, or anything else — groundcrew is language-agnostic, so opt in by adding the script.

The `--deps-only` flag tells the script "you're being called by an automated system before an agent launches — skip anything interactive or one-time-only." The same script handles both modes; branch on `$1`:

- **With `--deps-only`**: do the cheap recurring work this worktree needs (lockfile install, generate types, etc.). No prompts, no global installs, no `nvm` / `pyenv` bootstrap.
- **Without the flag**: full interactive bootstrap. Use this when an engineer runs the script by hand for first-time onboarding, or when wiring it into another tool's SessionStart hook.

Setup failures are advisory — groundcrew logs the non-zero exit and still launches the agent so a flaky network or stale lockfile doesn't block the session.

<details>
<summary>Examples</summary>

**Python (uv):**

```bash
#!/usr/bin/env bash
set -euo pipefail
if [ "${1:-}" = "--deps-only" ]; then
  uv sync --dev
else
  uv sync --dev
  # ... extra one-time bootstrap (e.g., pre-commit install, db seed) ...
fi
```

**Node (npm):**

```bash
#!/usr/bin/env bash
set -euo pipefail
if [ "${1:-}" = "--deps-only" ]; then
  npm clean-install
else
  npm clean-install
  # ... extra one-time bootstrap (e.g., husky install, codegen, link local packages) ...
fi
```

**Docs-only or polyglot repo with no install step:** omit the script. With nothing at `.groundcrew/setup.sh`, groundcrew skips the hook silently.

For a comprehensive real-world example (nvm bootstrap, hash-based skip-on-no-changes caching, portable SHA-256 detection), see [this repo's own `.groundcrew/setup.sh`](./.groundcrew/setup.sh). It's also symlinked at `.claude/setup.sh` so the same script doubles as a Claude Code SessionStart hook for this repo — that symlink is local convenience, not part of groundcrew's contract.

To scaffold `.groundcrew/setup.sh` with a coding agent (Claude Code, Cursor, etc.), see [docs/setup-hook-agent-prompt.md](./docs/setup-hook-agent-prompt.md) — it encodes the contract above as a copy-pasteable prompt.

</details>

## Pluggable ticket sources

`sources` declares extra ticket-system adapters. They're verified at `crew run` startup and dispatched alongside the built-in Linear adapter, so a shell, Jira, or local-plan integration feeds the same orchestration loop as Linear.

The built-in `shell` adapter runs command templates and reads JSON from stdout:

```ts
export default {
  // ...
  sources: [
    {
      kind: "shell",
      name: "jira",
      commands: {
        verify: "jira me",
        fetch: "~/.config/groundcrew/jira-fetch.sh",
        resolveOne: "~/.config/groundcrew/jira-resolve.sh ${id}",
        markInProgress: "jira issue move ${id} 'In Progress'",
      },
      timeouts: { fetch: 60_000 },
    },
  ],
};
```

`commands.fetch` must print a JSON array of issues. `commands.resolveOne`, when set, must print one issue, print nothing for "not found", or exit `3` for "not found". `commands.markInProgress`, when set, receives the issue's `sourceRef` as JSON on stdin. `${id}`, `${canonicalId}`, and `${name}` placeholders are shell-quoted before substitution.

```json
[
  {
    "id": "JIRA-123",
    "title": "Add retry logic",
    "description": "Ticket body",
    "status": "todo",
    "repository": "your-org/your-repo",
    "model": "claude",
    "assignee": "Alice",
    "updatedAt": "2026-05-22T15:00:00Z",
    "blockers": [{ "id": "JIRA-122", "title": "Schema migration", "status": "done" }],
    "hasMoreBlockers": false,
    "sourceRef": { "nativeId": "10042" }
  }
]
```

Allowed `status` values are `todo`, `in-progress`, `in-review`, `done`, and `other`. Use `null` for `repository` or `model` when a ticket should not be groundcrew-eligible. `hasMoreBlockers` is optional and defaults to `false`; `sourceRef` is opaque data that groundcrew passes back to your writeback command.

## Prompt customization

Groundcrew ships one model-agnostic unattended prompt by default. It tells the agent to make reasonable assumptions, follow repository instructions, run documented verification, review its diff, open a PR when GitHub/`gh` is available, and include a workspace continuation hint when known.

For a personal workflow, keep the prompt next to your local config and load it with `readFileSync`:

```ts
import { readFileSync } from "node:fs";

export default {
  // ...
  prompts: {
    initial: readFileSync(new URL("./initial-prompt.md", import.meta.url), "utf8"),
  },
};
```

This keeps package defaults portable while letting your private config reference team-specific statuses, tools, plugins, or review loops.

## Disabling a shipped default model

Groundcrew ships `claude` and `codex` as default model definitions, additively merged into every resolved config. To stop probing one:

```ts
// crew.config.ts
export default {
  // …
  models: {
    default: "claude",
    definitions: {
      codex: { disabled: true },
    },
  },
};
```

Effects:

- `crew doctor` does not probe the disabled model's CLI. `crew doctor || exit 1` becomes viable as a CI gate when you only have one agent installed.
- `agent-any` only resolves to enabled models.
- An `agent-<disabled>` label on a ticket falls back to `models.default` with a warning in the log.

Rules:

- `disabled` only accepts shipped-default keys (`claude`, `codex`). A typo fails loudly at config load.
- `disabled` must be exactly the boolean `true`.
- It cannot be combined with `cmd`, `color`, or `usage` in the same entry.
- `models.default` must point at an enabled model.

## Using 1Password for the API key

`crew` reads `GROUNDCREW_LINEAR_API_KEY` first, then falls back to `LINEAR_API_KEY`. To resolve from 1Password:

```bash
echo "GROUNDCREW_LINEAR_API_KEY='op://<vault>/LINEAR_API_KEY/credential'" > .env.1password
op run --env-file .env.1password -- crew doctor
```

## Troubleshooting

First stop for "what exists locally right now": `crew status <ticket>` shows the ticket's worktrees, workspace presence, run state, logs, and latest Linear status. Use `crew doctor` when you need to verify host setup.

<details>
<summary>Safehouse-already-wrapped commands are not re-wrapped</summary>

If a `models.definitions.<name>.cmd` already starts with `safehouse`, groundcrew assumes that command owns its Safehouse flags and does not add the `safehouse-clearance` wrapper a second time. Changing the proxy's allowlist after it's running requires killing the PID in `${XDG_CACHE_HOME:-$HOME/.cache}/clearance/clearance.pid` so the next launch picks up the new env.

</details>

<details>
<summary>Dead tmux windows vanish by default</summary>

When a wrapped agent command fails (e.g. `safehouse-clearance` not found, `npm install` crash), the tmux window closes immediately and the error scrolls into the void. Set `GROUNDCREW_KEEP_DEAD_WINDOWS=1` in the env you launch `crew` from to flip the per-window `remain-on-exit` to `on`; the window stays open with the error visible. Close it manually with `tmux kill-window -t groundcrew:<ticket>` after diagnosis. tmux backend only.

</details>

<details>
<summary>Tickets stay in-progress until something else moves them</summary>

Groundcrew sets a ticket to `Started` (the first workflow state with `type === "started"` on that team) when it provisions a workspace and never advances it. The next transition (typically "In Review" when a PR opens) is left to your Linear automation rules.

</details>

<details>
<summary>Claude launches in auto mode by default</summary>

Groundcrew creates isolated per-ticket worktrees for unattended runs, so the shipped `claude` command is `claude --permission-mode auto` to let Claude proceed without stopping for clarifying questions while keeping its built-in safety prompts intact. Override `models.definitions.claude.cmd` for `bypassPermissions` if you need to suppress tool-permission prompts entirely, or for a stricter mode.

</details>

<details>
<summary>Doctor's command introspection is shallow</summary>

Doctor reports the resolved local runner (safehouse / sdx / none) and whether its prerequisites are met, then tokenizes model `cmd` and checks the first two non-flag tokens against PATH. Boolean flags without values, env-var assignments (`FOO=1`), shell pipelines, and subshells are not parsed — verify those manually. When `local.runner` is `"none"`, doctor surfaces a single WARNING line.

</details>

<details>
<summary>Doctor checks every enabled model</summary>

`models.definitions` includes both shipped defaults (`claude`, `codex`) by default via additive merge. If you only intend to label tickets `agent-claude` and don't have `codex` installed, set `models.definitions.codex: { disabled: true }`. Without that, doctor exits non-zero on a missing `codex` binary even though `crew run` would never route to it.

</details>

<details>
<summary>Switch to tmux if cmux is misbehaving</summary>

Set `workspaceKind: "tmux"` to force the tmux backend when cmux's CLI/socket bridge is flaky (symptoms: `cmux --json list-workspaces` returning `Failed to write to socket (Broken pipe)` or `Socket not found at ...cmux.sock` on every tick). tmux is more reliable — just a unix socket, no GUI app — at the cost of losing cmux's status pills, notifications, and sidebar.

</details>

<details>
<summary>Agent CLI must accept a positional prompt</summary>

The handoff is `<your cmd> "<prompt>"`. `claude`, `codex`, and `cursor-agent` all support this.

</details>

## Development

Clone the repo and the `crew` / `crew:op` scripts execute straight from TypeScript source — no build step needed.

```bash
cd ~/dev/c/groundcrew
node --run crew -- doctor

# With 1Password for GROUNDCREW_LINEAR_API_KEY:
node --run crew:op -- run --watch
```

Both forms discover config via cosmiconfig — project-walk from cwd for `crew.config.ts` and friends, then `${XDG_CONFIG_HOME:-$HOME/.config}/groundcrew/crew.config.ts`. Set `GROUNDCREW_CONFIG` to point elsewhere. The `crew:op` wrapper additionally reads `${XDG_CONFIG_HOME:-$HOME/.config}/groundcrew/op.env` (1Password env-file with `op://` references resolved at launch).

Logs land in `${XDG_STATE_HOME:-$HOME/.local/state}/groundcrew/groundcrew.log` by default (override via `logging.file`).

Source edits in `src/**` are picked up on the next invocation. Requires Node ≥ 24 (native `.ts` type stripping).

## License

[MIT](./LICENSE)
