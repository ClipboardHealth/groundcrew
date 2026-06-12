# Troubleshooting

First stop for "what exists locally right now": `crew status <task>` shows the task's worktrees, workspace presence, run state, logs, and task-source status. Use `crew doctor` when you need to verify host setup.

## Missing Agent CLI

`crew doctor` probes every agent listed in `agents.definitions`. If you do not have `codex` installed, initialize with `crew init --agent claude` or leave `codex` out of the enabled agent set:

```ts
agents: {
  default: "claude",
  definitions: {
    claude: {},
  },
},
```

If `codex: {}` is listed, doctor expects the `codex` CLI to be installed because tasks can route to `agent-codex` and `agent-any` can select it.

## Safehouse-Wrapped Commands Are Not Re-Wrapped

If a `agents.definitions.<name>.cmd` already starts with `safehouse`, groundcrew assumes that command owns its Safehouse flags and does not add the `safehouse-clearance` wrapper a second time. Changing the proxy's allowlist after it is running requires killing the PID in `${XDG_CACHE_HOME:-$HOME/.cache}/clearance/clearance.pid` so the next launch picks up the new env.

## Dead Tmux Windows Vanish By Default

When a wrapped agent command fails, the tmux window closes immediately and the error scrolls away. Set `GROUNDCREW_KEEP_DEAD_WINDOWS=1` in the env you launch `crew` from to flip the per-window `remain-on-exit` to `on`; the window stays open with the error visible. `crew status` reports those kept windows as `exited` and keeps the tmux attach command visible so you can inspect scrollback before resuming or cleaning up.

This applies to the tmux backend only.

## Tasks Stay In-Progress

Groundcrew marks a task `In Progress` when it provisions a workspace. When a PR opens on that worktree branch, the reviewer pass attempts to mark the task `In Review`. Linear's default `In Review` status works out of the box; if your team renamed it, configure `sources: [{ kind: "linear", statuses: { inReview: ["Code Review"] } }]`.

If the task intentionally has no PR, mark it complete with `crew task done <task-id>`. Groundcrew refuses dirty matching worktrees with no PR unless you pass `--allow-dirty`, so inspect or commit/stash unexpected changes first. For todo-txt tasks with `rec:`, this completion path also lets the source schedule the next recurrence.

## Claude Launches In Auto Mode By Default

Groundcrew creates isolated per-task worktrees for unattended runs, so the shipped `claude` command is `claude --permission-mode auto` to let Claude proceed without stopping for clarifying questions while keeping its built-in safety prompts intact. Override `agents.definitions.claude.cmd` for `bypassPermissions` if you need to suppress tool-permission prompts entirely, or for a stricter mode.

## Doctor's Command Introspection Is Shallow

Doctor reports the resolved local runner and whether its prerequisites are met, then tokenizes agent `cmd` and checks the first two non-flag tokens against PATH. Boolean flags without values, env-var assignments (`FOO=1`), shell pipelines, and subshells are not parsed. When `local.runner` is `"none"`, doctor surfaces a single WARNING line.

## Switch To Tmux If Cmux Is Misbehaving

Set `workspaceKind: "tmux"` to force the tmux backend when cmux's CLI/socket bridge is flaky, such as `cmux --json list-workspaces` returning `Failed to write to socket (Broken pipe)` or `Socket not found at ...cmux.sock` on every tick. Tmux is more reliable because it uses a unix socket, at the cost of losing cmux's status pills, notifications, and sidebar.

## Zellij Backend

Set `workspaceKind: "zellij"` to run agents as tabs in a shared `groundcrew` zellij session. Each ticket is a named tab; `main` tails the live `crew run` log. Attach with `zellij attach groundcrew` (the session is created on first dispatch, so it does not exist until a ticket runs). When an agent exits on its own its tab stays and `crew status` reports it as `exited`; a groundcrew-issued close removes the tab. groundcrew also drops a stale resurrectable `groundcrew` session on launch so dead agent tabs from a previous run are not replayed on attach.

![A groundcrew agent running in a zellij tab](../static/zellij.png)

## Agent CLI Must Accept A Positional Prompt

The handoff is `<your cmd> "<prompt>"`. `claude`, `codex`, and `cursor-agent` all support this.
