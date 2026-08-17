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

## Requirements

- cmux with the custom sidebar interpreter. Verified against 0.64.19; the interpreter is beta and
  its accepted syntax has shifted between releases, so `cmux sidebar validate groundcrew` is the
  check that matters after an upgrade.
- `crew` on `PATH` for the cleanup action.
- Linear desktop app for the ticket links, which use the `linear://` scheme against the
  `clipboardhealth` workspace.

## Status pills

The pill on each row comes from cmux's native status entries, which `cmux set-status <key> <value>`
writes and `cmux list-status` reads back. Entries are keyed so several tools can register their own:
`applyCmuxStatus` in `src/lib/cmuxAdapter.ts` registers `agent`, and the Claude Code cmux hooks
register `claude_code`. The sidebar reads `w.status` and falls back to its own `stateColor` /
`stateIcon` mapping when an entry arrives without a color or icon.

The comment above the `applyCmuxStatus` call site claims cmux v2 dropped `set-status`. That is stale
as of cmux 0.64.19, where the command is present and succeeds.

## Known limits

Task detection depends on the naming conventions above. Workspaces created outside crew, or with
renamed titles and directories, render in the task list without a ticket link.

`cmux workspace list --json` reports `status` and `pr` as null regardless of what is set, since
status entries are a separate surface reached through `cmux list-status`. The CLI JSON is not a way
to check what the sidebar will render.
