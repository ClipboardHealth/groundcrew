import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

import { agentConfigRelocation } from "./codexConfigRelocation.ts";
import { runCommand } from "./commandRunner.ts";
import { shellSingleQuote } from "./shell.ts";
import { errorMessage, logEvent, styleWarning, writeError } from "./util.ts";

const CMUX_HOOKS_INSTALL_EVENT = "cmux-agent-hooks-install";
const CMUX_HOOKS_INSTALL_TIMEOUT_MS = 10_000;
const CMUX_HOOKS_FILE_NAME = "hooks.json";

const cmuxHookSettingsSchema = z.looseObject({
  hooks: z.record(
    z.string(),
    z.array(
      z.looseObject({
        hooks: z.array(
          z.looseObject({
            command: z.string(),
          }),
        ),
      }),
    ),
  ),
});

/**
 * Best-effort `cmux hooks <agent> install --yes` against a relocated,
 * writable config home (e.g. codex's `CODEX_HOME`) so a file-driven agent —
 * whose hook activation reads `$CODEX_HOME/config.toml` + `hooks.json` rather
 * than an `agentArgs` flag — reports its lifecycle to the cmux sidebar the
 * same way Claude already does via `--settings`.
 *
 * Never throws: an agent with no registered config relocation, a missing
 * `cmux` CLI, or a non-zero install exit all degrade to that agent simply
 * emitting no live status — never to a failed launch. A short timeout keeps a
 * hung `cmux` binary from stalling every launch on this agent.
 */
export function installCmuxAgentHooks(input: { agent: string; configDir: string }): void {
  const logContext = { agent: input.agent };
  const relocation = agentConfigRelocation(input.agent);
  if (relocation === undefined) {
    logEvent(CMUX_HOOKS_INSTALL_EVENT, { ...logContext, outcome: "skipped" });
    return;
  }

  try {
    runCommand("cmux", ["hooks", input.agent, "install", "--yes"], {
      // oxlint-disable-next-line node/no-process-env -- the cmux CLI must inherit PATH etc.; only the agent's config-dir var is overridden
      env: { ...process.env, [relocation.configDirEnv]: input.configDir },
      timeoutMs: CMUX_HOOKS_INSTALL_TIMEOUT_MS,
    });
    hardenCmuxAgentHooks({ configDir: input.configDir });
    logEvent(CMUX_HOOKS_INSTALL_EVENT, { ...logContext, outcome: "installed" });
  } catch (error) {
    const message = errorMessage(error);
    writeError(
      styleWarning(`groundcrew: cmux hooks install failed for ${input.agent}: ${message}`),
    );
    logEvent(CMUX_HOOKS_INSTALL_EVENT, {
      ...logContext,
      outcome: "error",
      errorMessage: message,
    });
  }
}

function hardenCmuxAgentHooks(input: { configDir: string }): void {
  const hooksPath = path.join(input.configDir, CMUX_HOOKS_FILE_NAME);
  if (!existsSync(hooksPath)) {
    return;
  }

  const settings = cmuxHookSettingsSchema.parse(JSON.parse(readFileSync(hooksPath, "utf8")));
  const commandPrefix =
    `export CFFIXED_USER_HOME=${shellSingleQuote(input.configDir)}; ` +
    "export CMUX_CLI_SENTRY_DISABLED=1; ";
  for (const groups of Object.values(settings.hooks)) {
    for (const group of groups) {
      for (const hook of group.hooks) {
        hook.command = `${commandPrefix}${hook.command}`;
      }
    }
  }
  writeFileSync(hooksPath, `${JSON.stringify(settings, undefined, 2)}\n`);
}
