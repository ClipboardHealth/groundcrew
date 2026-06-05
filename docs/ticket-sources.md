# Ticket Sources

`sources` declares extra ticket-system adapters. They are verified at `crew run` startup and dispatched alongside the built-in Linear adapter, so a shell, Jira, or local-plan integration feeds the same orchestration loop as Linear.

The built-in `shell` adapter runs command templates and reads JSON from stdout:

```ts
export default {
  sources: [
    {
      kind: "shell",
      name: "jira",
      commands: {
        verify: "jira me",
        fetch: "~/.config/groundcrew/jira-fetch.sh",
        resolveOne: "~/.config/groundcrew/jira-resolve.sh ${id}",
        markInProgress: "jira issue move ${id} 'In Progress'",
        markInReview: "jira issue move ${id} 'In Review'",
      },
      timeouts: { fetch: 60_000, markInReview: 15_000 },
    },
  ],
};
```

`commands.fetch` must print a JSON array of issues. `commands.resolveOne`, when
set, must print one issue, print nothing for "not found", or exit `3` for "not
found". `commands.markInProgress`, when set, receives the issue's `sourceRef` as
JSON on stdin. `commands.markInReview`, when set, receives the same `sourceRef`
and is run after groundcrew sees an open or merged PR on the ticket's worktree
branch. If `commands.markInReview` is omitted, groundcrew treats in-review
advancement as unsupported for that source and does not claim the transition
succeeded. `${id}`, `${canonicalId}`, and `${name}` placeholders are shell-quoted
before substitution.

```json
[
  {
    "id": "JIRA-123",
    "title": "Add retry logic",
    "description": "Ticket body",
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

Allowed `status` values are `todo`, `in-progress`, `in-review`, `done`, and `other`. Use `null` for `repository` or `model` when a ticket should not be groundcrew-eligible. `hasMoreBlockers` is optional and defaults to `false`; `sourceRef` is opaque data that groundcrew passes back to your writeback command.

## The `description` is the agent's prompt

Groundcrew wraps each issue's `description` in its generic unattended-execution prompt and hands it to the agent as the task. It does not pick a different prompt per source or ticket type. Specialized behavior belongs in the `description` your adapter emits, not in groundcrew.

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
