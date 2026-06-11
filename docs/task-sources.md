# Task Sources

`sources` declares extra task-system adapters. They are verified at `crew run` startup and dispatched alongside the built-in Linear adapter, so a shell, Jira, or local-plan integration feeds the same orchestration loop as Linear.

The built-in `shell` adapter runs command templates and reads JSON from stdout:

```ts
export default {
  sources: [
    {
      kind: "shell",
      name: "jira",
      commands: {
        verify: "jira me",
        listTasks: "~/.config/groundcrew/jira-list.sh",
        getTask: "~/.config/groundcrew/jira-get.sh ${id}",
        markInProgress: "jira issue move ${id} 'In Progress'",
        markInReview: "jira issue move ${id} 'In Review'",
        markDone: "jira issue move ${id} 'Done'",
      },
      timeouts: { listTasks: 60_000, markInReview: 15_000, markDone: 15_000 },
    },
  ],
};
```

`commands.listTasks` must print a JSON array of issues. `commands.getTask`, when
set, must print one issue, print nothing for "not found", or exit `3` for "not
found". The legacy aliases `commands.fetch` and `commands.resolveOne` still work
for existing configs, but new configs should use `listTasks` and `getTask`.
`commands.markInProgress`, when set, receives the issue's `sourceRef` as
JSON on stdin. `commands.markInReview`, when set, receives the same `sourceRef` and is run
after groundcrew sees an **open** PR on the task's worktree branch (in-progress
tasks only). If omitted, groundcrew treats in-review advancement as unsupported
for that source and does not claim the transition succeeded. `commands.markDone`,
when set, receives the same `sourceRef` and is run after groundcrew sees a
**merged** PR on the task's worktree branch (a merged PR never advances to
in-review). If omitted, groundcrew treats done advancement as unsupported and
leaves the task for the source's own integration to close out. `${id}`,
`${canonicalId}`, and `${name}` placeholders are shell-quoted before substitution.

```json
[
  {
    "id": "JIRA-123",
    "title": "Add retry logic",
    "description": "Task body",
    "status": "todo",
    "repository": "your-org/your-repo",
    "model": "claude",
    "assignee": "Alice",
    "updatedAt": "2026-05-22T15:00:00Z",
    "blockers": [{ "id": "JIRA-122", "title": "Schema migration", "status": "done" }],
    "hasMoreBlockers": false,
    "sourceRef": { "nativeId": "10042" }
  }
]
```

Allowed `status` values are `todo`, `in-progress`, `in-review`, `done`, and `other`. Use `null` for `repository` or `model` when a task should not be groundcrew-eligible. `hasMoreBlockers` is optional and defaults to `false`; `sourceRef` is opaque data that groundcrew passes back to your writeback command.

## Todo.txt

The built-in `todo-txt` source supports listing, getting, writeback, and task creation through `crew task create`.

```ts
export default {
  sources: [
    {
      kind: "todo-txt",
      name: "todo",
      todoPath: "todo.txt",
      tasksDir: ".tasks",
      idPrefix: "GC",
      timezone: "UTC",
    },
  ],
};
```

Creating a todo task appends a line with `status:todo` as the final meaningful token and writes the prompt to `.tasks/<id>.md`. Pass `--repo <repo>` unless the source configures `defaultRepository`. Pass `--priority <letter>` to add a todo.txt priority marker. If `--agent` is omitted, the task uses `agent:any`.

```bash
crew task create "Fix cancellation retry race" \
  --source todo \
  --agent codex \
  --repo ClipboardHealth/api \
  --project marketplace \
  --context backend \
  --edit
```

```txt
Fix cancellation retry race +marketplace @backend id:GC-20260608-001 repo:ClipboardHealth/api agent:codex status:todo
```

For hand-written todo lines, a non-empty title is enough prompt text when `.tasks/<id>.md` is absent. Omit `agent:` to default to `agent:any`:

```txt
Say goodbye repo:ClipboardHealth/groundcrew id:GC-20260608-002 status:todo
```

## Linear

The built-in Linear source supports listing, getting, writeback, and task creation through `crew task create`.

Linear task creation needs a team because Linear issues are team-scoped. Configure it once on the source, or pass `--team <key-or-id>` for one command:

```ts
export default {
  sources: [
    {
      kind: "linear",
      team: "ENG",
    },
  ],
};
```

```bash
crew task create "Fix cancellation retry race" \
  --source linear \
  --agent codex \
  --repo ClipboardHealth/api \
  --description "Investigate retry handling."
```

Created Linear issues are assigned to the API key's viewer, moved into a Todo workflow state, labeled with exactly one `agent-*` label, and given a description that includes `Repository: <repo>` near the top. Repeated `--dep <ISSUE>` values create Linear blocked-by relations when the dependency is a Linear issue id.

## The `description` is the agent's prompt

Groundcrew wraps each issue's `description` in its generic unattended-execution prompt and hands it to the agent as the task. It does not pick a different prompt per source or task type. Specialized behavior belongs in the `description` your adapter emits, not in groundcrew.

So the adapter classifies, enriches, dedupes, and builds the description; groundcrew runs the result. A Datadog flaky-test source emits a description that says how to classify the flake, where the logs are, and what counts as success. A GitHub CI-failure source emits the PR link, the failing workflow, the logs, and whether to open a PR or leave a comment.

Example `description` for a CI-failure source:

```text
Investigate the failed CI run for this pull request.

Repository: your-org/your-repo
Pull request: https://github.com/your-org/your-repo/pull/123
Failing workflow: backend-tests
Logs: https://...

Goal:
- Decide whether this is a real regression, a flaky test, or an infra issue.
- If it is a real regression, make the smallest fix.
- If it is flaky, follow the repo's flaky-test triage pattern.
- If no code change is right, record that conclusion.

Output:
- Open a PR if a code change is needed; otherwise leave the branch clean and record the conclusion.
```
