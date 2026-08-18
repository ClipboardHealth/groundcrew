# Commands

## Task

`crew task list` lists normalized tasks across all configured sources. Use `--source <name>` to call only one source's `listTasks()` method. Filters include repeatable `--status <status>`, `--agent <name>`, `--repo <owner/repo>`, `--blocked`, `--unblocked`, and `--limit <n>`. Add `--json` for normalized task JSON.

```bash
crew task list
crew task list --source todo --status todo --unblocked
crew task list --agent claude-fable --repo ClipboardHealth/api --json
```

`crew task get <task-id>` prints one normalized task. Canonical IDs such as `todo:GC-20260608-001` route directly to the named source. Natural IDs can be resolved with `--source <name>` or, when unique, by searching all configured sources. Exact IDs are tried first; if none match, Groundcrew accepts a unique prefix of a current listed task ID. If more than one task matches, the command fails and prints the matching canonical IDs.

```bash
crew task get todo:GC-20260608-001
crew task get GC-20260608-001 --source todo
crew task get todo:GC-20260608-001 --prompt
```

`crew task create "Short title" --source <source> [--agent <agent>]` creates a task in a source that supports creation. When `--agent` is omitted, it defaults to `any`. Todo.txt creation requires `--repo <repo>` unless the source configures `defaultRepository`, appends the todo line, writes `.tasks/<id>.md`, and leaves `status:todo` as the final meaningful token, so no separate ready command is required. Pass `--priority <letter>` to add a todo.txt priority marker. Hand-written todo-txt lines can omit `.tasks/<id>.md` when the line has a non-empty title; that title becomes the prompt text.

```bash
crew task create "Fix cancellation retry race" \
  --source todo \
  --agent claude-fable \
  --repo ClipboardHealth/api \
  --project marketplace \
  --context backend \
  --edit
```

Linear creation creates a Todo issue assigned to the current Linear API viewer, with exactly one `agent-*` label and a `Repository: <repo>` line in the description. Configure `sources: [{ kind: "linear", team: "ENG" }]` or pass `--team ENG`; the CLI option wins when both are present.

```bash
crew task create "Fix cancellation retry race" \
  --source linear \
  --agent claude-fable \
  --team ENG \
  --repo ClipboardHealth/api \
  --description "Investigate retry handling."
```

`crew task done <task-id>` marks one task done through its source adapter. Use
it for completed work that intentionally does not produce a PR. The command
resolves canonical IDs such as `todo:flaky-triage-1` directly, or natural IDs
when they match exactly one configured source. Exact IDs are tried first; if
none match, Groundcrew accepts a unique prefix of a current listed task ID.
Sources without a done writeback return an unsupported error.

Groundcrew checks matching local worktrees before marking a task done. Clean
worktrees, and tasks with no local worktree, are allowed. A dirty worktree with
no matching PR is refused by default so later cleanup does not discard
uncommitted work; pass `--allow-dirty` only when that dirty state is expected.

```bash
# PR-producing tasks usually complete automatically:
# open PR -> in-review, merged PR -> done.

# Manual completion for no-PR operational work:
crew task done todo:flaky-triage-1

# Explicit override when a no-PR task intentionally leaves local changes:
crew task done todo:docs-refresh-1 --allow-dirty
```

For recurring no-PR tasks, keep recurrence in the source and complete the
current task with `crew task done`. The todo-txt source marks the current line
done and schedules the next `status:todo` recurrence itself.

```bash
crew task create "Run flaky triage sweep" \
  --source todo \
  --agent claude-fable \
  --repo ClipboardHealth/groundcrew \
  --id flaky-triage-1 \
  --rec 2h \
  --description "Triage the flaky queue. No PR is needed when the queue is updated."

crew task done todo:flaky-triage-1
```

## Status

`crew status <TASK>` prints a read-only snapshot for one task: cached title and URL when present, recorded run state, live workspace presence, matching worktrees, git dirtiness, PR links for matching branches, recent log lines when present, and the task status from the configured task source.

`crew status` with no task prints the current inventory: known worktrees with cached task metadata, workspace/run-state agreement, attach hints, worktree paths, PR links, and stray sessions reported by the configured backend. When the source fetch succeeds, status also prints any in-progress source tasks with no local worktree, slot usage, and Queue/Blocked sections for eligible Todo tasks. Worktree-less in-progress rows include the task title, URL when the source provides one, and repository when the source resolves one. If every source fetch fails, Queue shows `unavailable: <reason>` and the slots line is omitted. If only some sources fail, healthy queue rows remain visible beside a Source problems section and slot usage is marked unknown.

Status is informational only. Use `crew cleanup <TASK>` to tear down stale worktrees and `crew resume <TASK>` to reopen preserved work.

