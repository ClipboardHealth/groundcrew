# 0003. Effect's costs cut against the locked constraints

- Status: Accepted
- Date: 2026-07-17
- Ticket: [DEVOP-5970](https://linear.app/clipboardhealth/issue/DEVOP-5970)
- Design doc: §12.1

## Context

Research into adopting Effect for the CLI orchestrator, ahead of the plain-TypeScript decision.

## Decision

The research concluded Effect's costs cut against v2's locked constraints: v4-beta churn in the
platform/CLI layers, span-based rather than stack-based debugging against a "dead simple to know
what happened" goal, and function coloring as a contributor/AI filter against pluggability. This
finding feeds ADR 0006.

## Consequences

- Plain TypeScript is chosen (see ADR 0006).
- If reconsidered: gate on v4-stable, follow the opencode pattern, mandate `Effect.fn` spans.
- Research branch: `research/effect-for-cli-orchestrator`.
