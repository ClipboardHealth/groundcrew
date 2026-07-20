# jira source bundle

Dispatches the issues matching a configurable JQL query from Jira Cloud, and
writes back as issue comments. Talks to Jira's REST API v3 over https with
node's global `fetch` — no SDK, node builtins only.

## Configuration

| Env                       | Kind              | Purpose                                                                                                              |
| ------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------- |
| `JIRA_EMAIL`              | secret (required) | Atlassian account email; the Basic-auth **user**.                                                                    |
| `JIRA_API_TOKEN`          | secret (required) | Atlassian API token; the Basic-auth **password**. Together they form the `Authorization` header.                     |
| `JIRA_BASE_URL`           | env (required)    | Site root, e.g. `https://your-domain.atlassian.net`. Overridable for tests (point at a local fake).                  |
| `JIRA_GROUNDCREW_JQL`     | env               | The queue query. Default: `assignee = currentUser() AND statusCategory != Done ORDER BY priority DESC, created ASC`. |
| `JIRA_DONE_TRANSITION_ID` | env               | Optional workflow **transition id**; when set, a `delivered` completion also transitions the issue there.            |

`JIRA_EMAIL` and `JIRA_API_TOKEN` are declared in the manifest `secrets`; core
resolves them from the environment / `secrets.env` / `op run` and injects them.
`JIRA_BASE_URL` and `JIRA_GROUNDCREW_JQL` are declared in the manifest
`environment` block.

### The base-URL / network-allowlist tension

Jira is single-tenant per customer: your site host is `your-site.atlassian.net`,
not a shared API host. The manifest therefore ships **placeholders** you MUST
override for your own site:

- `environment.JIRA_BASE_URL` ships `https://your-domain.atlassian.net`.
- the sandbox `network` allowlist ships `your-domain.atlassian.net`.

Override **both** in `crew.config.jsonc` so the source can reach your site under
the sandbox lane:

```jsonc
{
  "sources": [
    { "kind": "jira", "environment": { "JIRA_BASE_URL": "https://acme.atlassian.net" } }
  ],
  // the source sandbox egress allowlist is the manifest's; widen it for your host
  // (see the sandbox note in the design doc — a manifest cannot know your site).
}
```

If the allowlist and `JIRA_BASE_URL` disagree, the sandbox blocks egress and
`list` fails closed. `doctor` surfaces the placeholder host as a warning.

## Mappings

- **Queue** — `list` POSTs `JIRA_GROUNDCREW_JQL` to `/rest/api/3/search/jql`
  and follows `nextPageToken` cursor pagination. `get` resolves a single issue
  by key (e.g. `PROJ-123`) via `/rest/api/3/issue/{key}`.
- **Priority** — Jira priority **names** map so the higher protocol number
  dispatches first: **Highest→5, High→4, Medium→3, Low→2, Lowest→1**; any other
  (or absent) priority is omitted (no ordering signal).
- **Terminal** — `status.statusCategory.key === "done"` → `terminal: true`.
- **Blocked** — an `is blocked by` issue link whose blocker is itself
  non-`done` → `blocked: true` (not eligible this poll).
- **Repos designation** — a `Repos: a, b` line anywhere in the issue
  description → task `repos`. The v3 description is Atlassian Document Format
  (rich JSON); the bundle flattens it to text before matching.
- **Agent routing** — an `Agent: <name>` line in the description → task `agent`.

## Writeback

`update` is **comment-only by default** — Jira's own automation moves issue
states, and this bundle does not fight it. Comments are posted as ADF documents.

- `claimed` → posts a claim comment, returns `{ "result": "ok" }` (no contention
  arbitration).
- `progress` → posts a progress comment.
- `completed` → posts a comment with the outcome, message, and artifact list.
  If the outcome is `delivered` **and** `JIRA_DONE_TRANSITION_ID` is set, the
  issue is additionally transitioned via `/rest/api/3/issue/{key}/transitions`
  (which then drops it from the non-`Done` queue on the next poll).

## Testing

`jira.test.mts` drives the real scripts as child processes against a local fake
Jira server (`JIRA_BASE_URL` override), asserting the Basic `Authorization`
header, the JQL search shape and `nextPageToken` pagination, the
priority/terminal/blocked/repos/agent mapping, the `get` + 404 paths, and the
ADF comment / transition writeback. No real API calls. Because the bundle calls
back into the in-process server, the suite spawns children **asynchronously**
(a synchronous spawn would deadlock the parent event loop that serves them).