### Status JSON contract

```bash
crew status --json
crew status TEAM-123 --json
```

Each successful command writes exactly one JSON document to stdout. It contains
no headings, ANSI styling, diagnostic lines, or recent log contents. Status
does not write snapshot files. A fatal error before a snapshot can be produced
writes nothing to stdout, reports a human-readable message on stderr, and exits
non-zero.

Both documents have these required fields:

| Field         | Type                    | Meaning                                            |
| ------------- | ----------------------- | -------------------------------------------------- |
| `kind`        | `"inventory" \| "task"` | Selects the document shape.                        |
| `generatedAt` | ISO-8601 string         | Time collection for this snapshot started.         |
| `problems`    | problem array           | Partial probe failures; empty when probes succeed. |

An inventory document additionally contains:

| Field                        | Type                  | Meaning                                                                                        |
| ---------------------------- | --------------------- | ---------------------------------------------------------------------------------------------- |
| `slots`                      | object                | `maximum` is configured capacity; `used` is present only when every task source was available. |
| `worktrees`                  | inventory worktree[]  | One entry per local worktree.                                                                  |
| `inProgressWithoutWorktrees` | queue entry[]         | In-progress source tasks that have no local worktree.                                          |
| `queue.ready`                | queue entry[]         | Eligible Todo tasks with no open blocker and no local worktree.                                |
| `queue.blocked`              | blocked queue entry[] | Eligible Todo tasks with open blockers and no local worktree.                                  |
| `straySessions`              | stray session[]       | Live or exited workspaces with no matching local worktree.                                     |

A task document additionally contains `task`, optional `repository`, `run`,
`workspace`, `worktrees`, and `recommendedActions`. Its `worktrees` array is
empty when no local worktree exists.

Task identities contain required `naturalId` and optional canonical `id`,
`title`, canonical `status`, and `url`. Queue entries add optional `repository`
and `agent`, plus required `recommendedActions`. Blocked queue entries add
`blockedBy`; each blocker contains `id`, `naturalId`, canonical `status`, and
optional source-native `nativeStatus`.

`run.lifecycle` is `idle` or a recorded Groundcrew lifecycle. The remaining run
fields are optional: `agent`, `startedAt`, `updatedAt`, `resumeCount`, and `reason`.
Consumers derive elapsed time from `startedAt`; durations are not stored.
`workspace.state` is `live`, `exited`, `not-live`, or `unknown`.

A task worktree contains `repository`, `kind`, `branch`, absolute `directory`,
`dirtiness`, and `pullRequests`. Dirtiness has `kind: "clean"`,
`kind: "unknown"`, or `kind: "dirty"` with `modified` and `untracked` counts.
Each pull request contains `url`, `number`, lowercase `state`, and `title`.
Inventory worktrees add their `task`, `run`, `workspace`, and
`recommendedActions`.

Recommended actions are stable codes: `stop` closes a workspace, `resume`
reopens preserved work, `cleanup` removes a local worktree, `run` recreates
work for an eligible in-progress task with no local worktree, and `open-task`,
`open-pr`, and `open-worktree` navigate to the represented resource. An action
is omitted when its required target data is unavailable: `run` requires a
repository and agent, while each `open-*` action requires the represented URL
or worktree. Consumers must tolerate unknown future action codes. A stray
session contains its `name`, `state`, and `recommendedActions`.

Problems contain required `code` and human-readable `message`, plus optional
`source`, `task`, and `worktreeDirectory` context. Current codes are
`source-probe-failed`, `workspace-probe-failed`, `git-probe-failed`, and
`github-probe-failed`. A partial failure keeps the command successful and does
not discard data from probes that succeeded. Consumers must tolerate unknown
future problem codes. Messages are short public summaries and deliberately do
not include raw subprocess output; use human-readable status or debug logs for
detailed diagnostics.

Groundcrew SemVer governs compatibility. Adding optional fields is compatible;
existing required fields will not be removed, renamed, or change meaning in a
compatible release. Consumers must ignore unknown fields. There is no embedded
schema-version negotiation field. A future incompatible format requires either
a new explicitly selectable JSON version or a Groundcrew major release.

<details>
<summary>Sample task status output</summary>

```text
crew status ENG-123
===================
task: eng-123  in-progress  https://linear.app/example/issue/ENG-123
title: Multi-event extractor: year inference can produce date_start > date_end
run: running; agent=claude; updated=2026-05-26T00:01:00.000Z; resumes=0
workspace: live

Worktrees
---------
- acme/widgets host
  branch: dev-eng-123
  dir: /dev/workspaces/acme/widgets-eng-123
  git: dirty (0 modified, 1 untracked)
  pr: https://github.com/acme/widgets/pull/224 (open)

Recent logs
-----------
[10:15:30] Workspace "eng-123" launched
```

