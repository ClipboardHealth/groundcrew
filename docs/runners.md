# Runners

`local.runner` picks the local isolation backend. `auto` resolves per platform.

| Runner      | Default on  | Backend                                                                                                                                                                      |
| ----------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `safehouse` | macOS       | [Safehouse](https://agent-safehouse.dev/) — fastest local; cannot safely give the agent Docker.                                                                              |
| `srt`       | — (opt-in)  | [Anthropic sandbox-runtime](https://github.com/anthropic-experimental/sandbox-runtime) — fast, non-Docker, on macOS **and** Linux/WSL. Built-in network + filesystem policy. |
| `sdx`       | Linux / WSL | [Docker Sandboxes](https://docs.docker.com/sandboxes/) (`sbx`) — required when the agent needs `docker`.                                                                     |
| `none`      | —           | Unsandboxed escape hatch. Never picked implicitly; doctor warns when configured.                                                                                             |

`auto` never resolves to `srt` — opt in explicitly with `local.runner: "srt"`.

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

## srt (Anthropic sandbox-runtime)

`srt` is the fast, non-Docker option that works on **both macOS and Linux/WSL** — the gap `safehouse` (macOS-only) and `sdx` (Docker) leave. It replaces both Safehouse and Clearance in one tool: a sandbox engine (`sandbox-exec` on macOS, `bubblewrap` on Linux) plus a built-in proxy network allowlist. It is opt-in while it stabilizes:

```bash
crew run --watch  # with local.runner: "srt" in crew.config.ts
```

> **Beta.** `@anthropic-ai/sandbox-runtime` is an Anthropic research preview; its config format may evolve. groundcrew pins the version it ships with, so upgrades are deliberate.

Groundcrew generates a per-launch policy itself (Safehouse's `.sb` profiles have no equivalent here):

- **Reads**: the home region (`/Users` on macOS, `/home`+`/root` on Linux) is denied, then the worktree, the repo's git metadata, the language toolchains needed to run the agent, and the agent's own credential dirs (`~/.claude`, `~/.codex`, …) are re-opened. The agent cannot read `~/.ssh`, `~/.aws`, shell history, or unrelated repos.
- **Writes**: allow-only — the worktree, git metadata, the npm cache, and the agent's state dir. Global toolchain bins (`~/.cargo/bin`, global `node_modules`, …) are never writable, closing the host-CLI persistence vector.
- **Network**: allow-only, **reused from the same Clearance allowlist** (`CLEARANCE_ALLOW_HOSTS` / `CLEARANCE_ALLOW_HOSTS_FILES`, including the shipped `clearance-allow-hosts`) so there is one source of truth. Local binding and unix sockets stay off (never the Docker socket).

### Linux / WSL prerequisites

Install the srt runtime dependencies:

```bash
# Debian / Ubuntu
sudo apt install bubblewrap socat ripgrep
```

On **Ubuntu 24.04+**, unprivileged user namespaces are restricted by AppArmor; enable them once:

```bash
sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
```

`crew doctor` checks these and prints what is missing. macOS needs no extra dependencies — the `srt` CLI ships with groundcrew.

### Debugging sandbox denials

- **macOS**: `log stream --predicate 'process == "sandbox-exec"' --style syslog`
- **Linux**: bubblewrap has no built-in violation log; trace the failing command with `strace -f -e trace=file <cmd>` to find the blocked path, then widen the policy.

## Docker Sandboxes Setup

Each model that runs under `sdx` needs a `sandbox: { agent: "<sbx-agent>" }` block in `crew.config.ts`. Groundcrew addresses the sandbox as `groundcrew-<agent>` and reuses one existing sandbox per agent across repos and tickets.

First-time setup is manual:

```bash
sbx create --name groundcrew-claude claude <projectDir>
sbx exec -it groundcrew-claude claude auth login
sbx exec -it groundcrew-claude gh auth login
```

Replace `claude` with the sbx agent for the model and `<projectDir>` with `workspace.projectDir` from `crew.config.ts`. Manage lifecycle and auth with `sbx` directly (`sbx ls`, `sbx exec`, `sbx rm`). Groundcrew does not create, authenticate, regenerate, list, or remove sandboxes.
