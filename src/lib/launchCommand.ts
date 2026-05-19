import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

import {
  BUILD_SECRET_NAMES,
  DEFAULT_HOST_SETUP_COMMAND,
  DEFAULT_SANDBOX_SETUP_COMMAND,
  type LocalRunner,
  type ModelDefinition,
} from "./config.ts";
import { shellSingleQuote } from "./shell.ts";

export { shellSingleQuote } from "./shell.ts";

/**
 * Resolve the shipped Safehouse proxy wrapper inside `@clipboard-health/clearance`
 * via Node's module-resolution algorithm so the path works whether npm hoists
 * clearance as a sibling of groundcrew or nests it under
 * `groundcrew/node_modules/@clipboard-health/clearance`.
 *
 * @param baseUrl - **Test-only seam.** Production callers must omit this so the
 *   helper resolves from this module's URL. Tests pass an invalid value to
 *   exercise the catch branch.
 */
export function resolveSafehouseClearancePath(baseUrl: string = import.meta.url): string {
  let clearancePackageJson: string;
  try {
    clearancePackageJson = createRequire(baseUrl).resolve(
      "@clipboard-health/clearance/package.json",
    );
  } catch (error) {
    throw new Error(
      "@clipboard-health/clearance is required by @clipboard-health/groundcrew but could not be resolved. " +
        "Install it alongside groundcrew (for example: `npm install -g @clipboard-health/clearance`).",
      { cause: error },
    );
  }
  return resolve(dirname(clearancePackageJson), "safehouse", "safehouse-clearance");
}

const SAFEHOUSE_CLEARANCE_WRAPPER_PATH = resolveSafehouseClearancePath();

function renderAgentCommand(arguments_: {
  agentCmd: string;
  worktreeDir: string;
  sandboxName: string;
}): string {
  return arguments_.agentCmd
    .replaceAll("{{worktree}}", shellSingleQuote(arguments_.worktreeDir))
    .replaceAll("{{sandbox}}", shellSingleQuote(arguments_.sandboxName));
}

function setupWithStatusReporting(setupCommand: string): string {
  return [
    setupCommand,
    "setup_status=$?",
    'if [ "$setup_status" -ne 0 ]; then echo "groundcrew setup command exited with status $setup_status; continuing to agent." >&2; fi',
  ].join("; ");
}

/**
 * Source a `KEY='value'` file with auto-export so build-time secrets land
 * in the shell env before setup runs. The `-f` guard keeps it a no-op if
 * the file disappeared between staging and launch.
 */
function sourceSecretsLine(secretsFile: string): string {
  return `if [ -f ${shellSingleQuote(secretsFile)} ]; then set -a && . ${shellSingleQuote(secretsFile)} && set +a; fi`;
}

function unsetSecretsLine(): string {
  return `unset ${BUILD_SECRET_NAMES.join(" ")}`;
}

interface LaunchCommandArguments {
  definition: ModelDefinition;
  promptFile: string;
  worktreeDir: string;
  /**
   * Optional path to a `KEY='value'` env file containing build-time
   * secrets (see `BUILD_SECRET_NAMES`). Sourced on the host shell before
   * setup; for the sdx runner the names are propagated into the sandbox
   * via `sbx exec -e KEY`. Always unset before exec'ing the agent so the
   * agent process never inherits them.
   */
  secretsFile?: string | undefined;
  /**
   * Concrete local isolation backend chosen for this launch. Resolved
   * from `config.local.runner` via `resolveLocalRunner` before this
   * function is called — `auto` is never seen here.
   */
  runner: LocalRunner;
  /**
   * sbx sandbox name when `runner === "sdx"`. Derived by the caller from
   * `sandboxNameFor({ repository, model })`. Required for sdx; ignored
   * otherwise. Kept off the model definition so a model can launch under
   * safehouse on one host and sdx on another without config edits.
   */
  sandboxName?: string | undefined;
}

/**
 * Build the shell command that runs inside the workspace. The prompt is
 * staged in a temp file (so backticks/quotes/$ in the description survive),
 * read into `$_p`, the temp dir is removed, then the agent CLI is exec'd
 * with the prompt as its trailing positional argument. This removes the
 * need for a `readyMarker` poll because the agent starts up with the
 * prompt in hand.
 */
export function buildLaunchCommand(arguments_: LaunchCommandArguments): string {
  if (arguments_.runner === "sdx") {
    return buildSdxLaunchCommand(arguments_);
  }
  return buildHostLaunchCommand(arguments_);
}

