import type { LocalRunner } from "./config.ts";
import type { HostCapabilities } from "./host.ts";
import { log } from "./util.ts";

/**
 * Verify the host can run the chosen local isolation backend before we
 * create a worktree. The runner has already been resolved from
 * `config.local.runner` (via `resolveLocalRunner`), so `auto` never gets
 * here — the caller passes `safehouse`, `bubblewrap`, or `none`.
 *
 * `none` is a deliberately unsafe escape hatch. It is never selected
 * implicitly (`auto` only picks `safehouse` / `bubblewrap`); when the
 * user has set it explicitly, this helper logs a single warning so the
 * unsandboxed launch is visible in groundcrew's log, but does not throw.
 */
export function assertLocalRunnerRequirements(host: HostCapabilities, runner: LocalRunner): void {
  if (runner === "safehouse") {
    if (!host.isSafehouseSupported) {
      throw new Error(
        "Local groundcrew runs with the safehouse runner require macOS. On Linux/WSL, set local.runner to 'bubblewrap' (default) or label the ticket `agent-remote` to use the remote runner.",
      );
    }
    if (!host.hasSafehouse) {
      throw new Error(
        "Local groundcrew runs require `safehouse` on PATH. Install Safehouse from https://agent-safehouse.dev/ and retry.",
      );
    }
    return;
  }
  if (runner === "bubblewrap") {
    if (!host.isLinux) {
      throw new Error(
        "Local groundcrew runs with the bubblewrap runner require Linux. On macOS, set local.runner to 'safehouse' (default) or 'auto'.",
      );
    }
    if (!host.hasBwrap) {
      throw new Error(
        "Local groundcrew runs require `bwrap` (Bubblewrap) on PATH. Install with your distro's package manager (e.g. `apt install bubblewrap`, `dnf install bubblewrap`) and retry.",
      );
    }
    return;
  }
  // runner === "none"
  log(
    "WARNING: local.runner='none' — agent process will run on the host without sandboxing. Only use this when you understand the implications.",
  );
}
