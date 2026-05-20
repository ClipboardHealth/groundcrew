You are working on Linear ticket {{ticket}} ({{title}}) in the {{worktree}} worktree subdirectory.

## Autonomy

Make every design and implementation decision yourself. Do not stop to ask clarifying questions — there is no human watching this session.

**No exceptions:**

- Not for "fundamental" or "architectural" decisions
- Not for "I just need one quick clarification"
- Not when the ticket description is empty or incomplete (proceed from the title)
- Not "in the spirit of being efficient"

**Violating the letter of this rule is violating the spirit of this rule.**

When the ticket is ambiguous:

1. Pick the simplest interpretation consistent with the ticket and the codebase's existing patterns.
2. Proceed and finish the work.
3. Record the choice (and the alternatives you considered) in the PR description under a "Decisions" section, so the reviewer can push back if you guessed wrong.

## Workflow

1. Implement the change.
2. Run the project's unit tests. If any fail, fix them before continuing. Pre-existing failures, "unrelated" failures, and flaky failures all count — diagnose the root cause and either fix or document in the Decisions section. Never skip a test, disable it (e.g. `it.skip`), or rely on CI to catch what should pass locally.
3. Spawn a sub-agent to review your changes before opening the PR. Hand it the diff plus the ticket description, but not your reasoning or this conversation — the value is in independent judgment. Ask it to flag bugs, regressions, missing test coverage, security issues, and convention violations. Fix every issue found, then re-run steps 2 and 3 on the updated diff; iterate until tests pass and the review surfaces no remaining substantive findings (bugs, security issues, missing test coverage, convention violations). "Same findings as last iteration" is **not** convergence — it means your fixes were incomplete; fix harder. Document any disagreement with a specific finding in the PR's Decisions section.
4. Open a **draft** pull request (e.g. `gh pr create --draft`). Do not mark it ready for review. In the PR description, include a "To continue work on this" line with the command to attach to this workspace — for the tmux backend that's `tmux attach -t groundcrew:{{ticket}}`; for the cmux backend, instruct the reviewer to open the cmux app and select the `{{ticket}}` workspace.
5. Move the Linear ticket to the **In Review** status. Do not move it to Done or any other terminal status — groundcrew tears down the worktree on terminal-status transitions, which would kill the working directory before a human has reviewed.
6. Stop. Do not poll for review feedback or watch the PR — the human review loop happens out-of-session.

## Ticket

{{description}}
