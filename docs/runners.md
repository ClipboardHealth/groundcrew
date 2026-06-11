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

Only applies when `local.runner` resolves to `safehouse`. Groundcrew starts `clearance` on `http://127.0.0.1:19999` and runs the agent through the bundled `safehouse-clearance` wrapper. Groundcrew automatically points clearance at its shipped starter allowlist, so a fresh install does not need a `CLEARANCE_ALLOW_HOSTS_FILES` export.

Groundcrew ships that starter file at `$(npm root -g)/@clipboard-health/groundcrew/clearance-allow-hosts`, covering model APIs, Linear, Notion, Slack, Datadog, GitHub, npm, and common dev tooling.

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

`@clipboard-health/clearance` is pulled in transitively when you install groundcrew and provides the `clearance` / `clearance-ensure` bins used by Safehouse runs. See the [clearance README](https://github.com/ClipboardHealth/core-utils/tree/main/packages/clearance) for proxy env vars, log paths, and DNS rules.

## srt (Anthropic sandbox-runtime)

`srt` is the fast, non-Docker option that works on **both macOS and Linux/WSL** — the gap `safehouse` (macOS-only) and `sdx` (Docker) leave. It replaces both Safehouse and Clearance in one tool: a sandbox engine (`sandbox-exec` on macOS, `bubblewrap` on Linux) plus a built-in proxy network allowlist. It is opt-in while it stabilizes:

```bash
crew run --watch  # with local.runner: "srt" in crew.config.ts
```

> **Beta.** `@anthropic-ai/sandbox-runtime` is an Anthropic research preview; its config format may evolve. groundcrew pins the version it ships with, so upgrades are deliberate.

Groundcrew generates a per-launch policy itself (Safehouse's `.sb` profiles have no equivalent here):

- **Reads**: the home region (`/Users` on macOS, `/home`+`/root`+`/mnt` on Linux — `/mnt` covers WSL's Windows drive mounts) is denied, then the worktree, the repo's git metadata, the language toolchains needed to run the agent, and the agent's own config dirs (`~/.claude`, `~/.codex`, …) are re-opened. On macOS the user keychain dir (`~/Library/Keychains`) is also re-opened read-only so keychain-authenticated agents (claude) can sign in under the home mask. The agent cannot read `~/.ssh`, `~/.aws`, shell history, or unrelated repos.
- **Writes**: allow-only, and the host-CLI persistence vector (planting hooks, `mcpServers`, `commands/`, `plugins/`, … that run on the user's next host invocation) is closed per agent. **claude** keeps a writable `~/.claude` (its Bash tool needs scratch/session state there) but every fixed-path executable/instruction surface — `~/.claude.json` (`mcpServers`), `settings.json` and its hooks, `commands/`, `agents/`, `plugins/`, `skills/`, `statusline.sh`, `CLAUDE.md`, the bundled `chrome` binary, `.git/{hooks,config}` — is denied; claude tolerates those write denials. **codex** hard-fails with a read-only home, so it is pointed at a per-launch relocated config dir (`CODEX_HOME`) seeded with its credentials, leaving the real `~/.codex` entirely unwritten. The git common dir is granted as a **narrow allowlist** of only what `status/diff/add/commit/push/gc` write (`objects`, `refs`, `logs`, `packed-refs`, this worktree's gitdir, …) — never wholesale, so the repo `config`/`hooks`, the per-worktree gitdir redirection files, and **sibling worktree gitdirs** stay unwritable. Global toolchain bins (`~/.cargo/bin`, global `node_modules`, the npx cache, …) are never writable either.
- **Environment**: each `srt` invocation runs under a sanitized env (`env -i` + a benign baseline). Unlike safehouse and sdx, the `srt` CLI inherits the host env, so without this an ambient `AWS_*`, `GITHUB_TOKEN`, etc. would reach the agent and bypass the read mask. Credentials the agent legitimately needs from the environment must be forwarded explicitly via the agent's `preLaunchEnv` (the same opt-in pass-list safehouse uses).
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

Each agent that runs under `sdx` needs a `sandbox: { agent: "<sbx-agent>" }` block in `crew.config.ts`. Groundcrew addresses the sandbox as `groundcrew-<agent>` and reuses one existing sandbox per agent across repos and tasks.

First-time setup is manual:

```bash
sbx create --name groundcrew-claude claude <projectDir>
sbx exec -it groundcrew-claude claude auth login
sbx exec -it groundcrew-claude gh auth login
```

Replace `claude` with the sbx agent name for your agent and `<projectDir>` with `workspace.projectDir` from `crew.config.ts`. Manage lifecycle and auth with `sbx` directly (`sbx ls`, `sbx exec`, `sbx rm`). Groundcrew does not create, authenticate, regenerate, list, or remove sandboxes.
