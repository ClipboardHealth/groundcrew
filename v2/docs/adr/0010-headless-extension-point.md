# 0010. The session presenter seam; headless is a future detached presenter

- Status: Accepted
- Date: 2026-07-17
- Ticket: [DEVOP-5976](https://linear.app/clipboardhealth/issue/DEVOP-5976)
- Design doc: §8

## Context

Where should the seam for non-interactive / remote execution live, without leaking multiplexer
concerns into the launch layer as v1 did?

## Decision

- **The seam is a standalone core interface: the session presenter** — presentation-only,
  deciding where a local, already-sandbox-wrapped agent runs and how a human reaches it.
- **Born serializable** (JSON in/out): `open`, `probe`, `close`, `accessHint`, optional
  `setStatus` (capability by omission). Nesting is presenter → sandbox → agent.
- **Config field renamed `multiplexer` → `presenter`.** cmux/tmux/zellij ship in-core for v2.0.
- **Headless = a future "detached" presenter** implementing the same contract; v2.0 ships none,
  so one of cmux/tmux/zellij on PATH stays required. Remote execution enters via the
  source-contract door (`claimed` → _rejected_), never as a presenter.

## Consequences

- v1's cmux/Claude in-sandbox `set-progress` hook plumbing dies with no replacement.
- Presenter bundles and subagent panes are deferred, additive kinds.
