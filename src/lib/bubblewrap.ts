import { homedir } from "node:os";
import { resolve } from "node:path";

import type { BubblewrapPolicy } from "./config.ts";
import { shellSingleQuote } from "./shell.ts";
import { readEnvironmentVariable } from "./util.ts";

/**
 * Args bind-mounted into every Bubblewrap launch regardless of policy.
 * Keeps the sandbox functional (toolchain, certs, /proc, /dev, /tmp) while
 * staying deny-first: nothing under `$HOME` or `/etc` outside this set
 * crosses the boundary unless policy adds it explicitly. `-try` variants
 * skip silently on hosts that don't ship the path (e.g. distros without
 * `/lib64`), so the launch isn't brittle to platform differences.
 */
const BASE_SANDBOX_ARGS: readonly string[] = [
  "--unshare-user",
  "--unshare-ipc",
  "--unshare-pid",
  "--unshare-uts",
  "--unshare-cgroup-try",
  "--die-with-parent",
  "--new-session",
  "--proc",
  "/proc",
  "--dev",
  "/dev",
  "--tmpfs",
  "/tmp",
  "--ro-bind",
  "/usr",
  "/usr",
  "--ro-bind-try",
  "/bin",
  "/bin",
  "--ro-bind-try",
  "/sbin",
  "/sbin",
  "--ro-bind-try",
  "/lib",
  "/lib",
  "--ro-bind-try",
  "/lib64",
  "/lib64",
  "--ro-bind-try",
  "/etc/alternatives",
  "/etc/alternatives",
  "--ro-bind-try",
  "/etc/ssl",
  "/etc/ssl",
  "--ro-bind-try",
  "/etc/ca-certificates",
  "/etc/ca-certificates",
  "--ro-bind-try",
  "/etc/resolv.conf",
  "/etc/resolv.conf",
  "--ro-bind-try",
  "/etc/nsswitch.conf",
  "/etc/nsswitch.conf",
  "--ro-bind-try",
  "/etc/hosts",
  "/etc/hosts",
];

/**
 * Paths a policy is never allowed to grant — even when the user lists
 * them in `local.linux.allowedReadPaths` or `allowedWritePaths`. These
 * would defeat the sandbox by exposing the host filesystem or pre-existing
 * credential stores wholesale. Failing fast is much safer than letting a
 * config typo (e.g. `~` instead of `~/.config/gh`) silently undo
 * deny-first.
 */
const FORBIDDEN_MOUNT_PATHS: ReadonlySet<string> = new Set([
  "/",
  "/etc",
  "/home",
  "/root",
  "/var",
  "/proc",
  "/sys",
  "/dev",
]);

/**
 * Tilde-expansion mirroring `expandHome` in `config.ts`, kept local so
 * this module is self-contained and the launcher can be unit-tested
 * without dragging in the config loader.
 */
function expandHome(value: string, home: string): string {
  if (value === "~") {
    return home;
  }
  if (value.startsWith("~/")) {
    return resolve(home, value.slice(2));
  }
  return value;
}

function assertSafeMount(path: string, origin: string, home: string): void {
  // Strip trailing slashes so `/etc/` is rejected alongside `/etc`. Bare
  // `/` collapses to `""` after the strip — match either form.
  const normalized = path === "/" ? "/" : path.replace(/\/+$/u, "");
  // Reject the static forbidden set plus the resolved `$HOME` itself,
  // which a config like `allowedReadPaths: ["~"]` would otherwise mount
  // wholesale and defeat the sandbox.
  const homeNormalized = home.replace(/\/+$/u, "");
  if (FORBIDDEN_MOUNT_PATHS.has(normalized) || normalized === "" || normalized === homeNormalized) {
    throw new Error(
      `Refusing to bind ${path} into the bubblewrap sandbox (${origin}). Grant a more specific path under it instead.`,
    );
  }
}

interface BubblewrapWrapInput {
  /** Policy from `ResolvedConfig.local.linux`. */
  policy: BubblewrapPolicy;
  /** Worktree directory — always read-write inside the sandbox. */
  worktreeDir: string;
  /**
   * Override `$HOME` resolution. Defaults to `os.homedir()`. Tests pass
   * a fixed value so policy-expansion is deterministic across machines.
   */
  homeDir?: string;
  /** Override `bwrap` binary path. Defaults to `bwrap` on PATH. */
  bwrapBinary?: string;
  /**
   * URL of the clearance HTTP proxy reachable from inside the sandbox.
   * When set, `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY` and a matching
   * `NO_PROXY` (for loopback) are injected into the sandbox env so the
   * agent's HTTP traffic is gated against the clearance allow-host list.
   * Mirrors the macOS Safehouse setup. Skipped when `policy.network` is
   * `"none"` — clearance lives on host loopback and is unreachable
   * without the host network namespace. Defaults to
   * `http://127.0.0.1:19999`, clearance's default bind.
   */
  clearanceProxyUrl?: string;
}

