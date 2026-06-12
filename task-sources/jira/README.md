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

### What `jira init` sets up

`jira init` is a one-time wizard that writes `~/.config/.jira/.config.yml` — the
non-secret connection details every `jira` command (and therefore `jira.sh`)
relies on. It prompts for:

- **Installation** (`Cloud` vs. on-prem Server/Data Center) and the **server
  URL** the CLI talks to.
- Your **login** email and **auth type** (`basic` = email + API token on Cloud).
- A **default project** and **board**. The default project matters here: the
  `list` JQL has no `project = …` clause, so it implicitly scopes to whatever
  project `jira init` selected.

It also introspects your instance and caches every custom-field definition, so
the config file can be large (hundreds of KB) — that is expected.

Note that `jira init` does **not** store the API token. jira-cli reads the token
from the OS keyring or the `JIRA_API_TOKEN` environment variable; this source
supplies it via the latter from a gitignored file (see [Setup](#setup) step 2).
So `jira init` owns the connection (server, login, project) and `jira.sh` layers
the token on per invocation.

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

3. **Label your issues** so groundcrew knows what to pick up and where to
   dispatch it:

   | Label                  | Example                            | Effect                                                                                                                                                                                                                                                                              |
   | ---------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `groundcrew`           | `groundcrew`                       | Opts the issue in. The default JQL fetches only issues carrying this label, so work is dispatched explicitly rather than every open issue being swept up. The label name is just a JQL convention — change the `labels = …` clause in `JIRA_GROUNDCREW_JQL` to use a different one. |
   | `repo:<name>`          | `repo:wild-horses`                 | Sets `repository: "wild-horses"`. Use a bare repository name when your config's `knownRepositories` lists it by name — no owner needed.                                                                                                                                             |
   | `repo:<Owner>__<name>` | `repo:ClipboardHealth__groundcrew` | Sets `repository: "ClipboardHealth/groundcrew"`. JIRA labels cannot contain `/`, so the slash is encoded as exactly **two** underscores (`__`).                                                                                                                                     |
   | `agent:<name>`         | `agent:claude`                     | **Optional** — omit it to use `JIRA_DEFAULT_AGENT` (`claude` in the sample config). Only add this label to override the default for a specific issue.                                                                                                                               |

   So a typical dispatchable issue carries just `groundcrew` + a `repo:` label.
   An issue without a `repo:` label is listed but not dispatchable (and with no
   `agent:` label and no `JIRA_DEFAULT_AGENT`, its agent is `null`).

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
       "JIRA_GROUNDCREW_JQL": "statusCategory != Done AND labels = groundcrew",
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

| Variable              | Default                                          | Purpose                                                                |
| --------------------- | ------------------------------------------------ | ---------------------------------------------------------------------- |
| `JIRA_GROUNDCREW_JQL` | `statusCategory != Done AND labels = groundcrew` | Which issues `list` returns. Omit `ORDER BY` (jira-cli adds its own).  |
| `JIRA_REVIEW_PATTERN` | `review`                                         | Case-insensitive regex; matching status names map to `in-review`.      |
| `JIRA_DEFAULT_AGENT`  | _(empty -> `null`)_                              | Agent used when an issue has no `agent:` label.                        |
| `JIRA_TOKEN_FILE`     | `~/.config/groundcrew/jira.token`                | Token file path.                                                       |
| `JIRA_STATE_*`        | `In Progress` / `In Review` / `Done`             | Native JIRA state names used by `move`. Match your project's workflow. |

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

- `list` returns at most 20 issues (the `--paginate 0:20` bound in `jira.sh`).
  Raise that bound or narrow `JIRA_GROUNDCREW_JQL` if you have more eligible
  issues than that.
- A query that matches nothing is the steady state (no issue is ready to
  dispatch). jira-cli treats "no results" as an error and exits non-zero, but
  `list` folds that into an empty array and exits `0`, so the shell adapter sees
  "no tasks" instead of throwing a fetch failure on every poll. Genuine failures
  (auth, network) still print to stderr and propagate as a non-zero exit.
- `jira issue list --raw` returns a reduced shape (no `id`, `self`, or
  `statusCategory`), so `list` reads the matching keys and then enriches each one
  with `jira issue view <key> --raw` — the full REST issue the transform needs.
  That means one extra API call per listed issue, so a tighter
  `JIRA_GROUNDCREW_JQL` keeps `list` fast.
- Cloud descriptions are rich text (ADF); the script flattens their text nodes
  into a plain description and prepends a `Repository:`/issue-URL header, since
  groundcrew uses the description as the agent's prompt.
- Writeback (`move`) uses the native state names from `JIRA_STATE_*`; if a
  transition name does not exist in your workflow, `jira issue move` fails and
  groundcrew surfaces the error.
