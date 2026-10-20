# cmux custom sidebar

A [custom cmux sidebar](https://cmux.com/docs/custom-sidebars) that groups crew tasks by PR review
stage, with a compact row per task: title and a horizontal agent-icon strip on the first line, then
the ticket pill and one line per pull request the workspace has open or recently closed.

## Install

```bash
./contrib/cmux/install.sh
cmux sidebar select groundcrew
```

The script copies `groundcrew.swift` to `~/.config/cmux/sidebars/`, substitutes the groundcrew
checkout path, and validates the result. It backs up any sidebar already installed under that name.
Set `GROUNDCREW_DIR` to override the checkout path when running the script from outside the repo.

Re-run it after pulling changes to this file.

## What it renders

Workspaces split into two sections:

- **Workbench** lists pinned workspaces with their tabs, each tab a focus button.
- **Groundcrew** lists everything else that looks like a task, meaning it has a PR, a cmux status
  lane, an agent session, or a ticket id — then groups those task rows into stage sections instead
  of one flat list:

  `Needs you` → `Your review` → `CI failing` → `Changes requested` → `Needs testing` →
  `Ready to merge` → `Working` → `Waiting` → `Peer review` → `Stage unknown` (or `Open PRs`, see
  [PR-stage sync](#pr-stage-sync-cmuxprstages)) → `Done`

  A row's stage comes first from live signal (an agent waiting on you, or one still executing)
  before falling back to the synced PR stage, so a row never gets stuck showing a stale badge while
  an agent is actively working it. Empty sections are hidden. Each row's left stripe and background
  tint match the color of the section it sits under.

Ticket ids come from `crew_ticket`, a cmux status [`pr-stage-sync`](#pr-stage-sync-cmuxprstages)
writes on each matched task workspace — not parsed from the title or directory name — and link into
the Linear desktop app. The right-click menu offers `Close workspace` and, for rows with a ticket,
`Cleanup workspace`, which opens a new workspace in the groundcrew checkout running
`crew cleanup <ticket>` and closes the task workspace on success. Cleanup keeps crew's dirty-worktree
guard, so uncommitted changes must be inspected before removal.

PR links open on GitHub by default. To open them in Linear Reviews instead, set `prLinkTarget()` at
the top of the file to `"linear-app"` (desktop app) or `"linear"` (`linear.review` in the
browser). Both Linear targets are derived from the GitHub PR URL, so they work whether or not the
PR has a linked Linear ticket.
Both Linear targets need Linear Reviews set up: the workspace GitHub integration with code access to
the repository, your personal GitHub account connected in Linear, and Reviews enabled under
Settings → Account → Code & reviews.

## PR-stage sync (`cmux.prStages`)

Stage sections, the per-row stage badge color, and the gating-label toggles below all depend on
`crew` (the watch loop's `pr-stage-sync` step) painting each task workspace with `crew_stage`,
`crew_labels`, and `crew_prs`, gated on the opt-in
[`cmux.prStages.enabled`](../../docs/configuration.md) config flag — see `node --run crew -- --help`
and `docs/configuration.md` in the repository root. Run a pass on demand with `crew stage refresh`,
or manage the gating labels directly with `crew stage label-add`/`crew stage label-remove`.

`crew_ticket` is written for every matched cmux task workspace regardless of this flag, so the
ticket pill and `Cleanup workspace` action work whether or not PR-stage sync is enabled.

### Stacked PRs

A task's PRs are every pull request whose head branch is the task's worktree branch, or starts with
`<branch>-` (how an agent splits one task into a stack). `pr-stage-sync` discovers them with one
`gh pr list --state all --author @me` call per repository per tick, not per task, scoped to the
operator's own PRs (who every agent-created PR is authored by) and capped at the 100 most recent to
keep that call cheap. A task whose PR falls outside that window — too old, or for any other reason
missing from the repository-wide list — is recovered by one exact-branch `gh pr list --head <branch>`
fallback call for that task alone, the same lookup `pr-stage-sync` used before stack discovery
existed. Either way, `pr-stage-sync` shows every open or merged PR for the task, falling back to its
closed PRs only when none are open or merged. When the shown PRs chain by base branch into a single
stack, they're ordered bottom to top; otherwise by PR number.

Each shown PR's stage is encoded into the `crew_prs` status, and a row renders one "PR #&lt;n&gt; ·
&lt;stage&gt;" line per entry instead of cmux's native PR list. `crew_stage` (the row's section) and
`crew_labels` both describe whichever shown PR is most urgent, ranked by the same order the sections
render in (`Your review` first, then `CI failing`, `Changes requested`, `Needs testing`,
`Ready to merge`, CI running, `Peer review`, merged, closed last) — so a stack with one PR needing
your review and another still in CI shows the review PR's stage and labels. Workspaces without
`crew_prs` (PR-stage sync off, or no matched PR) keep rendering from cmux's native single-PR data.

When `cmux.prStages` has never run for any tracked task (no workspace carries a
`crew_poller_heartbeat` status at all), the sidebar assumes the feature is off rather than broken:
the "PR stages stale — is crew run --watch running?" caption stays hidden, and PR-bearing rows with no
stage information render under "Open PRs" instead of "Stage unknown". Once PR-stage sync has run at
least once, a missing or outdated heartbeat goes back to meaning "stale" and the caption reappears.

### Label toggles

For a task with a PR, the context menu additionally offers (via `crew stage label-add` /
`crew stage label-remove`, run from the groundcrew checkout and followed by a `crew stage refresh`).
When `crew_prs` is present, the toggles act on the same stage-driving PR described above — in a
stack, that's whichever PR is currently most urgent, not always the task's original PR — so
right-clicking a stack's row walks the stack naturally as PRs move through review:

- `Self-review done` / `Undo self-review` — toggles the `selfReviewed` gating label
- `Testing done` / `Undo testing` — toggles the `tested` gating label
- `Refresh stages` — runs `crew stage refresh` directly

Both the menu's "has this label already?" check and the label name it sends to `crew stage
label-add`/`label-remove` are hardcoded to the **default** names (`self-reviewed` and `tested`),
not read from `crew_labels` or anywhere else. If your `cmux.prStages.labels` config overrides either
name, these two toggle actions stop working: the "has this label?" check never matches (so the menu
always offers the "add" action, never "undo"), and `crew stage label-add`/`label-remove` reject the
hardcoded default name since it no longer matches your configured one. `Refresh stages` is
unaffected, since it carries no label name. Keep `cmux.prStages.labels` at its defaults to use the
toggles from this sidebar, or toggle labels with `crew stage label-add`/`label-remove` directly.

## Requirements

- cmux with the custom sidebar interpreter. Verified against 0.64.19; the interpreter is beta and
  its accepted syntax has shifted between releases, so `cmux sidebar validate groundcrew` is the
  check that matters after an upgrade. Agent rows additionally need a build that exposes `agents`
  in the sidebar data context.
- `crew` on `PATH`, for the cleanup action, the label toggles, and `crew stage refresh`.
- Linear desktop app for the ticket links, which use the `linear://` scheme against the
  `clipboardhealth` workspace, and for PR links when `prLinkTarget()` is `"linear-app"`.

## Agent icon strip

When cmux reports coding-agent sessions for a workspace (`w.agents`), a row renders one icon per
distinct agent in a horizontal strip next to its title — no per-agent text row, no state label.
Icon color and opacity encode state: full brand color and opacity for an executing agent (pulsing
while it runs), reduced opacity while idle, and a neutral gray at low opacity once an executing
agent has gone silent for 2+ hours (treated as abandoned, not busy). `needs_input` keeps full brand
color with an amber ring rather than any opacity change, since that state should never read as
quiet. Hover an icon for a tooltip naming the runtime, its state, and the conversation title when
cmux knows one.

The runtime icon distinguishes each coding agent at a glance — orange `sparkles` for Claude,
near-black `circle.hexagongrid.fill` for Codex, with `gemini`, `grok`, and `opencode` mapped as well
and `cpu` for anything else. The interpreter's `Image` resolves system symbols only, so cmux's own
`AgentIcons` brand assets cannot be used here.

One running process can report two agent registry records (cmux does not retire the previous id on
session restart); the strip collapses these by process id so a single agent shows once, picking
whichever record is both freshest and furthest along in its lifecycle.

This needs a cmux new enough to expose `agents` in the sidebar data context. On older builds the
array is absent and a row simply shows no icon strip.

## Status pills

A workspace's native cmux status entry (`cmux set-status <key> <value>`, `cmux list-status`) never
renders as its own row element in this layout — not even as a fallback. The only pills on a task row
are the ticket id and each PR's number/status, both sourced from the poller-managed status keys above. A
native status pill with no agent session and no PR is still enough to make a workspace count as a
task (so it doesn't fall out of the list entirely), but its value is not itself displayed.

## Known limits

Task detection for rows without a ticket, PR, or native status still depends on an agent session
being present; a workspace created outside crew with none of those will not appear in the task list.

`cmux workspace list --json` reports `status` and `pr` as null regardless of what is set, since
status entries are a separate surface reached through `cmux list-status`. The CLI JSON is not a way
to check what the sidebar will render.

## Tests

`contrib/cmux/tests/` has Swift Testing suites that drive this file through cmux's own sidebar
interpreter with synthetic workspace snapshots — see `contrib/cmux/tests/README.md` to run them
against a cmux checkout. They are not part of this repository's `npm run verify`, since they require
a live cmux checkout and its Swift toolchain.