function buildHostLaunchCommand(arguments_: LaunchCommandArguments): string {
  const promptDir = dirname(arguments_.promptFile);
  const agentCmd = renderAgentCommand({
    agentCmd: arguments_.definition.cmd,
    worktreeDir: arguments_.worktreeDir,
    sandboxName: "",
  });

  const wrapped = wrapAgentForHostRunner({
    runner: arguments_.runner,
    rawCmd: arguments_.definition.cmd,
    agentCmd,
  });

  const lines: string[] = [`cd ${shellSingleQuote(arguments_.worktreeDir)}`];
  if (arguments_.secretsFile !== undefined) {
    lines.push(sourceSecretsLine(arguments_.secretsFile));
  }
  lines.push(setupWithStatusReporting(DEFAULT_HOST_SETUP_COMMAND));
  if (arguments_.secretsFile !== undefined) {
    lines.push(unsetSecretsLine());
  }
  lines.push(
    `_p=$(cat ${shellSingleQuote(arguments_.promptFile)})`,
    `rm -rf ${shellSingleQuote(promptDir)}`,
    `exec ${wrapped} "$_p"`,
  );
  return lines.join(" && ");
}

interface WrapForHostRunnerArguments {
  runner: LocalRunner;
  rawCmd: string;
  agentCmd: string;
}

function wrapAgentForHostRunner(arguments_: WrapForHostRunnerArguments): string {
  if (arguments_.runner === "none") {
    return arguments_.agentCmd;
  }
  // buildLaunchCommand routes `sdx` through buildSdxLaunchCommand, so the
  // only remaining shape here is `safehouse`. Treat the explicit branch as
  // the safehouse wrap to keep this function readable; the `sdx` arm exists
  // only to satisfy TS's exhaustiveness checker.
  /* v8 ignore next 3 @preserve -- buildLaunchCommand short-circuits sdx before calling this helper */
  if (arguments_.runner === "sdx") {
    return arguments_.agentCmd;
  }
  // safehouse: skip the wrap if `cmd` already starts with `safehouse` so
  // legacy configs don't double-wrap.
  const cmdStartsWithSafehouse = /^safehouse(\s|$)/.test(arguments_.rawCmd);
  if (cmdStartsWithSafehouse) {
    return arguments_.agentCmd;
  }
  return [shellSingleQuote(SAFEHOUSE_CLEARANCE_WRAPPER_PATH), arguments_.agentCmd].join(" ");
}

function buildSdxLaunchCommand(arguments_: LaunchCommandArguments): string {
  /* v8 ignore next 5 @preserve -- setupWorkspace passes sandboxName + sandbox config when picking sdx; missing fields are programmer errors */
  if (arguments_.sandboxName === undefined || arguments_.definition.sandbox === undefined) {
    throw new Error(
      "buildLaunchCommand: runner='sdx' requires sandboxName and a model `sandbox` config block (set sandbox.agent on the model in config.ts).",
    );
  }
  const promptDir = dirname(arguments_.promptFile);
  const agentCmd = renderAgentCommand({
    agentCmd: arguments_.definition.cmd,
    worktreeDir: arguments_.worktreeDir,
    sandboxName: arguments_.sandboxName,
  });
  const setupCommand = arguments_.definition.sandbox.setupCommand ?? DEFAULT_SANDBOX_SETUP_COMMAND;
  const innerParts = [setupWithStatusReporting(setupCommand)];
  if (arguments_.secretsFile !== undefined) {
    innerParts.push(unsetSecretsLine());
  }
  innerParts.push(`exec ${agentCmd} "$@"`);
  const innerCommand = innerParts.join("; ");
  // Passthrough form (`-e KEY` without `=VALUE`): sbx reads each value
  // from its own env at invocation time — populated by sourceSecretsLine
  // a few lines up. Avoids `-e KEY="$KEY"`, which would embed the value
  // in argv and break on `"`, `$`, or backticks in the token.
  const sbxEnvironmentFlags =
    arguments_.secretsFile === undefined
      ? ""
      : `${BUILD_SECRET_NAMES.map((name) => `-e ${name}`).join(" ")} `;
  const lines: string[] = [];
  if (arguments_.secretsFile !== undefined) {
    lines.push(sourceSecretsLine(arguments_.secretsFile));
  }
  lines.push(
    `_p=$(cat ${shellSingleQuote(arguments_.promptFile)})`,
    `rm -rf ${shellSingleQuote(promptDir)}`,
    `exec sbx exec -it ${sbxEnvironmentFlags}-w ${shellSingleQuote(arguments_.worktreeDir)} ${shellSingleQuote(arguments_.sandboxName)} sh -lc ${shellSingleQuote(innerCommand)} sh "$_p"`,
  );
  return lines.join(" && ");
}
