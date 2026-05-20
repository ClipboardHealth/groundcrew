<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./static/groundcrew-wordmark-dark.svg">
    <img alt="groundcrew" src="./static/groundcrew-wordmark-light.svg" height="96">
  </picture>
</p>

<p align="center">
  Dispatch your Linear backlog to AI coding agents — one git worktree per ticket, sandboxed by default.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@clipboard-health/groundcrew"><img alt="npm" src="https://img.shields.io/npm/v/@clipboard-health/groundcrew?style=flat-square&label=npm&color=77d94e&labelColor=18181b"></a>
  <a href="https://www.npmjs.com/package/@clipboard-health/groundcrew"><img alt="downloads" src="https://img.shields.io/npm/dw/@clipboard-health/groundcrew?style=flat-square&label=downloads&color=18181b&labelColor=18181b"></a>
  <a href="https://github.com/ClipboardHealth/groundcrew/actions/workflows/ci.yml"><img alt="ci" src="https://img.shields.io/github/actions/workflow/status/ClipboardHealth/groundcrew/ci.yml?style=flat-square&label=ci&color=77d94e&labelColor=18181b"></a>
  <a href="./LICENSE"><img alt="license" src="https://img.shields.io/npm/l/@clipboard-health/groundcrew?style=flat-square&label=license&color=18181b&labelColor=18181b"></a>
</p>

```text
$ crew doctor --ticket HRD-446
groundcrew doctor --ticket HRD-446 (Add retry logic to the sync job)
────────────────────────────────────────────────────────────────────

Resolution
  [ok] Ticket exists in Linear ("Add retry logic to the sync job")
  [ok] Status is Todo
  [ok] Has agent-* label (agent-claude)
  [ok] Model resolves from agent-* label (model "claude")
  [ok] Description mentions known repo (owner/repo)
  [ok] Resolved repo is cloned locally (/dev/workspaces/owner/repo)

Eligibility
  [ok] No active blockers
  [ok] Model "claude" usage under sessionLimitPercentage (12% (limit 85%))
  [ok] In-progress cap not hit (2/4 used)

→ would be dispatched on next tick
```

## Why

- **Linear-native.** Polls a project, respects `agent-*` labels, honors blockers.
- **One worktree per ticket.** Agents work in parallel without stepping on each other.
- **Local-first sandboxing.** Safehouse on macOS, Docker Sandboxes on Linux, or an explicit `none` escape hatch.
- **Multi-agent.** Ships with `claude` and `codex`; bring your own CLI by dropping a definition into `config.ts`.

## Install

```bash
npm install -g @clipboard-health/groundcrew
```

Installs the `crew` binary. `@clipboard-health/clearance` is pulled in transitively and provides the `clearance` / `clearance-ensure` bins used by Safehouse runs.

## Quickstart

1. **Install prereqs.** Node 24, `git`, `cmux` _or_ `tmux`, and the agent CLIs themselves (`claude`, `codex`, `cursor-agent`, …). Optional: `codexbar` for session-usage gating.

