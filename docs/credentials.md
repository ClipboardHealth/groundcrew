# Credentials

## Linear API Key

`crew` reads `GROUNDCREW_LINEAR_API_KEY` first, then falls back to `LINEAR_API_KEY`.

```bash
export GROUNDCREW_LINEAR_API_KEY="lin_api_..."
crew doctor
```

To resolve the key from 1Password:

```bash
echo "GROUNDCREW_LINEAR_API_KEY='op://<vault>/LINEAR_API_KEY/credential'" > .env.1password
op run --env-file .env.1password -- crew doctor
```

## Build-Time Secrets

Groundcrew forwards a small allowlist of build-time secrets from your shell into the `prepareWorktree` phase so package installs can authenticate against private registries. The agent process never inherits these values.

Recognized names, defined in [`BUILD_SECRET_NAMES`](../src/lib/buildSecrets.ts):

- `NPM_TOKEN`
- `BUF_TOKEN`

Set them in the shell you run `crew` from. Anything not in this list is ignored.

<details>
<summary>How the secret shuttle works</summary>

For each task:

1. If a `prepareWorktree` hook is configured and any recognized var is set and non-empty, groundcrew writes `secrets.env` with mode `0600` into the task's temp prompt dir as `KEY='value'` lines.
2. The launch script sources `secrets.env` with `set -a` so the values are exported into the `prepareWorktree` phase only. Under `sdx`, they are forwarded into the sandbox via `-e KEY` flags.
3. After `prepareWorktree` completes, the script removes every name in `BUILD_SECRET_NAMES` from the environment and removes the entire prompt dir before executing the agent.

Net effect: by the time the agent process exists, the values are gone from the environment and the file is gone from disk.

</details>

## Per-Session Credentials

`preLaunch` runs a host-shell snippet outside Safehouse/sdx before the agent starts. Use it when the agent needs a short-lived credential that must be minted from something the sandbox cannot reach, such as an engineer CLI session in Keychain.

The "preLaunch never sees build secrets" contract is enforced differently per runner:

- `runner: "safehouse"`: `preLaunch` runs immediately after `cd`, before `secrets.env` is sourced into the launch shell. `prepareWorktree` then runs inside its own profile-neutral `safehouse-clearance` wrap with `--env-pass=NPM_TOKEN,BUF_TOKEN`; build secrets are unset on the host before the agent's Safehouse wrap is executed.
- `runner: "none"`: `secrets.env` is sourced first, `prepareWorktree` runs on the host, build-secret names are unset, then `preLaunch` runs against a clean env, then the agent is executed.

Under the default `safehouse` runner, the agent runs under a sanitized env allowlist. Exports from `preLaunch` land in the launch shell but are stripped before reaching the agent unless they are forwarded. `preLaunchEnv` is the supported way to forward them:

```ts
models: {
  definitions: {
    claude: {
      preLaunch: "SESSION_TOKEN=$(your-mint-command) && export SESSION_TOKEN",
      preLaunchEnv: ["SESSION_TOKEN"],
    },
  },
},
```

`&&` ensures `export` only runs when the mint succeeds. A failed mint propagates non-zero out of `preLaunch` and aborts launch before the agent starts. `{{worktree}}` is substituted the same way as in `cmd`.

Under `runner: "none"`, exports flow through unchanged and `preLaunchEnv` is a no-op. A non-empty `preLaunchEnv` is not supported when `local.runner` resolves to `sdx` in v1. An empty `preLaunchEnv: []` is a uniform no-op in every runner.

<details>
<summary>Manual fallback when <code>cmd</code> brings its own <code>safehouse</code> wrap</summary>

If your `cmd` already starts with `safehouse`, groundcrew will not auto-compose `--env-pass=` for you and a non-empty `preLaunchEnv` is rejected at launch. Add the names to your own `cmd` instead. This opts the model out of groundcrew's default `safehouse-clearance` wrap, so re-supply `--append-profile` / `--env` yourself if you need it:

```ts
claude: {
  preLaunch: "SESSION_TOKEN=$(your-mint-command) && export SESSION_TOKEN",
  cmd: "safehouse --env-pass=SESSION_TOKEN your-agent-cli",
},
```

</details>
