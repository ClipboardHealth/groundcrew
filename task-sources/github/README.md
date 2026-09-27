# GitHub Issues shell source

A ready-to-use [`shell` task source](../../docs/task-sources.md) that feeds GitHub
issues into groundcrew using the [GitHub CLI](https://cli.github.com/) (`gh`).
Everything lives in one script, [`github.sh`](./github.sh), which the shell
adapter calls with a subcommand per operation:

| Subcommand                    | Adapter command                                | What it does                                                    |
| ----------------------------- | ---------------------------------------------- | --------------------------------------------------------------- |
| `github.sh verify`            | `verify`                                       | Checks `gh` is authenticated (`gh auth status`).                |
| `github.sh list`              | `listTasks`                                    | Prints a `ShellIssue[]` JSON array for the configured query.    |
| `github.sh get <ID>`          | `getTask`                                      | Prints one `ShellIssue`, or exits `3` when the issue is absent. |
| `github.sh move <ID> <STATE>` | `markInProgress` / `markInReview` / `markDone` | Relabels (`in-progress`, `in-review`) or closes (`done`).       |

## Prerequisites

- [`gh`](https://cli.github.com/), then `gh auth login`:
  - macOS: `brew install gh`
  - Linux: `sudo apt-get install gh` (see [other installs](https://github.com/cli/cli#installation))
- [`jq`](https://jqlang.github.io/jq/):
  - macOS: `brew install jq`
  - Linux: `sudo apt-get install jq`

The script uses `gh`'s own authentication, so there is no token file. `move`
needs write access to the issue's repository (to edit labels and close issues).

## Setup

1. **Install the script** where your config references it:

   ```bash
   mkdir -p ~/.config/groundcrew
   cp task-sources/github/github.sh ~/.config/groundcrew/github.sh
   chmod +x ~/.config/groundcrew/github.sh
   ```

2. **Label your issues** so groundcrew knows what to pick up:

   | Label          | Example        | Effect                                                                                                                                                                               |
   | -------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
   | `groundcrew`   | `groundcrew`   | Opts the issue in. The default query also requires the issue to be assigned to you, so nobody else's issues are swept up. Change `GITHUB_GROUNDCREW_QUERY` to use other qualifiers.  |
   | `agent:<name>` | `agent:claude` | Sets `agent: "claude"`. Omit it only when `GITHUB_DEFAULT_AGENT` is configured; the shipped source leaves that default empty so unlabeled issues are listed but not auto-dispatched. |

   The repository is always the issue's own repository, so no `repo:` label is
   needed. A typical dispatchable issue is assigned to you and carries
   `groundcrew` + an `agent:` label.

3. **Add the source** to your `crew.config.json` (or `crew.config.ts`):

   ```json
   {
     "kind": "shell",
     "name": "github",
     "commands": {
       "verify": "~/.config/groundcrew/github.sh verify",
       "listTasks": "~/.config/groundcrew/github.sh list",
       "getTask": "~/.config/groundcrew/github.sh get ${id}",
       "markInProgress": "~/.config/groundcrew/github.sh move ${id} in-progress",
       "markInReview": "~/.config/groundcrew/github.sh move ${id} in-review",
       "markDone": "~/.config/groundcrew/github.sh move ${id} done"
     },
     "env": {
       "GITHUB_GROUNDCREW_QUERY": "label:groundcrew assignee:@me",
       "GITHUB_DEFAULT_AGENT": "",
       "GITHUB_IN_PROGRESS_LABEL": "groundcrew:in-progress",
       "GITHUB_IN_REVIEW_LABEL": "groundcrew:in-review"
     },
     "timeouts": {
       "listTasks": 60000
     }
   }
   ```

## Configuration knobs

The script reads these from the source's `env` block:

| Variable                   | Default                         | Purpose                                                                                                                                                              |
| -------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GITHUB_GROUNDCREW_QUERY`  | `label:groundcrew assignee:@me` | [Search qualifiers](https://docs.github.com/en/search-github/searching-on-github/searching-issues-and-pull-requests) for `list`. Add `repo:` or `org:` to narrow it. |
| `GITHUB_DEFAULT_AGENT`     | _(empty -> `null`)_             | Agent used when an issue has no `agent:` label.                                                                                                                      |
| `GITHUB_IN_PROGRESS_LABEL` | `groundcrew:in-progress`        | Label `move ... in-progress` adds, and `list`/`get` read as `in-progress`.                                                                                           |
| `GITHUB_IN_REVIEW_LABEL`   | `groundcrew:in-review`          | Label `move ... in-review` adds, and `list`/`get` read as `in-review`.                                                                                               |

## Task ids

Task ids carry the issue's repository, so `get` and `move` need no lookup:
`ClipboardHealth/groundcrew#412` becomes `ClipboardHealth__groundcrew-412`.
`/` and `#` are not safe in worktree paths and branch names, and GitHub owners
cannot contain `_`, so the first `__` always separates owner from repository.

## Status mapping

GitHub issues are only open or closed, so the in-flight states are labels:

| Issue                             | Canonical status |
| --------------------------------- | ---------------- |
| open, no status label             | `todo`           |
| open + `GITHUB_IN_PROGRESS_LABEL` | `in-progress`    |
| open + `GITHUB_IN_REVIEW_LABEL`   | `in-review`      |
| closed (completed or not planned) | `done`           |

`move` creates the status label in the repository on first use and removes the
other status label, so an issue carries at most one. `move ... done` removes both
and closes the issue; an issue already closed by a merged `Fixes #N` PR is left
as is.

## Notes

- `list` runs two searches, open issues and issues closed in the last 7 days,
  each capped at 50 results. groundcrew only tears down a task's worktree once
  `list`/`get` report it `done`, so dropping closed issues immediately would
  leak worktrees; the 7-day window gives cleanup time to run.
- Search results omit comments, so `list` enriches each hit with
  `gh issue view`: one extra API call per listed issue. A tighter
  `GITHUB_GROUNDCREW_QUERY` keeps `list` fast. Search is rate limited to 30
  requests per minute, and each `list` uses two.
- Issue comments are appended to the description under a `--- Comments ---`
  heading (oldest first, each headed by author and timestamp), since the
  description is what the agent sees.
- `get` exits `3` for a missing issue or repository, and for a pull request
  number (`gh issue view` also resolves PRs). Auth and network failures exit `1`
  so groundcrew retries instead of treating the task as vanished. The not-found
  check matches `gh`'s `Could not resolve to` wording, validated against gh 2.93.
- Blockers are not read: `blockers` is always empty.
