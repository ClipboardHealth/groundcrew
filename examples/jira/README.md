# JIRA shell source

A ready-to-use [`shell` task source](../../docs/task-sources.md) that feeds JIRA
issues into groundcrew using the [`jira` CLI](https://github.com/ankitpokhrel/jira-cli).
Everything lives in one script, [`jira.sh`](./jira.sh), which the shell adapter
calls with a subcommand per operation:

| Subcommand                   | Adapter command                                | What it does                                                     |
| ---------------------------- | ---------------------------------------------- | ---------------------------------------------------------------- |
| `jira.sh verify`             | `verify`                                       | Checks the token and connectivity (`jira me`).                   |
| `jira.sh list`               | `listTasks`                                    | Prints a `ShellIssue[]` JSON array for the configured JQL.       |
| `jira.sh get <KEY>`          | `getTask`                                      | Prints one `ShellIssue`, or exits `3` when the key is not found. |
| `jira.sh move <KEY> <STATE>` | `markInProgress` / `markInReview` / `markDone` | Transitions the issue.                                           |

## Prerequisites

- [`jira` CLI](https://github.com/ankitpokhrel/jira-cli) — `brew install ankitpokhrel/jira-cli/jira-cli`, then `jira init`.
- [`jq`](https://jqlang.github.io/jq/) — `brew install jq`.

## Setup

1. **Install the script** where your config references it:

   ```bash
   mkdir -p ~/.config/groundcrew
   cp examples/jira/jira.sh ~/.config/groundcrew/jira.sh
   chmod +x ~/.config/groundcrew/jira.sh
   ```

2. **Store the API token** in a gitignored file so it stays scoped to this
   source instead of your global environment ([create one here](https://id.atlassian.com/manage-profile/security/api-tokens)):

   ```bash
   echo '<your-token>' > ~/.config/groundcrew/jira.token
   chmod 600 ~/.config/groundcrew/jira.token
   ```

   The script reads the token from this file, trims surrounding whitespace (so a
   trailing newline or CRLF is fine), and exports `JIRA_API_TOKEN` only into its
   own process — nothing global, and no secret in your config file.

3. **Label your issues** so groundcrew knows where to dispatch them. JIRA labels
   cannot contain `/`, so the repository slash is encoded as `__`:
   - `repo:Owner__name` -> `repository: "Owner/name"`
   - `agent:<name>` -> `agent: "<name>"`

   An issue without a `repo:` label is listed but not dispatchable. An issue
   without an `agent:` label falls back to `JIRA_DEFAULT_AGENT` (or `null`).

4. **Add the source** to your `crew.config.json` (or `crew.config.ts`):

   ```json
   {
     "kind": "shell",
     "name": "jira",
     "commands": {
       "verify": "~/.config/groundcrew/jira.sh verify",
       "listTasks": "~/.config/groundcrew/jira.sh list",
       "getTask": "~/.config/groundcrew/jira.sh get ${id}",
       "markInProgress": "~/.config/groundcrew/jira.sh move ${id} \"$JIRA_STATE_IN_PROGRESS\"",
       "markInReview": "~/.config/groundcrew/jira.sh move ${id} \"$JIRA_STATE_IN_REVIEW\"",
       "markDone": "~/.config/groundcrew/jira.sh move ${id} \"$JIRA_STATE_DONE\""
     },
     "env": {
       "JIRA_GROUNDCREW_JQL": "statusCategory != Done ORDER BY updated DESC",
       "JIRA_REVIEW_PATTERN": "review",
       "JIRA_DEFAULT_AGENT": "claude",
       "JIRA_STATE_IN_PROGRESS": "In Progress",
       "JIRA_STATE_IN_REVIEW": "In Review",
       "JIRA_STATE_DONE": "Done"
     },
     "timeouts": {
       "listTasks": 60000,
       "markInReview": 15000,
       "markDone": 15000
     }
   }
   ```

## Configuration knobs

The script reads these from the source's `env` block:

| Variable              | Default                                        | Purpose                                                                |
| --------------------- | ---------------------------------------------- | ---------------------------------------------------------------------- |
| `JIRA_GROUNDCREW_JQL` | `statusCategory != Done ORDER BY updated DESC` | Which issues `list` returns.                                           |
| `JIRA_REVIEW_PATTERN` | `review`                                       | Case-insensitive regex; matching status names map to `in-review`.      |
| `JIRA_DEFAULT_AGENT`  | _(empty -> `null`)_                            | Agent used when an issue has no `agent:` label.                        |
| `JIRA_TOKEN_FILE`     | `~/.config/groundcrew/jira.token`              | Token file path.                                                       |
| `JIRA_STATE_*`        | `In Progress` / `In Review` / `Done`           | Native JIRA state names used by `move`. Match your project's workflow. |

## Status mapping

JIRA Cloud groups statuses into three `statusCategory` keys; groundcrew needs
five. There is no "in-review" category, so review is detected by status _name_:

| JIRA `statusCategory.key` | Canonical status                                                                 |
| ------------------------- | -------------------------------------------------------------------------------- |
| `new`                     | `todo`                                                                           |
| `indeterminate`           | `in-progress`, or `in-review` when the status name matches `JIRA_REVIEW_PATTERN` |
| `done`                    | `done`                                                                           |
| anything else             | `other`                                                                          |

## Notes

- `list` returns at most 100 issues (the `jira` CLI's per-page maximum). Narrow
  `JIRA_GROUNDCREW_JQL` if you have more eligible issues than that.
- Cloud descriptions are rich text (ADF); the script flattens their text nodes
  into a plain description and prepends a `Repository:`/issue-URL header, since
  groundcrew uses the description as the agent's prompt.
- Writeback (`move`) uses the native state names from `JIRA_STATE_*`; if a
  transition name does not exist in your workflow, `jira issue move` fails and
  groundcrew surfaces the error.
