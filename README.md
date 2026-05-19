<h1 align="center">groundcrew</h1>
<p align="center">
  <img alt="Groundcrew logo." height="250px" src="./static/groundcrew.svg">
</p>

Watch a Linear project and farm out ready tickets to coding-agent CLIs running in workspaces backed by git worktrees. Workspaces are [`cmux`](https://github.com/clayton-cole/cmux) panes or `tmux` windows.

## Install

```bash
npm install -g @clipboard-health/groundcrew
```

This installs the `crew` binary. `@clipboard-health/clearance` is pulled in transitively and provides the `clearance` / `clearance-ensure` bins used by local Safehouse execution.

## Quickstart

1. **Install prereqs.** Node 24, `git`, `cmux` _or_ `tmux`, and the agent CLIs themselves (`claude`, `codex`, `cursor-agent`, ...). Groundcrew is **macOS-only** and requires [Safehouse](https://agent-safehouse.dev/) on `PATH`. Optional: `codexbar` for session-usage gating. The `workspaceKind` config key picks the workspace backend (`auto` resolves to cmux when installed, else tmux).

2. **Create a Linear project to scope your work.** Any team works — make a project inside it and drop tickets in. The orchestrator polls by project, not by team, so you don't need a dedicated team.

3. **Create your config.** Copy the shipped example into the XDG config path and edit it:

   ```bash
   mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/groundcrew"
   cp "$(npm root -g)/@clipboard-health/groundcrew/configExample.ts" \
      "${XDG_CONFIG_HOME:-$HOME/.config}/groundcrew/config.ts"
   $EDITOR "${XDG_CONFIG_HOME:-$HOME/.config}/groundcrew/config.ts"
   ```

   At minimum set `linear.projectSlug` (paste the trailing segment of your Linear project URL, e.g. `ai-strategy-5152195762f3`), `workspace.projectDir`, and `workspace.knownRepositories`. Everything else has a default.

   Create `workspace.projectDir` if it does not exist, and clone each repo in `workspace.knownRepositories` into `<projectDir>/<repo>` before the first `crew run`. Groundcrew creates per-ticket worktrees from these clones; it does not auto-clone. Use the literal `knownRepositories` string as the path under `projectDir` — `"owner/repo"` lives at `<projectDir>/owner/repo`, bare `"repo"` lives at `<projectDir>/repo`.

   ```bash
   mkdir -p ~/dev/groundcrew-workspaces
   gh repo clone owner/repo ~/dev/groundcrew-workspaces/owner/repo
   ```

   Or let `crew` clone every missing `owner/repo` entry for you using your `gh` login:

   ```bash
   crew setup repos              # clone all missing entries
   crew setup repos --dry-run    # preview what would be cloned
   crew setup repos owner/repo   # restrict to one entry
   ```

   `crew setup repos` is idempotent — already-cloned repos are reported `[exists]` and untouched. Bare-name entries (no `owner/`) are skipped with an instruction to clone manually, since groundcrew can't safely guess the org. The command fails fast with an install hint when `gh` is not on `PATH`.

   `crew` resolves the config path as: `GROUNDCREW_CONFIG` if set → `${XDG_CONFIG_HOME:-$HOME/.config}/groundcrew/config.ts` if it exists → a `config.ts` sitting next to `crew`'s own source files (only useful from a local checkout; see [Hacking on groundcrew](#hacking-on-groundcrew)). Set `GROUNDCREW_CONFIG` only when you want to override the XDG location.

4. **Provide a Linear API key.** `crew` expects `LINEAR_API_KEY` in its environment. Any mechanism works — shell export, [direnv](https://direnv.net/), a `.env` file you `source`, or piping through `op run` if you store the credential in 1Password:

   ```bash
   # Direct
   export LINEAR_API_KEY="lin_api_..."
   crew doctor

   # Via 1Password CLI (`op`), if you keep the key in a vault
   echo "LINEAR_API_KEY='op://<vault>/LINEAR_API_KEY/credential'" > .env.1password
   op run --env-file .env.1password -- crew doctor
   ```

5. **Prepare the runner and agent auth.** Groundcrew supports one runner: a `cmux` or `tmux` workspace on macOS, with Safehouse on `PATH`, `clearance`, and locally authenticated agent CLIs.

   Setup fails before creating a worktree when the host is not macOS or `safehouse` is missing. `models.isolation`, per-model `isolation`, and per-model `sandbox` are legacy keys and now fail config validation.

6. **Set the clearance allowlist for local macOS runs.** Groundcrew starts `clearance` from `@clipboard-health/clearance` on `http://127.0.0.1:19999` (skipping the launch if something is already listening) and runs the agent through the bundled `safehouse-clearance` wrapper. Clearance refuses to start without an allowlist — see [its README](https://github.com/ClipboardHealth/core-utils/tree/main/packages/clearance) for the proxy's env vars, log paths, and DNS rules. The shortest path is to set the env before `crew run`:

   ```bash
   CLEARANCE_ALLOW_HOSTS="api.openai.com,auth.openai.com,api.anthropic.com,mcp.linear.app,api.linear.app" \
   crew run --watch
   ```

   Groundcrew also ships a starter allowlist file covering model APIs, Linear, Notion, Slack, Datadog, GitHub, npm, and common dev tooling at `$(npm root -g)/@clipboard-health/groundcrew/clearance-allow-hosts`. Point clearance at it (and optionally a personal file) via `CLEARANCE_ALLOW_HOSTS_FILES`:

   ```bash
   CLEARANCE_ALLOW_HOSTS_FILES="$(npm root -g)/@clipboard-health/groundcrew/clearance-allow-hosts:$HOME/.config/clearance/personal-allow-hosts" \
   crew run --watch
   ```

   Watch `${XDG_CACHE_HOME:-$HOME/.cache}/clearance/clearance.log` for `DENY` lines and add only the domains your agents actually need.

7. **Run.** Doctor first, then a dry run, then the real thing:

   ```bash
   crew doctor
   crew run --dry-run
   crew run            # one-shot
   crew run --watch    # poll forever
   ```

## Config reference

Required fields are marked **required**; everything else has a default and can be omitted from `config.ts`.

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
| `models.definitions.<name>.cmd`         | —                   | Shell command launched for the model. Runs in the worktree through Safehouse/clearance. `{{worktree}}` is replaced before launch and legacy `{{sandbox}}` expands to an empty string.                                                                                                     |
| `models.definitions.<name>.color`       | —                   | Color for the workspace status pill (cmux only; tmux silently drops it).                                                                                                                                                                                                                  |
| `models.definitions.<name>.usage`       | optional            | If set, codexbar usage is fetched for this model and gated by `sessionLimitPercentage`. Omit to never gate. When `usage.codexbar.source` is omitted, groundcrew uses `auto` on macOS and `cli` elsewhere.                                                                                 |
| `models.definitions.<name>.disabled`    | optional            | When set to exactly `true`, drops the named shipped default (`claude` or `codex`). Doctor skips probing it; `agent-<name>` labels fall back to `models.default` with a warning. See "Disabling a shipped default" below.                                                                  |
| `prompts.initial`                       | (template)          | First message sent to the agent. Placeholders: `{{ticket}}`, `{{worktree}}`, `{{title}}`, `{{description}}`.                                                                                                                                                                              |
| `workspaceKind`                         | `"auto"`            | Terminal session manager. `"auto"` picks `cmux` when on PATH, else `tmux`. Set to `"cmux"` or `"tmux"` to fail loudly when the chosen backend is missing. tmux windows live in a dedicated `groundcrew` session.                                                                          |
| `logging.file`                          | XDG state path      | Append-mode log file destination. `log()` / `logEvent()` tee here in addition to stdout, so a vanished workspace doesn't take the evidence with it. Defaults to `${XDG_STATE_HOME:-$HOME/.local/state}/groundcrew/groundcrew.log`.                                                        |

The branch prefix (`<prefix>-<TICKET>`) is derived from your OS username (`os.userInfo().username`), not configured. Agent selection looks for a top-level Linear label named `agent-<model>` (e.g. `agent-claude`, `agent-codex`). **`crew run` without `--ticket` only fetches tickets with an `agent-*` label** — the GraphQL query filters them server-side, so unlabeled tickets are never returned by Linear's API and do not appear in the rendered board. Use `crew run --ticket <TICKET>` to provision an unlabeled ticket on demand (manual setup falls back to `models.default`). The reserved label `agent-any` routes the ticket to the configured model with the most available session capacity (lowest codexbar session-used percent), skipping any model already over `sessionLimitPercentage`. With no usage data, `agent-any` resolves to `models.default`. The name `any` cannot be used in `models.definitions`. Todo tickets blocked by Linear issues that are not in `linear.statuses.terminal` are skipped until their blockers reach a terminal status.

### Disabling a shipped default

Groundcrew ships `claude` and `codex` as default model definitions, additively merged into every resolved config. If you only ever route work through one of them, set `disabled: true` on the other so doctor stops probing for the unused CLI:

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
- An `agent-<disabled>` label on a ticket (e.g. `agent-codex` after disabling codex) falls back to `models.default` with a warning in the log, so the ticket still runs and you can see the mismatch.

Rules:

- `disabled` only accepts shipped-default keys (`claude`, `codex`). A typo on the key fails loudly at config load instead of silently disabling nothing.
- `disabled` must be exactly the boolean `true`.
- It cannot be combined with `cmd`, `color`, or `usage` in the same entry — disable a model or override its fields, not both.
- `models.default` must point at an enabled model.

## Manual commands

```bash
crew run --ticket <TICKET>
crew setup repos [--dry-run] [<repo>...]
crew cleanup <TICKET>
```

`crew run --ticket <TICKET>` provisions a single ticket the same way the orchestrator would: the repo is parsed from the ticket's Linear description and the model comes from the ticket's `agent-*` label (manual setup falls back to `models.default` for unlabeled tickets). If the description does not mention a repo from `workspace.knownRepositories`, setup fails before provisioning. `--watch` and `--ticket` are mutually exclusive — `--watch` drives the orchestrator loop; `--ticket` provisions one ticket and exits. `crew cleanup <TICKET>` resolves to every tracked worktree carrying that ticket id (across repos) and tears them all down. To inspect codexbar session windows directly, run `codexbar usage`; the orchestrator already gates on this internally via `orchestrator.sessionLimitPercentage`.

## Gotchas

- **Execution is macOS plus Safehouse only.** There is no `models.isolation` strategy and no direct local execution mode. Linux/WSL is not supported.
- **Safehouse-already-wrapped commands are not re-wrapped.** If a `models.definitions.<name>.cmd` already starts with `safehouse`, groundcrew assumes that command owns its Safehouse flags and does not add the `safehouse-clearance` wrapper a second time. Changing the proxy's allowlist after it's running requires killing the PID in `${XDG_CACHE_HOME:-$HOME/.cache}/clearance/clearance.pid` so the next launch picks up the new env.
- **Legacy Docker Sandboxes state is unmanaged.** Groundcrew no longer discovers or cleans `.sbx` worktrees or persistent Docker Sandboxes containers. If you have old state, inspect and remove it manually with `sbx`.
- **Dead tmux windows vanish by default.** When a wrapped agent command fails (e.g. `safehouse-clearance` not found, `npm install` crash), the tmux window closes immediately and the error scrolls into the void. Set `GROUNDCREW_KEEP_DEAD_WINDOWS=1` (any non-empty value works) in the env you launch `crew` from to flip the per-window `remain-on-exit` to `on`; the window stays open with the error visible. Close it manually with `tmux kill-window -t groundcrew:<ticket>` after diagnosis. tmux backend only.
- **Status names matter.** If your team uses `Started` instead of `In Progress`, set `linear.statuses.inProgress = "Started"`.
- **Leaf-only.** Parent issues with children are ignored — sub-issues are the work items.
- **Tickets stay in the in-progress status until something else moves them.** Groundcrew sets a ticket to `inProgress` when it provisions a workspace and never advances it. The next transition (typically "in review" when a PR opens) is left to your team's Linear automation rules.
- **Project must be on a single Linear team in practice.** Cross-team projects work — the orchestrator caches the in-progress state ID per team — but every team in the project must use the same status name for `linear.statuses.inProgress`.
- **Claude launches in bypass-permissions mode by default.** Groundcrew creates isolated per-ticket worktrees for unattended runs, so the shipped `claude` command is `claude --permission-mode bypassPermissions` to avoid workspace-trust and tool-permission prompts blocking automation. Override `models.definitions.claude.cmd` if you want a stricter mode.
- **Doctor's command introspection is shallow.** Doctor reports whether the host can run local tickets with macOS plus Safehouse, then tokenizes model `cmd` and checks the first two non-flag tokens against PATH (so `safehouse claude --foo` checks both `safehouse` and `claude`). Boolean flags without values, env-var assignments (`FOO=1`), shell pipelines, and subshells are not parsed — verify those manually. In particular, `npx -y claude` and `env FOO=1 claude` only check the wrapper, not the wrapped CLI.
- **Doctor checks every enabled model, including shipped defaults you didn't disable.** `models.definitions` includes both shipped defaults (`claude`, `codex`) by default via additive merge. If you only intend to label tickets `agent-claude` and don't have `codex` installed, set `models.definitions.codex: { disabled: true }` (see "Disabling a shipped default" under "Config reference"). Without that, doctor exits non-zero on a missing `codex` binary even though `crew run` would never route to it.
- **Switch to tmux if cmux is misbehaving.** Set `workspaceKind: "tmux"` to force the tmux backend when cmux's CLI/socket bridge is flaky (symptoms: `cmux --json list-workspaces` returning `Failed to write to socket (Broken pipe)` or `Socket not found at ...cmux.sock` on every tick). tmux is more reliable — just a unix socket, no GUI app — at the cost of losing cmux's status pills, notifications, and vertical-tab sidebar.
- **Agent CLI must accept a positional prompt.** The handoff is `<your cmd> "<prompt>"`. `claude`, `codex`, and `cursor-agent` all support this.
- **`crew setup repos` only auto-clones `owner/repo` entries.** Bare-name entries in `workspace.knownRepositories` (e.g. `"api"` rather than `"clipboardhealth/api"`) are skipped with a hint to clone manually — the command refuses to guess the owner. After a partial setup, the exit code is non-zero so CI gates notice; rerun is idempotent once you clone the bare ones into `<projectDir>/<name>` yourself. Adding a new repo to `knownRepositories` later? Just rerun `crew setup repos`; already-present entries report `[exists]` and are untouched.

## Hacking on groundcrew

For developers working on the package itself, clone this repo, run `npm install`, and the repo's `crew` / `crew:op` scripts execute groundcrew straight from TypeScript source — no build step. Package dependencies, including `@clipboard-health/clearance`, resolve through normal npm package exports.

```bash
cd ~/dev/c/groundcrew
node --run crew -- doctor

# With 1Password for LINEAR_API_KEY:
node --run crew:op -- run --watch
```

Both forms read `${XDG_CONFIG_HOME:-$HOME/.config}/groundcrew/config.ts` by default; set `GROUNDCREW_CONFIG` to point elsewhere. The `crew:op` wrapper additionally reads `${XDG_CONFIG_HOME:-$HOME/.config}/groundcrew/op.env` (1Password env-file with `op://` references resolved at launch) — symlink it there if you keep yours elsewhere; the path is not configurable.

Logs land in `${XDG_STATE_HOME:-$HOME/.local/state}/groundcrew/groundcrew.log` by default (override via `logging.file` in your config). The "Loaded config from …" line at startup tells you which config won.

Source edits in `src/**` are picked up on the next invocation. Requires Node ≥ 24.3 (the version with native `.ts` type stripping enabled by default).
