# One task-source path; Linear is just an adapter

**Status:** Accepted; not yet implemented. Implementation is tracked under STAFF-1033 / STAFF-1034 (lands PR #89). The past/present tense below describes the decided end state, not the current code — at time of writing `orchestrator.ts` still calls `boardSource.fetch()` and `boardSource.ts` still exists.

There is a single path from board state to dispatch: `Source[] → Board → Dispatcher`. Linear is a `TaskSource` adapter like any other; the dispatcher and eligibility code never import Linear-specific logic. We deleted the legacy `boardSource.ts → dispatcher` path (which made Linear the only source that could actually start agents) and moved the live Linear logic into `src/lib/adapters/linear/`, because the half-wired parallel architecture meant declared shell sources validated at startup but contributed zero tasks to dispatch — defeating the entire pluggable-source point.

## Considered Options

- **Keep `boardSource.ts` as a Linear fast-path and wire extras alongside it** — rejected: two paths from board to dispatch is exactly the coupling that let Linear concepts leak into the dispatcher. The whole value is symmetry — every source, including Linear, reaches dispatch the same way.

## Consequences

- The canonical seam is the `Issue` contract: a source emits `model` and `repository`, or the task is ignored (`isGroundcrewIssue` keys off exactly that). Consumers branch on the canonical `CanonicalStatus` enum, never on a source's native status names.
- **Linear-specific** concepts live in the adapter: `agent-*` label parsing, `agent-any` routing, sub-issue/parent detection, assigned-to-viewer + label selection policy.
- **Canonical** concepts stay in eligibility so every source benefits: blocker classification (sources populate `blockers[]`) and exhausted-model gating (sources pick a `model`).
- This was a pure internal refactor with no user-visible change — Linear keeps working identically — so it carried no migration cost and landed before the breaking v5 cuts.
- Changing the Linear selection mechanism (assigned + labeled) is now an adapter-local change that does not touch the engine.
