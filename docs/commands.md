# Commands

## Task

`crew task list` lists normalized tasks across all configured sources. Use `--source <name>` to call only one source's `listTasks()` method. Filters include repeatable `--status <status>`, `--agent <name>`, `--repo <owner/repo>`, `--blocked`, `--unblocked`, and `--limit <n>`. Add `--json` for normalized task JSON.

```bash
crew task list
crew task list --source todo --status todo --unblocked
crew task list --agent codex --repo ClipboardHealth/api --json
```

`crew task get <task-id>` prints one normalized task. Canonical IDs such as `todo:GC-20260608-001` route directly to the named source. Natural IDs can be resolved with `--source <name>` or, when unique, by searching all configured sources. If more than one source matches, the command fails and asks for a canonical ID or `--source`.

```bash
crew task get todo:GC-20260608-001
crew task get GC-20260608-001 --source todo
crew task get todo:GC-20260608-001 --prompt
```

`crew task create "Short title" --source <source> [--agent <agent>]` creates a task in a source that supports creation. When `--agent` is omitted, it defaults to `any`. Todo.txt creation requires `--repo <repo>` unless the source configures `defaultRepository`, appends the todo line, writes `.tasks/<id>.md`, and leaves `status:todo` as the final meaningful token, so no separate ready command is required. Pass `--priority <letter>` to add a todo.txt priority marker. Hand-written todo-txt lines can omit `.tasks/<id>.md` when the line has a non-empty title; that title becomes the prompt text.

```bash
crew task create "Fix cancellation retry race" \
  --source todo \
  --agent codex \
  --repo ClipboardHealth/api \
  --project marketplace \
  --context backend \
  --edit
```

Linear creation creates a Todo issue assigned to the current Linear API viewer, with exactly one `agent-*` label and a `Repository: <repo>` line in the description. Configure `sources: [{ kind: "linear", team: "ENG" }]` or pass `--team ENG`; the CLI option wins when both are present.

```bash
crew task create "Fix cancellation retry race" \
  --source linear \
  --agent codex \
  --team ENG \
  --repo ClipboardHealth/api \
  --description "Investigate retry handling."
```

## Status

`crew status <TASK>` prints a read-only snapshot for one task: cached title and URL when present, recorded run state, live workspace presence, matching worktrees, git dirtiness, PR links for matching branches, recent log lines when present, and the task status from the configured task source.

`crew status` with no task prints the current inventory: known worktrees with cached task metadata, workspace/run-state agreement, attach hints, worktree paths, PR links, and stray sessions reported by the configured backend. Local diagnostics are printed before task-source fetches complete. When the source fetch succeeds, status also prints any in-progress source tasks with no local worktree, slot usage, and Queue/Blocked sections for eligible Todo tasks. Worktree-less in-progress rows include the task title, URL when the source provides one, and repository when the source resolves one. If the source fetch fails, Queue shows `unavailable: <reason>` and the slots line is omitted.

Status is informational only. Use `crew cleanup <TASK>` to tear down stale worktrees and `crew resume <TASK>` to reopen preserved work.

<details>
<summary>Sample task status output</summary>

```text
crew status ENG-123
===================
task: eng-123  in-progress  https://linear.app/example/issue/ENG-123
title: Multi-event extractor: year inference can produce date_start > date_end
run: running; model=claude; updated=2026-05-26T00:01:00.000Z; resumes=0
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

`crew doctor` checks host prerequisites only: config validity, task-source reachability, required binaries on PATH, workspace backend availability, `workspace.projectDir`, local runner capability, and enabled model commands.

Doctor's command introspection is intentionally shallow. It reports the resolved local runner and tokenizes each model `cmd`, then checks the first two non-flag tokens against PATH. Boolean flags without values, env-var assignments, shell pipelines, and subshells are not parsed.

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

`crew resume <TASK>` reopens an existing task worktree with a continuation prompt. Resume never creates a new worktree; if none exists it fails and leaves re-dispatch to `crew start <task>`.

The resume prompt tells the agent to inspect git status and diff before editing, includes the previous interrupt reason when recorded, and reuses the recorded model, repository, branch, runner, sandbox, and workspace backend. When no run-state file exists but a worktree does, resume falls back to Linear resolution for the model and task context.
