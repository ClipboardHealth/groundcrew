# 0013. Migration easing deferred post-v2; two commitments carried

- Status: Accepted
- Date: 2026-07-17
- Ticket: [DEVOP-5981](https://linear.app/clipboardhealth/issue/DEVOP-5981)
- Design doc: §11

## Context

Designing conversion details against a spec that will shift during implementation is waste.

## Decision

Defer migration easing to post-v2 handoff work. Carry exactly two commitments:

1. **5.0.0 release blocker — the `crew upgrade` ambush.** v1's `upgrade` self-updates to
   `@latest`; the moment 5.0.0 hits the `latest` dist-tag, v1 users get silently major-bumped.
   Before publishing, decide a dist-tag strategy or a first-run v1 guard.
2. **v2 fails loudly on v1-only config.** Finding a v1 config (`crew.config.ts`) and no v2 config
   is an error with a migration pointer — never a silent fallback to defaults.

## Consequences

- `crew init` conversion detail, killed-command stubs, the migration doc, and 5.0.0 release notes
  move to the handoff backlog, gated on a working v2.
