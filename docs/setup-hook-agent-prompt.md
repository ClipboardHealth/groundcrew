# Agent prompt: generate `.groundcrew/config.json`

When onboarding a repository to Groundcrew, an operator can ask a coding agent
to author the repo-local `prepareWorktree` hook. The hook has a narrow contract:
it is recurring, non-interactive worktree preparation for unattended agents.

Paste this prompt at the target repo root:

```text
You're adding Groundcrew's repo-local prepareWorktree hook for this repository.
Produce `.groundcrew/config.json` and smoke-test the command.

Context: Groundcrew launches each agent in a fresh git worktree per task. If
`.groundcrew/config.json` contains `hooks.prepareWorktree`, Groundcrew runs that
command from the repo root after creating the worktree and before launching the
agent. The same command runs under Safehouse, sdx, or the host runner.

Hook requirements:

- JSON shape:
  {
    "version": 1,
    "hooks": {
      "prepareWorktree": "<command>"
    }
  }
- The command must be non-interactive and idempotent.
- Include only recurring worktree preparation the agent needs, such as lockfile
  installs, dependency downloads, or type/code generation required for
  navigation and tests.
- Do NOT include prompts, global installs, auth setup, runtime-version-manager
  bootstrap (`nvm`, `pyenv`, `rustup`, `mise`, `asdf`), db seeds, husky,
  pre-commit, or local package linking.
- Keep it fast. Each task starts from a fresh worktree, so use frozen-lockfile
  installs (`npm ci`, `pnpm install --frozen-lockfile`, `uv sync --frozen`,
  `cargo fetch`, `go mod download`, etc.) and trust global package-manager
  caches.

Detect this repo's stack and write the shortest command that prepares the root
worktree:

- `package.json` + `package-lock.json` → `npm ci`
- `package.json` + `pnpm-lock.yaml` → `pnpm install --frozen-lockfile`
- `package.json` + `yarn.lock` → `yarn install --frozen-lockfile`
- `pyproject.toml` + `uv.lock` → `uv sync --dev --frozen`
- `poetry.lock` → `poetry install`
- `Cargo.lock` → `cargo fetch`
- `go.mod` → `go mod download`
- `Gemfile.lock` → `bundle install --jobs=4`
- Multiple lockfiles → combine each required root-level prep command with `&&`.
- No recurring root worktree prep → do not create the file.

Verify before reporting done:

1. Run the exact `hooks.prepareWorktree` command from the repo root.
2. Confirm it exits 0 with no prompts and no runtime-bootstrap warnings.

Do NOT commit. Report exactly what you wrote so the operator can review.
```
