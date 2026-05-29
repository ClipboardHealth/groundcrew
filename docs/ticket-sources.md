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
      },
      timeouts: { fetch: 60_000 },
    },
  ],
};
```

`commands.fetch` must print a JSON array of issues. `commands.resolveOne`, when set, must print one issue, print nothing for "not found", or exit `3` for "not found". `commands.markInProgress`, when set, receives the issue's `sourceRef` as JSON on stdin. `${id}`, `${canonicalId}`, and `${name}` placeholders are shell-quoted before substitution.

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
