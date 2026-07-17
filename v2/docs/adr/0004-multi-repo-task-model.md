# 0004. One session per task over a workspace of worktrees

- Status: Accepted
- Date: 2026-07-17
- Ticket: [DEVOP-5967](https://linear.app/clipboardhealth/issue/DEVOP-5967)
- Design doc: §4

## Context

A task may touch several repos. v1 assumed one repo per task and inferred repos from prose.

## Decision

Provision worktrees side by side under one task workspace directory; launch one agent session at
the workspace root that coordinates all repos. Repo resolution is explicit: a `Repos:`
designation resolved against local clones under the base directory, or nothing (empty workspace,
runtime `crew repo add`). Any designated repo missing on disk → bail (provision nothing).
`knownRepositories` and prose-inference die; groundcrew never clones.

## Consequences

- Uniform task branch across worktrees; one PR per repo as default writeback; one artifact
  record per repo. Cross-repo atomicity is an explicit non-goal — per-repo records tell the truth.
- Single-repo tasks stay the degenerate case: one worktree, one branch, one PR.
- The gate widens from "repos in config" to "anything cloned under the base directory", mitigated
  by sandboxing; an optional allowlist can layer on later.
