# 0007. Task sources are the only plugin kind: sandboxed directory bundles

- Status: Accepted
- Date: 2026-07-17
- Ticket: [DEVOP-5973](https://linear.app/clipboardhealth/issue/DEVOP-5973)
- Design doc: §6

## Context

Following ADR 0002, decide what a plugin is and how it is packaged, versioned, and trusted.

## Decision

- **"Plugin" means exactly one thing: a task source.** Agent harnesses are declarative config;
  sandbox runners are core-only (srt only; safehouse/clearance/sbx die). No in-process plugin
  class exists.
- **Packaging**: a directory bundle (`source.json` + scripts) discovered under the user config
  dir or shipped in the package. Provenance collapses to `package | user`. No registry in v2.0.
- **Versioning**: `source.json` carries a required integer `protocolVersion: 1`; additive change
  rides capability-by-omission. Unsupported-but-parseable → loud actionable error; unparseable →
  skip-plus-warn.
- **Sandboxed by default** under the same srt machinery as agents, with a network egress
  allowlist; `sandbox: false` opt-out is loud. `linear`, `jira`, `todo-txt` ship as bundles.

## Consequences

- Third-party code never enters the core repo or the core process.
- First-party bundles are the protocol's permanent conformance tests.
