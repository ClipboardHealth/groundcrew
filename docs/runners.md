# Runners

`local.runner` picks the local isolation backend. `auto` resolves per platform.

| Runner      | Default on  | Backend                                                                                                  |
| ----------- | ----------- | -------------------------------------------------------------------------------------------------------- |
| `safehouse` | macOS       | [Safehouse](https://agent-safehouse.dev/) — fastest local; cannot safely give the agent Docker.          |
| `sdx`       | Linux / WSL | [Docker Sandboxes](https://docs.docker.com/sandboxes/) (`sbx`) — required when the agent needs `docker`. |
| `none`      | —           | Unsandboxed escape hatch. Never picked implicitly; doctor warns when configured.                         |

## Safehouse Clearance Allowlist

Only applies when `local.runner` resolves to `safehouse`. Groundcrew starts `clearance` on `http://127.0.0.1:19999` and runs the agent through the bundled `safehouse-clearance` wrapper. Clearance refuses to start without an allowlist.

Shortest path:

```bash
CLEARANCE_ALLOW_HOSTS="api.openai.com,auth.openai.com,api.anthropic.com,mcp.linear.app,api.linear.app" \
crew run --watch
```

Groundcrew ships a starter file covering model APIs, Linear, Notion, Slack, Datadog, GitHub, npm, and common dev tooling at `$(npm root -g)/@clipboard-health/groundcrew/clearance-allow-hosts`. Point clearance at it, optionally with a personal file:

```bash
CLEARANCE_ALLOW_HOSTS_FILES="$(npm root -g)/@clipboard-health/groundcrew/clearance-allow-hosts:$HOME/.config/clearance/personal-allow-hosts" \
crew run --watch
```

Watch `${XDG_CACHE_HOME:-$HOME/.cache}/clearance/clearance.log` for `DENY` lines and add only the domains your agents actually need.

`@clipboard-health/clearance` is pulled in transitively when you install groundcrew and provides the `clearance` / `clearance-ensure` bins used by Safehouse runs. See the [clearance README](https://github.com/ClipboardHealth/core-utils/tree/main/packages/clearance) for proxy env vars, log paths, and DNS rules.

## Docker Sandboxes Setup

Each model that runs under `sdx` needs a `sandbox: { agent: "<sbx-agent>" }` block in `crew.config.ts`. Groundcrew addresses the sandbox as `groundcrew-<agent>` and reuses one existing sandbox per agent across repos and tickets.

First-time setup is manual:

```bash
sbx create --name groundcrew-claude claude <projectDir>
sbx exec -it groundcrew-claude claude auth login
sbx exec -it groundcrew-claude gh auth login
```

Replace `claude` with the sbx agent for the model and `<projectDir>` with `workspace.projectDir` from `crew.config.ts`. Manage lifecycle and auth with `sbx` directly (`sbx ls`, `sbx exec`, `sbx rm`). Groundcrew does not create, authenticate, regenerate, list, or remove sandboxes.
