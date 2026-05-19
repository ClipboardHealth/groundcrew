/**
 * Host capability snapshot — what local tooling is available on the
 * current machine. Doctor and setup inject a capabilities object directly
 * so tests don't have to mock `which`.
 */

import process from "node:process";

import { runCommandAsync } from "./commandRunner.ts";

export interface HostCapabilities {
  /** True when the `safehouse` binary is on PATH. */
  hasSafehouse: boolean;
  /** True when the `sbx` (Docker Sandboxes) binary is on PATH. */
  hasSbx: boolean;
  /** True when the `cmux` binary is on PATH. */
  hasCmux: boolean;
  /** True when the `tmux` binary is on PATH. */
  hasTmux: boolean;
  /** True when the host platform is macOS. Safehouse is macOS-only. */
  isMacOS: boolean;
  /** True when the host platform is Linux. */
  isLinux: boolean;
  /**
   * True when the host platform is one Safehouse supports. Safehouse is
   * macOS-only at time of writing; local setup uses this to reject Linux
   * or WSL before creating a worktree.
   */
  isSafehouseSupported: boolean;
  /**
   * True when sdx (Docker Sandboxes) is supportable on this platform —
   * sbx is published for both macOS and Linux, so this stays in sync with
   * "macOS || Linux". WSL inherits Linux capabilities transparently.
   */
  isSdxSupported: boolean;
}

/**
 * Resolves a binary on PATH the same way `which` does. Returns the first
 * matching absolute path, or `undefined` if missing. Shared with `doctor`
 * so both the host detector and the user-facing report use one probe.
 */
export async function which(cmd: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    const out =
      signal === undefined
        ? await runCommandAsync("which", [cmd])
        : await runCommandAsync("which", [cmd], { signal });
    const trimmed = out.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch (error) {
    if (signal?.aborted === true) {
      throw error;
    }
    return undefined;
  }
}

export async function detectHostCapabilities(signal?: AbortSignal): Promise<HostCapabilities> {
  const isMacOS = process.platform === "darwin";
  const isLinux = process.platform === "linux";
  const [safehouse, sbx, cmux, tmux] = await Promise.all([
    which("safehouse", signal),
    which("sbx", signal),
    which("cmux", signal),
    which("tmux", signal),
  ]);
  return {
    hasSafehouse: safehouse !== undefined,
    hasSbx: sbx !== undefined,
    hasCmux: cmux !== undefined,
    hasTmux: tmux !== undefined,
    isMacOS,
    isLinux,
    isSafehouseSupported: isMacOS,
    isSdxSupported: isMacOS || isLinux,
  };
}
