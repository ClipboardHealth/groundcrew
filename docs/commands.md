# Commands

## Status

`crew status <TICKET>` prints a read-only snapshot for one ticket: cached title and URL when present, recorded run state, live workspace presence, matching worktrees, git dirtiness, PR links for matching branches, recent log lines when present, and the ticket status from the configured ticket source.

`crew status` with no ticket prints the current inventory: known worktrees with cached ticket metadata, workspace/run-state agreement, attach hints, worktree paths, PR links, and stray sessions reported by the configured backend. Local diagnostics are printed before ticket-source fetches complete. When the source fetch succeeds, status also prints any in-progress source tickets with no local worktree, slot usage, and Queue/Blocked sections for eligible Todo tickets. Worktree-less in-progress rows include the ticket title, URL when the source provides one, and repository when the source resolves one. If the source fetch fails, Queue shows `unavailable: <reason>` and the slots line is omitted.

Status is informational only. Use `crew cleanup <TICKET>` to tear down stale worktrees and `crew resume <TICKET>` to reopen preserved work.

<details>
<summary>Sample ticket status output</summary>

```text
crew status ENG-123
===================
ticket: eng-123  in-progress  https://linear.app/example/issue/ENG-123
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

`crew doctor` checks host prerequisites only: config validity, ticket-source reachability, required binaries on PATH, workspace backend availability, `workspace.projectDir`, local runner capability, and enabled model commands.

Doctor's command introspection is intentionally shallow. It reports the resolved local runner and tokenizes each model `cmd`, then checks the first two non-flag tokens against PATH. Boolean flags without values, env-var assignments, shell pipelines, and subshells are not parsed.

## Start

`crew start <TICKET>` launches one ticket immediately, bypassing orchestrator eligibility. Use it to dispatch a specific ticket on demand, including unlabeled tickets that `crew run` ignores.

```bash
crew start ENG-123
crew start ENG-123 --dry-run
```

## Stop

`crew stop <TICKET>` stops a live workspace pane while preserving the ticket worktree and branch. Use it when you need terminal capacity back, want to stop an agent going in the wrong direction, or need to inspect the diff before letting another agent continue.

```bash
crew stop ENG-123 --reason "wrong implementation direction"
crew status ENG-123
crew resume ENG-123
```

The command closes the cmux/tmux workspace if present, records local run state, and never tears down the worktree. If the workspace was already gone but the worktree is still present, stop records that fact so status can show the preserved branch.

## Resume

`crew resume <TICKET>` reopens an existing ticket worktree with a continuation prompt. Resume never creates a new worktree; if none exists it fails and leaves re-dispatch to `crew start <ticket>`.

The resume prompt tells the agent to inspect git status and diff before editing, includes the previous interrupt reason when recorded, and reuses the recorded model, repository, branch, runner, sandbox, and workspace backend. When no run-state file exists but a worktree does, resume falls back to Linear resolution for the model and ticket context.
