import type { LocalRunner, LocalRunnerSetting } from "./config.ts";
import type { HostCapabilities } from "./host.ts";
import { log, styleWarning } from "./util.ts";

/**
 * Resolve `local.runner` from config + host capabilities into a concrete
 * backend. `auto` defaults to safehouse on macOS and sdx on Linux — both
 * are the deny-first paths for their platform. `srt`, `none`, and the
 * explicit names pass through unchanged so users always get exactly what
 * they asked for; `srt` is therefore opt-in only and never picked by
 * `auto` in this phase. Pure: takes everything it needs as arguments so
 * the dispatcher can test platform pivots without touching real hosts.
 */
export function resolveLocalRunner(
  setting: LocalRunnerSetting,
  host: HostCapabilities,
): LocalRunner {
  if (setting !== "auto") {
    return setting;
  }
  // macOS → safehouse; everything else (Linux/WSL, exotic platforms) → sdx.
  // `assertLocalRunnerRequirements` then enforces sdx's platform/binary
  // preconditions and surfaces a precise error on truly unsupported hosts.
  return host.isMacOS ? "safehouse" : "sdx";
}

/**
 * Verify the host can run the chosen local isolation backend before we
 * create a worktree. The runner has already been resolved from
 * `config.local.runner` (via `resolveLocalRunner`), so `auto` never gets
 * here — the caller passes `safehouse`, `sdx`, or `none`.
 *
 * `none` is a deliberately unsafe escape hatch. It is never selected
 * implicitly (`auto` picks `safehouse`/`sdx`); when the user has set it
 * explicitly, this helper logs a single warning so the unsandboxed launch
 * is visible in groundcrew's log, but does not throw.
 */
export function assertLocalRunnerRequirements(host: HostCapabilities, runner: LocalRunner): void {
  if (runner === "safehouse") {
    if (!host.isSafehouseSupported) {
      throw new Error(
        "Local groundcrew runs with the safehouse runner require macOS. On Linux/WSL, set local.runner to 'sdx' (default) or 'auto'.",
      );
    }
    if (!host.hasSafehouse) {
      throw new Error(
        "Local groundcrew runs require `safehouse` on PATH. Install Safehouse from https://agent-safehouse.dev/ and retry.",
      );
    }
    return;
  }
  if (runner === "srt") {
    if (!host.isSrtSupported) {
      throw new Error(
        "Local groundcrew runs with the srt runner require macOS or Linux/WSL. Set local.runner to 'auto' to pick the platform default.",
      );
    }
    if (host.isLinux) {
      const missing = [
        host.hasBubblewrap ? undefined : "bubblewrap",
        host.hasSocat ? undefined : "socat",
        host.hasRipgrep ? undefined : "ripgrep (rg)",
      ].filter((name): name is string => name !== undefined);
      if (missing.length > 0) {
        throw new Error(
          `Local groundcrew runs with the srt runner on Linux require ${missing.join(", ")} on PATH. ` +
            "Install the missing dependencies (Debian/Ubuntu: `apt install bubblewrap socat ripgrep`). " +
            "On Ubuntu 24.04+ you may also need `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` to allow unprivileged user namespaces.",
        );
      }
    }
    return;
  }
  if (runner === "sdx") {
    if (!host.isSdxSupported) {
      throw new Error("Local groundcrew runs with the sdx runner require macOS or Linux.");
    }
    if (!host.hasSbx) {
      throw new Error(
        "Local groundcrew runs with the sdx runner require `sbx` (Docker Sandboxes) on PATH. Install from https://docs.docker.com/ai/sandboxes/ and retry.",
      );
    }
    return;
  }
  // runner === "none"
  log(
    styleWarning(
      "WARNING: local.runner='none' — agent process will run on the host without sandboxing. Only use this when you understand the implications.",
    ),
  );
}
