# Lifecycle command results

The lifecycle commands used by external automation accept `--json`:

```bash
crew start <task> --json
crew stop <task> [--reason <text>] --json
crew resume <task> --json
crew cleanup <task> --json
```

These results are action receipts. They describe what that invocation changed;
they are not task status snapshots. After every receipt—including a conflict,
refusal, partial result, or cancellation—the consumer must refresh the full
legacy `crew status --json` inventory and filter the affected task locally.
There is no task-scoped status JSON dependency.

## Output and exit behavior

On a classified completion, JSON mode writes exactly one JSON document to
stdout. Progress messages, headings, ANSI styling, and remediation shell
commands are excluded. Diagnostics may be written to stderr and to the
configured Groundcrew log.

Successful and idempotent outcomes exit zero. The `partial`, `conflict`, and
`refused` outcomes write their typed receipt and exit non-zero. Invocation,
configuration, task-resolution, and unexpected internal failures that prevent
a trustworthy receipt write no JSON to stdout, write a human-readable error to
stderr, and exit non-zero. Groundcrew does not emit a generic JSON error
envelope.

Without `--json`, the same typed result drives the existing human-readable
completion output.

## Common fields

Every action-specific result has these required fields:

| Field              | Meaning                                                                                                               |
| ------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `action`           | `start`, `stop`, `resume`, or `cleanup`. This is the discriminant.                                                    |
| `task.id`          | Lower-cased local task key used by worktrees and workspaces.                                                          |
| `task.canonicalId` | Optional source-qualified ID, when task resolution or persisted state supplies it.                                    |
| `task.url`         | Optional source URL, when known.                                                                                      |
| `outcome`          | Action-specific classified outcome.                                                                                   |
| `state`            | Best observed state: `provisioning`, `running`, `interrupted`, `resumed`, `failed-to-launch`, `absent`, or `unknown`. |
| `resources`        | Action-specific repository, branch, worktree, and workspace resources observed or affected.                           |
| `problems`         | Array of `{ code, message }` records. Empty on a complete result with no known problem.                               |

Start, stop, and resume expose singular resource fields when known:
`repository`, `branch`, `worktreeDir`, `workspace.name`, optional
`workspace.accessCommand`, and `agent`. Cleanup exposes `worktrees[]` with
`repository`, `branch`, `worktreeDir`, and `removed`, plus `workspaces[]` with
`name` and `closed`. A partial cleanup preserves successful removals and every
reported failure rather than collapsing to the first error.

## Outcomes

| Action  | Outcomes                                                                              |
| ------- | ------------------------------------------------------------------------------------- |
| Start   | `started`, `already-running`, `dry-run`, `partial`, `conflict`                        |
| Stop    | `stopped`, `already-stopped`, `workspace-missing`, `not-found`, `partial`, `conflict` |
| Resume  | `resumed`, `already-running`, `not-found`, `partial`, `conflict`                      |
| Cleanup | `cleaned`, `nothing-to-clean`, `state-cleared`, `refused`, `partial`, `conflict`      |

`already-running`, `already-stopped`, `workspace-missing`, `not-found`,
`nothing-to-clean`, and `state-cleared` are idempotent zero-exit receipts. A
Start whose local workspace opened but whose task-source status write failed is
`partial`, retains the running resources, and includes
`task-status-update-failed`.

Cleanup without `--force` refuses a live workspace, a dirty worktree, or a
worktree whose cleanliness cannot be verified before teardown. JSON refusal
messages intentionally do not recommend force cleanup. `--force` remains a
direct operator option; automation such as the Raycast extension must never
pass, expose, or recommend it.

## Problem codes

The current stable codes are:

| Code                           | Meaning                                                                 |
| ------------------------------ | ----------------------------------------------------------------------- |
| `cancelled`                    | Cooperative `SIGINT` or `SIGTERM` interrupted the operation.            |
| `lifecycle-lock-held`          | Another lifecycle mutation currently owns the task.                     |
| `task-status-update-failed`    | Start succeeded locally but source status writeback failed.             |
| `state-write-failed`           | An observed external mutation could not be fully recorded in run state. |
| `workspace-busy`               | Cleanup found a live workspace and refused teardown.                    |
| `workspace-conflict`           | A live workspace did not match trustworthy local task context.          |
| `workspace-status-unavailable` | Groundcrew could not verify workspace state.                            |
| `worktree-conflict`            | Existing local state or a stale worktree blocks Start.                  |
| `worktree-dirty`               | Cleanup found uncommitted changes.                                      |
| `worktree-status-unknown`      | Cleanup could not verify worktree cleanliness.                          |
| `workspace-close-failed`       | Teardown could not close an affected workspace.                         |
| `worktree-remove-failed`       | Teardown could not remove an affected worktree.                         |

Lifecycle mutations are serialized per task. Lock ownership is recorded by
process and dead owners are recoverable, so a crashed command does not
permanently strand the task.

`SIGINT` and `SIGTERM` are cooperative: Groundcrew passes an `AbortSignal`
through workspace and worktree operations, preserves completed teardown steps,
and reconciles the best observed durable run state before returning a partial
receipt. `SIGKILL` and equivalent forced termination cannot guarantee recovery
or a final JSON document; the caller must still refresh `crew status --json`.

## Compatibility

This contract follows Groundcrew SemVer. Removing or renaming a required field,
or changing its meaning, requires a major release. Additive optional fields,
new outcome values, and new problem codes are compatible changes. Consumers
must ignore unknown fields and tolerate unknown outcome and problem codes while
refreshing status after the mutation.
