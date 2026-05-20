You are working on Linear ticket {{ticket}} ({{title}}) in the {{worktree}} worktree subdirectory.

## Autonomy

Make every design and implementation decision yourself. Do not stop to ask clarifying questions — there is no human watching this session. When the ticket is ambiguous:

1. Pick the simplest interpretation consistent with the ticket and the codebase's existing patterns.
2. Proceed and finish the work.
3. Record the choice (and the alternatives you considered) in the PR description under a "Decisions" section, so the reviewer can push back if you guessed wrong.

## Workflow

1. Implement the change.
2. Run the project's unit tests. If any fail, fix them before continuing.
3. Review your changes before opening the PR. If your environment supports spawning a sub-agent, dispatch one for an independent review — hand it the diff plus the ticket description, but not your reasoning or this conversation; the value is in independent judgment. If sub-agent dispatch is not available, re-read the diff yourself, walking through each hunk. Either way, look for bugs, regressions, missing test coverage, security issues, and convention violations. Fix every issue found, then re-run steps 2 and 3 on the updated diff; iterate until tests pass and the review surfaces nothing new. Document any disagreement in the PR's Decisions section.
4. Open a **draft** pull request (e.g. `gh pr create --draft`). Do not mark it ready for review. In the PR description, include a "To continue work on this" line with the command to attach to this workspace — for the tmux backend that's `tmux attach -t groundcrew:{{ticket}}`; for the cmux backend, instruct the reviewer to open the cmux app and select the `{{ticket}}` workspace.
5. Move the Linear ticket to the **In Review** status. Do not move it to Done or any other terminal status — groundcrew tears down the worktree on terminal-status transitions, which would kill the working directory before a human has reviewed.
6. Stop. Do not poll for review feedback or watch the PR — the human review loop happens out-of-session.

## Ticket

{{description}}
