# Groundcrew v2 domain language

Four nouns form the model:

- **Task**: normalized work offered by a configured source. Its canonical identity is
  `<sourceName>:<sourceLocalId>`.
- **Workspace**: a per-task directory containing a task marker and zero or more Git
  worktrees. It is not a terminal workspace.
- **Run**: one claim-and-execution attempt. Its durable record is Groundcrew's source of truth
  and moves `provisioning -> running -> complete`. `crew continue` resumes a completed Run's
  session as a new attempt on the same record: fresh run ID, prior IDs kept in
  `previousRunIds`, once the prior completion's source writeback has settled.
- **Artifact**: an output the agent reports, such as a pull request, branch, document, file,
  or ticket. Artifacts are reported claims, never inferred Git facts.

The **presented workspace** is the cmux surface that hosts an interactive agent. A presenter
reports surface existence, not process liveness. A Run owns an immutable, presenter-neutral
presentation ID and may store an opaque presenter handle; the human-editable title is never an
identity. **Observed facts** come from Git;
**reported claims** come from the run record; **source facts** come from source processes.
Status keeps those layers separate.

Cleanup is always an explicit operator action. Source terminality affects dispatch eligibility
but never closes a presented workspace or removes local task state. `crew cleanup <task>` tears
down one Run, `crew cleanup --delivered` tears down delivered Runs without stopping active Runs or
removing failed or stopped Runs, and `crew cleanup --all` tears down every local Run.

A **source bundle** is a directory containing `source.json` and executable protocol commands.
A configured **source instance** gives that bundle an instance name and environment. A
**verdict** is the persisted reason a visible task did not dispatch.
