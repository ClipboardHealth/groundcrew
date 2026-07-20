# linear source bundle

Dispatches the Linear viewer's assigned, non-terminal issues, and writes back as
issue comments. Talks to Linear's GraphQL API over https with node's global
`fetch` — no SDK, node builtins only.

## Configuration

| Env                         | Kind              | Purpose                                                                                                |
| --------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------ |
| `LINEAR_API_KEY`            | secret (required) | Personal API key; sent verbatim as the `Authorization` header.                                         |
| `LINEAR_API_URL`            | env               | GraphQL endpoint. Default `https://api.linear.app/graphql`. Overridable for proxies and tests.         |
| `LINEAR_GROUNDCREW_LABEL`   | env               | Optional issue-label **name**; when set, only issues carrying that label are listed.                   |
| `LINEAR_COMPLETED_STATE_ID` | env               | Optional workflow **state id**; when set, a `delivered` completion also moves the issue to that state. |

`LINEAR_API_KEY` is declared in the manifest `secrets`; core resolves it from
the environment / `secrets.env` / `op run` and injects it. The manifest
`network` allowlist is `api.linear.app`.

## Mappings

- **Queue** — `list` fetches issues where `assignee.isMe` and the workflow
  `state.type` is **not** `completed`/`canceled` (optionally filtered by
  `LINEAR_GROUNDCREW_LABEL`). `get` resolves a single issue by identifier
  (e.g. `DEVOP-123`).
- **Priority** — Linear uses `0=None, 1=Urgent, 2=High, 3=Medium, 4=Low`. The
  protocol dispatches the **higher** number first, so this bundle inverts:
  **Urgent→4, High→3, Medium→2, Low→1**, and **None** is omitted (no ordering
  signal).
- **Terminal** — `state.type ∈ {completed, canceled}` → `terminal: true`.
- **Blocked** — a `blocks` relation whose blocker issue is itself non-terminal
  → `blocked: true` (the task is not eligible this poll).
- **Repos designation** — a `Repos: a, b` line anywhere in the issue
  description → task `repos`.
- **Agent routing** — an `Agent: <name>` line in the description → task `agent`.

## Writeback

`update` is **comment-only by default** — Linear's own automation (e.g. its
GitHub integration) moves issue states, and this bundle does not fight it.

- `claimed` → posts a claim comment, returns `{ "result": "ok" }` (no contention
  arbitration).
- `progress` → posts a progress comment.
- `completed` → posts a comment with the outcome, message, and artifact list.
  If the outcome is `delivered` **and** `LINEAR_COMPLETED_STATE_ID` is set, the
  issue is additionally moved to that workflow state (which then drops it from
  the non-terminal queue on the next poll).

## Testing

`linear.test.mts` drives the real scripts as child processes against a local
fake GraphQL server (`LINEAR_API_URL` override), asserting the `Authorization`
header, the query/filter shape, the priority/blocked/terminal mapping, and the
comment writeback. No real API calls. A read-only real-`list` probe runs only
when an ambient `LINEAR_API_KEY` is present, and never fails the suite.
