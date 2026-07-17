# 0005. Sinks and flows dissolve; a three-verb source contract

- Status: Accepted
- Date: 2026-07-17
- Ticket: [DEVOP-5968](https://linear.app/clipboardhealth/issue/DEVOP-5968)
- Design doc: §3

## Context

v1 modeled pipelines with typed sources, sinks, and flow config. Following ADR 0001, the
generalization is asymmetric.

## Decision

- **Sinks dissolve.** Every task output happens through the agent's own tools or the source's
  writeback. No typed sink stage.
- **Flows dissolve.** Config declares sources and agent profiles; each task carries its routing.
  No pipeline/flow object.
- **Source contract is `list` / `get` / `update`**, capability by omission (`update` absent ⇒
  read-only). `update` events: `claimed` (may return _rejected_), `progress`, `completed`.
- **Artifacts are plural, kind-tagged, agent-reported.** The core is forge-blind; it observes
  only workspace-local git facts.
- **Run states**: `provisioning → running ⇄ paused → complete{delivered | failed | stopped}`.

## Consequences

- The core knows nothing about GitHub or any forge; a forgotten report is a missing link.
- Recurring tasks are a source concern; core ships no recurrence machinery.
