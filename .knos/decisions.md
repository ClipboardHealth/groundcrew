# Decisions and current work

<!-- Written by `knos export`. Commit this file. -->

A second clone reads this on its first question - it is one of the decision
records knos looks for. Nothing here is private: secrets and private paths
never reach it.


## Decisions

- **a worktree per task, sandboxed by default** - Each dispatched task gets its own git worktree and runs sandboxed unless told otherwise.  _(README.md)_
- **coverage ignores are annotated and preserved** - `/* v8 ignore next @preserve */` for genuinely unreachable statements or functions, and `/* v8 ignore else @preserve */` before an `if` when only the else branch is unreachable.  _(AGENTS.md, Project-specific rules)_
- **run state is per worktree** - `src/lib/worktreeRunState.ts` scopes run state to the worktree that produced it.  _(src/lib/worktreeRunState.ts)_

## Being worked on right now

_Nothing claimed._

---
<sub>knos export. Claims lapse after 30 minutes.</sub>
