# Runners

`local.runner` picks the local isolation backend. `auto` resolves per platform.

| Runner      | Default on  | Backend                                                                                                  |
| ----------- | ----------- | -------------------------------------------------------------------------------------------------------- |
| `safehouse` | macOS       | [Safehouse](https://agent-safehouse.dev/) — fastest local; cannot safely give the agent Docker.          |
| `sdx`       | Linux / WSL | [Docker Sandboxes](https://docs.docker.com/sandboxes/) (`sbx`) — required when the agent needs `docker`. |
| `none`      | —           | Unsandboxed escape hatch. Never picked implicitly; doctor warns when configured.                         |

## Safehouse Clearance Allowlist

Only applies when `local.runner` resolves to `safehouse`. Groundcrew starts `clearance` on `http://127.0.0.1:19999` and runs the agent through the bundled `safehouse-clearance` wrapper. Groundcrew automatically points clearance at its shipped starter allowlist, so a fresh install does not need a `CLEARANCE_ALLOW_HOSTS_FILES` export.

Groundcrew ships that starter file at `$(npm root -g)/@clipboard-health/groundcrew/clearance-allow-hosts`, covering model APIs, Linear, Notion, Slack, Datadog, GitHub, npm, PyPI, and common dev tooling.

To add ad hoc hosts for one run, use `CLEARANCE_ALLOW_HOSTS`:

```bash
CLEARANCE_ALLOW_HOSTS="api.openai.com,auth.openai.com,api.anthropic.com,mcp.linear.app,api.linear.app" \
crew run --watch
```

To keep personal hosts in a file, set `CLEARANCE_ALLOW_HOSTS_FILES` to only the additional files. Groundcrew prepends its shipped file automatically:

```bash
CLEARANCE_ALLOW_HOSTS_FILES="$HOME/.config/clearance/personal-allow-hosts" \
crew run --watch
```

Watch `${XDG_CACHE_HOME:-$HOME/.cache}/clearance/clearance.log` for `DENY` lines and add only the domains your agents actually need.

`@clipboard-health/clearance` is pulled in transitively when you install groundcrew, but npm links its `clearance` / `clearance-ensure` bins only into the nested `node_modules/.bin/`, never onto your shell `PATH`. So groundcrew exposes its own first-class `crew-clearance-ensure` command (installed alongside `crew`) that dispatches straight to clearance's `clearance-ensure` entrypoint, forwarding all args, stdio, and exit code unchanged. See the [clearance README](https://github.com/ClipboardHealth/core-utils/tree/main/packages/clearance) for proxy env vars, log paths, and DNS rules.

### Opening network egress (`local.networkEgress: "open"`)

`local.networkEgress` defaults to `"allowlisted"`, which makes the `safehouse` runner wrap agents with Clearance. Set it to `"open"` to keep the Safehouse **filesystem sandbox** while opening **network egress**: groundcrew runs the bare `safehouse` binary instead of the `safehouse-clearance` shim, so there is no egress allowlist, no proxy env, and no clearance daemon to start.

```ts
// crew.config.ts
export default {
  // ...
  local: { runner: "safehouse", networkEgress: "open" },
} satisfies Config;
```

This is for the case where the allowlist is more friction than the egress restriction is worth, but you still want the filesystem isolation and per-agent profiles. To keep clearance on and merely add hosts, use `CLEARANCE_ALLOW_HOSTS` / `CLEARANCE_ALLOW_HOSTS_FILES` (above) instead.

Scope and limits:

- **safehouse only.** It applies to both groundcrew-composed Safehouse wraps (the `prepareWorktree` wrap and the agent wrap).
- **Ignored by `sdx` / `none`.** The other runners ignore it, so you can leave `networkEgress` set while switching `local.runner`.
- **No additional effect when `cmd` already starts with `safehouse`:** that command owns its own wrap, so groundcrew injects nothing. Groundcrew-managed setup/resume launches still reject cmd-owned Safehouse wraps because worker self-completion env cannot be injected.

## Pi on Safehouse

Current Agent Safehouse releases ship a dedicated [`pi.sb` profile](https://github.com/eugene1g/agent-safehouse/blob/main/profiles/60-agents/pi.sb) that grants Pi's default `~/.pi` state while keeping the worktree boundary in Groundcrew's composed sandbox. Its bundled runtime grants cover system package roots, common Node version managers, and `~/.local` npm installs. If `command -v pi` resolves through another home-directory prefix such as `~/.npm-global`, add that prefix to `local.readOnlyDirs` so Safehouse can read both the launcher and package files:

```ts
local: {
  runner: "safehouse",
  readOnlyDirs: ["~/.config/tfenv", "~/.npm-global"],
},
```

Update Safehouse if a Pi launch reports that its profile or `~/.pi/agent` is unavailable. The profile also assumes Pi's default state directory; a custom `PI_CODING_AGENT_DIR` needs corresponding Safehouse environment and writable-path grants.

Safehouse's Pi profile exposes the real `~/.pi` state read/write, so use it only with repositories whose project-local Pi resources you trust. Use Docker Sandboxes when unattended repository code must be isolated from the host's Pi settings, extensions, credentials, and session state.

Groundcrew's bundled Clearance allowlist covers Pi's startup service, Anthropic, OpenAI, and their subscription-authentication hosts. Pi supports many additional providers; add the selected provider's hosts with `CLEARANCE_ALLOW_HOSTS` / `CLEARANCE_ALLOW_HOSTS_FILES`, or explicitly choose `local.networkEgress: "open"`.

## Grok on Safehouse

Safehouse 0.11.1 has no `grok.sb` profile. Groundcrew still wraps `grok` through Safehouse and grants the Grok home (`$GROK_HOME` when set, otherwise `~/.grok`) as writable `--add-dirs` on the agent wrap. That grant is required so `auth.json` and per-cwd sessions stay readable and writable. It also exposes host Grok plugins, hooks, credentials, and sessions to the sandbox. Use it only with repositories whose project-local Grok resources you trust. Authenticate on the host first. When `GROK_HOME` is set, Groundcrew also forwards that name into the Safehouse agent wrap so Grok reads the granted directory. Prefer this grant over relocating `GROK_HOME` into a temp dir: `crew resume` needs the real session store. An ephemeral home would drop the previous conversation.

If `command -v grok` resolves outside `~/.grok/bin`, add that prefix to `local.readOnlyDirs` so Safehouse can read the binary:

```ts
local: {
  runner: "safehouse",
  readOnlyDirs: ["~/.config/tfenv", "~/.local/bin"],
},
```

Groundcrew's bundled Clearance allowlist covers `auth.x.ai`, `api.x.ai`, `*.grok.com` (including `cli-chat-proxy.grok.com`), `grok.com`, and `x.ai`. Add more with `CLEARANCE_ALLOW_HOSTS` / `CLEARANCE_ALLOW_HOSTS_FILES` if a later Grok release needs them, or set `local.networkEgress: "open"`.

There is no reviewed Docker Sandboxes kit for Grok Build. Leave `sandbox` unset on the `grok` profile.

## Docker Sandboxes Setup

`sdx` does not support `unsandboxedHooks`. The sdx container has no
host to run it on; configuring it for an `sdx`-runner repo is a launch-time
config error. Use `safehouse` or `none` if you need host-side setup.

Each agent that runs under `sdx` needs a `sandbox: { agent: "<sbx-agent>" }` block in `crew.config.ts`. Groundcrew addresses the sandbox as `groundcrew-<agent>` and reuses one existing sandbox per agent across repos and tasks.

First-time setup is manual:

```bash
sbx create --name groundcrew-claude claude <projectDir>
sbx exec -it groundcrew-claude claude auth login
sbx exec -it groundcrew-claude gh auth login
```

Replace `claude` with the sbx agent name for your agent and `<projectDir>` with `workspace.projectDir` from `crew.config.ts`. Manage lifecycle and auth with `sbx` directly (`sbx ls`, `sbx exec`, `sbx rm`). Groundcrew does not create, authenticate, regenerate, list, or remove sandboxes.

Pi is available as a contributed Docker Sandbox agent kit. Its supported default routes Anthropic requests through Docker Sandboxes' [credential proxy](https://docs.docker.com/ai/sandboxes/security/credentials/), so the real key remains on the host. Create the exact sandbox name Groundcrew addresses, then scope that credential to this sandbox:

```bash
sbx create --name groundcrew-pi \
  --kit "git+https://github.com/docker/sbx-kits-contrib.git#ref=v0.12.0&dir=pi" \
  pi <projectDir>
sbx secret set groundcrew-pi anthropic
sbx exec -it groundcrew-pi gh auth login
```

The example pins the reviewed `v0.12.0` kit; review upstream changes before moving the `ref` to a newer release. Enable it in Groundcrew with `pi: { sandbox: { agent: "pi" } }`. The sandbox is persistent, so Pi's per-worktree sessions remain available to later `crew resume` launches. The contributed kit's default network and credential policy supports Anthropic; use a reviewed custom kit or policy before selecting another provider or storing its credentials inside the sandbox.
