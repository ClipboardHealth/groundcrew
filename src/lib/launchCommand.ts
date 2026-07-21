import { createRequire } from "node:module";
import path from "node:path";

import {
  BUILD_SECRET_NAMES,
  hasPreLaunchEnv,
  type LocalRunner,
  type AgentDefinition,
  type NetworkEgressSetting,
} from "./config.ts";
import { clearanceAllowHostsFilesFromEnvironment } from "./clearanceAllowlist.ts";
import { buildPreLaunchEmptyCheckLines } from "./preLaunchEmptyCheck.ts";
import { shellSingleQuote } from "./shell.ts";

export { shellSingleQuote } from "./shell.ts";

/**
 * Return a copy of `definition` whose `cmd` has the agent's `resumeArgs`
 * appended, so `crew resume` relaunches the agent into its previous
 * conversation (e.g. `--continue` for Claude, `resume --last` for Codex).
 * Appending after the base `cmd` keeps the first token — which
 * `inferAgentCommandName` reads for the safehouse profile — and the trailing
 * `"$_p"` prompt positional the launch builders add both intact.
 */
export function withResumeArgs(definition: AgentDefinition, resumeArgs: string): AgentDefinition {
  return { ...definition, cmd: `${definition.cmd} ${resumeArgs}` };
}

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

function prepareWorktreeWithStatusReporting(prepareWorktreeCommand: string): string {
  return [
    `(${prepareWorktreeCommand})`,
    "prepare_status=$?",
    'if [ "$prepare_status" -ne 0 ]; then echo "groundcrew prepareWorktree hook exited with status $prepare_status; continuing to agent." >&2; fi',
  ].join("; ");
}

/**
 * Host-shell line for the operator-only `unsandboxedHooks.prepareWorktree` command.
 * Reuses the same status-reporting wrapper as the sandboxed hook so a failure is
 * surfaced but non-fatal. `scrubNames` (the agent's `preLaunchEnv`) are `unset`
 * inside the subshell so this trusted host command cannot read agent
 * credentials minted by `preLaunch`. Build secrets are intentionally left in
 * scope so `npm`/`bundle` can authenticate; the caller `unset`s them before the
 * agent wrap.
 */
function hostPrepareWorktreeLine(command: string, scrubNames: readonly string[]): string {
  const scrub = scrubNames.length === 0 ? "" : `${unsetEnvironmentLine(scrubNames)}; `;
  return `{ ${prepareWorktreeWithStatusReporting(`${scrub}${command}`)}; }`;
}

/**
 * Source a `KEY='value'` file with auto-export so build-time secrets land
 * in the shell env before prepareWorktree runs. The `-f` guard keeps it a
 * no-op if the file disappeared between staging and launch.
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

function safehouseClearanceWrapperCommand(): string {
  return `CLEARANCE_ALLOW_HOSTS_FILES=${shellSingleQuote(clearanceAllowHostsFilesFromEnvironment())} ${shellSingleQuote(SAFEHOUSE_CLEARANCE_WRAPPER_PATH)}`;
}

/**
 * Pick the Safehouse wrapper for a launch: the Clearance shim by default, or the
 * bare `safehouse` binary when network egress is open. Both wrap sites in
 * `buildSafehouseLaunchCommand` read the selection, so the prepareWorktree wrap
 * and agent wrap use the same egress posture.
 */
function safehouseWrapperCommand(networkEgress: NetworkEgressSetting): string {
  return networkEgress === "allowlisted" ? safehouseClearanceWrapperCommand() : "safehouse";
}

function trapCleanupLine(promptDir: string): string {
  const cleanupCmd = `rm -rf ${shellSingleQuote(promptDir)}`;
  return `trap ${shellSingleQuote(cleanupCmd)} EXIT`;
}

/**
 * Shared head of every host-shell `&&` chain: arm the `EXIT` trap that wipes
 * `promptDir` (must come before any link that can fail, including the `cd`),
 * then `cd` into the working directory (the worktree root, or its `workdir`
 * subproject). Kept separate from secret sourcing so the safehouse path can
 * splice `preLaunch` between the `cd` and the secrets source — preLaunch must
 * never see build-time secrets in env.
 */
