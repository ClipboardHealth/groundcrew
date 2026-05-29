<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./static/groundcrew-wordmark-dark.svg">
    <img alt="groundcrew" src="./static/groundcrew-wordmark-light.svg" height="96">
  </picture>
</p>

<p align="center">
  Dispatch your ticket backlog to AI coding agents. One git worktree per ticket, sandboxed by default.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@clipboard-health/groundcrew"><img alt="npm" src="https://img.shields.io/npm/v/@clipboard-health/groundcrew?style=flat-square&label=npm&color=77d94e&labelColor=18181b"></a>
  <a href="https://www.npmjs.com/package/@clipboard-health/groundcrew"><img alt="downloads" src="https://img.shields.io/npm/dw/@clipboard-health/groundcrew?style=flat-square&label=downloads&color=18181b&labelColor=18181b"></a>
  <a href="https://github.com/ClipboardHealth/groundcrew/actions/workflows/ci.yml"><img alt="ci" src="https://img.shields.io/github/actions/workflow/status/ClipboardHealth/groundcrew/ci.yml?style=flat-square&label=ci&color=77d94e&labelColor=18181b"></a>
  <a href="./LICENSE"><img alt="license" src="https://img.shields.io/npm/l/@clipboard-health/groundcrew?style=flat-square&label=license&color=18181b&labelColor=18181b"></a>
</p>

Groundcrew watches assigned tickets, creates isolated worktrees, launches agent CLIs in cmux or tmux, and leaves each ticket's work on its own branch. The longer product story is in [Tickets to pull requests while you sleep](https://www.clipboardworks.com/resources/blog/tickets-to-pull-requests-while-you-sleep).

## Why

- **One worktree per ticket.** Agents work in parallel without stepping on each other.
- **Linear out of the box.** Assign yourself an `agent-*` labeled issue and Groundcrew can pick it up.
- **Local-first isolation.** Safehouse on macOS, Docker Sandboxes on Linux/WSL, or an explicit `none` escape hatch.
- **Multi-agent routing.** Ships with `claude` and `codex`; bring your own CLI in config.

## Quickstart

```bash
# 1. Install Node >= 24, git, cmux or tmux, and the agent CLI you'll use.

# 2. Install groundcrew.
npm install -g @clipboard-health/groundcrew

# 3. Scaffold a global config.
#    runner=none is the quickest path, but it runs agents unsandboxed on the host.
crew init --global --project-dir ~/dev --repo OWNER/REPO --runner none --model claude

# 4. Run the clone commands printed by `crew init`.

# 5. If using Linear, export your API key.
export GROUNDCREW_LINEAR_API_KEY="lin_api_..."

# 6. Verify setup, then dispatch.
crew doctor
crew run --watch
```

`crew init --global` writes config to `${XDG_CONFIG_HOME:-$HOME/.config}/groundcrew/`. Pass `--repo` more than once for multiple repos. Pass `--model claude` or `--model codex` to disable the missing CLI if you only have one installed.

## Ticket Pickup

For Linear, assign tickets to yourself and add an `agent-*` label:

- `agent-claude`, `agent-codex`, or `agent-<name>` routes to that model.
- `agent-any` routes to the enabled model with the most available capacity.
- Tickets without an `agent-*` label are ignored by `crew run`; dispatch one manually with `crew start <TICKET>`.

Groundcrew scans `workspace.knownRepositories` to infer which repo a ticket belongs to. A ticket blocked by non-terminal blockers is skipped until those blockers are done.

## Commands

```bash
crew init [--global | --local] [--force] [--dry-run]     # create a crew.config.ts
          [--project-dir <dir>] [--repo <repo>]
          [--runner <auto|safehouse|sdx|none>] [--model <claude|codex>]
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

See [command details](./docs/commands.md) for status output, doctor behavior, and the stop/resume workflow.

## Configuration

Two keys are required; everything else has a default.

```ts
import type { Config } from "@clipboard-health/groundcrew";

export default {
  workspace: {
    projectDir: "~/dev",
    knownRepositories: ["OWNER/REPO"],
  },
  local: {
    runner: "none",
  },
  models: {
    default: "claude",
    definitions: {
      codex: { disabled: true },
    },
  },
} satisfies Config;
```

There is no `linear` config block. Groundcrew reads `GROUNDCREW_LINEAR_API_KEY` first, then falls back to `LINEAR_API_KEY`.

## Reference

- [Configuration](./docs/configuration.md): discovery order, repo layout, full config table, prompt customization.
- [Runners](./docs/runners.md): Safehouse, Docker Sandboxes, and the `none` escape hatch.
- [Credentials](./docs/credentials.md): Linear API keys, 1Password, build secrets, and `preLaunch`.
- [Setup hooks](./docs/setup-hooks.md): `.groundcrew/setup.sh --deps-only` for per-repo dependency setup.
- [Ticket sources](./docs/ticket-sources.md): custom shell/Jira/local-plan adapters.
- [Troubleshooting](./docs/troubleshooting.md): common operational pitfalls and fixes.

## Development

Clone the repo and run the CLI from TypeScript source:

```bash
cd ~/dev/c/groundcrew
node --run crew -- doctor

# With 1Password for GROUNDCREW_LINEAR_API_KEY:
node --run crew:op -- run --watch
```

Both forms discover config through cosmiconfig. Source edits in `src/**` are picked up on the next invocation. Requires Node >= 24.

## License

[MIT](./LICENSE)
