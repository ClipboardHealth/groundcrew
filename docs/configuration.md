# Configuration

Workspace settings and at least one enabled model are required; everything else has a default.

| Key                           | What                                                                   |
| ----------------------------- | ---------------------------------------------------------------------- |
| `workspace.projectDir`        | Parent dir for cloned repos and sibling ticket worktrees.              |
| `workspace.knownRepositories` | Repos searched for in ticket descriptions to infer where work belongs. |
| `models.definitions`          | Enabled model set. Built-in presets can be enabled with `{}`.          |

The branch prefix (`<prefix>-<TICKET>`) defaults to `os.userInfo().username`; override it with `git.branchPrefix` (see the full reference below). Changing it only affects newly created worktrees; existing local branches keep their original names until cleaned up. Groundcrew picks up every issue assigned to your API key's viewer that carries an `agent-*` label across every visible team and project, governed by a single `orchestrator.maximumInProgress` budget.

## Repository Layout

Groundcrew never clones repositories for you. `crew init --repo OWNER/REPO` prints the clone command to run. If you are cloning manually, clone each `workspace.knownRepositories` entry into `workspace.projectDir` using the same relative path the config uses.

```bash
PROJECT_DIR="$HOME/dev"
mkdir -p "$PROJECT_DIR/OWNER"
git clone git@github.com:OWNER/REPO.git "$PROJECT_DIR/OWNER/REPO"
```

Bare-name entries have no owner, so pick the remote URL yourself and clone to `$PROJECT_DIR/<name>`.

## Config Discovery

Resolution order:

1. `GROUNDCREW_CONFIG`
2. cosmiconfig project-walk from cwd
3. `${XDG_CONFIG_HOME:-$HOME/.config}/groundcrew/crew.config.ts`

The project walk checks:

- `crew.config.{ts,mjs,js,json}`
- `.crewrc{,.json,.ts}`
- `.config/crew.config.{ts,json}`
- `.config/crewrc{,.json}`

The "Loaded config from ..." line at startup tells you which config won.

## Agent Label Routing

- `agent-claude`, `agent-codex`, `agent-<name>` routes to that enabled model.
- `agent-any` routes to the model with the most available session capacity.
- Unknown `agent-<name>` falls back to `models.default`.
- A built-in `agent-<name>` label whose model is not enabled falls back to `models.default` with a warning.
- No `agent-*` label is ignored by `crew run`. Dispatch on demand with `crew start <TICKET>`, which falls back to `models.default`.
- Todo tickets blocked by non-terminal blockers are skipped until their blockers reach a terminal status.

Status classification uses Linear's default status names `In Progress` and `In Review` to disambiguate multiple `started` workflow states. Statuses that do not match those names fall back to Linear's workflow `state.type` (`unstarted`, `started`, `completed`, `canceled`, `duplicate`), so broad lifecycle classification still works without configuration. Parent issues with children are ignored; sub-issues are the work items.

If your Linear workflow uses different names, explicitly declare the built-in Linear source and override only the names you need:

```ts
export default {
  sources: [
    {
      kind: "linear",
      statuses: {
        inProgress: ["Doing"],
        inReview: ["Code Review"],
      },
    },
  ],
};
```

Configured names replace the default for that status; omitted fields keep their defaults. Matching is case-insensitive and trims surrounding whitespace.

## Enabling Model Presets

Groundcrew ships built-in presets for `claude` and `codex`, but models are not enabled by default. List the models you want in `models.definitions`:

```ts
export default {
  models: {
    default: "claude",
    definitions: {
      claude: {},
    },
  },
};
```

To keep both shipped presets enabled:

```ts
export default {
  models: {
    default: "claude",
    definitions: {
      claude: {},
      codex: {},
    },
  },
};
```

Rules:

- `models.definitions` is the enabled model set; `crew doctor` only probes listed models.
- Built-in entries can be `{}` or partial overrides such as `{ cmd: "..." }`.
- Custom model names must provide `cmd` and `color`.
- `models.default` must point at an enabled model.
- Legacy model entries like `codex: { disabled: true }` are rejected with migration guidance; remove unwanted entries instead.