function hostTrapAndCd(arguments_: { workingDir: string; promptDir: string }): string[] {
  return [trapCleanupLine(arguments_.promptDir), `cd ${shellSingleQuote(arguments_.workingDir)}`];
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
  definition: AgentDefinition;
  worktreeDir: string;
  promptFile: string;
  promptDir: string;
  execLine: string;
}): string[] {
  const lines: string[] = [];
  if (arguments_.definition.preLaunch !== undefined) {
    lines.push(
      renderPreLaunch(arguments_.definition.preLaunch, arguments_.worktreeDir),
      ...buildPreLaunchEmptyCheckLines(arguments_.definition.preLaunchEnv ?? []),
    );
  }
  lines.push(
    `_p=$(cat ${shellSingleQuote(arguments_.promptFile)})`,
    `rm -rf ${shellSingleQuote(arguments_.promptDir)}`,
    arguments_.execLine,
  );
  return lines;
}

/**
 * Shared by the safehouse and sdx builders: render the `exec <agent> "$@"`
 * inner command and the optional status-reported prepareWorktree hook. The
 * `{{sandbox}}` template is filled from `sandboxName` (empty for safehouse).
 */
function renderPrepareAndAgentCommand(arguments_: LaunchCommandArguments): {
  agentCommand: string;
  prepareWorktreeCommand: string | undefined;
} {
  const agentCmd = renderAgentCommand({
    agentCmd: arguments_.definition.cmd,
    worktreeDir: arguments_.worktreeDir,
    sandboxName: arguments_.sandboxName ?? "",
  });
  const agentArgs = arguments_.safehouseAgentIntegration?.agentArgs ?? [];
  const agentInvocation = agentArgs.length === 0 ? agentCmd : `${agentCmd} ${agentArgs.join(" ")}`;
  return {
    agentCommand: `exec ${agentInvocation} "$@"`,
    prepareWorktreeCommand:
      arguments_.prepareWorktreeCommand === undefined
        ? undefined
        : prepareWorktreeWithStatusReporting(arguments_.prepareWorktreeCommand),
  };
}

/**
 * Shared host-shell prologue for the safehouse runner: when a
 * `preLaunch` hook is present, scrub build-secret and `preLaunchEnv` names so it
 * cannot see them; then source build secrets, read the staged prompt into `$_p`,
 * and wipe the prompt dir. The caller arms the EXIT trap and `cd`s first.
 */