</details>

## Doctor

`crew doctor` checks host prerequisites only: config validity, task-source reachability, required binaries on PATH, workspace backend availability, `workspace.projectDir`, local runner capability, and enabled agent commands.

Doctor's command introspection is intentionally shallow. It reports the resolved local runner and tokenizes each agent `cmd`, then checks the first two non-flag tokens against PATH. Boolean flags without values, env-var assignments, shell pipelines, and subshells are not parsed.

## Start

`crew start <TASK>` launches one task immediately, bypassing orchestrator eligibility. Use it to dispatch a specific task on demand, including unlabeled tasks that `crew run` ignores.

```bash
crew start ENG-123
crew start ENG-123 --dry-run
```

## Stop

`crew stop <TASK>` stops a live workspace pane while preserving the task worktree and branch. Use it when you need terminal capacity back, want to stop an agent going in the wrong direction, or need to inspect the diff before letting another agent continue.

```bash
crew stop ENG-123 --reason "wrong implementation direction"
crew status ENG-123
crew resume ENG-123
```

The command closes the cmux/tmux/zellij workspace if present, records local run state, and never tears down the worktree. If the workspace was already gone but the worktree is still present, stop records that fact so status can show the preserved branch.

## Resume

`crew resume [--new] <TASK>` reopens an existing task worktree with a continuation prompt. Resume never creates a new worktree; if none exists it fails and leaves re-dispatch to `crew start <task>`.

The resume prompt tells the agent to inspect git status and diff before editing, includes the previous interrupt reason when recorded, and reuses the recorded agent, repository, branch, runner, sandbox, and workspace backend. When no run-state file exists but a worktree does, resume falls back to Linear resolution for the agent and task context.

`crew resume <TASK>` reopens the agent's previous conversation in the worktree by default — the built-in `claude`, `codex`, `cursor`, `cursor-grok`, and `pi` presets ship a [`resumeArgs`](./configuration.md#resuming-the-agents-conversation) default (`--continue`, `resume --last`, `--continue`, `--continue`, `--continue`) that groundcrew appends to the agent's command. `crew resume --new <TASK>` ignores `resumeArgs` and forces a fresh conversation. Custom agents cold-start unless they set `resumeArgs`. groundcrew stores no session id — it relies on one conversation per worktree.

## Open

`crew open` provisions a worktree for an existing pull request or branch — work that groundcrew did not create — and launches a session in it. Use it to iterate on a PR opened by hand, by a teammate, or by another tool.

```bash
crew open 1234 --repo owner/repo                       # PR number (repo required)
crew open https://github.com/owner/repo/pull/1234      # PR URL (repo inferred)
crew open --branch jdoe/fix-thing --repo owner/repo    # a pushed branch with no PR yet
crew open 1234 --repo owner/repo --prompt "address the review comments"
crew open 1234 --repo owner/repo --agent codex --task pr-1234 --dry-run
```

Open checks out the PR's actual head branch (fetching it from the remote when it isn't already local), so commits and pushes land on the same PR. It synthesizes a task id — `pr-<number>` for a PR, or a slug of the branch — that becomes the handle for `crew status`, `crew stop`, `crew resume`, and `crew cleanup`. `--task` overrides it. The opened worktree's real branch is recorded in run state, so `crew status` shows it and its PR.

When `--prompt`/`--prompt-file` is given, the agent starts with that prompt; otherwise it opens its interactive session with no prompt and hands control to you.

`crew cleanup <task>` removes the opened worktree but never deletes the remote PR branch. Fork (cross-repository) PRs and `provision`/sparse-checkout repositories are not supported; for a fork, check the branch out locally and use `--branch`.

## Completions

`crew completions <bash|zsh|fish>` prints a shell completion script to stdout. The script completes command names, subcommands (for `crew source` and `crew task`), flags, and enumerated flag values (`--runner`, `--status`, `--agent`); `--prompt-file` and `--project-dir` fall back to file and directory completion. Task IDs, source names, and repositories are configuration-specific and are not completed.

Load it once per shell session, or install it so your shell loads it automatically.

```bash
# bash — add to ~/.bashrc
source <(crew completions bash)

# zsh — write into a directory on your $fpath (run once), then restart the shell
crew completions zsh > "${fpath[1]}/_crew"
# or, to load in the current session, add to ~/.zshrc:
source <(crew completions zsh)

# fish — install once; fish loads it automatically on the next session
crew completions fish > ~/.config/fish/completions/crew.fish
```

The command tree is generated from a single spec in `src/commands/completions.ts`, so completions stay in sync with the CLI as commands and flags change.
