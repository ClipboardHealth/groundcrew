# Configuration

Workspace settings and at least one enabled agent are required; everything else has a default.

| Key                           | What                                                                 |
| ----------------------------- | -------------------------------------------------------------------- |
| `workspace.projectDir`        | Parent dir for cloned repos and the default task worktree root.      |
| `workspace.worktreeDir`       | Optional parent dir for task worktrees.                              |
| `workspace.knownRepositories` | Repos searched for in task descriptions to infer where work belongs. |
| `agents.definitions`          | Enabled agent set. Built-in presets can be enabled with `{}`.        |

The branch prefix (`<prefix>-<TASK>`) defaults to `os.userInfo().username`; override it with `git.branchPrefix` (see the full reference below). Changing it only affects newly created worktrees; existing local branches keep their original names until cleaned up. Groundcrew picks up every issue assigned to your API key's viewer that carries an `agent-*` label across every visible team and project, governed by a single `orchestrator.maximumInProgress` budget.

## Repository Layout

Groundcrew never clones repositories for you. `crew init --repo OWNER/REPO`
prints the clone command to run. If you are cloning manually, clone each string
`workspace.knownRepositories` entry into `workspace.projectDir` using the same
relative path the config uses.

```bash
PROJECT_DIR="$HOME/dev"
mkdir -p "$PROJECT_DIR/OWNER"
git clone git@github.com:OWNER/REPO.git "$PROJECT_DIR/OWNER/REPO"
```

Bare-name entries have no owner, so pick the remote URL yourself and clone to
`$PROJECT_DIR/<name>`. To keep a repo clone somewhere else, use
`{ name: "OWNER/REPO", projectDirOverride: "~/other" }` and clone it under that
parent dir.

By default, task worktrees are created beside the repos under
`workspace.projectDir`. Set `workspace.worktreeDir` to collect worktrees under a
separate root, regardless of where each source repo clone lives. Changing
`workspace.worktreeDir` only affects worktrees discovered under the new root.
Clean up existing worktrees before switching it, or temporarily unset
`worktreeDir` when you need `crew cleanup` to find worktrees created beside the
repos.

## Scripted Worktrees (Sparse Checkouts)

A `workspace.knownRepositories` entry can be an **object** instead of a string when you want groundcrew to provision the worktree with a custom command — for example a sparse checkout via `graft` — instead of `git worktree add`:

```ts
workspace: {
  projectDir: "~/dev/groundcrew",
  knownRepositories: [
    "your-org/your-repo",
    {
      name: "billing",
      provision: {
        create: "graft new ${branch} billing --from ${baseRef} --dir ${dir}",
        remove: "graft rm ${branch} -f",
      },
      workdir: "services/billing",
    },
  ],
},
```

- **`name`** is a logical name — it is the token matched in task descriptions and the basename of the per-task worktree directory. The physical clone is the command's concern, so several scripted entries can share one underlying clone.
- **`provision`** marks the entry as scripted. **`provision.create`** runs in place of `git worktree add`; **`provision.remove`** runs in place of `git worktree remove`. Both are required — a `provision` block missing either is rejected at config load. `projectDirOverride` (the per-repo source-directory override for native entries) cannot be combined with `provision`; a scripted entry has no groundcrew-managed clone, so it is rejected at config load.
- Both templates run on the host via `sh -c` with the working directory set to the worktree root (`worktreeDir`, defaulting to `projectDir`). They interpolate `${branch}`, `${dir}`, `${baseRef}` (`<remote>/<defaultBranch>`), `${repo}`, and `${task}`; each value is shell-quoted.
- **`workdir`** (optional) is a relative subdirectory of the worktree. When set, the agent's working directory, the `prepareWorktree` hook, and the `.groundcrew/config.json` lookup all re-root to `<worktree>/<workdir>` — use it when a sparse checkout materializes a monorepo whose project lives in a subdirectory (e.g. `uv sync` must run there). The worktree root is unchanged: it is still what create/remove/list operate on, and a sandboxed agent keeps full read/write access to the whole checkout. `workdir` must be relative with no `..` segments; if it is missing after checkout, `crew` fails fast.
- A dirty scripted worktree is still protected from data loss: `crew cleanup` refuses to run `remove` unless you pass `--force`. Orphan and branch cleanup are delegated to your `remove` template, since groundcrew does not track the scripted clone.