function hostPreLaunchSourceAndReadPrompt(arguments_: {
  definition: AgentDefinition;
  worktreeDir: string;
  promptFile: string;
  promptDir: string;
  secretsFile: string | undefined;
}): string[] {
  const lines: string[] = [];
  if (arguments_.definition.preLaunch !== undefined) {
    const preLaunchEnv = arguments_.definition.preLaunchEnv ?? [];
    // Order is load-bearing: unset scrubs inherited values so the empty-check
    // reads what preLaunch actually produced, not what the parent shell leaked.
    lines.push(
      unsetEnvironmentLine([...BUILD_SECRET_NAMES, ...preLaunchEnv]),
      renderPreLaunch(arguments_.definition.preLaunch, arguments_.worktreeDir),
      ...buildPreLaunchEmptyCheckLines(preLaunchEnv),
    );
  }
  lines.push(
    ...hostSourceSecrets(arguments_.secretsFile),
    `_p=$(cat ${shellSingleQuote(arguments_.promptFile)})`,
    `rm -rf ${shellSingleQuote(arguments_.promptDir)}`,
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

export function isEnvironmentAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

/**
 * Infer the agent's command basename from a agent `cmd` (skipping a leading
 * `env`/`KEY=val` prefix). Safehouse uses it to pick the matching `.sb`
 * profile.
 */
export function inferAgentCommandName(agentCmd: string): string {
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
    throw new Error(`Cannot infer the agent command from agent cmd ${JSON.stringify(agentCmd)}.`);
  }

  const commandName = path.basename(commandToken);
  if (
    commandName === "." ||
    commandName === ".." ||
    commandName.startsWith("-") ||
    !/^[A-Za-z0-9._-]+$/.test(commandName)
  ) {
    throw new Error(
      `Cannot use ${JSON.stringify(commandName)} as an agent command name inferred from agent cmd ${JSON.stringify(agentCmd)}.`,
    );
  }
  return commandName;
}

const WORKER_ENVIRONMENT_NAMES = ["GROUNDCREW_TASK_ID", "GROUNDCREW_COMPLETE"] as const;

type WorkerEnvironmentName = (typeof WORKER_ENVIRONMENT_NAMES)[number];

export type WorkerEnvironment = Readonly<{
  GROUNDCREW_TASK_ID: string;
  GROUNDCREW_COMPLETE?: string;
}>;

export function workerEnvironmentForTask(arguments_: {
  taskId: string;
  markDoneSupported: boolean;
}): WorkerEnvironment {
  const { taskId, markDoneSupported } = arguments_;
  return {
    GROUNDCREW_TASK_ID: taskId,
    ...(markDoneSupported ? { GROUNDCREW_COMPLETE: `crew task done ${taskId}` } : {}),
  };
}

function workerEnvironmentNames(
  workerEnvironment: WorkerEnvironment | undefined,
): readonly WorkerEnvironmentName[] {
  if (workerEnvironment === undefined) {
    return [];
  }
  return WORKER_ENVIRONMENT_NAMES.filter((name) => workerEnvironment[name] !== undefined);
}

function workerEnvironmentExports(workerEnvironment: WorkerEnvironment | undefined): string[] {
  if (workerEnvironment === undefined) {
    return [];
  }
  const exports: string[] = [];
  for (const name of WORKER_ENVIRONMENT_NAMES) {
    const value = workerEnvironment[name];
    if (value !== undefined) {
      exports.push(`export ${name}=${shellSingleQuote(value)}`);
    }
  }
  return exports;
}

function envPassFlag(names: readonly string[]): string {
  const uniqueNames = [...new Set(names)];
  return uniqueNames.length === 0 ? "" : `--env-pass=${uniqueNames.join(",")} `;
}

/**
 * Trailing prompt positional passed to the agent. Normally ` "$_p"` (the staged
 * prompt read into `$_p`); empty when `omitPromptArgument` is set, so the agent
 * launches with no initial prompt and drops into its interactive session. The
 * `$_p` read still runs either way — only the positional is dropped.
 */
function promptPositional(omitPromptArgument: boolean | undefined): string {
  return omitPromptArgument === true ? "" : ` "$_p"`;
}

export interface SafehouseAgentIntegration {
  addDirsReadOnly: readonly string[];
  envPass: readonly string[];
  commandPreludes: readonly string[];
  /**
   * Extra, already-shell-safe argv tokens appended to the agent invocation
   * before the prompt positional (e.g. `--settings <quoted-json>` to inject
   * cmux activity-reporting hooks for a Claude agent).
   */
  agentArgs?: readonly string[];
}

interface LaunchCommandArguments {
  definition: AgentDefinition;
  promptFile: string;
  worktreeDir: string;
  /**
   * Directory the agent and prepareWorktree hook cwd into (the `cd`/`-w`
   * target). Equals `worktreeDir` unless the repo recipe sets a `workdir`, in
   * which case it is the subproject dir. The `{{worktree}}` template keeps using
   * `worktreeDir` (the whole checkout).
   */
  workingDir: string;
  /**
   * Optional path to a `KEY='value'` env file containing build-time
   * secrets (see `BUILD_SECRET_NAMES`). Sourced on the host shell before
   * prepareWorktree; for the sdx runner the names are propagated into the sandbox
   * via `sbx exec -e KEY`. Always unset before exec'ing the agent so the
   * agent process never inherits them.
   */
  secretsFile?: string | undefined;
  /**
   * Optional repo-preparation hook resolved by the caller from the freshly
   * created worktree's `.groundcrew/config.json`, falling back to
   * `defaults.hooks.prepareWorktree` from crew.config.ts.
   */
  prepareWorktreeCommand?: string | undefined;
  /**
   * Operator-only, per-repository setup command run on the HOST shell (never a
   * sandbox), before `prepareWorktreeCommand` and the agent. Resolved by the
   * caller from `knownRepositories[].unsandboxedHooks.prepareWorktree` in
   * crew.config.ts. Emitted for the safehouse and none runners; the sdx
   * runner rejects it (no host to run it on).
   */
  prepareWorktreeUnsandboxedCommand?: string | undefined;
  /**
   * Concrete local isolation backend chosen for this launch. Resolved
   * from `config.local.runner` via `resolveLocalRunner` before this
   * function is called — `auto` is never seen here.
   */
  runner: LocalRunner;
  /**
   * Network egress posture. The safehouse runner uses `"allowlisted"` for the
   * Clearance shim and `"open"` for bare `safehouse`; sdx/unwrapped paths
   * ignore it.
   */
  networkEgress: NetworkEgressSetting;
  /**
   * sbx sandbox name when `runner === "sdx"`. Derived by the caller from
   * `sandboxNameFor({ agent })`. Required for sdx; ignored otherwise.
   * Kept off the agent definition so a agent can launch under safehouse
   * on one host and sdx on another without config edits.
   */
  sandboxName?: string | undefined;
  /**
   * Extra filesystem paths granted read/write to the safehouse sandbox via
   * `--add-dirs`, beyond safehouse's automatic cwd grant. Resolved (and deduped)
   * by `composeAgentLaunch`'s `resolveSafehouseAddDirs` — see there for which
   * paths and why git needs them. Empty/undefined → no `--add-dirs` flag (the
   * pre-existing behavior). Only consumed by the safehouse wrap.
   */
  safehouseAddDirs?: readonly string[] | undefined;
  /**
   * Extra read/write paths granted only to the Safehouse agent wrap. These are
   * intentionally withheld from the repo-controlled prepareWorktree wrap.
   */
  safehouseAgentAddDirs?: readonly string[] | undefined;
  /**
   * Optional Safehouse integrations turned on for the agent wrap, emitted as
   * `--enable=<comma-list>` before the profile shim. Each name layers the
   * matching optional sandbox profile (e.g. `agent-browser`) on top of the
   * agent's deny-by-default policy. Withheld from the repo-controlled
   * prepareWorktree wrap, which never needs them. Empty/undefined → no
   * `--enable` flag.
   */
  safehouseEnableFeatures?: readonly string[] | undefined;
  /**
   * Extra read-only paths granted only to the Safehouse agent wrap via
   * `--add-dirs-ro` (host toolchains the Safehouse profile masks but doesn't
   * re-open). Read-only so the agent cannot mutate host toolchain state.
   */
  safehouseAgentAddDirsReadOnly?: readonly string[] | undefined;
  /**
   * Extra host-terminal integration surface granted only to the Safehouse agent
   * wrap. The agent may need to execute host shims and reach their sockets
   * while repo-controlled prepareWorktree hooks should not inherit those paths
   * or env vars.
   */
  safehouseAgentIntegration?: SafehouseAgentIntegration | undefined;
  /**
   * Groundcrew-managed task metadata exposed to the launched worker. Forwarded
   * to the agent process, not the prepareWorktree hook.
   */
  workerEnvironment?: WorkerEnvironment | undefined;
  /**
   * When set, the agent is exec'd with no trailing prompt positional so it opens
   * its interactive session and hands control to the user. The staged prompt is
   * still read into `$_p` (and the prompt dir cleaned up) for a uniform launch
   * chain; only the positional is dropped. Used by `crew open` when no
   * `--prompt`/`--prompt-file` is given.
   */
  omitPromptArgument?: boolean | undefined;
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
    if (arguments_.prepareWorktreeUnsandboxedCommand !== undefined) {
      throw new Error(
        "unsandboxedHooks.prepareWorktree is not supported for runner='sdx': the sdx container has no host to run it on. Remove unsandboxedHooks for this repo, or use runner 'safehouse' or 'none'.",
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
  if (arguments_.workerEnvironment !== undefined && arguments_.runner === "safehouse") {
    throw new Error(
      "workerEnvironment cannot be injected when `cmd` starts with `safehouse` — your cmd owns the wrap, so add GROUNDCREW_TASK_ID,GROUNDCREW_COMPLETE to its own `--env-pass=` flag, or drop the `safehouse` prefix from `cmd` to let groundcrew compose the flag for you.",
    );
  }
  return buildUnwrappedHostLaunchCommand(arguments_);
}

/**
 * The Safehouse wrap applies only when `runner === "safehouse"` and `cmd` does
 * not already invoke `safehouse` itself. A `safehouse …` cmd owns its own
 * sandbox flags, and we can't splice prepareWorktree into a command we don't
 * control, so those (and the `none` runner) fall through to the unwrapped host
 * path.
 */
function shouldWrapWithSafehouse(arguments_: LaunchCommandArguments): boolean {
  if (arguments_.runner !== "safehouse") {
    return false;
  }
  return !/^safehouse(?:\s|$)/.test(arguments_.definition.cmd);
}

/**
 * Unsandboxed host launch (`runner === "none"`, or a `safehouse …` cmd that
 * brings its own wrap). prepareWorktree, secret sourcing, and the agent all run
 * on the host shell because there is no groundcrew-managed sandbox to run them
 * inside.
 */
function buildUnwrappedHostLaunchCommand(arguments_: LaunchCommandArguments): string {
  const promptDir = path.dirname(arguments_.promptFile);
  const agentCmd = renderAgentCommand({
    agentCmd: arguments_.definition.cmd,
    worktreeDir: arguments_.worktreeDir,
    sandboxName: "",
  });

  const lines = [
    ...hostTrapAndCd({ workingDir: arguments_.workingDir, promptDir }),
    ...hostSourceSecrets(arguments_.secretsFile),
  ];
  if (arguments_.prepareWorktreeUnsandboxedCommand !== undefined) {
    lines.push(
      hostPrepareWorktreeLine(
        arguments_.prepareWorktreeUnsandboxedCommand,
        arguments_.definition.preLaunchEnv ?? [],
      ),
    );
  }
  if (arguments_.prepareWorktreeCommand !== undefined) {
    lines.push(prepareWorktreeWithStatusReporting(arguments_.prepareWorktreeCommand));
  }
  if (arguments_.secretsFile !== undefined) {
    lines.push(unsetSecretsLine());
  }
  lines.push(
    ...workerEnvironmentExports(arguments_.workerEnvironment),
    ...preLaunchPromptAndExec({
      definition: arguments_.definition,
      worktreeDir: arguments_.worktreeDir,
      promptFile: arguments_.promptFile,
      promptDir,
      execLine: `exec ${agentCmd}${promptPositional(arguments_.omitPromptArgument)}`,
    }),
  );
  return lines.join(" && ");
}

/**
 * Safehouse launch. Two Safehouse wraps, by design:
 *
 *   1. **prepareWorktree wrap**: plain
 *      `safehouse-clearance ... sh -c '<prepareWorktree>'`. Runs the repo
 *      preparation hook filesystem-isolated and egress-restricted,
 *      **without** inheriting agent-profile grants. Omitted entirely when no
 *      hook command is configured.
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
 * into the **prepareWorktree wrap** via `--env-pass=` (Safehouse's `--env=FILE` mode strips
 * them otherwise). After prepareWorktree returns, `BUILD_SECRET_NAMES` are `unset` again
 * on the host so they cannot reach the agent wrap.
 *
 * `--env-pass` composition is split per wrap (deliberate, post PR #128):
 * - prepareWorktree wrap forwards build secrets only.
 * - Agent wrap forwards `preLaunchEnv` names only. preLaunch credentials never
 *   reach the profile-neutral prepare phase.
 */
function buildSafehouseLaunchCommand(arguments_: LaunchCommandArguments): string {
  const promptDir = path.dirname(arguments_.promptFile);
  const safehouseCommandName = inferAgentCommandName(arguments_.definition.cmd);
  const { agentCommand: rawAgentCommand, prepareWorktreeCommand } =
    renderPrepareAndAgentCommand(arguments_);
  const { safehouseAgentIntegration } = arguments_;
  const agentCommand = [
    ...(safehouseAgentIntegration?.commandPreludes ?? []),
    rawAgentCommand,
  ].join("; ");

  // Split --env-pass per wrap: the prepareWorktree wrap only needs build secrets (so
  // `npm install` etc. can authenticate); the agent wrap only needs the
  // user's preLaunchEnv (build secrets are `unset` on the host between the
  // two wraps, so forwarding them here would silently no-op). Keeps preLaunch
  // credentials out of the profile-neutral prepare phase — see PR #128.
  // Trailing space keeps each flag separated from the next argv token.
  const prepareWorktreeEnvPassFlag =
    arguments_.secretsFile === undefined ? "" : `--env-pass=${BUILD_SECRET_NAMES.join(",")} `;
  const agentEnvPassFlag = envPassFlag([
    ...(arguments_.definition.preLaunchEnv ?? []),
    ...workerEnvironmentNames(arguments_.workerEnvironment),
    ...(safehouseAgentIntegration?.envPass ?? []),
  ]);
  // safehouse reads colon-separated paths from `--add-dirs`; both wraps get the
  // same grant so the prepareWorktree hook and the agent can each reach git.
  // Quote the whole value so shell-special chars survive; the trailing space
  // separates it from the next argv token. See `resolveSafehouseAddDirs` for
  // which paths these are and why.
  const safehousePrepareAddDirs = arguments_.safehouseAddDirs ?? [];
  const safehouseAgentAddDirs = uniqueStrings([
    ...safehousePrepareAddDirs,
    ...(arguments_.safehouseAgentAddDirs ?? []),
  ]);
  const safehouseAddDirsFlag = safehousePathListFlag("--add-dirs", safehousePrepareAddDirs);
  const safehouseAgentAddDirsFlag = safehousePathListFlag("--add-dirs", safehouseAgentAddDirs);
  const safehouseAgentAddDirsReadOnlyFlag = safehousePathListFlag(
    "--add-dirs-ro",
    uniqueStrings([
      ...(safehouseAgentIntegration?.addDirsReadOnly ?? []),
      ...(arguments_.safehouseAgentAddDirsReadOnly ?? []),
    ]),
  );
  // Optional sandbox integrations (e.g. `agent-browser`) layered onto the agent
  // profile only — the repo-controlled prepareWorktree hook never needs them.
  const safehouseEnableFlag = safehouseEnableFeaturesFlag(arguments_.safehouseEnableFeatures ?? []);
  const safehouseWrapper = safehouseWrapperCommand(arguments_.networkEgress);

  // Defensive shim+promptDir trap: by the time we arm it, `rm -rf <promptDir>`
  // has already run (line below) so the promptDir wipe is a no-op on the happy
  // path. Keeps the failure-window between shim creation and the explicit
  // post-wrap cleanup covered for both targets without an unarmed window.
  const shimAndPromptCleanup = `rm -rf "$_safehouse_shim_dir"; rm -rf ${shellSingleQuote(promptDir)}`;
  const shimAndPromptTrap = `trap ${shellSingleQuote(shimAndPromptCleanup)} EXIT`;

  const lines = hostTrapAndCd({ workingDir: arguments_.workingDir, promptDir });
  // Scrub inherited env before preLaunch (build secrets are copied out of
  // `process.env`, which the launch shell inherits), then source secrets and
  // read the staged prompt. See `hostPreLaunchSourceAndReadPrompt`.
  lines.push(
    ...hostPreLaunchSourceAndReadPrompt({
      definition: arguments_.definition,
      worktreeDir: arguments_.worktreeDir,
      promptFile: arguments_.promptFile,
      promptDir,
      secretsFile: arguments_.secretsFile,
    }),
  );
  if (arguments_.prepareWorktreeUnsandboxedCommand !== undefined) {
    lines.push(
      hostPrepareWorktreeLine(
        arguments_.prepareWorktreeUnsandboxedCommand,
        arguments_.definition.preLaunchEnv ?? [],
      ),
    );
  }
  if (prepareWorktreeCommand !== undefined) {
    lines.push(
      `${safehouseWrapper} ${safehouseAddDirsFlag}${prepareWorktreeEnvPassFlag}sh -c ${shellSingleQuote(prepareWorktreeCommand)}`,
    );
  }
  if (arguments_.secretsFile !== undefined) {
    lines.push(unsetSecretsLine());
  }
  lines.push(
    ...workerEnvironmentExports(arguments_.workerEnvironment),
    `_safehouse_shim_dir=$(mktemp -d "\${TMPDIR:-/tmp}/groundcrew-safehouse-XXXXXX")`,
    shimAndPromptTrap,
    `_safehouse_shim="$_safehouse_shim_dir/${safehouseCommandName}"`,
    `ln -s /bin/sh "$_safehouse_shim"`,
    // Safehouse selects an agent profile from the wrapped command's basename.
    // Running the real launch chain as `sh -c` would make it see `sh`, so use
    // an agent-named symlink to /bin/sh. This preserves per-agent profile
    // selection without enabling every agent profile.
    `{ ${safehouseWrapper} ${safehouseAgentAddDirsFlag}${safehouseAgentAddDirsReadOnlyFlag}${safehouseEnableFlag}${agentEnvPassFlag}"$_safehouse_shim" -c ${shellSingleQuote(agentCommand)} sh${promptPositional(arguments_.omitPromptArgument)}; _safehouse_status=$?; rm -rf "$_safehouse_shim_dir"; trap - EXIT; exit "$_safehouse_status"; }`,
  );
  return lines.join(" && ");
}

function safehousePathListFlag(
  flagName: "--add-dirs" | "--add-dirs-ro",
  paths: readonly string[],
): string {
  return paths.length === 0 ? "" : `${flagName}=${shellSingleQuote(paths.join(":"))} `;
}

function safehouseEnableFeaturesFlag(features: readonly string[]): string {
  return features.length === 0 ? "" : `--enable=${shellSingleQuote(features.join(","))} `;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function buildSdxLaunchCommand(arguments_: LaunchCommandArguments): string {
  /* v8 ignore next 5 @preserve -- setupWorkspace passes sandboxName + sandbox config when picking sdx; missing fields are programmer errors */
  if (arguments_.sandboxName === undefined || arguments_.definition.sandbox === undefined) {
    throw new Error(
      "buildLaunchCommand: runner='sdx' requires sandboxName and a agent `sandbox` config block (set sandbox.agent on the agent in config.ts).",
    );
  }
  const promptDir = path.dirname(arguments_.promptFile);
  const { agentCommand, prepareWorktreeCommand } = renderPrepareAndAgentCommand(arguments_);
  const innerParts: string[] = [];
  if (prepareWorktreeCommand !== undefined) {
    innerParts.push(prepareWorktreeCommand);
  }
  if (arguments_.secretsFile !== undefined) {
    innerParts.push(unsetSecretsLine());
  }
  innerParts.push(...workerEnvironmentExports(arguments_.workerEnvironment), agentCommand);
  const innerCommand = innerParts.join("; ");
  // Passthrough form (`-e KEY` without `=VALUE`): sbx reads each value
  // from its own env at invocation time — populated by sourceSecretsLine
  // a few lines up. Avoids `-e KEY="$KEY"`, which would embed the value
  // in argv and break on `"`, `$`, or backticks in the token.
  const sbxEnvironmentNames = arguments_.secretsFile === undefined ? [] : BUILD_SECRET_NAMES;
  const sbxEnvironmentFlags =
    sbxEnvironmentNames.length === 0
      ? ""
      : `${sbxEnvironmentNames.map((name) => `-e ${name}`).join(" ")} `;
  const lines: string[] = [trapCleanupLine(promptDir)];
  if (arguments_.secretsFile !== undefined) {
    lines.push(sourceSecretsLine(arguments_.secretsFile));
  }
  lines.push(
    `_p=$(cat ${shellSingleQuote(arguments_.promptFile)})`,
    `rm -rf ${shellSingleQuote(promptDir)}`,
    `exec sbx exec -it ${sbxEnvironmentFlags}-w ${shellSingleQuote(arguments_.workingDir)} ${shellSingleQuote(arguments_.sandboxName)} sh -c ${shellSingleQuote(innerCommand)} sh${promptPositional(arguments_.omitPromptArgument)}`,
  );
  return lines.join(" && ");
}