## Prompt Customization

Groundcrew ships one model-agnostic unattended prompt by default. It tells the agent to make reasonable assumptions, follow repository instructions, run documented verification, review its diff, open a PR when GitHub/`gh` is available, and include a workspace continuation hint when known.

This prompt describes how the agent works, not what it does. The task is the ticket description, which groundcrew passes through unchanged. Keep source-specific instructions, acceptance criteria, links, and output requirements in the ticket body. Override `prompts.initial` only to change the execution contract for every dispatched ticket — team-wide review rules, required verification, local tool conventions — not to encode behavior for a single ticket type.

For a personal workflow, keep the prompt next to your local config and load it with `readFileSync`:

```ts
import { readFileSync } from "node:fs";

export default {
  prompts: {
    initial: readFileSync(new URL("./initial-prompt.md", import.meta.url), "utf8"),
  },
};
```

This keeps package defaults portable while letting your private config reference team-specific statuses, tools, plugins, or review loops.

## Default Hooks

Repo-local `.groundcrew/config.json` is the preferred place for
`hooks.prepareWorktree`. To provide a fallback for repos that do not define one,
set `defaults.hooks.prepareWorktree`:

```ts
export default {
  defaults: {
    hooks: {
      prepareWorktree: "test ! -f package-lock.json || npm ci",
    },
  },
};
```

See [Prepare Worktree Hooks](./setup-hooks.md) for the repo-local config shape
and hook contract.

## Full Reference

