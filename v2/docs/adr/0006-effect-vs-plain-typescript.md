# 0006. Plain TypeScript; exceptions inside, result-shaped protocol at the boundary

- Status: Accepted
- Date: 2026-07-17
- Ticket: [DEVOP-5972](https://linear.app/clipboardhealth/issue/DEVOP-5972)
- Design doc: §12.1

## Context

Choice of error/effect model for v2, informed by ADR 0003.

## Decision

- **Plain TypeScript**, not Effect.
- **Public source boundary**: result-shaped protocol data on one channel — expected failure is a
  variant in the response; a crash or nonzero exit is mapped by the core into the same shape.
- **Internals**: plain exceptions plus typed error classes (native stack traces). The adapter
  layer is the single seam converting caught exception / nonzero exit → protocol failure. No code
  handles both models. neverthrow dies; `ServiceResult` is not used in v2.
- **Crash safety = reconcile-on-startup** (stronger than in-process finalizers).

## Consequences

- Stack, `@clipboard-health/util-ts` `ServiceResult` conventions are overridden here by design.
- p-retry, p-limit + AbortSignal, execa, zod 4, commander are the stack primitives.
