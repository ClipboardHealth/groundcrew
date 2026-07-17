# 0009. A v2-only, red-first black-box acceptance suite

- Status: Accepted
- Date: 2026-07-17
- Ticket: [DEVOP-5974](https://linear.app/clipboardhealth/issue/DEVOP-5974)
- Design doc: §5

## Context

The evolve verdict's safety net assumed the acceptance suite would run green on v1. v2 breaks too
much of v1's surface for that to pay for itself.

## Decision

- **Drop the green-on-v1 gate.** The suite is v2-only and written red-first, before v2 code
  exists; it brings v2 up red→green and is the language-agnostic escape hatch (any implementation
  that passes is conformant).
- **Suite trustworthiness comes from harness self-tests** — fixture source, scripted agent,
  call journal, tmux/git observation helpers each tested without any `crew` binary.
- **Completion model codified**: forge-blind, agent-reported, lingers for human review with two
  exits (manual `cleanup` or source-terminal auto-reap). See design doc §5 and catalog §2.

## Consequences

- The `e2e/` package (plain TS + vitest) spawns the built binary and asserts on an observation
  surface, never internals. It must never import `src/`.
- The v1 reviewer loop (poll `gh`) does not survive.