| Key                                      | Default              | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sources`                                | `[]`                 | Additional pluggable ticket sources, dispatched alongside the built-in Linear adapter. Built-in kinds: `shell`, `linear`. Declare `{ kind: "linear", statuses: { ... } }` only to override Linear status names used for `in-progress` / `in-review` disambiguation.                                                                                                                                                                                                                                                         |
| `git.remote`                             | `"origin"`           | Remote used for `fetch` and as the worktree base ref.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `git.defaultBranch`                      | `"main"`             | Branch fetched from `git.remote` and used as the worktree base.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `git.branchPrefix`                       | OS username          | Prefix groundcrew puts before the ticket id when naming a worktree branch (`<branchPrefix>-<ticket>`). Must be a slash-free slug of letters, digits, `.`, `_`, or `-`. Defaults to the OS account username. Changing it only affects newly created worktrees; existing local branches keep their original names until cleaned up. Prefer a per-user config for personal prefixes — a committed `git.branchPrefix` gives every contributor the same branch prefix.                                                           |
| `workspace.projectDir`                   | **required**         | Parent dir for cloned repos and sibling ticket worktrees.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `workspace.knownRepositories`            | **required**         | Repos searched for in ticket descriptions to infer where work belongs. A ticket labeled for groundcrew (`agent-*`) fails fast when no known repo appears; unlabeled tickets are ignored.                                                                                                                                                                                                                                                                                                                                    |
| `defaults.hooks.prepareWorktree`         | optional             | Fallback repo-preparation command used only when the worktree does not define `.groundcrew/config.json` `hooks.prepareWorktree`. The hook runs after worktree creation and before the agent starts. Repo-local config wins.                                                                                                                                                                                                                                                                                                 |
| `orchestrator.maximumInProgress`         | `4`                  | Cap on in-progress tickets at once for this `crew` instance.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `orchestrator.pollIntervalMilliseconds`  | `120_000`            | Poll interval in `--watch` mode.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `orchestrator.sessionLimitPercentage`    | `85`                 | Number in `(0, 100]`. A model whose codexbar session window exceeds this percentage is skipped that tick.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `models.default`                         | `"claude"`           | Tiebreak for `agent-any` resolution and fallback for explicit but unknown `agent-*` labels. Also used by `crew start <TICKET>` for unlabeled tickets. `crew run` ignores unlabeled tickets and does not apply this default. Must exist in `models.definitions`. If you enable only `codex`, set `default: "codex"`.                                                                                                                                                                                                         |
| `models.definitions`                     | **required**         | Enabled model set. Built-in keys (`claude`, `codex`) can use `{}` to opt into the shipped preset. Custom model names must provide `cmd` and `color`.                                                                                                                                                                                                                                                                                                                                                                        |
| `models.definitions.<name>.cmd`          | preset for built-ins | Shell command launched for the model. Required for custom models. Runs in the worktree through the resolved `local.runner`. `{{worktree}}` is replaced before launch; `{{sandbox}}` expands to the sbx sandbox name under the sdx runner and an empty string otherwise.                                                                                                                                                                                                                                                     |
| `models.definitions.<name>.color`        | preset for built-ins | Color for the workspace status pill (cmux only; tmux silently drops it). Required for custom models.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `models.definitions.<name>.usage`        | preset for built-ins | If set, codexbar usage is fetched for this model and gated by `sessionLimitPercentage`. When `usage.codexbar.source` is omitted, groundcrew uses `oauth` for Codex/Claude on macOS, `auto` for other macOS providers, and `cli` elsewhere. Set to `{ disabled: true }` to disable usage gating while keeping the model enabled.                                                                                                                                                                                             |
| `models.definitions.<name>.sandbox`      | optional             | Docker Sandboxes binding for the model. Required at launch when `local.runner` resolves to `sdx`. Field: `agent` (required sbx agent name). Groundcrew assumes the `groundcrew-<agent>` sandbox already exists.                                                                                                                                                                                                                                                                                                             |
| `models.definitions.<name>.preLaunch`    | optional             | Host-only shell snippet run before the agent exec and outside Safehouse/sdx. Exports survive into the launch shell; under the default `safehouse` runner they are only forwarded to the agent when listed via `preLaunchEnv` or when `cmd` includes its own `safehouse --env-pass=NAMES`. `{{worktree}}` is substituted. A non-zero exit aborts launch. Not supported when `local.runner` resolves to `sdx` in v1.                                                                                                          |
| `models.definitions.<name>.preLaunchEnv` | optional             | Companion to `preLaunch`: list of env var names to append to groundcrew's `safehouse-clearance` `--env-pass=` flag, so `preLaunch` exports reach the agent without overriding `cmd` and losing the project's egress allowlist. Each entry must match `[A-Za-z_][A-Za-z0-9_]*`. Under `runner: "none"` exports already inherit and `preLaunchEnv` is a no-op. An empty array is a uniform no-op in every runner; a non-empty list is rejected when `cmd` already starts with `safehouse` or when `runner` resolves to `sdx`. |
| `prompts.initial`                        | unattended template  | First message sent to the agent: the execution wrapper around each ticket. The ticket description is the task-specific prompt. Placeholders: `{{ticket}}`, `{{worktree}}`, `{{title}}`, `{{description}}`. Override only to change the execution contract for every ticket, such as team-wide review rules or tool conventions.                                                                                                                                                                                             |
| `workspaceKind`                          | `"auto"`             | Terminal session manager. `"auto"` picks `cmux` when on PATH, else `tmux`. Set to `"cmux"` or `"tmux"` to fail loudly when the chosen backend is missing.                                                                                                                                                                                                                                                                                                                                                                   |
| `local.runner`                           | `"auto"`             | Local isolation backend. `"auto"` uses `safehouse` on macOS and `sdx` on Linux/WSL. Explicit: `"safehouse"`, `"sdx"`, `"none"`. `"none"` is never picked implicitly.                                                                                                                                                                                                                                                                                                                                                        |
| `logging.file`                           | XDG state path       | Append-mode log file. `log()` / `logEvent()` tee here in addition to stdout. Defaults to `${XDG_STATE_HOME:-$HOME/.local/state}/groundcrew/groundcrew.log`.                                                                                                                                                                                                                                                                                                                                                                 |