/**
 * Default clearance proxy URL. Matches `clearance.env` shipped by
 * `@clipboard-health/clearance`, so the macOS Safehouse setup and the
 * Linux Bubblewrap setup gate egress against the same hostname allowlist
 * with no per-host config.
 */
const DEFAULT_CLEARANCE_PROXY_URL = "http://127.0.0.1:19999";

/**
 * Loopback addresses the agent should reach directly without going
 * through clearance. Matches the `NO_PROXY` value in `clearance.env`.
 */
const CLEARANCE_NO_PROXY = "localhost,127.0.0.1,::1";

/**
 * Compile a `BubblewrapPolicy` into the `bwrap` argv that wraps the
 * agent process. Returns the argv list (not a shell string). Callers
 * append the actual command to run after the argv.
 *
 * Guarantees:
 *
 * - `--unshare-user`/`-pid`/`-uts`/`-ipc` namespaces are always set, so a
 *   policy can't accidentally drop them.
 * - `/`, `$HOME`, `/etc`, and other broad mounts are rejected — the
 *   policy must list specific paths (e.g. `~/.claude`, `~/.config/gh`).
 * - Read-only paths use `--ro-bind-try` and read-write paths use
 *   `--bind-try`, so a missing path is a no-op instead of a launch
 *   failure.
 * - The environment is cleared (`--clearenv`) and only the names listed
 *   in `policy.envPass` are forwarded with their host values. Unset
 *   names are skipped silently.
 * - Network defaults to host (agents need outbound HTTP); `network:
 *   "none"` joins an empty net namespace.
 */
export function buildBubblewrapArgs(input: BubblewrapWrapInput): string[] {
  const home = input.homeDir ?? homedir();
  const args: string[] = [...BASE_SANDBOX_ARGS];

  if (input.policy.network === "none") {
    args.push("--unshare-net");
  }

  args.push("--clearenv");
  for (const name of input.policy.envPass) {
    // bwrap's `--setenv` requires the value; if the host doesn't export
    // the name, drop it silently rather than passing an empty string
    // (which would mask "var unset" vs "var set to empty" in the agent).
    const value = readEnvironmentVariable(name);
    if (value === undefined) {
      continue;
    }
    args.push("--setenv", name, value);
  }

  // Force the agent's HTTP traffic through the clearance proxy so the
  // hostname allowlist gates egress the same way macOS Safehouse does.
  // Skipped when the sandbox joins an empty net namespace — clearance
  // lives on host loopback and would be unreachable.
  //
  // KNOWN LIMITATION: this is honor-system. With `network: "host"` bwrap
  // shares the host's net namespace, so a process inside the sandbox can
  // ignore HTTP_PROXY and connect directly to the internet. Macos
  // Safehouse closes this via `clearance-only.sb` denying all
  // network-outbound at the sandbox layer; Linux has no equivalent without
  // root-level nftables/iptables or a routed namespace via
  // `slirp4netns` --- both out of scope for this default. Well-behaved
  // agent CLIs (claude/codex/git/npm/curl) honor HTTP_PROXY, so the
  // typical attack surface is covered, but a hostile or buggy process
  // can still reach the internet directly. Set `network: "none"` to
  // close egress entirely (at the cost of no API access).
  if (input.policy.network !== "none") {
    const proxyUrl = input.clearanceProxyUrl ?? DEFAULT_CLEARANCE_PROXY_URL;
    for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"]) {
      args.push("--setenv", name, proxyUrl);
    }
    // Lowercase aliases — many CLIs honor only one of the two cases.
    for (const name of ["http_proxy", "https_proxy", "all_proxy"]) {
      args.push("--setenv", name, proxyUrl);
    }
    args.push("--setenv", "NO_PROXY", CLEARANCE_NO_PROXY);
    args.push("--setenv", "no_proxy", CLEARANCE_NO_PROXY);
  }

  // Worktree is the working tree the agent operates on — always RW.
  args.push("--bind", input.worktreeDir, input.worktreeDir);

  for (const rawPath of input.policy.allowedReadPaths) {
    const expanded = expandHome(rawPath, home);
    assertSafeMount(expanded, "local.linux.allowedReadPaths", home);
    args.push("--ro-bind-try", expanded, expanded);
  }
  for (const rawPath of input.policy.allowedWritePaths) {
    const expanded = expandHome(rawPath, home);
    assertSafeMount(expanded, "local.linux.allowedWritePaths", home);
    args.push("--bind-try", expanded, expanded);
  }

  // `--chdir` makes the agent start in the worktree even if the host
  // shell's CWD differed. Belt-and-braces with `cd` in the launch script.
  args.push("--chdir", input.worktreeDir);

  return args;
}

/**
 * Render `buildBubblewrapArgs` as a shell-quoted prefix suitable for
 * embedding in `buildLaunchCommand`. Returns `<bwrap_bin> <args...>`.
 */
export function buildBubblewrapPrefix(input: BubblewrapWrapInput): string {
  const binary = input.bwrapBinary ?? "bwrap";
  const args = buildBubblewrapArgs(input);
  return [binary, ...args].map(shellSingleQuote).join(" ");
}