2. **Pick an isolation runner.** See [Runners](#runners) — `auto` resolves to `safehouse` on macOS and `sdx` on Linux/WSL.

3. **Create a Linear project to scope your work.** Any team works — make a project inside it and drop tickets in. The orchestrator polls by project, not by team.

4. **Configure.** Copy the shipped example into XDG config and edit:

   ```bash
   mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/groundcrew"
   cp "$(npm root -g)/@clipboard-health/groundcrew/configExample.ts" \
      "${XDG_CONFIG_HOME:-$HOME/.config}/groundcrew/config.ts"
   $EDITOR "${XDG_CONFIG_HOME:-$HOME/.config}/groundcrew/config.ts"
   ```

   Set `linear.projectSlug` (paste the trailing slug of your Linear project URL, e.g. `ai-strategy-5152195762f3`), `workspace.projectDir`, and `workspace.knownRepositories`. Defaults cover everything else.

   Then clone each repo before the first `crew run` — groundcrew creates per-ticket worktrees from these clones, it does not auto-clone:

   ```bash
   crew setup repos              # clone all missing entries via gh
   crew setup repos --dry-run    # preview
   crew setup repos owner/repo   # restrict to one entry
   ```

   `crew setup repos` is idempotent; already-cloned repos report `[exists]`. Bare-name entries (no `owner/`) are skipped — clone them manually into `<projectDir>/<name>`.

5. **Export a Linear API key.** `crew` reads `GROUNDCREW_LINEAR_API_KEY` first, then falls back to `LINEAR_API_KEY`.

   ```bash
   export GROUNDCREW_LINEAR_API_KEY="lin_api_..."
   ```

   <details>
   <summary>Using 1Password (<code>op</code>) for the key</summary>

   ```bash
   echo "GROUNDCREW_LINEAR_API_KEY='op://<vault>/LINEAR_API_KEY/credential'" > .env.1password
   op run --env-file .env.1password -- crew doctor
   ```

   </details>

6. **Run.**

   ```bash
   crew doctor                    # check setup
   crew run --dry-run             # preview without provisioning
   crew run --watch               # poll forever
   ```

## Runners

`local.runner` picks the local isolation backend. `auto` resolves per platform.

| Runner      | Default on  | Backend                                                                                                  |
| ----------- | ----------- | -------------------------------------------------------------------------------------------------------- |
| `safehouse` | macOS       | [Safehouse](https://agent-safehouse.dev/) — fastest local; cannot safely give the agent Docker.          |
| `sdx`       | Linux / WSL | [Docker Sandboxes](https://docs.docker.com/sandboxes/) (`sbx`) — required when the agent needs `docker`. |
| `none`      | —           | Unsandboxed escape hatch. Never picked implicitly; doctor warns when configured.                         |

For `sdx`: each model that runs under it needs a `sandbox: { agent: "<sbx-agent>" }` block in `config.ts`. Groundcrew names sandboxes `groundcrew-<agent>` (e.g. `groundcrew-claude`) and reuses one sandbox per agent across repos and tickets. First-time agent auth happens inside the sandbox the first time it launches. To bootstrap manually instead, run `sbx create --name groundcrew-<agent> <agent> <projectDir>` once.

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

</details>

## Configuration

Three keys are required; everything else has a default.

| Key                           | What                                                                       |
| ----------------------------- | -------------------------------------------------------------------------- |
| `linear.projectSlug`          | Trailing slug of the Linear project URL (e.g. `ai-strategy-5152195762f3`). |
| `workspace.projectDir`        | Parent dir for cloned repos and sibling ticket worktrees.                  |
| `workspace.knownRepositories` | Repos searched for in ticket descriptions to infer where work belongs.     |

`crew` resolves config as: `GROUNDCREW_CONFIG` if set → `${XDG_CONFIG_HOME:-$HOME/.config}/groundcrew/config.ts` if it exists → a `config.ts` next to `crew`'s own source (only useful from a local checkout). The branch prefix (`<prefix>-<TICKET>`) is derived from `os.userInfo().username` — not configurable.

Agent selection uses Linear labels: `agent-claude`, `agent-codex`, `agent-<name>`. `crew run` without `--ticket` only fetches tickets carrying an `agent-*` label — the GraphQL query filters server-side, so unlabeled tickets are never returned by Linear and do not appear on the board. Use `crew run --ticket <TICKET>` to provision an unlabeled ticket on demand (falls back to `models.default`). `agent-any` routes to the model with the most available session capacity. Todo tickets blocked by non-terminal blockers are skipped until their blockers reach a terminal status.

<details>
<summary>Full reference table</summary>

| Key                                     | Default             | What it does                                                                                                                                                                                                                                                                              |
| --------------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `linear.projectSlug`                    | **required**        | Linear project URL slug (e.g. `ai-strategy-5152195762f3`). The trailing 12-char hex `slugId` is what's matched against Linear's API; the leading name keeps `config.ts` self-documenting and the lookup survives project renames.                                                         |
| `linear.statuses.todo`                  | `"Todo"`            | Status name picked up for new work.                                                                                                                                                                                                                                                       |
| `linear.statuses.inProgress`            | `"In Progress"`     | Status set after a workspace is provisioned; counts toward `maximumInProgress`.                                                                                                                                                                                                           |
| `linear.statuses.done`                  | `"Done"`            | Status that triggers worktree cleanup.                                                                                                                                                                                                                                                    |
| `linear.statuses.terminal`              | `["Done"]`          | Additional status names treated as terminal for cleanup, board remaining counts, and blocker checks. The `done` status is always included.                                                                                                                                                |
| `git.remote`                            | `"origin"`          | Remote used for `fetch` and as the worktree base ref.                                                                                                                                                                                                                                     |
| `git.defaultBranch`                     | `"main"`            | Branch fetched from `git.remote` and used as the worktree base.                                                                                                                                                                                                                           |
| `workspace.projectDir`                  | **required**        | Parent dir for cloned repos and sibling ticket worktrees.                                                                                                                                                                                                                                 |
| `workspace.knownRepositories`           | **required**        | Repos searched for in ticket descriptions to infer where work belongs. A ticket labeled for groundcrew (`agent-*`) fails fast when no known repo appears; unlabeled tickets are ignored.                                                                                                  |
| `orchestrator.maximumInProgress`        | `4`                 | Cap on tickets in `linear.statuses.inProgress` at once.                                                                                                                                                                                                                                   |
| `orchestrator.pollIntervalMilliseconds` | `120_000`           | Poll interval in `--watch` mode.                                                                                                                                                                                                                                                          |
| `orchestrator.sessionLimitPercentage`   | `85`                | Number in `(0, 100]`. A model whose codexbar session window exceeds this percentage is skipped that tick.                                                                                                                                                                                 |
| `models.default`                        | `"claude"`          | Tiebreak for `agent-any` resolution and fallback for explicit but unknown `agent-*` labels. Also used by `crew run --ticket <TICKET>` for unlabeled tickets. `crew run` without `--ticket` ignores unlabeled tickets and does not apply this default. Must exist in `models.definitions`. |
| `models.definitions`                    | `{ claude, codex }` | Agent definitions. Additive merge with shipped defaults.                                                                                                                                                                                                                                  |
| `models.definitions.<name>.cmd`         | —                   | Shell command launched for the model. Runs in the worktree through the resolved `local.runner`. `{{worktree}}` is replaced before launch; `{{sandbox}}` expands to the sbx sandbox name under the sdx runner and an empty string otherwise.                                               |
| `models.definitions.<name>.color`       | —                   | Color for the workspace status pill (cmux only; tmux silently drops it).                                                                                                                                                                                                                  |
| `models.definitions.<name>.usage`       | optional            | If set, codexbar usage is fetched for this model and gated by `sessionLimitPercentage`. Omit to never gate. When `usage.codexbar.source` is omitted, groundcrew uses `auto` on macOS and `cli` elsewhere.                                                                                 |
| `models.definitions.<name>.sandbox`     | optional            | Docker Sandboxes binding for the model. Required at launch when `local.runner` resolves to `sdx`. Fields: `agent` (required sbx agent name), `template`, `kits`, `setupCommand` (override for the inside-sandbox setup script).                                                           |
| `models.definitions.<name>.disabled`    | optional            | When set to exactly `true`, drops the named shipped default (`claude` or `codex`). Doctor skips probing it; `agent-<name>` labels fall back to `models.default` with a warning.                                                                                                           |
| `prompts.initial`                       | (template)          | First message sent to the agent. Placeholders: `{{ticket}}`, `{{worktree}}`, `{{title}}`, `{{description}}`.                                                                                                                                                                              |
| `workspaceKind`                         | `"auto"`            | Terminal session manager. `"auto"` picks `cmux` when on PATH, else `tmux`. Set to `"cmux"` or `"tmux"` to fail loudly when the chosen backend is missing.                                                                                                                                 |
| `local.runner`                          | `"auto"`            | Local isolation backend. `"auto"` → `safehouse` on macOS, `sdx` on Linux/WSL. Explicit: `"safehouse"`, `"sdx"`, `"none"`. `"none"` is never picked implicitly.                                                                                                                            |
| `logging.file`                          | XDG state path      | Append-mode log file. `log()` / `logEvent()` tee here in addition to stdout. Defaults to `${XDG_STATE_HOME:-$HOME/.local/state}/groundcrew/groundcrew.log`.                                                                                                                               |

</details>

<details>
<summary>Disabling a shipped default</summary>

Groundcrew ships `claude` and `codex` as default model definitions, additively merged into every resolved config. To stop probing one:

```ts
// config.ts
export const config = {
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

</details>

## Commands

```bash
crew doctor                        # full setup check
crew doctor --ticket <TICKET>      # diagnose one ticket
crew run                           # one-shot dispatch
crew run --watch                   # poll forever
crew run --ticket <TICKET>         # provision one ticket and exit
crew setup repos [--dry-run] [<repo>...]
crew cleanup <TICKET>              # tear down every worktree carrying this ticket
```

`--watch` and `--ticket` are mutually exclusive. To inspect codexbar session windows directly, run `codexbar usage`.

### `crew doctor --ticket <ticket>`

Diagnose why a ticket would or wouldn't be dispatched on the next tick. Runs the same resolution and eligibility chain as the dispatcher. Exits 0 if the ticket would dispatch, 1 otherwise. The hero above shows a passing run; here's a failing one:

```text
groundcrew doctor --ticket HRD-447 (Refactor auth middleware)
─────────────────────────────────────────────────────────────

Resolution
  [ok] Ticket exists in Linear ("Refactor auth middleware")
  [--] Status is Todo (current: In Progress)
  [ok] Has agent-* label (agent-claude)
  [ok] Model resolves from agent-* label (model "claude")
  [ok] Description mentions known repo (owner/repo)
  [ok] Resolved repo is cloned locally (/dev/workspaces/owner/repo)

Eligibility
  (skipped — resolution checks failed)

→ ineligible: status is In Progress (need Todo)
```

## Troubleshooting

First stop for "labeled but not on the board": `crew doctor --ticket <ticket>` lists every check the dispatcher runs and flags the failing one.

<details>
<summary>Local execution picks one of safehouse / sdx / none</summary>

`local.runner: "auto"` resolves to `safehouse` on macOS and `sdx` (Docker Sandboxes) on Linux/WSL. Override with `local.runner: "safehouse" | "sdx" | "none"`. There is no per-model `isolation` knob — the runner is global. `sdx` requires a per-model `sandbox: { agent }` block so groundcrew can map the model to an sbx agent.

</details>

<details>
<summary>Safehouse-already-wrapped commands are not re-wrapped</summary>

If a `models.definitions.<name>.cmd` already starts with `safehouse`, groundcrew assumes that command owns its Safehouse flags and does not add the `safehouse-clearance` wrapper a second time. Changing the proxy's allowlist after it's running requires killing the PID in `${XDG_CACHE_HOME:-$HOME/.cache}/clearance/clearance.pid` so the next launch picks up the new env.

</details>

<details>
<summary>Sandbox lifecycle is create-only</summary>

Groundcrew auto-creates the sandbox for an sbx agent (`groundcrew-<agent>`) when missing, but never deletes one — sandboxes persist across tickets and across `crew cleanup`. Auth state lives inside the sandbox, so deleting it forces a re-login. Inspect or remove them manually with `sbx ls` / `sbx rm`.

</details>

<details>
<summary>Dead tmux windows vanish by default</summary>

When a wrapped agent command fails (e.g. `safehouse-clearance` not found, `npm install` crash), the tmux window closes immediately and the error scrolls into the void. Set `GROUNDCREW_KEEP_DEAD_WINDOWS=1` in the env you launch `crew` from to flip the per-window `remain-on-exit` to `on`; the window stays open with the error visible. Close it manually with `tmux kill-window -t groundcrew:<ticket>` after diagnosis. tmux backend only.

</details>

<details>
<summary>Status names matter</summary>

If your team uses `Started` instead of `In Progress`, set `linear.statuses.inProgress = "Started"`.

</details>

<details>
<summary>Leaf-only</summary>

Parent issues with children are ignored — sub-issues are the work items.

</details>

<details>
<summary>Tickets stay in-progress until something else moves them</summary>

Groundcrew sets a ticket to `inProgress` when it provisions a workspace and never advances it. The next transition (typically "in review" when a PR opens) is left to your Linear automation rules.

</details>

<details>
<summary>Project must be on a single Linear team in practice</summary>

Cross-team projects work — the orchestrator caches the in-progress state ID per team — but every team in the project must use the same status name for `linear.statuses.inProgress`.

</details>

<details>
<summary>Claude launches in bypass-permissions mode by default</summary>

Groundcrew creates isolated per-ticket worktrees for unattended runs, so the shipped `claude` command is `claude --permission-mode bypassPermissions` to avoid workspace-trust and tool-permission prompts blocking automation. Override `models.definitions.claude.cmd` for a stricter mode.

</details>

<details>
<summary>Doctor's command introspection is shallow</summary>

Doctor reports the resolved local runner (safehouse / sdx / none) and whether its prerequisites are met, then tokenizes model `cmd` and checks the first two non-flag tokens against PATH. Boolean flags without values, env-var assignments (`FOO=1`), shell pipelines, and subshells are not parsed — verify those manually. When `local.runner` is `"none"`, doctor surfaces a single WARNING line.

</details>

<details>
<summary>Doctor checks every enabled model</summary>

`models.definitions` includes both shipped defaults (`claude`, `codex`) by default via additive merge. If you only intend to label tickets `agent-claude` and don't have `codex` installed, set `models.definitions.codex: { disabled: true }` (see "Disabling a shipped default" above). Without that, doctor exits non-zero on a missing `codex` binary even though `crew run` would never route to it.

</details>

<details>
<summary>Switch to tmux if cmux is misbehaving</summary>

Set `workspaceKind: "tmux"` to force the tmux backend when cmux's CLI/socket bridge is flaky (symptoms: `cmux --json list-workspaces` returning `Failed to write to socket (Broken pipe)` or `Socket not found at ...cmux.sock` on every tick). tmux is more reliable — just a unix socket, no GUI app — at the cost of losing cmux's status pills, notifications, and sidebar.

</details>

<details>
<summary>Agent CLI must accept a positional prompt</summary>

The handoff is `<your cmd> "<prompt>"`. `claude`, `codex`, and `cursor-agent` all support this.

</details>

<details>
<summary><code>crew setup repos</code> only auto-clones <code>owner/repo</code> entries</summary>

Bare-name entries in `workspace.knownRepositories` (e.g. `"api"` rather than `"clipboardhealth/api"`) are skipped with a hint to clone manually — the command refuses to guess the owner. After a partial setup, the exit code is non-zero so CI gates notice; rerun is idempotent once you clone the bare ones into `<projectDir>/<name>` yourself.

</details>

## Development

Clone the repo and the `crew` / `crew:op` scripts execute straight from TypeScript source — no build step needed.

```bash
cd ~/dev/c/groundcrew
node --run crew -- doctor

# With 1Password for GROUNDCREW_LINEAR_API_KEY:
node --run crew:op -- run --watch
```

Both forms read `${XDG_CONFIG_HOME:-$HOME/.config}/groundcrew/config.ts` by default; set `GROUNDCREW_CONFIG` to point elsewhere. The `crew:op` wrapper additionally reads `${XDG_CONFIG_HOME:-$HOME/.config}/groundcrew/op.env` (1Password env-file with `op://` references resolved at launch).

Logs land in `${XDG_STATE_HOME:-$HOME/.local/state}/groundcrew/groundcrew.log` by default (override via `logging.file`). The "Loaded config from …" line at startup tells you which config won.

Source edits in `src/**` are picked up on the next invocation. Requires Node ≥ 24.3 (native `.ts` type stripping).

## License

[MIT](./LICENSE)
