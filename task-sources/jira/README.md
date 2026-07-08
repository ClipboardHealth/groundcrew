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

- [`jira` CLI](https://github.com/ankitpokhrel/jira-cli), then `jira init`:
  - macOS: `brew install ankitpokhrel/jira-cli/jira-cli`
  - Linux: `go install github.com/ankitpokhrel/jira-cli/cmd/jira@latest` (or grab a
    binary from the [releases page](https://github.com/ankitpokhrel/jira-cli/releases))
- [`jq`](https://jqlang.github.io/jq/):
  - macOS: `brew install jq`
  - Linux: `sudo apt-get install jq`

> **Note:** `list` and `get` detect "no results" and "not found" by matching the
> `jira` CLI's stderr wording (it exposes no machine-readable signal for either).
> Those strings are validated against **jira-cli 1.7.x**; re-verify them if you
> upgrade the CLI, since a reworded message would be misread as a real failure.

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
   cp task-sources/jira/jira.sh ~/.config/groundcrew/jira.sh
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

   | Label                  | Example                            | Effect                                                                                                                                                                                                                                                                                                         |
   | ---------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `groundcrew`           | `groundcrew`                       | Opts the issue in. The default JQL fetches only issues carrying this label, so work is dispatched explicitly rather than every open issue being swept up. The label name is just a JQL convention — change the `labels = …` clause in `JIRA_GROUNDCREW_JQL` to use a different one.                            |
   | `repo:<name>`          | `repo:wild-horses`                 | Sets `repository: "wild-horses"`. Use a bare repository name when your config's `knownRepositories` lists it by name — no owner needed.                                                                                                                                                                        |
   | `repo:<Owner>__<name>` | `repo:ClipboardHealth__groundcrew` | Sets `repository: "ClipboardHealth/groundcrew"`. JIRA labels cannot contain `/`, so the slash is encoded as exactly **two** underscores (`__`). Every `__` decodes to `/`, so only two-component `Owner/name` repos are supported — a repository whose owner or name itself contains `__` cannot be expressed. |
   | `agent:<name>`         | `agent:claude`                     | **Optional** — omit it to use `JIRA_DEFAULT_AGENT` (`claude` in the sample config). Only add this label to override the default for a specific issue.                                                                                                                                                          |

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
       "JIRA_GROUNDCREW_JQL": "labels = groundcrew AND (statusCategory != Done OR (statusCategory = Done AND updated >= -7d))",
       "JIRA_REVIEW_PATTERN": "review",
       "JIRA_TODO_PATTERN": "",
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

| Variable              | Default                                                                                          | Purpose                                                                                                                                                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `JIRA_GROUNDCREW_JQL` | `labels = groundcrew AND (statusCategory != Done OR (statusCategory = Done AND updated >= -7d))` | Which issues `list` returns, capped at the first 20 (`--paginate 0:20` in `jira.sh`). Defaults to open issues plus those done in the last 7 days (so groundcrew can clean up their worktrees). Omit `ORDER BY` (jira-cli adds its own). |
| `JIRA_REVIEW_PATTERN` | `review`                                                                                         | Case-insensitive regex; matching In-Progress status names map to `in-review`.                                                                                                                                                           |
| `JIRA_TODO_PATTERN`   | _(empty -> off)_                                                                                 | Case-insensitive regex; matching In-Progress status names map to `todo` so groundcrew dispatches them as new work. Set it to e.g. `acknowledged` for an "Acknowledged" triage status. Checked before `JIRA_REVIEW_PATTERN`.             |
| `JIRA_DEFAULT_AGENT`  | _(empty -> `null`)_                                                                              | Agent used when an issue has no `agent:` label.                                                                                                                                                                                         |
| `JIRA_TOKEN_FILE`     | `~/.config/groundcrew/jira.token`                                                                | Token file path.                                                                                                                                                                                                                        |
| `JIRA_STATE_*`        | `In Progress` / `In Review` / `Done`                                                             | Native JIRA state names used by `move`. Match your project's workflow.                                                                                                                                                                  |

## Status mapping

JIRA Cloud groups statuses into three `statusCategory` keys; groundcrew needs
five. The catch-all `indeterminate` ("In Progress") category covers in-flight
workflow, so `in-review` and `todo` are recovered from the status _name_: a name
matching `JIRA_TODO_PATTERN` demotes to `todo` (so e.g. an "Acknowledged" triage
status is dispatched as new work); a name matching `JIRA_REVIEW_PATTERN` promotes
to `in-review`. The todo pattern is checked first.

| JIRA `statusCategory.key` | Canonical status                                                                                                        |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `new`                     | `todo`                                                                                                                  |
| `indeterminate`           | `in-progress`; `todo` when the name matches `JIRA_TODO_PATTERN`, else `in-review` when it matches `JIRA_REVIEW_PATTERN` |
| `done`                    | `done`                                                                                                                  |
| anything else             | `other`                                                                                                                 |

## Notes

- `list` returns at most 20 issues (the `--paginate 0:20` bound in `jira.sh`).
  Raise that bound or narrow `JIRA_GROUNDCREW_JQL` if you have more eligible
  issues than that.
- The default JQL keeps tickets done within the last 7 days in the list, not
  just open ones. groundcrew only tears down a task's worktree once `list`/`get`
  report it `done`, so dropping done tickets immediately would leak worktrees;
  the 7-day window gives cleanup time to run, then the ticket falls out so the
  steady-state list stays small. The window is keyed on `updated`, so a done
  ticket edited within 7 days stays listed (harmless — groundcrew never
  re-dispatches a `done` task). Shorten or drop the
  `statusCategory = Done AND updated >= -7d` clause in `JIRA_GROUNDCREW_JQL` if
  your source closes out worktrees some other way.
- The default JQL has no `project = …` clause, so it implicitly scopes to the
  default project `jira init` selected (see [What `jira init` sets up](#what-jira-init-sets-up)).
  On a multi-project instance, add an explicit `project = "ENG"` clause to
  `JIRA_GROUNDCREW_JQL` to constrain which project `list` sweeps.
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
- Issue comments are appended to that description under a `--- Comments ---`
  heading (oldest first, each headed by author and timestamp), since `ShellIssue`
  has no comments field and the description is what the agent sees. Comment text
  is flattened the same way as the description, so `@mentions` come through as
  their display text. jira-cli returns only the first page of comments, so a
  heavily-commented issue may be truncated.
- Writeback (`move`) uses the native state names from `JIRA_STATE_*`; if a
  transition name does not exist in your workflow, `jira issue move` fails and
  groundcrew surfaces the error.
