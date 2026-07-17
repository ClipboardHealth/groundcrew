# 0012. Rewrite in `v2/` on `main`; ships as 5.0.0

- Status: Accepted
- Date: 2026-07-17
- Ticket: [DEVOP-5978](https://linear.app/clipboardhealth/issue/DEVOP-5978)
- Design doc: §2

## Context

The locked decisions kill or reshape most of v1 (~21K source lines): config format, the reviewer
loop, clearance/safehouse/sbx, several commands, and the core nouns. Every external surface
breaks.

## Decision

- **Rewrite, not evolve.** Evolve's safety net was stale (the suite never runs on v1).
- **Same repo, isolated `v2/` workspace** on `main`, with its own `package.json` and its own
  `CLAUDE.md`/`AGENTS.md`/`CONTEXT.md`. dependency-cruiser forbids cross-tree imports both ways.
  Flip condition: escalate to a new repo if agents keep tripping over v1.
- **Keep `@clipboard-health/groundcrew` and the `crew` bin; release is 5.0.0.** No npm publish
  until the E2E suite is green; v1 goes fixes-only. Cutover: cut a `4.x` maintenance branch,
  flatten `v2/` to root, delete the v1 tree.
- **Release-automation wrinkle**: `main`'s Nx Release must not treat v2 commits as 4.x releases
  (see ADR 0014).

## Consequences

- Surviving v1 code (srtPolicy/srtLaunch, cleaner, tmux/git plumbing, doctor) is ported
  file-by-file with its tests; `git mv` preserves history.
