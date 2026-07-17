# 0001. Generalize source/sink asymmetrically

- Status: Accepted
- Date: 2026-07-17
- Ticket: [DEVOP-5969](https://linear.app/clipboardhealth/issue/DEVOP-5969)
- Design doc: §3

## Context

Prior-art research (Concourse, Tekton) asked whether groundcrew should model inputs and outputs
with a symmetric source/sink type system.

## Decision

Do not. Symmetric source/sink abstractions are where Concourse and Tekton died. Generalize
asymmetrically: sources are a first-class contract; outputs are not a typed stage.

## Consequences

- Sinks and flows dissolve (see ADR 0005).
- The generalization pressure lands on the source protocol, not on a matched pair.
- Research branch: `research/agent-flow-prior-art`.
