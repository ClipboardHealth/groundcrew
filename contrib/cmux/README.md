# cmux custom sidebar

A [custom cmux sidebar](https://cmux.com/docs/custom-sidebars) that renders crew tasks as a list:
ticket link, worktree directory, PR button, and a cleanup action per workspace.

## Install

```bash
./contrib/cmux/install.sh
cmux sidebar select groundcrew
```

The script copies `groundcrew.swift` to `~/.config/cmux/sidebars/`, substitutes the groundcrew
checkout path, and validates the result. It backs up any sidebar already installed under that name.
Set `GROUNDCREW_DIR` to override the checkout path when running the script from outside the repo.

Re-run it after pulling changes to this file.

## What it renders

Workspaces split into two sections:

- **Workbench** lists pinned workspaces with their tabs, each tab a focus button.
- **Groundcrew** lists everything else that looks like a task, meaning it has a PR, a cmux status
  lane, or a ticket id.

Ticket ids are read from the worktree directory name (`…-tg-4265`) or the leading token of the
workspace title (`TG-4265 …`), then linked into the Linear desktop app. The right-click menu offers
`Close workspace` and, for rows with a ticket, `Cleanup workspace`, which opens a new workspace in
the groundcrew checkout running `crew cleanup <ticket>` and closes the task workspace on success.
Cleanup keeps crew's dirty-worktree guard, so uncommitted changes must be inspected before removal.

PR links open in Linear Reviews by default. Set `prLinkTarget()` at the top of the file to
`"linear-app"` (desktop app, the default), `"linear"` (`linear.review` in the browser), or
`"github"`. Both Linear targets are derived from the GitHub PR URL, so they work whether or not the
PR has a linked Linear ticket.

## Requirements

- cmux with the custom sidebar interpreter. Verified against 0.64.19; the interpreter is beta and
  its accepted syntax has shifted between releases, so `cmux sidebar validate groundcrew` is the
  check that matters after an upgrade. Agent rows additionally need a build that exposes `agents`
  in the sidebar data context.
- `crew` on `PATH` for the cleanup action.
- Linear desktop app for the ticket links, which use the `linear://` scheme against the
  `clipboardhealth` workspace, and for PR links when `prLinkTarget()` is `"linear-app"`.

## Agent rows

When cmux reports coding-agent sessions for a workspace (`w.agents`), each session renders as its
own row: a runtime icon, that session's state icon, and its state text. A workspace running two
agents shows two rows with independent states rather than one merged pill.

The runtime icon distinguishes Claude from Codex at a glance — orange `sparkles` and near-black
`circle.hexagongrid.fill`, with `gemini`, `grok`, and `opencode` mapped as well and `cpu` for
anything else. The interpreter's `Image` resolves system symbols only, so cmux's own `AgentIcons`
brand assets cannot be used here; hover a row for a tooltip naming the runtime, its state, and the
conversation title when cmux knows one.

Agent states are `idle`, `working`, `needs_input`, and `ended`. `needs_input` reads as "needs you"
and pulses, since it is the one state that blocks on a human.

This needs a cmux new enough to expose `agents` in the sidebar data context. On older builds the
array is absent and the sidebar falls back to the status pill below, so the file stays installable
either way.

## Status pills

The pill is the fallback when no agent sessions are reported. It comes from cmux's native status
entries, which `cmux set-status <key> <value>` writes and `cmux list-status` reads back. Entries are
keyed so several tools can register their own: `applyCmuxStatus` in `src/lib/cmuxAdapter.ts`
registers `agent`, and the Claude Code cmux hooks register `claude_code`. The sidebar reads
`w.status` and falls back to its own `stateColor` / `stateIcon` mapping when an entry arrives
without a color or icon.

Agent rows take precedence because both describe lifecycle state and the per-agent rows carry
strictly more of it. The row's accent bar and background still follow the native entry when there is
one, and the first agent's state otherwise.

The comment above the `applyCmuxStatus` call site claims cmux v2 dropped `set-status`. That is stale
as of cmux 0.64.19, where the command is present and succeeds.

## Known limits

Task detection depends on the naming conventions above. Workspaces created outside crew, or with
renamed titles and directories, render in the task list without a ticket link.

`cmux workspace list --json` reports `status` and `pr` as null regardless of what is set, since
status entries are a separate surface reached through `cmux list-status`. The CLI JSON is not a way
to check what the sidebar will render.
