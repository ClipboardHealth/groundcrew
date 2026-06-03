<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./static/groundcrew-wordmark-dark.svg">
    <img alt="groundcrew" src="./static/groundcrew-wordmark-light.svg" height="96">
  </picture>
</p>

<p align="center">
  Dispatch your ticket backlog to local, interactive AI coding agents. One git worktree per ticket, sandboxed by default.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@clipboard-health/groundcrew"><img alt="npm" src="https://img.shields.io/npm/v/@clipboard-health/groundcrew?style=flat-square&label=npm&color=77d94e&labelColor=18181b"></a>
  <a href="https://www.npmjs.com/package/@clipboard-health/groundcrew"><img alt="downloads" src="https://img.shields.io/npm/dw/@clipboard-health/groundcrew?style=flat-square&label=downloads&color=18181b&labelColor=18181b"></a>
  <a href="https://github.com/ClipboardHealth/groundcrew/actions/workflows/ci.yml"><img alt="ci" src="https://img.shields.io/github/actions/workflow/status/ClipboardHealth/groundcrew/ci.yml?style=flat-square&label=ci&color=77d94e&labelColor=18181b"></a>
  <a href="./LICENSE"><img alt="license" src="https://img.shields.io/npm/l/@clipboard-health/groundcrew?style=flat-square&label=license&color=18181b&labelColor=18181b"></a>
</p>

<p align="center">
  <a href="./static/demo.tape"><img alt="Groundcrew dispatching tickets into tmux panes with coding agents running in parallel" src="./static/demo.gif" width="800"></a>
</p>

<p align="center">
  VHS source: <a href="./static/demo.tape">static/demo.tape</a>.
</p>

Groundcrew watches assigned tickets, creates isolated worktrees, launches agent CLIs in dedicated terminals, and leaves each ticket's work on its own PR-ready branch. For the backstory, read _[Tickets to pull requests while you sleep](https://www.clipboardworks.com/resources/blog/tickets-to-pull-requests-while-you-sleep)_.

## Why

- **Local.** Agents run on your machine with your tools, shell, and credentials. That makes them more steerable than remote agents, and easy to nudge when they drift.
- **Interactive.** Each ticket launches the real `claude` or `codex` CLI in its own terminal pane, not a wrapper that approximates it. Watch any session live and take over when you need to.
- **One worktree per ticket.** Agents work in parallel without stepping on each other.
- **Sandboxed by default.** Safehouse or Docker Sandboxes isolate each agent on the host; `none` is an explicit escape hatch.
- **Pluggable ticket sources.** Linear by default; Jira and local files via [ticket sources](./docs/ticket-sources.md).
- **Multi-agent routing.** Ships `claude` and `codex` presets; bring your own CLI in config.

## Prerequisites

`crew doctor` checks all of these, so you can install as you go.

- **Node >= 24:** [nvm](https://github.com/nvm-sh/nvm): `nvm install 24`.
- **git:** e.g., `brew install git`, `apt install git`.
- **A terminal multiplexer:** [tmux](https://github.com/tmux/tmux/wiki/Installing) (cross-platform) or [cmux](https://cmux.com/) (macOS).
- **An agent CLI:** [Claude Code](https://code.claude.com/docs/en/quickstart) and/or [Codex](https://developers.openai.com/codex/quickstart?setup=cli).
- **A sandbox runner:** [Docker Sandboxes](https://docs.docker.com/ai/sandboxes/) (cross-platform) or [Safehouse](https://agent-safehouse.dev/) on macOS. Skip only with `--runner none`.

## Quickstart

```bash
# 1. Install groundcrew.
npm install -g @clipboard-health/groundcrew@latest

# 2. Scaffold a global config. Agents are sandboxed by default
#    (Safehouse/Docker Sandboxes); add --runner none to run unsandboxed on the host.
crew init --global --project-dir ~/dev --repo OWNER/REPO --model claude

# 3. Run the clone commands printed by `crew init`.

# 4. Using Linear? Export your API key. (Jira and other trackers: see Ticket Pickup.)
export GROUNDCREW_LINEAR_API_KEY="lin_api_..."

# 5. Verify setup, then dispatch.
crew doctor
crew run --watch
```

`crew init --global` writes config to `${XDG_CONFIG_HOME:-$HOME/.config}/groundcrew/`. Pass `--repo` more than once for multiple repos. `--model claude` or `--model codex` chooses the single built-in model preset to enable in the generated config.

## Ticket Pickup

**Not on Linear?** Use Jira or local files via [ticket sources](./docs/ticket-sources.md).

Linear works out of the box: assign tickets to yourself and add an `agent-*` label.

- `agent-claude`, `agent-codex`, or `agent-<name>` routes to that model.
- `agent-any` routes to the enabled model with the most available capacity.
- Tickets without an `agent-*` label are ignored by `crew run`; dispatch one manually with `crew start <TICKET>`.

Groundcrew scans `workspace.knownRepositories` to infer which repo a ticket belongs to.

A ticket blocked by non-terminal blockers is skipped until those blockers are done.

## Commands

```bash
crew init [--global | --local] [--force] [--dry-run]     # create a crew.config.ts
          [--project-dir <dir>] [--repo <repo>]...
          [--runner <auto|safehouse|sdx|none>] [--model <claude|codex>]
crew doctor                                              # check setup
crew status [<TICKET>]                                   # inspect current state or one ticket
crew run [--watch]                                       # one-shot or --watch forever
crew start <TICKET>                                      # provision + launch one ticket now
crew stop <TICKET> [--reason <text>]                     # stop workspace, keep worktree
crew resume <TICKET>                                     # reopen a paused ticket
crew cleanup <TICKET>                                    # tear down every worktree for a ticket
crew upgrade [<version>]                                 # reinstall crew globally through npm
```

See [command details](./docs/commands.md) for status output, doctor behavior, and the stop/resume workflow.

## Configuration

Workspace settings and at least one enabled model are required; everything else has a default.

```ts
import type { Config } from "@clipboard-health/groundcrew";

export default {
  workspace: {
    projectDir: "~/dev",
    knownRepositories: ["OWNER/REPO"],
  },
  models: {
    default: "claude",
    definitions: {
      claude: {},
    },
  },
  defaults: {
    hooks: {
      // No-op placeholder; replace with your repo's setup, e.g. "npm ci".
      prepareWorktree: "true",
    },
  },
} satisfies Config;
```

There is no `linear` config block. Groundcrew reads `GROUNDCREW_LINEAR_API_KEY` first, then falls back to `LINEAR_API_KEY`.

## Reference

- [Configuration](./docs/configuration.md): discovery order, repo layout, full config table, prompt customization.
- [Runners](./docs/runners.md): Safehouse, Docker Sandboxes, and the `none` escape hatch.
- [Credentials](./docs/credentials.md): Linear API keys, 1Password, build secrets, and `preLaunch`.
- [Prepare worktree hooks](./docs/setup-hooks.md): `.groundcrew/config.json` `hooks.prepareWorktree` for per-repo dependency setup.
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

Regenerate the README demo with VHS:

```bash
./static/render-demo.sh
```

## License

[MIT](./LICENSE)
