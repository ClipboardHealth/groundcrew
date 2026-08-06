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

The hook runs from the worktree root unless the repo entry sets `workdir`; in
that case it runs from that subdirectory. Under every runner:

- `safehouse`: inside a profile-neutral Safehouse wrap before the agent wrap.
- `sdx`: inside the Docker Sandbox before the agent command.
- `none`: on the host shell before the agent command.

Hook failures are advisory. Groundcrew logs the non-zero exit and still launches
the agent so a flaky package registry or stale lockfile does not block the
session.

## Task-level opt-out

Some tasks need the repository checkout but not its dependency installation or
code generation. Add the exact Linear label `groundcrew-skip-prepare` to skip
worktree preparation for that task. Shell task sources can emit
`"worktreePreparation": "skip"` in the issue JSON for the same behavior.

The opt-out skips every preparation layer, including the operator-only
`unsandboxedHooks.prepareWorktree` hook. Groundcrew still creates the worktree
and launches the agent normally. This policy does not make the worktree
read-only; it only skips preparation commands.

Dry-run output includes `prepareWorktree skipped` when the policy applies.

## Precedence

`prepareWorktree` resolves through three layers, highest priority first:

| Layer                                             | Where                      | Author           |
| ------------------------------------------------- | -------------------------- | ---------------- |
| `.groundcrew/config.json` `hooks.prepareWorktree` | committed in the repo      | repo maintainers |
| `knownRepositories[].hooks.prepareWorktree`       | `crew.config.ts`, per-repo | operator         |
| `defaults.hooks.prepareWorktree`                  | `crew.config.ts`, global   | operator         |

The repo-committed file wins (it travels with the code and stays in sync with
the repo's build), then the per-repo operator layer, then the global default. A
repo with none of the three set skips the phase.

### Global default

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

### Per-repo operator hook

When you can't (or don't want to) commit a `.groundcrew/config.json` into a repo
— a third-party repo, or one where adding groundcrew files is undesirable — set
the hook for just that repo from your own `crew.config.ts`:

```ts
export default {
  workspace: {
    projectDir: "~/dev",
    knownRepositories: [
      "your-org/your-repo",
      {
        name: "other-org/their-repo",
        hooks: {
          prepareWorktree: "uv sync --dev --frozen",
        },
      },
    ],
  },
  // ...
};
```

This reuses the same `hooks` container and `prepareWorktree` contract as the
other two layers. It beats `defaults.hooks` but still yields to a committed
`.groundcrew/config.json` in that repo.

## `unsandboxedHooks` (operator-only host setup)

Some setup cannot run in the sandbox — it needs host toolchains, host network
posture, or writes outside the worktree. For those cases an operator may grant a
**per-repository** host hook. It mirrors the `hooks` container's
`prepareWorktree` phase, on the opposite side of the sandbox boundary:

```ts
// crew.config.ts (operator only)
knownRepositories: [
  {
    name: "catalog-admin",
    hooks: { prepareWorktree: "npm ci" }, // sandboxed
    unsandboxedHooks: { prepareWorktree: "bin/setup" }, // HOST, explicit opt-in
  },
];
```

When both are set, `unsandboxedHooks.prepareWorktree` runs first on the host,
then `hooks.prepareWorktree` runs sandboxed, then the agent starts.

**The trust granted.** `unsandboxedHooks.prepareWorktree` runs on the host shell
outside any sandbox, with the operator's full host authority, against
repo-controlled code (lifecycle scripts, `Gemfile`, the repo's own `bin/setup`).
Grant it only to repositories you trust to run arbitrary code on the host.

**Constraints.**

- **Operator-only.** It is honored only from `crew.config.ts`. Setting
  `unsandboxedHooks` in a repo-committed `.groundcrew/config.json`
  (top-level or under `hooks`) is a hard config error.
- **Per-repository only.** There is no `defaults.unsandboxedHooks`;
  host execution is never a fleet-wide default.
- **Runner support.** Runs on the host for `safehouse` and `none`. The
  `sdx` runner rejects it at launch — a container has no host to run it on.
- **Credentials.** Build secrets are available so `npm`/`bundle` can
  authenticate; the agent's `preLaunchEnv` names are scrubbed so the command
  cannot read agent credentials.

## `hookGeneratedPaths` (when the hook dirties the worktree)

Some `prepareWorktree` hooks modify tracked files or write untracked files git
does not ignore — a `postinstall` that regenerates a tracked rules file, or a
sync script that drops `.agents/skills/` into the checkout. Every worktree is then
dirty from birth, and the teardown guard refuses to remove it: `crew cleanup`
reports `worktree has N modified files and M untracked files` on every poll,
forever, even though the agent never touched them.

Declare those paths so the guard stops counting them:

```ts
// crew.config.ts (operator only)
knownRepositories: [
  {
    name: "catalog-admin",
    hooks: { prepareWorktree: "npm ci" },
    hookGeneratedPaths: [".agents/skills", ".claude/settings.json", ".rules/frontend/x.md"],
  },
];
```

A global fallback for repos that share one hook lives under `defaults`:

```ts
defaults: {
  hooks: { prepareWorktree: "npm ci" },
  hookGeneratedPaths: [".agents/skills"],
},
```

**How it behaves.**

- The dirtiness probe passes each path to git as an exclude pathspec, so
  `crew cleanup`, `crew status`, and `crew task done` all stop seeing them.
  Teardown then retries `git worktree remove --force` — but only when the
  filtered probe reads clean **and** the unfiltered one still reports work,
  proving the declared paths were the sole blocker.
- Anything undeclared still blocks. Add one file git did not expect under a
  declared directory and the guard fires again, so real agent work is never
  discarded silently.
- With no `hookGeneratedPaths` anywhere, the git command is unchanged and the
  guard is exactly as strict as before.

**Constraints.**

- **Operator-only.** Honored only from `crew.config.ts`. Setting
  `hookGeneratedPaths` in a repo-committed `.groundcrew/config.json` (top-level
  or under `hooks`) is a hard config error — a repository must not get to
  decide which host files groundcrew may force-discard.
- **Per-repo overrides, does not merge.** A repo entry's list replaces
  `defaults.hookGeneratedPaths` wholesale.
- **Worktree-root-relative, matched literally.** Paths are relative to the
  worktree root even when the entry sets a `workdir`, matching what
  `git status` prints — copy them straight out of its output. Wildcards are
  inert; absolute paths, `.`/`..` segments, and leading-colon pathspec magic
  are rejected at config load.
- **Declare narrowly.** A path listed here is force-discarded on teardown.
  Naming a directory that also holds real work (`src`, or a parent of it)
  throws that work away with no warning.

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
