# 0014. The run record is the truth; one JSON-lines log; `status` is the why affordance

- Status: Accepted
- Date: 2026-07-17
- Ticket: [DEVOP-5982](https://linear.app/clipboardhealth/issue/DEVOP-5982)
- Design doc: §10

## Context

How v2 answers "why did / didn't X happen" and reaps stale state.

## Decision

- **Logs are diagnostics; the run record is the truth.** The run record gains a compact,
  versioned, append-only event history `{ts, event, detail}`. Logs stay freely deletable.
- **One global JSON-lines file** with size-based rotation (~10 MB × 3); correlation ids
  (`taskId`/`runId`/`sessionId`/`source`/`repo`) are the filter. The logging lib exports a zod
  schema for the line format; the E2E suite validates every emitted line against it.
- **`crew status <task>` is the why affordance** for three situations: ran/running, queued and
  never starting (Dispatch persists a per-task skip verdict), and finished/lingering.
- **Active sweep, no TTL.** Reconcile is idempotent with two callers (startup, dispatcher tick);
  auto-GC only the provably dead; never auto-kill a live agent process.

## Consequences

- No 15th command; `status` carries the diagnostic load.
- Finer-than-run-state live activity (`crew progress`) is a documented, deferred seam.
