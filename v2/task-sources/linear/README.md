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
| `LINEAR_STATUS_IN_PROGRESS` | env               | Comma-separated candidate **names** for the in-progress column. Default `In Progress`.                 |
| `LINEAR_STATUS_IN_REVIEW`   | env               | Comma-separated candidate **names** for the in-review column. Default `In Review`.                     |
| `LINEAR_COMPLETED_STATE_ID` | env               | Optional workflow **state id**; when set, `delivered` moves straight there, overriding in-review.      |

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
- **Parent/epic guard** — an issue with sub-issues (a non-empty `children`
  connection) → `blocked: true`, so a labelled epic is never dispatched. v1
  excluded such issues from the dispatch list outright and only logged them as
  `parentSkips` (`src/lib/adapters/linear/fetch.ts:265-276`); v2's single tasks
  channel surfaces them `blocked` instead, keeping the epic visible and reapable.
- **Repos designation** — a `Repos: a, b` line anywhere in the issue
  description → task `repos`.
- **Agent routing** — an `Agent: <name>` line in the description → task `agent`.

## Writeback

`update` posts a comment **and** moves the issue through the workflow, porting
v1's transition semantics (`src/lib/adapters/linear/writeback.ts`) into the
protocol's event vocabulary. Each event always posts its comment; the state move
is additive.

| Event                          | Comment                        | State move                                                    |
| ------------------------------ | ------------------------------ | ------------------------------------------------------------- |
| `claimed`                      | claim + run id                 | → **in-progress** state                                       |
| `progress`                     | progress note                  | none                                                          |
| `completed` `outcome:delivered`| outcome + message + artifacts  | → **in-review** state (or `LINEAR_COMPLETED_STATE_ID` if set) |
| `completed` `outcome:failed`   | outcome + message + artifacts  | none — left in-progress                                       |
| `completed` `outcome:stopped`  | outcome + message + artifacts  | none — left in-progress                                       |

Why these mappings (v1 parity):

- **`claimed` → in-progress.** v1's dispatcher moved the ticket to In Progress
  the instant a run was provisioned (`src/commands/dispatcher.ts:151`,
  `setupWorkspace.ts:484`). `claimed` is that same moment in the protocol.
- **`delivered` → in-review.** v1 had no agent-reported completion. Its (now
  removed) reviewer polled worktrees and moved an in-progress task to In Review
  **only once an open PR existed** (`src/commands/reviewer.ts:78-89, 224`). The
  agent reports `delivered` with its PR artifacts at exactly that moment, so
  `delivered` inherits the In Review transition. `LINEAR_COMPLETED_STATE_ID`
  overrides this with an exact state id (e.g. to send delivered straight to Done).
- **`failed` / `stopped` → no move.** No v1 board caller ever reverted a ticket
  to Todo, and the reap / `runStateCleanup` teardown paths do no writeback — a
  died-or-stopped run left the ticket In Progress. This bundle does the same:
  comment only.

### State resolution

Linear's default workflow has **multiple** `started`-type states — both
"In Progress" and "In Review" are `started` (`statusNames.ts:16-19`). Per
transition the bundle fetches the team's `workflowStates` (keyed by the team key
in the issue identifier), filters to `type === "started"`, and resolves:

- **in-progress** — first name match against `LINEAR_STATUS_IN_PROGRESS`
  (default `In Progress`), else the **lowest-position** (leftmost) started
  column (`writeback.ts:63-66`).
- **in-review** — name match against `LINEAR_STATUS_IN_REVIEW` (default
  `In Review`) only, **no** position fallback — v1 reported `unsupported` when
  unmatched (`writeback.ts:74-90`).

States are fetched fresh per invocation. Like v1, there is **no negative
caching**: a missing column is an operator-fixable config issue, and each
`update` is a short-lived process, so there is nothing to cache stale.

### Soft posture

The comment is the primary writeback; a **state-move failure must never lose
it**. So the bundle posts the comment first, then attempts the move; a failed or
unresolvable transition is logged to **stderr** and the command still returns
`{ "result": "ok" }`. This mirrors v1's reviewer, which logged and swallowed
writeback errors and retried on the next tick (`src/commands/reviewer.ts:209-211`).

## Testing

`linear.test.mts` drives the real scripts as child processes against a local
fake GraphQL server (`LINEAR_API_URL` override), asserting the `Authorization`
header, the query/filter shape, the priority/blocked/terminal mapping, and the
comment writeback. No real API calls. A read-only real-`list` probe runs only
when an ambient `LINEAR_API_KEY` is present, and never fails the suite.
