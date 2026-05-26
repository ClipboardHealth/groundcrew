# Groundcrew uses sandboxes but does not provision them

**Status:** Accepted; not yet implemented. Implementation is tracked under STAFF-1033 and its slices. The past tense below describes the decided end state, not the current code — at time of writing `lib/dockerSandbox.ts` and `crew sandbox` still exist.

Groundcrew launches agent processes _inside_ an isolation backend (safehouse on macOS, sdx/Docker Sandboxes elsewhere, or `none`), but it no longer manages the lifecycle of those sandboxes. We removed `crew sandbox` (ensure/regenerate/auth/rm/list), the auth-recipe machinery, and `lib/dockerSandbox.ts` because they duplicated functionality `sbx` already provides — wrapping someone else's CLI to be marginally more ergonomic cost ~1100 LOC and pulled sandbox-provisioning concepts (templates, kits, auth recipes, git defaults) into groundcrew's config surface for no proportional benefit.

## Considered Options

- **Keep the sdx lifecycle commands** — rejected: they reimplement `sbx run`/`sbx exec` setup flows, and every concept they expose (`authRecipes`, `template`, `kits`, `gitDefaults`) is a sandbox concern, not an orchestration concern.
- **Generalize the launch wrap to a user-supplied template string** — rejected for now: the build-time-secrets and `.groundcrew/setup.sh` plumbing inside the sdx wrap is awkward to express in a user template. Kept a small `safehouse | sdx | none` WRAP enum in core instead.

## Consequences

- The launch **WRAP** stays in core (`launchCommand.ts`): given an agent command + worktree + secrets + sandbox name, produce the shell string that runs the agent under the chosen backend.
- First-time sandbox setup is now a manual `sbx` workflow the user runs themselves; the README points to it. Groundcrew assumes the sandbox already exists at launch.
- Linux/WSL users are unaffected at launch time — they keep the sdx WRAP — but no longer get groundcrew-driven provisioning.
- Removed config keys (`sandbox.authRecipes`, `sandbox.gitDefaults`, sdx lifecycle fields like `template`/`kits`) hard-fail with an actionable message, matching the existing `config.ts` precedent for removed shapes.
