# 0011. One bounded context, seven modules, graph enforced by dependency-cruiser

- Status: Accepted
- Date: 2026-07-17
- Ticket: [DEVOP-5977](https://linear.app/clipboardhealth/issue/DEVOP-5977)
- Design doc: §9

## Context

How to lay out v2's source so the flow-model invariants are structurally enforced.

## Decision

- **One bounded context**: one root `CONTEXT.md`, no `CONTEXT-MAP.md`. v2's real boundaries are
  process seams, each carrying the same language across it.
- **Seven modules** under a flat `src/<module>/` (path = glossary noun): acquisition, dispatch,
  run, workspace, session, sandbox, shell. A module's interface is its `index.ts`.
- **The core noun triple**: Workspace (per-task worktrees), Run (execution lifecycle), Session
  (one live occupancy of a run).
- **Observed = Workspace, Reported = Run** — one owner per truth layer.
- **The §9.4 dependency graph is enforced as dependency-cruiser rules** (`architecture:check`):
  entry-point boundary, the graph as an allowlist, and process-boundary rules
  (`src ↛ task-sources`, `task-sources ↛ src`, `e2e ↛ src`). The rules were proven to bite.

## Consequences

- Run never sees Acquisition; a read-only source is a no-op handle and Run's tests never touch
  discovery. Acyclic; nothing calls upward.
- `task-sources/` lives outside `src/` with no import path.
