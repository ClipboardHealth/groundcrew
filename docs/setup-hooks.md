# Prepare Worktree Hooks

Groundcrew can run one repo-preparation hook after it creates a task worktree
and before it launches the agent. Add a repo-local `.groundcrew/config.json`:

```json
{
  "version": 1,
  "hooks": {
    "prepareWorktree": "npm ci && npm run codegen:types"
  }
}
```

If the file or hook is absent, Groundcrew skips this phase. There is no
implicit `npm install`, `uv sync`, or legacy setup script convention.

`prepareWorktree` must be non-interactive, idempotent, and limited to recurring
worktree preparation the agent needs: lockfile installs, dependency downloads,
or type/code generation required for navigation and tests. Do not put human
onboarding in this hook: no prompts, global installs, auth setup, runtime
manager bootstrap (`nvm`, `pyenv`, `rustup`, `mise`, `asdf`), db seeds, husky,
pre-commit, or local package linking.

The hook runs from the repo root under every runner:

- `safehouse`: inside a profile-neutral Safehouse wrap before the agent wrap.
- `sdx`: inside the Docker Sandbox before the agent command.
- `none`: on the host shell before the agent command.

Hook failures are advisory. Groundcrew logs the non-zero exit and still launches
the agent so a flaky package registry or stale lockfile does not block the
session.

## Defaults

For repos without local config, set a fallback in `crew.config.ts`:

```ts
export default {
  defaults: {
    hooks: {
      prepareWorktree: "test ! -f package-lock.json || npm ci",
    },
  },
  // ...
};
```

Repo-local `.groundcrew/config.json` wins for that hook. A repo-local file
without `hooks.prepareWorktree` still falls back to the `crew.config.ts`
default.

## Examples

Python with uv:

```json
{
  "version": 1,
  "hooks": {
    "prepareWorktree": "uv sync --dev --frozen"
  }
}
```

Node with npm:

```json
{
  "version": 1,
  "hooks": {
    "prepareWorktree": "npm ci"
  }
}
```

Docs-only or manually prepared repos can omit the file.

To scaffold `.groundcrew/config.json` with a coding agent, see
[setup-hook-agent-prompt.md](./setup-hook-agent-prompt.md).
