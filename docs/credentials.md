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

## Pi Provider Authentication

Pi does **not** require authentication with every provider it supports. It only needs credentials for the provider used by the selected model. The built-in Groundcrew preset does not force a provider or model, so Pi uses the defaults from its own settings.

Authenticate the provider before the first unattended launch:

```bash
pi
# In Pi: /login, select and authenticate the provider Groundcrew tasks will use,
# then /quit.
```

By default, Pi stores provider API keys and subscription tokens in `~/.pi/agent/auth.json`; `PI_CODING_AGENT_DIR` changes that base directory. You can authenticate several providers for interactive model switching, but a fixed Pi launch profile only needs its configured provider. `crew doctor` verifies that the `pi` executable exists; it cannot verify provider credentials without making a model request.

If you use a Claude Pro/Max subscription, Pi's [provider documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md#claude-promax) warns that third-party harness usage is billed as extra usage per token rather than against normal plan limits.

Credential handling depends on the runner:

- `none`: Pi uses the host's auth file. Ambient provider API-key environment variables are also inherited.
- `safehouse`: current Safehouse releases include a Pi profile that grants access to the default `~/.pi` directory. Authenticate on the host first and keep the default directory when using that profile. To pass an ambient provider API key instead, list its name in the Pi definition's `preLaunchEnv`; Safehouse otherwise sanitizes it. See [Pi on Safehouse](./runners.md#pi-on-safehouse) for nonstandard install prefixes.
- `sdx`: the contributed Pi kit's supported default keeps an Anthropic key on the host and injects it through Docker Sandboxes' credential proxy. After creating the sandbox, configure the credential specifically for it with `sbx secret set groundcrew-pi anthropic`. Host Pi auth files are not copied into the sandbox. Other providers require corresponding sandbox network and credential policy; see [Docker Sandboxes Setup](./runners.md#docker-sandboxes-setup).

The built-in command is `pi --approve`. Here `--approve` resolves Pi's **project trust** prompt so an unattended task can load project-local Pi resources; it does not authenticate an AI provider and does not bypass Groundcrew's Safehouse or Docker Sandbox boundary.

## Grok Build Authentication

The `grok` preset is the native [Grok Build](https://x.ai/cli) CLI. It is not the `cursor-grok` Cursor profile.

Authenticate on the host before the first unattended launch:

```bash
grok login
```

Grok stores the session in `~/.grok/auth.json` (or `$GROK_HOME/auth.json`). Tokens refresh in the background. When refresh fails, Grok prompts to sign in again.

For CI or machines without a browser, set `XAI_API_KEY` from [console.x.ai](https://console.x.ai). A stored session token wins over the key when both exist. Run `grok logout` to fall back to the key.

`crew doctor` checks that `grok` is on `PATH`. It does not call the API.

Credential handling depends on the runner:

- `none`: Grok uses the host auth file. Ambient `XAI_API_KEY` is inherited.
- `safehouse`: Groundcrew grants the Grok home (`$GROK_HOME` or `~/.grok`) on the agent wrap so auth and sessions stay readable and writable. Authenticate on the host first. To pass `XAI_API_KEY` instead, list it in `preLaunchEnv`. See [Grok on Safehouse](./runners.md#grok-on-safehouse).
- `sdx`: there is no reviewed Docker Sandboxes kit for Grok Build. Do not enable `sandbox: { agent }` for `grok` until you have a kit you have reviewed.

The built-in command is `grok --sandbox off --always-approve --no-plan`. `--sandbox off` leaves isolation to Groundcrew's runner. `--always-approve` skips tool-permission prompts. `--no-plan` blocks Grok plan mode, which waits for a human. These flags do not authenticate Grok.

## Build-Time Secrets

Groundcrew forwards a small allowlist of build-time secrets from your shell into the `prepareWorktree` phase so package installs can authenticate against private registries. The agent process never inherits these values.

Recognized names, defined in [`BUILD_SECRET_NAMES`](../src/lib/buildSecrets.ts):

- `NPM_TOKEN`
- `BUF_TOKEN`

Set them in the shell you run `crew` from. Anything not in this list is ignored.

<details>
<summary>How the secret shuttle works</summary>

For each task:

1. If a `prepareWorktree` or `unsandboxedHooks.prepareWorktree` hook is configured and any recognized var is set and non-empty, groundcrew writes `secrets.env` with mode `0600` into the task's temp prompt dir as `KEY='value'` lines.
2. The launch script sources `secrets.env` with `set -a` so the values are exported into the `prepareWorktree` phase only. Under `sdx`, they are forwarded into the sandbox via `-e KEY` flags.
3. After `prepareWorktree` completes, the script removes every name in `BUILD_SECRET_NAMES` from the environment and removes the entire prompt dir before executing the agent.

Net effect: by the time the agent process exists, the values are gone from the environment and the file is gone from disk.

</details>

## Per-Session Credentials

`preLaunch` runs a host-shell snippet outside Safehouse/sdx before the agent starts. Use it when the agent needs a short-lived credential that must be minted from something the sandbox cannot reach, such as an engineer CLI session in Keychain.

Build secrets are staged whenever either `prepareWorktree` or
`unsandboxedHooks.prepareWorktree` is configured. When
`unsandboxedHooks.prepareWorktree` is set, it runs on the host before
`prepareWorktree` with build secrets sourced; `preLaunchEnv` names are scrubbed
before it runs so the command cannot read agent credentials. After it completes,
execution continues with the normal sandboxed `prepareWorktree` phase.

The "preLaunch never sees build secrets" contract is enforced differently per runner:

- `runner: "safehouse"`: `preLaunch` runs immediately after `cd`, before `secrets.env` is sourced into the launch shell. `prepareWorktree` then runs inside its own profile-neutral `safehouse-clearance` wrap with `--env-pass=NPM_TOKEN,BUF_TOKEN`; build secrets are unset on the host before the agent's Safehouse wrap is executed.
- `runner: "none"`: `secrets.env` is sourced first, `prepareWorktree` runs on the host, build-secret names are unset, then `preLaunch` runs against a clean env, then the agent is executed.

Under the default `safehouse` runner, the agent runs under a sanitized env allowlist. Exports from `preLaunch` land in the launch shell but are stripped before reaching the agent unless they are forwarded. `preLaunchEnv` is the supported way to forward them:

```ts
agents: {
  definitions: {
    claude: {
      preLaunch: "SESSION_TOKEN=$(your-mint-command) && export SESSION_TOKEN",
      preLaunchEnv: ["SESSION_TOKEN"],
    },
  },
},
```

`&&` ensures `export` only runs when the mint succeeds. A failed mint propagates non-zero out of `preLaunch` and aborts launch before the agent starts. `{{worktree}}` is substituted the same way as in `cmd`.

Under `runner: "none"`, groundcrew clears each listed `preLaunchEnv` name immediately before `preLaunch`, then exports from the snippet flow through unchanged to the agent. Clearing inherited values ensures the launch-time empty check reflects what `preLaunch` produced instead of silently reusing an ambient credential. Groundcrew-managed worker metadata (`GROUNDCREW_TASK_ID` and `GROUNDCREW_COMPLETE`) cannot be listed because hooks may read those values and groundcrew owns what the agent receives. A non-empty `preLaunchEnv` is not supported when `local.runner` resolves to `sdx` in v1. An empty `preLaunchEnv: []` is a uniform no-op in every runner.

<details>
<summary>Manual fallback when <code>cmd</code> brings its own <code>safehouse</code> wrap</summary>

If your `cmd` already starts with `safehouse`, groundcrew will not auto-compose `--env-pass=` for you and a non-empty `preLaunchEnv` is rejected at launch. Add the names to your own `cmd` instead. This opts the agent out of groundcrew's default `safehouse-clearance` wrap, so re-supply `--append-profile` / `--env` yourself if you need it:

```ts
claude: {
  preLaunch: "SESSION_TOKEN=$(your-mint-command) && export SESSION_TOKEN",
  cmd: "safehouse --env-pass=SESSION_TOKEN your-agent-cli",
},
```

</details>
