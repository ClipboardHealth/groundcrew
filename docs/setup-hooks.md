# Setup Hooks

If `.groundcrew/setup.sh` exists in the repo root, groundcrew runs `bash .groundcrew/setup.sh --deps-only` before each agent launch. Otherwise nothing runs. Same convention applies inside the sdx sandbox, overridable per model via `models.definitions.<name>.sandbox.setupCommand`.

There is no implicit `npm install`, `uv sync`, or anything else. Groundcrew is language-agnostic, so opt in by adding the script.

The `--deps-only` flag tells the script it is being called by an automated system before an agent launches. Skip anything interactive or one-time-only. The same script handles both modes; branch on `$1`:

- With `--deps-only`: do the cheap recurring work this worktree needs, such as lockfile installs or type generation. No prompts, no global installs, no `nvm` / `pyenv` bootstrap.
- Without the flag: full interactive bootstrap for first-time onboarding or another tool's SessionStart hook.

Setup failures are advisory. Groundcrew logs the non-zero exit and still launches the agent so a flaky network or stale lockfile does not block the session.

## Examples

Python with uv:

```bash
#!/usr/bin/env bash
set -euo pipefail
if [ "${1:-}" = "--deps-only" ]; then
  uv sync --dev
else
  uv sync --dev
  # Extra one-time bootstrap, such as pre-commit install or db seed.
fi
```

Node with npm:

```bash
#!/usr/bin/env bash
set -euo pipefail
if [ "${1:-}" = "--deps-only" ]; then
  npm clean-install
else
  npm clean-install
  # Extra one-time bootstrap, such as husky install or codegen.
fi
```

Docs-only or polyglot repos can omit the script. With nothing at `.groundcrew/setup.sh`, groundcrew skips the hook silently.

For a comprehensive real-world example with nvm bootstrap, hash-based skip-on-no-changes caching, and portable SHA-256 detection, see [this repo's own `.groundcrew/setup.sh`](../.groundcrew/setup.sh). It is also symlinked at `.claude/setup.sh` so the same script doubles as a Claude Code SessionStart hook for this repo; that symlink is local convenience, not part of groundcrew's contract.

To scaffold `.groundcrew/setup.sh` with a coding agent, see [setup-hook-agent-prompt.md](./setup-hook-agent-prompt.md).
