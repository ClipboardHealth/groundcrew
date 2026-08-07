# Groundcrew v2 domain language

Four nouns form the model:

- **Task**: normalized work offered by a configured source. Its canonical identity is
  `<sourceName>:<sourceLocalId>`.
- **Workspace**: a per-task directory containing a task marker and zero or more Git
  worktrees. It is not a terminal workspace.
- **Run**: one claim-and-execution attempt. Its durable record is Groundcrew's source of truth
  and moves `provisioning -> running -> complete`.
- **Artifact**: an output the agent reports, such as a pull request, branch, document, file,
  or ticket. Artifacts are reported claims, never inferred Git facts.

The **presented workspace** is the cmux surface that hosts an interactive agent. A presenter
reports surface existence, not process liveness. **Observed facts** come from Git;
**reported claims** come from the run record; **source facts** come from source processes.
Status keeps those layers separate.

A **source bundle** is a directory containing `source.json` and executable protocol commands.
A configured **source instance** gives that bundle an instance name and environment. A
**verdict** is the persisted reason a visible task did not dispatch.
