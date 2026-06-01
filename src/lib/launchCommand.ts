import { createRequire } from "node:module";
import path from "node:path";

import {
  BUILD_SECRET_NAMES,
  hasPreLaunchEnv,
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
  return path.resolve(path.dirname(clearancePackageJson), "safehouse", "safehouse-clearance");
}

const SAFEHOUSE_CLEARANCE_WRAPPER_PATH = resolveSafehouseClearancePath();

/**
 * Per-repo setup hook: if `.groundcrew/setup.sh` exists, run it with
 * `--deps-only`; otherwise no-op.
 */
export const SETUP_COMMAND =
  "if [ -f .groundcrew/setup.sh ]; then bash .groundcrew/setup.sh --deps-only; fi";

function renderAgentCommand(arguments_: {
  agentCmd: string;
  worktreeDir: string;
  sandboxName: string;
}): string {
  return arguments_.agentCmd
    .replaceAll("{{worktree}}", shellSingleQuote(arguments_.worktreeDir))
    .replaceAll("{{sandbox}}", shellSingleQuote(arguments_.sandboxName));
}

function renderPreLaunch(preLaunch: string, worktreeDir: string): string {
  return preLaunch.replaceAll("{{worktree}}", shellSingleQuote(worktreeDir));
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

function unsetEnvironmentLine(names: readonly string[]): string {
  return `unset ${[...new Set(names)].join(" ")}`;
}

function unsetSecretsLine(): string {
  return unsetEnvironmentLine(BUILD_SECRET_NAMES);
}

function trapCleanupLine(promptDir: string): string {
  const cleanupCmd = `rm -rf ${shellSingleQuote(promptDir)}`;
  return `trap ${shellSingleQuote(cleanupCmd)} EXIT`;
}

/**
 * Shared head of every host-shell `&&` chain: arm the `EXIT` trap that wipes
 * `promptDir` (must come before any link that can fail, including the `cd`),
 * then `cd` into the worktree. Kept separate from secret sourcing so the
 * safehouse path can splice `preLaunch` between the `cd` and the secrets
 * source — preLaunch must never see build-time secrets in env.
 */
function hostTrapAndCd(arguments_: { worktreeDir: string; promptDir: string }): string[] {
  return [trapCleanupLine(arguments_.promptDir), `cd ${shellSingleQuote(arguments_.worktreeDir)}`];
}

/**
 * Optional source-of-secrets line. Returns `[]` when no `secretsFile` is
 * staged so callers can splat the result into their chain unconditionally.
 */
function hostSourceSecrets(secretsFile: string | undefined): string[] {
  return secretsFile === undefined ? [] : [sourceSecretsLine(secretsFile)];
}

/**
 * Shared tail of every host-shell `&&` chain: optional `preLaunch`, then the
 * staged prompt read, the explicit success-path `rm -rf` (the trap covers the
 * failure path), and the final `exec` of whatever wraps (or is) the agent.
 */
function preLaunchPromptAndExec(arguments_: {
  definition: ModelDefinition;
  worktreeDir: string;
  promptFile: string;
  promptDir: string;
  execLine: string;
}): string[] {
  const lines: string[] = [];
  if (arguments_.definition.preLaunch !== undefined) {
    lines.push(renderPreLaunch(arguments_.definition.preLaunch, arguments_.worktreeDir));
  }
  lines.push(
    `_p=$(cat ${shellSingleQuote(arguments_.promptFile)})`,
    `rm -rf ${shellSingleQuote(arguments_.promptDir)}`,
    arguments_.execLine,
  );
  return lines;
}

function tokenizeShellPrefix(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let isEscaped = false;
  for (const character of command.trim()) {
    if (isEscaped) {
      current += character;
      isEscaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      isEscaped = true;
      continue;
    }
    if (quote !== undefined) {
      if (character === quote) {
        quote = undefined;
      } else {
        current += character;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += character;
  }
  if (current.length > 0) {
    tokens.push(current);
  }
  return tokens;
}

function isEnvironmentAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

function safehouseProfileCommandName(agentCmd: string): string {
  const tokens = tokenizeShellPrefix(agentCmd);
  let tokenIndex = tokens[0] === "env" ? 1 : 0;
  if (tokens[0] === "env" && tokens[tokenIndex] === "--") {
    tokenIndex += 1;
  }
  let commandToken: string | undefined;
  for (const token of tokens.slice(tokenIndex)) {
    if (isEnvironmentAssignment(token)) {
      continue;
    }
    commandToken = token;
    break;
  }
  if (commandToken === undefined) {
    throw new Error(
      `Cannot infer Safehouse agent profile command from model cmd ${JSON.stringify(agentCmd)}.`,
    );
  }

  const commandName = path.basename(commandToken);
  if (
    commandName === "." ||
    commandName === ".." ||
    commandName.startsWith("-") ||
    !/^[A-Za-z0-9._-]+$/.test(commandName)
  ) {
    throw new Error(
      `Cannot use ${JSON.stringify(commandName)} as a Safehouse agent profile command name inferred from model cmd ${JSON.stringify(agentCmd)}.`,
    );
  }
  return commandName;
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
   * `sandboxNameFor({ agent })`. Required for sdx; ignored otherwise.
   * Kept off the model definition so a model can launch under safehouse
   * on one host and sdx on another without config edits.
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
    if (arguments_.definition.preLaunch !== undefined) {
      throw new Error(
        "preLaunch is not yet supported for runner='sdx'. Set local.runner to 'safehouse' or 'none', or open an issue for sdx support.",
      );
    }
    if (hasPreLaunchEnv(arguments_.definition)) {
      throw new Error(
        "preLaunchEnv is not yet supported for runner='sdx'. Set local.runner to 'safehouse' or 'none', or open an issue for sdx support.",
      );
    }
    return buildSdxLaunchCommand(arguments_);
  }
  if (shouldWrapWithSafehouse(arguments_)) {
    return buildSafehouseLaunchCommand(arguments_);
  }
  if (hasPreLaunchEnv(arguments_.definition) && arguments_.runner === "safehouse") {
    // `runner === "safehouse"` but `cmd` already starts with `safehouse` — the
    // user owns env forwarding in that case, so there's no wrap flag for us to
    // inject into. Fail loudly instead of silently dropping the contract.
    throw new Error(
      "preLaunchEnv cannot be injected when `cmd` starts with `safehouse` — your cmd owns the wrap, so add the names to its own `--env-pass=` flag, or drop the `safehouse` prefix from `cmd` to let groundcrew compose the flag for you.",
    );
  }
  return buildUnwrappedHostLaunchCommand(arguments_);
}

/**
 * The Safehouse wrap applies only when `runner === "safehouse"` and `cmd` does
 * not already invoke `safehouse` itself. A `safehouse …` cmd owns its own
 * sandbox flags, and we can't splice setup into a command we don't control, so
 * those (and the `none` runner) fall through to the unwrapped host path.
 */
function shouldWrapWithSafehouse(arguments_: LaunchCommandArguments): boolean {
  if (arguments_.runner !== "safehouse") {
    return false;
  }
  return !/^safehouse(\s|$)/.test(arguments_.definition.cmd);
}

/**
 * Unsandboxed host launch (`runner === "none"`, or a `safehouse …` cmd that
 * brings its own wrap). Setup, secret sourcing, and the agent all run on the
 * host shell because there is no groundcrew-managed sandbox to run them inside.
 */
function buildUnwrappedHostLaunchCommand(arguments_: LaunchCommandArguments): string {
  const promptDir = path.dirname(arguments_.promptFile);
  const agentCmd = renderAgentCommand({
    agentCmd: arguments_.definition.cmd,
    worktreeDir: arguments_.worktreeDir,
    sandboxName: "",
  });

  const lines = [
    ...hostTrapAndCd({ worktreeDir: arguments_.worktreeDir, promptDir }),
    ...hostSourceSecrets(arguments_.secretsFile),
    setupWithStatusReporting(SETUP_COMMAND),
  ];
  if (arguments_.secretsFile !== undefined) {
    lines.push(unsetSecretsLine());
  }
  lines.push(
    ...preLaunchPromptAndExec({
      definition: arguments_.definition,
      worktreeDir: arguments_.worktreeDir,
      promptFile: arguments_.promptFile,
      promptDir,
      execLine: `exec ${agentCmd} "$_p"`,
    }),
  );
  return lines.join(" && ");
}

/**
 * Safehouse launch. Two Safehouse wraps, by design:
 *
 *   1. **Setup wrap**: plain `safehouse-clearance ... sh -c '<setup>'`. Runs
 *      `.groundcrew/setup.sh --deps-only` filesystem-isolated and
 *      egress-restricted, **without** inheriting agent-profile grants.
 *   2. **Agent wrap**: `safehouse-clearance "$shim" -c '<exec agent>' sh "$_p"`
 *      where `$shim` is a `mktemp`-d symlink to `/bin/sh` named after the
 *      agent (e.g. `claude`). Safehouse selects the matching agent profile
 *      from the wrapped command's path.basename (`claude-code.sb` etc.) without
 *      needing every agent profile enabled globally.
 *
 * Host ordering matters: when a `preLaunch` hook is present, inherited
 * build-secret names and listed `preLaunchEnv` names are cleared before it runs.
 * That keeps the credential-minting snippet from seeing build-time secrets in
 * env — neither inherited values (the launch shell inherits groundcrew's env,
 * from which `stageBuildSecrets` reads them) nor file-sourced values — and keeps
 * stale same-named ambient credentials from being forwarded. `secrets.env` is
 * then sourced into the host launch shell so Safehouse can forward build secrets
 * into the **setup wrap** via `--env-pass=` (Safehouse's `--env=FILE` mode strips
 * them otherwise). After setup returns, `BUILD_SECRET_NAMES` are `unset` again
 * on the host so they cannot reach the agent wrap.
 *
 * `--env-pass` composition is split per wrap (deliberate, post PR #128):
 * - Setup wrap forwards build secrets only.
 * - Agent wrap forwards `preLaunchEnv` names only. preLaunch credentials never
 *   reach the profile-neutral setup phase.
 */
function buildSafehouseLaunchCommand(arguments_: LaunchCommandArguments): string {
  const promptDir = path.dirname(arguments_.promptFile);
  const safehouseCommandName = safehouseProfileCommandName(arguments_.definition.cmd);
  const agentCmd = renderAgentCommand({
    agentCmd: arguments_.definition.cmd,
    worktreeDir: arguments_.worktreeDir,
    sandboxName: "",
  });

  const setupCommand = setupWithStatusReporting(SETUP_COMMAND);
  const agentCommand = `exec ${agentCmd} "$@"`;

  // Split --env-pass per wrap: the setup wrap only needs build secrets (so
  // `npm install` etc. can authenticate); the agent wrap only needs the
  // user's preLaunchEnv (build secrets are `unset` on the host between the
  // two wraps, so forwarding them here would silently no-op). Keeps preLaunch
  // credentials out of the profile-neutral setup phase — see PR #128.
  // Trailing space keeps each flag separated from the next argv token.
  const setupEnvPassFlag =
    arguments_.secretsFile === undefined ? "" : `--env-pass=${BUILD_SECRET_NAMES.join(",")} `;
  const preLaunchEnvNames = arguments_.definition.preLaunchEnv ?? [];
  const agentEnvPassFlag =
    preLaunchEnvNames.length === 0 ? "" : `--env-pass=${preLaunchEnvNames.join(",")} `;
  const safehouseWrapper = shellSingleQuote(SAFEHOUSE_CLEARANCE_WRAPPER_PATH);

  // Defensive shim+promptDir trap: by the time we arm it, `rm -rf <promptDir>`
  // has already run (line below) so the promptDir wipe is a no-op on the happy
  // path. Keeps the failure-window between shim creation and the explicit
  // post-wrap cleanup covered for both targets without an unarmed window.
  const shimAndPromptCleanup = `rm -rf "$_safehouse_shim_dir"; rm -rf ${shellSingleQuote(promptDir)}`;
  const shimAndPromptTrap = `trap ${shellSingleQuote(shimAndPromptCleanup)} EXIT`;

  const lines = hostTrapAndCd({ worktreeDir: arguments_.worktreeDir, promptDir });
  if (arguments_.definition.preLaunch !== undefined) {
    // Scrub inherited env before preLaunch runs. `stageBuildSecrets` copies
    // build secrets out of `process.env`, and the launch shell inherits that
    // env, so source-after-preLaunch is not enough by itself. Clearing
    // preLaunchEnv names here also prevents stale same-named ambient values
    // from being forwarded if the hook forgets to overwrite them.
    lines.push(unsetEnvironmentLine([...BUILD_SECRET_NAMES, ...preLaunchEnvNames]));
    lines.push(renderPreLaunch(arguments_.definition.preLaunch, arguments_.worktreeDir));
  }
  lines.push(
    ...hostSourceSecrets(arguments_.secretsFile),
    `_p=$(cat ${shellSingleQuote(arguments_.promptFile)})`,
    `rm -rf ${shellSingleQuote(promptDir)}`,
    `${safehouseWrapper} ${setupEnvPassFlag}sh -c ${shellSingleQuote(setupCommand)}`,
  );
  if (arguments_.secretsFile !== undefined) {
    lines.push(unsetSecretsLine());
  }
  lines.push(
    `_safehouse_shim_dir=$(mktemp -d "\${TMPDIR:-/tmp}/groundcrew-safehouse-XXXXXX")`,
    shimAndPromptTrap,
    `_safehouse_shim="$_safehouse_shim_dir/${safehouseCommandName}"`,
    `ln -s /bin/sh "$_safehouse_shim"`,
    // Safehouse selects an agent profile from the wrapped command's basename.
    // Running the real launch chain as `sh -c` would make it see `sh`, so use
    // an agent-named symlink to /bin/sh. This preserves per-agent profile
    // selection without enabling every agent profile.
    `{ ${safehouseWrapper} ${agentEnvPassFlag}"$_safehouse_shim" -c ${shellSingleQuote(agentCommand)} sh "$_p"; _safehouse_status=$?; rm -rf "$_safehouse_shim_dir"; trap - EXIT; exit "$_safehouse_status"; }`,
  );
  return lines.join(" && ");
}

function buildSdxLaunchCommand(arguments_: LaunchCommandArguments): string {
  /* v8 ignore next 5 @preserve -- setupWorkspace passes sandboxName + sandbox config when picking sdx; missing fields are programmer errors */
  if (arguments_.sandboxName === undefined || arguments_.definition.sandbox === undefined) {
    throw new Error(
      "buildLaunchCommand: runner='sdx' requires sandboxName and a model `sandbox` config block (set sandbox.agent on the model in config.ts).",
    );
  }
  const promptDir = path.dirname(arguments_.promptFile);
  const agentCmd = renderAgentCommand({
    agentCmd: arguments_.definition.cmd,
    worktreeDir: arguments_.worktreeDir,
    sandboxName: arguments_.sandboxName,
  });
  const setupCommand = arguments_.definition.sandbox.setupCommand ?? SETUP_COMMAND;
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
  const lines: string[] = [trapCleanupLine(promptDir)];
  if (arguments_.secretsFile !== undefined) {
    lines.push(sourceSecretsLine(arguments_.secretsFile));
  }
  lines.push(
    `_p=$(cat ${shellSingleQuote(arguments_.promptFile)})`,
    `rm -rf ${shellSingleQuote(promptDir)}`,
    `exec sbx exec -it ${sbxEnvironmentFlags}-w ${shellSingleQuote(arguments_.worktreeDir)} ${shellSingleQuote(arguments_.sandboxName)} sh -c ${shellSingleQuote(innerCommand)} sh "$_p"`,
  );
  return lines.join(" && ");
}