Set `graft` (or whatever tool your templates call) up once, outside groundcrew:

```bash
graft repo add ~/dev/owner/monorepo
graft alias add billing services/billing libs/common
```

`crew doctor` does not parse or validate provisioner templates; if your setup is more than a simple command, put it in a wrapper script and call that from `provision.create` / `provision.remove`.

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

- `agent-claude`, `agent-codex`, `agent-<name>` routes to that enabled launch profile.
- `agent-any` routes to the agent with the most session headroom, after skipping agents over their session limit or weekly paced budget.
- Unknown `agent-<name>` falls back to `agents.default`.
- A built-in `agent-<name>` label whose agent is not enabled falls back to `agents.default` with a warning.
- No `agent-*` label is ignored by `crew run`. Dispatch on demand with `crew start <TASK>`, which falls back to `agents.default`.
- Todo tasks blocked by non-terminal blockers are skipped until their blockers reach a terminal status.

Agent names are launch profiles, not just vendor names. To choose a model per
task, define model-specific profiles and route tasks to them:

```ts
export default {
  agents: {
    default: "claude-fable",
    definitions: {
      "claude-fable": {
        cmd: "claude --model claude-fable-5 --permission-mode auto",
        color: "#C15F3C",
        usage: { codexbar: { provider: "claude" } },
      },
      "claude-opus": {
        cmd: "claude --model claude-opus-4-8 --permission-mode auto",
        color: "#8A4FFF",
        usage: { codexbar: { provider: "claude" } },
      },
    },
  },
};
```

Use the same profile name in every source: Linear label `agent-claude-fable`,
todo.txt token `agent:claude-fable`, shell JSON `"agent": "claude-fable"`,
or `crew task create ... --agent claude-fable`.

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

Linear is implicit-on, but you can turn it off entirely with the opt-out sentinel `{ kind: "linear", enabled: false }`. This suppresses the built-in Linear source so no adapter is constructed and no API key is required — useful for shell-only setups, where a failing Linear probe would otherwise mark the whole queue unavailable:

```ts
export default {
  sources: [
    { kind: "linear", enabled: false },
    {
      kind: "shell",
      name: "plans",
      commands: {
        fetch: "~/.config/groundcrew/plans-fetch.sh",
      },
    },
  ],
};
```

## Enabling Agent Presets

Groundcrew ships built-in presets for `claude` and `codex`, but agents are not enabled by default. List the agents you want in `agents.definitions`:

```ts
export default {
  agents: {
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
  agents: {
    default: "claude",
    definitions: {
      claude: {},
      codex: {},
    },
  },
};
```

Rules:

- `agents.definitions` is the enabled launch profile set; `crew doctor` only probes listed profiles.
- Built-in entries can be `{}` or partial overrides such as `{ cmd: "..." }`.
- Custom launch profile names must provide `cmd` and `color`.
- `agents.default` must point at an enabled agent.
- Legacy agent entries like `codex: { disabled: true }` are rejected with migration guidance; remove unwanted entries instead.

## Prompt Customization

Groundcrew ships one agent-agnostic unattended prompt by default. It tells the agent to make reasonable assumptions, follow repository instructions, run documented verification, review its diff, open a PR when GitHub/`gh` is available, and include a workspace continuation hint when known.

This prompt describes how the agent works, not what it does. The task is the task description, which groundcrew passes through unchanged. Keep source-specific instructions, acceptance criteria, links, and output requirements in the task body. Override `prompts.initial` only to change the execution contract for every dispatched task — team-wide review rules, required verification, local tool conventions — not to encode behavior for a single task type.

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

### Loading the prompt from a file (`prompts.promptFile`)

`readFileSync` works for `.ts` configs but not for `crew.config.json`, which has no way to reference an external file. Set `prompts.promptFile` instead and groundcrew reads the file's contents into the initial prompt at load time:

```json
{
  "prompts": {
    "promptFile": "prompt-initial.md"
  }
}
```

- The path is resolved **relative to the config file's directory** (matching the `.ts` `import.meta.url` behavior); a leading `~` is expanded and absolute paths are used as-is.
- `prompts.initial` and `prompts.promptFile` are **mutually exclusive** — setting both is a hard error. Set neither to keep the built-in default.
- Placeholder validation runs on the loaded file contents, so an unknown `{{placeholder}}` in the file fails the same way it would inline.

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
| `sources`                                | `[]`                 | Additional pluggable task sources, dispatched alongside the built-in Linear adapter. Built-in kinds: `shell`, `linear`. Declare `{ kind: "linear", team: "ENG", statuses: { ... } }` to configure Linear task creation's default team and/or override Linear status names used for `in-progress` / `in-review` disambiguation. Disable the implicit Linear source with `{ kind: "linear", enabled: false }` (no API key required) — useful for shell-only setups.                                                           |
| `git.remote`                             | `"origin"`           | Remote used for `fetch` and as the worktree base ref.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `git.defaultBranch`                      | `"main"`             | Branch fetched from `git.remote` and used as the worktree base.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `git.branchPrefix`                       | OS username          | Prefix groundcrew puts before the task id when naming a worktree branch (`<branchPrefix>-<task>`). Must be a slash-free slug of letters, digits, `.`, `_`, or `-`. Defaults to the OS account username. Changing it only affects newly created worktrees; existing local branches keep their original names until cleaned up. Prefer a per-user config for personal prefixes — a committed `git.branchPrefix` gives every contributor the same branch prefix.                                                               |
| `workspace.projectDir`                   | **required**         | Parent dir for cloned repos and the default task worktree root.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `workspace.worktreeDir`                  | optional             | Parent dir for task worktrees. When unset, worktrees are created under `workspace.projectDir`. Changing this only affects worktrees discovered under the new root; clean up existing worktrees before switching it, or temporarily unset it when you need `crew cleanup` to find old worktrees.                                                                                                                                                                                                                             |
| `workspace.knownRepositories`            | **required**         | Repos searched for in task descriptions to infer where work belongs. Entries can be strings under `workspace.projectDir` or `{ name, projectDirOverride }` objects when a repo clone lives under a different parent dir. A task labeled for groundcrew (`agent-*`) fails fast when no known repo appears; unlabeled tasks are ignored.                                                                                                                                                                                      |
| `defaults.hooks.prepareWorktree`         | optional             | Fallback repo-preparation command used only when the worktree does not define `.groundcrew/config.json` `hooks.prepareWorktree`. The hook runs after worktree creation and before the agent starts. Repo-local config wins.                                                                                                                                                                                                                                                                                                 |
| `orchestrator.maximumInProgress`         | `4`                  | Cap on in-progress tasks at once for this `crew` instance.                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `orchestrator.pollIntervalMilliseconds`  | `120_000`            | Poll interval in `--watch` mode.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `orchestrator.sessionLimitPercentage`    | `85`                 | Number in `(0, 100]`. An agent whose codexbar session window exceeds this percentage is skipped that tick. Agents are also skipped when codexbar reports weekly usage over the current weekly paced budget.                                                                                                                                                                                                                                                                                                                 |
| `agents.default`                         | `"claude"`           | Tiebreak for `agent-any` resolution and fallback for explicit but unknown `agent-*` labels. Also used by `crew start <TASK>` for unlabeled tasks. `crew run` ignores unlabeled tasks and does not apply this default. Must exist in `agents.definitions`. If you enable only `codex`, set `default: "codex"`.                                                                                                                                                                                                               |
| `agents.definitions`                     | **required**         | Enabled launch profile set. Built-in keys (`claude`, `codex`) can use `{}` to opt into the shipped preset. Custom profile names must provide `cmd` and `color`; use custom profiles such as `claude-fable` and `claude-opus` to select model-specific commands per task.                                                                                                                                                                                                                                                    |
| `agents.definitions.<name>.cmd`          | preset for built-ins | Shell command launched for the agent. Required for custom profiles. Runs in the worktree through the resolved `local.runner`. `{{worktree}}` is replaced before launch; `{{sandbox}}` expands to the sbx sandbox name under the sdx runner and an empty string otherwise.                                                                                                                                                                                                                                                   |
| `agents.definitions.<name>.color`        | preset for built-ins | Color for the workspace status pill (cmux only; tmux and zellij silently drop it). Required for custom profiles.                                                                                                                                                                                                                                                                                                                                                                                                            |
| `agents.definitions.<name>.usage`        | preset for built-ins | If set, codexbar usage is fetched for this agent and gated by `sessionLimitPercentage` plus the weekly paced budget when codexbar exposes a weekly window. When `usage.codexbar.source` is omitted, groundcrew uses `oauth` for Codex/Claude on macOS, `auto` for other macOS providers, and `cli` elsewhere. Set to `{ disabled: true }` to disable usage gating while keeping the agent enabled.                                                                                                                          |
| `agents.definitions.<name>.sandbox`      | optional             | Docker Sandboxes binding for the agent. Required at launch when `local.runner` resolves to `sdx`. Field: `agent` (required sbx agent name). Groundcrew assumes the `groundcrew-<agent>` sandbox already exists.                                                                                                                                                                                                                                                                                                             |
| `agents.definitions.<name>.preLaunch`    | optional             | Host-only shell snippet run before the agent exec and outside Safehouse/sdx. Exports survive into the launch shell; under the default `safehouse` runner they are only forwarded to the agent when listed via `preLaunchEnv` or when `cmd` includes its own `safehouse --env-pass=NAMES`. `{{worktree}}` is substituted. A non-zero exit aborts launch. Not supported when `local.runner` resolves to `sdx` in v1.                                                                                                          |
| `agents.definitions.<name>.preLaunchEnv` | optional             | Companion to `preLaunch`: list of env var names to append to groundcrew's `safehouse-clearance` `--env-pass=` flag, so `preLaunch` exports reach the agent without overriding `cmd` and losing the project's egress allowlist. Each entry must match `[A-Za-z_][A-Za-z0-9_]*`. Under `runner: "none"` exports already inherit and `preLaunchEnv` is a no-op. An empty array is a uniform no-op in every runner; a non-empty list is rejected when `cmd` already starts with `safehouse` or when `runner` resolves to `sdx`. |
| `prompts.initial`                        | unattended template  | First message sent to the agent: the execution wrapper around each task. The task description is the task-specific prompt. Placeholders: `{{task}}`, `{{worktree}}`, `{{title}}`, `{{description}}`. Override only to change the execution contract for every task, such as team-wide review rules or tool conventions. Mutually exclusive with `prompts.promptFile`.                                                                                                                                                       |
| `prompts.promptFile`                     | optional             | Path to a UTF-8 file whose contents become `prompts.initial`, read at load time. Resolved relative to the config file's directory; `~` is expanded and absolute paths are used as-is. The JSON-friendly alternative to inlining a large prompt or `readFileSync`. Mutually exclusive with `prompts.initial`.                                                                                                                                                                                                                |
| `workspaceKind`                          | `"auto"`             | Terminal session manager. `"auto"` picks `cmux` when on PATH, else `tmux`. Set to `"cmux"`, `"tmux"`, or `"zellij"` to fail loudly when the chosen backend is missing.                                                                                                                                                                                                                                                                                                                                                      |
| `local.runner`                           | `"auto"`             | Local isolation backend. `"auto"` uses `safehouse` on macOS and `sdx` on Linux/WSL. Explicit: `"safehouse"`, `"sdx"`, `"none"`. `"none"` is never picked implicitly.                                                                                                                                                                                                                                                                                                                                                        |
| `logging.file`                           | XDG state path       | Append-mode log file. `log()` / `logEvent()` tee here in addition to stdout. Defaults to `${XDG_STATE_HOME:-$HOME/.local/state}/groundcrew/groundcrew.log`.                                                                                                                                                                                                                                                                                                                                                                 |
