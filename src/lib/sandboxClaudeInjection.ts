import { existsSync } from "node:fs";
import { join } from "node:path";

import { runCommandAsync } from "./commandRunner.ts";

/**
 * Curated subset of the host `~/.claude` mirrored into the `claude`
 * sandbox during `ensureSandbox` and refreshed by `crew sandbox sync`.
 *
 * Identity, session, and host-only state are deliberately excluded:
 * `settings.json`, `.credentials.json`, `sessions/`, `projects/`,
 * `plugins/`, `hooks/`, `daemon*`, `cache/`, telemetry, history.
 */
export const CLAUDE_CONFIG_ALLOWLIST: readonly string[] = [
  "CLAUDE.md",
  "MEMORY.md",
  "skills",
  "commands",
  "agents",
  "memory",
];

const DEFAULT_SANDBOX_HOME = "/home/agent";

interface InjectClaudeConfigArguments {
  /** Sandbox container name, e.g. `groundcrew-claude`. */
  sandboxName: string;
  /** Host directory containing the `.claude` subtree (typically `os.homedir()`). */
  hostHome: string;
  /** Home directory inside the sandbox. Defaults to `/home/agent`. */
  sandboxHome?: string;
}

/**
 * Refresh the curated subset of the host `~/.claude` inside `sandboxName`.
 * Each allowlist entry is removed from the sandbox (if present) and
 * re-copied from the host with `sbx cp`. Missing host entries are skipped
 * silently so a partial host config doesn't fail the run.
 *
 * `sbx cp` "places source inside destination when destination exists",
 * so the `rm -rf` step is required to keep `skills/` from nesting into
 * `skills/skills/` on the second sync.
 */
export async function injectClaudeConfig(
  arguments_: InjectClaudeConfigArguments,
  signal?: AbortSignal,
): Promise<void> {
  const sandboxHome = arguments_.sandboxHome ?? DEFAULT_SANDBOX_HOME;
  const sandboxConfig = `${sandboxHome}/.claude`;
  const hostConfig = join(arguments_.hostHome, ".claude");
  const options = signal === undefined ? {} : { signal };

  if (!existsSync(hostConfig)) {
    return;
  }

  await runCommandAsync(
    "sbx",
    ["exec", arguments_.sandboxName, "mkdir", "-p", sandboxConfig],
    options,
  );

  for (const entry of CLAUDE_CONFIG_ALLOWLIST) {
    const hostPath = join(hostConfig, entry);
    if (!existsSync(hostPath)) {
      continue;
    }
    const sandboxPath = `${sandboxConfig}/${entry}`;
    // oxlint-disable-next-line no-await-in-loop -- one sbx call at a time keeps ordering deterministic.
    await runCommandAsync(
      "sbx",
      ["exec", arguments_.sandboxName, "rm", "-rf", sandboxPath],
      options,
    );
    // oxlint-disable-next-line no-await-in-loop -- sequential sbx cp avoids racing the rm above.
    await runCommandAsync(
      "sbx",
      ["cp", hostPath, `${arguments_.sandboxName}:${sandboxPath}`],
      options,
    );
  }
}
