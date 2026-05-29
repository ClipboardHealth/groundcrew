# Troubleshooting

First stop for "what exists locally right now": `crew status <ticket>` shows the ticket's worktrees, workspace presence, run state, logs, and ticket-source status. Use `crew doctor` when you need to verify host setup.

## Missing Model CLI

`models.definitions` includes both shipped defaults (`claude`, `codex`) by default via additive merge. If you only intend to label tickets `agent-claude` and do not have `codex` installed, initialize with `crew init --model claude` or set:

```ts
models: {
  default: "claude",
  definitions: {
    codex: { disabled: true },
  },
},
```

Without that, doctor exits non-zero on a missing `codex` binary even though `crew run` would never route to it.

## Safehouse-Wrapped Commands Are Not Re-Wrapped

If a `models.definitions.<name>.cmd` already starts with `safehouse`, groundcrew assumes that command owns its Safehouse flags and does not add the `safehouse-clearance` wrapper a second time. Changing the proxy's allowlist after it is running requires killing the PID in `${XDG_CACHE_HOME:-$HOME/.cache}/clearance/clearance.pid` so the next launch picks up the new env.

## Dead Tmux Windows Vanish By Default

When a wrapped agent command fails, the tmux window closes immediately and the error scrolls away. Set `GROUNDCREW_KEEP_DEAD_WINDOWS=1` in the env you launch `crew` from to flip the per-window `remain-on-exit` to `on`; the window stays open with the error visible. Close it manually with `tmux kill-window -t groundcrew:<ticket>` after diagnosis.

This applies to the tmux backend only.

## Tickets Stay In-Progress

Groundcrew sets a ticket to `Started`, the first workflow state with `type === "started"` on that team, when it provisions a workspace and never advances it. The next transition, typically "In Review" when a PR opens, is left to your Linear automation rules.

## Claude Launches In Auto Mode By Default

Groundcrew creates isolated per-ticket worktrees for unattended runs, so the shipped `claude` command is `claude --permission-mode auto` to let Claude proceed without stopping for clarifying questions while keeping its built-in safety prompts intact. Override `models.definitions.claude.cmd` for `bypassPermissions` if you need to suppress tool-permission prompts entirely, or for a stricter mode.

## Doctor's Command Introspection Is Shallow

Doctor reports the resolved local runner and whether its prerequisites are met, then tokenizes model `cmd` and checks the first two non-flag tokens against PATH. Boolean flags without values, env-var assignments (`FOO=1`), shell pipelines, and subshells are not parsed. When `local.runner` is `"none"`, doctor surfaces a single WARNING line.

## Switch To Tmux If Cmux Is Misbehaving

Set `workspaceKind: "tmux"` to force the tmux backend when cmux's CLI/socket bridge is flaky, such as `cmux --json list-workspaces` returning `Failed to write to socket (Broken pipe)` or `Socket not found at ...cmux.sock` on every tick. Tmux is more reliable because it uses a unix socket, at the cost of losing cmux's status pills, notifications, and sidebar.

## Agent CLI Must Accept A Positional Prompt

The handoff is `<your cmd> "<prompt>"`. `claude`, `codex`, and `cursor-agent` all support this.
