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
the groundcrew checkout running `crew cleanup <ticket> --force` and closes the task workspace on
success.

## Requirements

- cmux with the custom sidebar interpreter. Verified against 0.64.19; the interpreter is beta and
  its accepted syntax has shifted between releases, so `cmux sidebar validate groundcrew` is the
  check that matters after an upgrade.
- `crew` on `PATH` for the cleanup action.
- Linear desktop app for the ticket links, which use the `linear://` scheme against the
  `clipboardhealth` workspace.

## Known limits

Status pills and PR buttons only render when cmux populates `status` and `pr` on the workspace.
`applyCmuxStatus` in `src/lib/cmuxAdapter.ts` still shells out to `cmux set-status`, which cmux v2
removed, so the status pill is currently dormant and rows fall back to title, directory, and ticket.
The `stateColor` / `stateIcon` helpers are wired for a status feed that does not exist yet.

Task detection depends on the naming conventions above. Workspaces created outside crew, or with
renamed titles and directories, render in the task list without a ticket link.
