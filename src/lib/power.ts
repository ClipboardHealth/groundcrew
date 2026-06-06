/**
 * macOS idle-sleep prevention for long-running watch loops.
 *
 * Holds a `PreventUserIdleSystemSleep` assertion via `caffeinate -i -w <pid>`
 * for the lifetime of `crew run --watch`. The `-w <pid>` form tells caffeinate
 * to watch the node process and exit when it dies, so force-exit paths
 * (`process.exit` after a second SIGINT or the 10s force-exit timer) cannot
 * leave an orphaned assertion holder behind — without `-w` the child would
 * survive its parent and keep the Mac awake indefinitely. The release fn is
 * still used for graceful in-process teardown.
 *
 * Lid-close sleep is enforced at the hardware level and cannot be prevented
 * in userspace. For lid-closed remote access, configure clamshell mode.
 */

import { spawn } from "node:child_process";

import { errorMessage, logEvent } from "./util.ts";

type PowerReleaseFn = () => void;

const NOOP_RELEASE: PowerReleaseFn = () => {
  // Surfaced when disabled, on non-macOS, or when spawn fails so callers
  // can release unconditionally without branching on which path they took.
};

/**
 * Acquire a macOS idle-sleep assertion. Returns a release function. Returns
 * a no-op release when `enabled` is false or the host is non-macOS, so the
 * caller can release unconditionally. The returned release is idempotent.
 */
export function holdIdleSleep(enabled = true): PowerReleaseFn {
  if (!enabled || process.platform !== "darwin") {
    return NOOP_RELEASE;
  }
  try {
    // `-w <pid>` makes caffeinate self-terminate when the node parent dies,
    // covering force-exit paths that skip the release fn (process.exit after
    // a second SIGINT, the 10s force-exit timer, or an uncaught throw).
    const child = spawn("caffeinate", ["-i", "-w", String(process.pid)], {
      stdio: "ignore",
      detached: false,
    });
    // `spawn` does not throw for a missing binary — the failure surfaces
    // asynchronously via the 'error' event. Attach a listener so a missing
    // `caffeinate` logs and continues instead of crashing the watcher.
    child.once("error", (error: Error) => {
      logEvent("power", { action: "error", error: error.message });
    });
    logEvent("power", { action: "acquired", pid: child.pid });
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      try {
        child.kill("SIGTERM");
        logEvent("power", { action: "released", pid: child.pid });
      } catch (error) {
        logEvent("power", { action: "release_failed", error: errorMessage(error) });
      }
    };
  } catch (error) {
    logEvent("power", { action: "spawn_failed", error: errorMessage(error) });
    return NOOP_RELEASE;
  }
}
