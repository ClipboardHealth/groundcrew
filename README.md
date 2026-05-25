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
- **Multi-agent.** Ships with `claude` and `codex`; bring your own CLI by dropping a definition into `crew.config.ts`.

## Install

```bash
npm install -g @clipboard-health/groundcrew
```

Installs the `crew` binary. `@clipboard-health/clearance` is pulled in transitively and provides the `clearance` / `clearance-ensure` bins used by Safehouse runs.

## Quickstart

1. **Install prereqs.** Node 24, `git`, `cmux` _or_ `tmux`, and the agent CLIs themselves (`claude`, `codex`, `cursor-agent`, …). Optional: `codexbar` for session-usage gating.

2. **Pick an isolation runner.** See [Runners](#runners) — `auto` resolves to `safehouse` on macOS and `sdx` on Linux/WSL.

3. **Create a Linear project to scope your work.** Any team works — make a project inside it and drop tickets in. The orchestrator polls by project, not by team.

4. **Configure.** Create a `crew.config.ts` you can edit:

   ```bash
   # Write into the current folder:
   crew init && $EDITOR crew.config.ts

   # ...or into the XDG config dir:
   crew init --global && $EDITOR "${XDG_CONFIG_HOME:-$HOME/.config}/groundcrew/crew.config.ts"
   ```

   `crew init` refuses to overwrite an existing config; pass `--force` to replace it, or `--dry-run` to preview the destination path.

   `crew` discovers the config via cosmiconfig project-walk, so dropping it at the root of any repo you run `crew` from works too. Any of `crew.config.{ts,mjs,js,json}`, `.crewrc{,.json,.ts}`, `.config/crew.config.{ts,json}`, or `.config/crewrc{,.json}` are recognized.

   Set `linear.projects[].projectSlug` (paste the trailing slug of your Linear project URL, e.g. `ai-strategy-5152195762f3`), `workspace.projectDir`, and `workspace.knownRepositories`. Defaults cover everything else. To watch multiple projects from one `crew` instance, add more entries to `linear.projects`; they all share the same `orchestrator.maximumInProgress` budget.

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

## Secrets

Groundcrew forwards a small allowlist of build-time secrets from your shell into the setup phase (so `npm install` can authenticate against private registries) and then strips them before the agent runs. The agent process never inherits these values in its environment.

**Recognized names.** Defined in [`BUILD_SECRET_NAMES`](./src/lib/buildSecrets.ts):

- `NPM_TOKEN`
- `BUF_TOKEN`

Set them in the shell you run `crew` from. Anything not in this list is ignored by the secret-shuttling path.

**Flow.** For each ticket:

1. If any recognized var is set and non-empty, groundcrew writes `secrets.env` (mode `0600`) into the ticket's temp prompt dir as `KEY='value'` lines — see `stageBuildSecrets` in [`src/commands/setupWorkspace.ts`](./src/commands/setupWorkspace.ts).
2. The launch script sources `secrets.env` with `set -a` so the values are exported into the setup phase only (and under `sdx`, forwarded into the sandbox via `-e KEY` flags).
3. After setup completes, the script `unset`s every name in `BUILD_SECRET_NAMES` and then `rm -rf`s the entire prompt dir (including `secrets.env`) before `exec`'ing the agent. See `sourceSecretsLine` / `unsetSecretsLine` and the `rm -rf` / `exec` lines in [`src/lib/launchCommand.ts`](./src/lib/launchCommand.ts). The rollback path on setup failure ([`src/commands/setupWorkspace.ts`](./src/commands/setupWorkspace.ts)) wipes the prompt dir too.

Net effect: by the time the agent process exists, the values are gone from the environment and the file is gone from disk.

## Runners

`local.runner` picks the local isolation backend. `auto` resolves per platform.

| Runner      | Default on  | Backend                                                                                                  |
| ----------- | ----------- | -------------------------------------------------------------------------------------------------------- |
| `safehouse` | macOS       | [Safehouse](https://agent-safehouse.dev/) — fastest local; cannot safely give the agent Docker.          |
| `sdx`       | Linux / WSL | [Docker Sandboxes](https://docs.docker.com/sandboxes/) (`sbx`) — required when the agent needs `docker`. |
| `none`      | —           | Unsandboxed escape hatch. Never picked implicitly; doctor warns when configured.                         |

For `sdx`: each model that runs under it needs a `sandbox: { agent: "<sbx-agent>" }` block in `crew.config.ts`. Groundcrew names sandboxes `groundcrew-<agent>` (e.g. `groundcrew-claude`) and reuses one sandbox per agent across repos and tickets. First-time agent auth happens inside the sandbox the first time it launches. To bootstrap manually instead, run `sbx create --name groundcrew-<agent> <agent> <projectDir>` once.

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

| Key                             | What                                                                                                      |
| ------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `linear.projects[].projectSlug` | Trailing slug of each Linear project URL to watch (e.g. `ai-strategy-5152195762f3`). One or more entries. |
| `workspace.projectDir`          | Parent dir for cloned repos and sibling ticket worktrees.                                                 |
| `workspace.knownRepositories`   | Repos searched for in ticket descriptions to infer where work belongs.                                    |

`crew` resolves config as: `GROUNDCREW_CONFIG` if set → project-walk from cwd (cosmiconfig: `crew.config.{ts,mjs,js,json}`, `.crewrc{,.json,.ts}`, `.config/crew.config.{ts,json}`, `.config/crewrc{,.json}`) → `${XDG_CONFIG_HOME:-$HOME/.config}/groundcrew/crew.config.ts` (also accepts legacy `config.ts` for one release). The branch prefix (`<prefix>-<TICKET>`) is derived from `os.userInfo().username` — not configurable.

Agent selection uses Linear labels: `agent-claude`, `agent-codex`, `agent-<name>`. `crew run` without `--ticket` only fetches tickets carrying an `agent-*` label — the GraphQL query filters server-side, so unlabeled tickets are never returned by Linear and do not appear on the board. Use `crew run --ticket <TICKET>` to provision an unlabeled ticket on demand (falls back to `models.default`). `agent-any` routes to the model with the most available session capacity. Todo tickets blocked by non-terminal blockers are skipped until their blockers reach a terminal status.

### Pluggable ticket sources

`sources` declares extra ticket-system adapters. The current release verifies configured extra sources during `crew run` startup; the dispatch loop still reads Linear through `linear.projects` until the consumer refactor lands. This lets you validate shell/Jira/local-plan integrations without changing existing Linear behavior.

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

### Prompt customization

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

<details>
<summary>Full reference table</summary>

| Key                                     | Default             | What it does                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `linear.projects`                       | **required**        | Non-empty array of Linear projects to watch. One `crew` instance dispatches across every entry under a shared `maximumInProgress` budget.                                                                                                                                                                                                                               |
| `linear.projects[].projectSlug`         | **required**        | Linear project URL slug (e.g. `ai-strategy-5152195762f3`). The trailing 12-char hex `slugId` is what's matched against Linear's API; the leading name keeps `crew.config.ts` self-documenting and the lookup survives project renames.                                                                                                                                  |
| `linear.projects[].statuses.todo`       | `"Todo"`            | Status name picked up for new work in this project. Per-project so multi-team setups with divergent state names can coexist.                                                                                                                                                                                                                                            |
| `linear.projects[].statuses.inProgress` | `"In Progress"`     | Status set after a workspace is provisioned; counts toward the shared `maximumInProgress`.                                                                                                                                                                                                                                                                              |
| `linear.projects[].statuses.done`       | `"Done"`            | Status that triggers worktree cleanup for this project.                                                                                                                                                                                                                                                                                                                 |
| `linear.projects[].statuses.terminal`   | `["Done"]`          | Additional status names treated as terminal for cleanup and blocker checks. The project's `done` status is always included.                                                                                                                                                                                                                                             |
| `sources`                               | `[]`                | Additional pluggable ticket sources. Extra sources are verified at startup; Linear remains the dispatch read path until the consumer refactor. Built-in kinds: `shell`, `linear`.                                                                                                                                                                                       |
| `git.remote`                            | `"origin"`          | Remote used for `fetch` and as the worktree base ref.                                                                                                                                                                                                                                                                                                                   |
| `git.defaultBranch`                     | `"main"`            | Branch fetched from `git.remote` and used as the worktree base.                                                                                                                                                                                                                                                                                                         |
| `workspace.projectDir`                  | **required**        | Parent dir for cloned repos and sibling ticket worktrees.                                                                                                                                                                                                                                                                                                               |
| `workspace.knownRepositories`           | **required**        | Repos searched for in ticket descriptions to infer where work belongs. A ticket labeled for groundcrew (`agent-*`) fails fast when no known repo appears; unlabeled tickets are ignored.                                                                                                                                                                                |
| `orchestrator.maximumInProgress`        | `4`                 | Cap on in-progress tickets at once, shared across every project in `linear.projects`.                                                                                                                                                                                                                                                                                   |
| `orchestrator.pollIntervalMilliseconds` | `120_000`           | Poll interval in `--watch` mode.                                                                                                                                                                                                                                                                                                                                        |
| `orchestrator.sessionLimitPercentage`   | `85`                | Number in `(0, 100]`. A model whose codexbar session window exceeds this percentage is skipped that tick.                                                                                                                                                                                                                                                               |
| `models.default`                        | `"claude"`          | Tiebreak for `agent-any` resolution and fallback for explicit but unknown `agent-*` labels. Also used by `crew run --ticket <TICKET>` for unlabeled tickets. `crew run` without `--ticket` ignores unlabeled tickets and does not apply this default. Must exist in `models.definitions`.                                                                               |
| `models.definitions`                    | `{ claude, codex }` | Agent definitions. Additive merge with shipped defaults.                                                                                                                                                                                                                                                                                                                |
| `models.definitions.<name>.cmd`         | —                   | Shell command launched for the model. Runs in the worktree through the resolved `local.runner`. `{{worktree}}` is replaced before launch; `{{sandbox}}` expands to the sbx sandbox name under the sdx runner and an empty string otherwise.                                                                                                                             |
| `models.definitions.<name>.color`       | —                   | Color for the workspace status pill (cmux only; tmux silently drops it).                                                                                                                                                                                                                                                                                                |
| `models.definitions.<name>.usage`       | optional            | If set, codexbar usage is fetched for this model and gated by `sessionLimitPercentage`. Falls back to default when unset, with gating enabled for known models. When `usage.codexbar.source` is omitted, groundcrew uses `oauth` for Codex/Claude on macOS, `auto` for other macOS providers, and `cli` elsewhere. Set to `{ disabled: true }` to disable usage gating. |
| `models.definitions.<name>.sandbox`     | optional            | Docker Sandboxes binding for the model. Required at launch when `local.runner` resolves to `sdx`. Fields: `agent` (required sbx agent name), `template`, `kits`, `setupCommand` (override for the inside-sandbox setup script).                                                                                                                                         |
| `models.definitions.<name>.disabled`    | optional            | When set to exactly `true`, drops the named shipped default (`claude` or `codex`). Doctor skips probing it; `agent-<name>` labels fall back to `models.default` with a warning.                                                                                                                                                                                         |
| `prompts.initial`                       | unattended template | First message sent to the agent. Placeholders: `{{ticket}}`, `{{worktree}}`, `{{title}}`, `{{description}}`. Override this from `crew.config.ts` for team-specific statuses, tools, plugins, or review loops.                                                                                                                                                           |
| `workspaceKind`                         | `"auto"`            | Terminal session manager. `"auto"` picks `cmux` when on PATH, else `tmux`. Set to `"cmux"` or `"tmux"` to fail loudly when the chosen backend is missing.                                                                                                                                                                                                               |
| `local.runner`                          | `"auto"`            | Local isolation backend. `"auto"` → `safehouse` on macOS, `sdx` on Linux/WSL. Explicit: `"safehouse"`, `"sdx"`, `"none"`. `"none"` is never picked implicitly.                                                                                                                                                                                                          |
| `logging.file`                          | XDG state path      | Append-mode log file. `log()` / `logEvent()` tee here in addition to stdout. Defaults to `${XDG_STATE_HOME:-$HOME/.local/state}/groundcrew/groundcrew.log`.                                                                                                                                                                                                             |

</details>

<details>
<summary>Disabling a shipped default</summary>

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

</details>

## Per-repo setup hook

When groundcrew launches a worktree, if `.groundcrew/setup.sh` exists in the repo root it's invoked as `bash .groundcrew/setup.sh --deps-only` before the agent starts; otherwise nothing runs. The same convention applies inside the sdx sandbox (overridable per-model via `models.definitions.<name>.sandbox.setupCommand`). No implicit `npm install`, `uv sync`, or anything else — groundcrew is language-agnostic, so opt in by adding the script.

### The `--deps-only` contract

The flag tells the script "you're being called by an automated system before an agent launches — skip anything interactive or one-time-only." The same script handles both modes; branch on `$1`. The name is historical and Node-flavored, but the semantic is language-neutral:

- **With `--deps-only`**: do the cheap recurring work this worktree needs (lockfile install, generate types, etc.). No prompts, no global installs, no `nvm` / `pyenv` bootstrap that the host should already have.
- **Without the flag**: full interactive bootstrap. Use this path when an engineer runs the script by hand for first-time onboarding, or when wiring it into another tool's SessionStart hook.

Setup failures are advisory — groundcrew logs the non-zero exit and still launches the agent so a flaky network or stale lockfile doesn't block the session.

### Examples

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

**Docs-only or polyglot repo with no install step:**

Omit the script. With nothing at `.groundcrew/setup.sh`, groundcrew skips the hook silently — fine for documentation repos, polyglot monorepos where setup happens per-package, or anywhere the per-worktree work is genuinely zero.

For a more comprehensive real-world example (nvm bootstrap, hash-based skip-on-no-changes caching, portable SHA-256 detection), see [this repo's own `.groundcrew/setup.sh`](./.groundcrew/setup.sh). It's also symlinked at `.claude/setup.sh` so the same script doubles as a Claude Code SessionStart hook for this repo — that symlink is local convenience, not part of groundcrew's contract.

### Generating it with an agent

To have a coding agent (Claude Code, Cursor, etc.) scaffold `.groundcrew/setup.sh` for a repo you're onboarding, see [docs/setup-hook-agent-prompt.md](./docs/setup-hook-agent-prompt.md) — it encodes the contract above as a copy-pasteable prompt.

## Commands

```bash
crew init [--global | --local] [--force] [--dry-run] # create a crew.config.ts (cwd by default)
crew doctor                                              # full setup check
crew doctor --ticket <TICKET> [--no-linear] [--no-fetch] # full ticket lifecycle (dispatch + recovery)
crew run                                                 # one-shot dispatch
crew run --watch                                         # poll forever
crew run --ticket <TICKET>                               # provision one ticket and exit
crew setup repos [--dry-run] [<repo>...]
crew interrupt <TICKET> [--reason <text>]                # stop the live workspace, keep the worktree
crew resume <TICKET>                                     # reopen an existing ticket worktree
crew cleanup <TICKET>                                    # tear down every worktree carrying this ticket
```

`crew doctor --ticket <TICKET>` covers the full per-ticket lifecycle: pre-dispatch eligibility (Todo status, `agent-*` label, model resolution, repository mention, local clone, blockers, model session usage, in-progress capacity) **and** post-dispatch local-state recovery (recorded run state, host worktree, workspace pane, local branch, remote branch, open PR). Verdict precedence starts with PR outcomes (`pr-open` > `pr-merged`). Recorded failed launches report before ordinary local recovery, interrupted runs report concrete recoverable git work first when it exists and otherwise report `interrupted`, and ordinary post-dispatch cases report `in-flight` before `recoverable`. If none of those apply, doctor falls through to `unresolvable` > `ineligible` > `would-dispatch` > `lost`. Exits 0 on `would-dispatch`, `pr-open`, or `pr-merged`; any other verdict exits 1. `--watch` and `--ticket` are mutually exclusive. To inspect codexbar session windows directly, run `codexbar usage`.

### `crew doctor --ticket <ticket>`

Diagnose where a ticket is in its lifecycle and what to do next. Runs the same resolution and eligibility chain as the dispatcher, plus probes recorded run state, host worktree, workspace pane, local branch, remote branch, and PR; prints a single verdict with a copy-pasteable recovery step when one applies.

Flags:

- `--no-linear` — skip the Linear GraphQL call. Resolution and Eligibility sections are skipped; verdicts that need only local state (`in-flight`, `recoverable`, `pr-open`, `pr-merged`, `lost`) still fire.
- `--no-fetch` — skip the upfront `git fetch origin <branch>` before checking remote presence.

The Workspace section appends an attach hint to the pane name when the workspace backend exposes one (e.g. `tmux attach -t <session>:<pane>` or `cmux attach <name>`), so the verdict line is immediately actionable. The hero above shows a passing pre-dispatch run; here's the same command on a ticket that's already past dispatch:

```text
groundcrew doctor --ticket HRD-442 (Multi-event extractor: year inference can produce date_start > date_end)
────────────────────────────────────────────────────────────────────────────────────────────────────────────

Resolution
  [ok] Ticket exists in Linear ("Multi-event extractor: year inference can produce date_start > date_end")
  [ok] Status is Todo
  (skipped — post-dispatch — pre-dispatch checks are irrelevant)

Eligibility
  (skipped — post-dispatch — pre-dispatch checks are irrelevant)

Run state
  [ok] Local run state (running)
  [ok] Recorded model (claude)
  [ok] Recorded worktree (/Users/paul/dev/groundcrew-workspaces/herds-social/herds-hrd-442)
  [ok] Recorded branch (paul-hrd-442)
  [ok] Resume count (0)

Worktree
  [ok] Host worktree exists (/Users/paul/dev/groundcrew-workspaces/herds-social/herds-hrd-442)
  [--] Working tree clean (0 modified, 1 untracked)
  [ok] Branch checked out (paul-hrd-442)

Workspace
  [ok] Workspace pane open (hrd-442 — attach: `tmux attach -t groundcrew:hrd-442`)

Local branch
  [ok] Local branch exists (paul-hrd-442, 2 ahead / 0 behind origin/main)

Remote branch
  [ok] Branch present on origin

Pull request
  [ok] Open PR for this branch (#224 https://github.com/herds-social/herds/pull/224)

→ pr-open: https://github.com/herds-social/herds/pull/224 (#224)
```

#### Recovering a stranded ticket

The verdict on the last line maps to a recovery action:

| Verdict          | What to do                                                                                    |
| ---------------- | --------------------------------------------------------------------------------------------- |
| `pr-open`        | Nothing — the PR is the source of truth.                                                      |
| `pr-merged`      | Done.                                                                                         |
| `in-flight`      | The ticket is still being worked on; the verdict line names the workspace pane to attach to.  |
| `recoverable`    | Run the printed `nextStep` exactly.                                                           |
| `interrupted`    | Resume the preserved worktree with `crew resume <ticket>` or inspect it by hand.              |
| `failed-launch`  | Fix the launch failure, then run `crew resume <ticket>` or `crew cleanup <ticket>`.           |
| `would-dispatch` | Pre-dispatch checks pass; the orchestrator will pick the ticket up on its next tick.          |
| `ineligible`     | A resolution or eligibility check failed; the reason after the colon names the failing check. |
| `unresolvable`   | The Linear ticket couldn't be fetched; the reason after the colon names the error.            |
| `lost`           | No trace exists. Re-dispatch via `crew run --ticket <ticket>`.                                |

### `crew interrupt <ticket>`

Stop a live workspace pane while preserving the ticket worktree and branch. This is the manual pause button for cases where you need terminal capacity back, want to stop an agent that is going in the wrong direction, or need to inspect the diff before letting another agent continue.

```bash
crew interrupt HRD-442 --reason "wrong implementation direction"
crew doctor --ticket HRD-442
crew resume HRD-442
```

The command closes the cmux/tmux workspace when it exists, records local run state under the groundcrew state directory, and never tears down the worktree. If the workspace was already gone but the worktree is still present, interrupt records that fact so doctor can point at the preserved branch instead of reporting a mystery ticket.

### `crew resume <ticket>`

Reopen an existing ticket worktree with a continuation prompt. Resume never creates a new worktree; if none exists, it fails and leaves re-dispatch to `crew run --ticket <ticket>`.

The resume prompt tells the agent to inspect current git status and diff before editing, includes the previous interrupt reason when recorded, and reuses the recorded model, repository, branch, runner, sandbox, and workspace backend. When no run-state file exists but a worktree does, resume falls back to Linear resolution for the model and ticket context.

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

If your team uses `Started` instead of `In Progress`, set `linear.projects[].statuses.inProgress = "Started"` on that project's entry. Status overrides are per-project so divergent team workflows coexist.

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
<summary>Cross-team projects need a consistent `inProgress` name per project</summary>

Cross-team projects work — the orchestrator caches the in-progress state ID per `(team, statusName)` pair — but every team in a given project must use the same status name for that project's `statuses.inProgress`. If you watch two projects that share a Linear team but configure different `inProgress` names, each project's lookup is independent.

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

Both forms discover config via cosmiconfig — project-walk from cwd for `crew.config.ts` and friends, then `${XDG_CONFIG_HOME:-$HOME/.config}/groundcrew/crew.config.ts` (legacy `config.ts` is still accepted for one release). Set `GROUNDCREW_CONFIG` to point elsewhere. The `crew:op` wrapper additionally reads `${XDG_CONFIG_HOME:-$HOME/.config}/groundcrew/op.env` (1Password env-file with `op://` references resolved at launch).

Logs land in `${XDG_STATE_HOME:-$HOME/.local/state}/groundcrew/groundcrew.log` by default (override via `logging.file`). The "Loaded config from …" line at startup tells you which config won.

Source edits in `src/**` are picked up on the next invocation. Requires Node ≥ 24.3 (native `.ts` type stripping).

## License

[MIT](./LICENSE)
