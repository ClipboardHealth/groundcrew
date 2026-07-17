# 0002. Plugins cross a versioned process boundary

- Status: Accepted
- Date: 2026-07-17
- Ticket: [DEVOP-5971](https://linear.app/clipboardhealth/issue/DEVOP-5971)
- Design doc: §6

## Context

Plugin-distribution research compared in-process npm plugins against the models that work in
practice (Terraform providers, MCP).

## Decision

Reject in-process npm plugins: they deliver no sandboxing and no real review isolation. Adopt a
versioned process boundary, as Terraform providers and MCP do.

## Consequences

- A plugin is a directory bundle crossing a process boundary, not loaded code (see ADR 0007).
- Review isolation is met structurally: third-party code never enters the core repo or process.
- Research branch: `research/plugin-distribution-models`.
