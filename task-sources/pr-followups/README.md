# PR-followups shell source

A ready-to-use [`shell` task source](../../docs/task-sources.md) that watches a
repository's merged pull requests and emits one groundcrew task per newly merged
PR. Each task asks an agent to decide whether a small followup refactoring is
warranted and, if so, open a followup PR. Everything lives in one script,
[`pr-followups.sh`](./pr-followups.sh), which the shell adapter calls with a
subcommand per operation:

| Subcommand                      | Adapter command | What it does                                                          |
| ------------------------------- | --------------- | --------------------------------------------------------------------- |
| `pr-followups.sh verify`        | `verify`        | Checks `gh` auth and repo reachability.                               |
| `pr-followups.sh list`          | `listTasks`     | Prints a `ShellIssue[]` for merged PRs not yet handled.               |
| `pr-followups.sh get <ID>`      | `getTask`       | Prints one `ShellIssue`, or exits `3` when the PR is absent/unmerged. |
| `pr-followups.sh reviewed <ID>` | `markInReview`  | Records the PR as handled (a followup PR was opened).                 |
| `pr-followups.sh complete <ID>` | `markDone`      | Records the PR as handled (no-op completion or followup merged).      |

## How it works

The source is **read-only on GitHub**: it never labels or comments on the
upstream repo, so contributors without push access can run it. Dedup state lives
in a local JSON file per repo (`{floor, handled}`) under
`~/.config/groundcrew/pr-followups-state/<owner>__<name>.json`:

- `floor` is a low-water mark initialized to install time (no historical
  backfill). It advances over time across the contiguous run of fully-handled
  PRs, bounding both the state file and the query window.
- `handled` is the set of PR numbers that reached a terminal state. A PR is
  recorded only on `reviewed`/`complete`, never on emit, so a crashed agent run
  is retried rather than silently dropped.

Loop prevention: followup PRs are opened on `gc-followup/*` branches, which the
`list` query skips, so a merged followup never spawns a followup-of-a-followup.

## Prerequisites

- [`gh` CLI](https://cli.github.com) - `brew install gh`, then `gh auth login`.
- [`jq`](https://jqlang.github.io/jq/) - `brew install jq`.

## Install

1. **Copy the script** to `~/.config/groundcrew/`:

   ```bash
   mkdir -p ~/.config/groundcrew
   cp task-sources/pr-followups/pr-followups.sh ~/.config/groundcrew/pr-followups.sh
   chmod +x ~/.config/groundcrew/pr-followups.sh
   ```

2. **Add the source** to your `crew.config.json` (or `crew.config.ts`):

   ```json
   {
     "kind": "shell",
     "name": "pr-followups",
     "commands": {
       "verify": "~/.config/groundcrew/pr-followups.sh verify",
       "listTasks": "~/.config/groundcrew/pr-followups.sh list",
       "getTask": "~/.config/groundcrew/pr-followups.sh get ${id}",
       "markInReview": "~/.config/groundcrew/pr-followups.sh reviewed ${id}",
       "markDone": "~/.config/groundcrew/pr-followups.sh complete ${id}"
     },
     "env": {
       "PR_FOLLOWUPS_BASE": "main",
       "PR_FOLLOWUPS_BRANCH_GLOB": "gc-followup/*"
     }
   }
   ```

   Set `PR_FOLLOWUPS_REPO` in the `env` block to the `owner/name` you want
   watched, or run from within that repo's directory so the script can derive it
   via `gh repo view`.

## Knobs (set via the source's `env` block)

| Variable                   | Default                                   | Meaning                               |
| -------------------------- | ----------------------------------------- | ------------------------------------- |
| `PR_FOLLOWUPS_REPO`        | derived via `gh repo view`                | `owner/name` to watch.                |
| `PR_FOLLOWUPS_BASE`        | `main`                                    | Base branch whose merges are watched. |
| `PR_FOLLOWUPS_BRANCH_GLOB` | `gc-followup/*`                           | Followup branch glob (loop guard).    |
| `PR_FOLLOWUPS_AGENT`       | empty (`null`)                            | Agent assigned to emitted tasks.      |
| `PR_FOLLOWUPS_STATE_DIR`   | `~/.config/groundcrew/pr-followups-state` | Where per-repo state files live.      |

## Customizing the rubric

The refactorings the agent considers live in the `RUBRIC` block at the top of
`pr-followups.sh`. Edit that block to change what counts as a worthwhile
followup. Keep the instruction to open the followup PR on a `gc-followup/<N>-*`
branch and to run `$GROUNDCREW_COMPLETE` when nothing applies, or the loop guard
and no-op path will not work.
