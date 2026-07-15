import { readFileSync } from "node:fs";
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

/**
 * Resolve the `srt` CLI shipped by `@anthropic-ai/sandbox-runtime` (a pinned
 * groundcrew dependency) via Node's module resolution, reading the package's
 * `bin` field so the path survives version bumps that move the entry point.
 * The resolved `dist/cli.js` carries a `#!/usr/bin/env node` shebang and npm
 * marks it executable, so it is exec'd directly like the safehouse wrapper.
 *
 * @param baseUrl - **Test-only seam.** Production callers must omit this so the
 *   helper resolves from this module's URL. Tests pass an invalid value to
 *   exercise the catch branch.
 */
export function resolveSrtBinPath(baseUrl: string = import.meta.url): string {
  let packageJsonPath: string;
  try {
    packageJsonPath = createRequire(baseUrl).resolve("@anthropic-ai/sandbox-runtime/package.json");
  } catch (error) {
    throw new Error(
      "@anthropic-ai/sandbox-runtime is required by @clipboard-health/groundcrew for the srt runner but could not be resolved. " +
        "Reinstall groundcrew's dependencies (`npm install`), or set local.runner to 'safehouse' or 'sdx'.",
      { cause: error },
    );
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- reading our pinned dependency's well-known `bin` field
  const manifest = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    bin?: string | Record<string, string>;
  };
  return path.resolve(path.dirname(packageJsonPath), srtBinEntry(manifest));
}

/**
 * Extract the `srt` entry from a package manifest's `bin` field, which npm
 * allows as either a bare string (single-bin packages) or a name→path map.
 */
export function srtBinEntry(manifest: { bin?: string | Record<string, string> }): string {
  const binEntry = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.["srt"];
  if (binEntry === undefined) {
    throw new Error("@anthropic-ai/sandbox-runtime package.json is missing the `srt` bin entry.");
  }
  return binEntry;
}

/**
 * Lazily resolved + memoized srt bin path. Unlike the safehouse wrapper (eager
 * at module load), this defers the `package.json` read until an srt launch is
 * actually built — srt is opt-in, so non-srt runs never pay for it.
 */
let srtBinPathCache: string | undefined;
function srtBinPath(): string {
  srtBinPathCache ??= resolveSrtBinPath();
  return srtBinPathCache;
}

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
 * Host-shell prepareWorktree line for the safehouse runner: the trusted repo
 * hook runs directly on the host (not inside the agent sandbox), so it has the
 * host toolchain's full filesystem access. `scrubNames` are `unset` inside the
 * status-reporting subshell — used for the declared `preLaunchEnv` credential
 * names, which `preLaunch` has already minted into the host env by this point,
 * so the hook cannot read them (PR #128's credential wall) while the parent
 * shell keeps them for the agent wrap's `--env-pass`. Build secrets are left in
 * env so the hook can authenticate `npm install` etc.; they are `unset` on the
 * host afterward, before the agent wrap.
 */
function hostPrepareWorktreeLine(
  prepareWorktreeCommand: string,
  scrubNames: readonly string[],
): string {
  const scrub = scrubNames.length === 0 ? "" : `${unsetEnvironmentLine(scrubNames)}; `;
  return prepareWorktreeWithStatusReporting(`${scrub}${prepareWorktreeCommand}`);
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
    lines.push(renderPreLaunch(arguments_.definition.preLaunch, arguments_.worktreeDir));
  }
  lines.push(
    `_p=$(cat ${shellSingleQuote(arguments_.promptFile)})`,
    `rm -rf ${shellSingleQuote(arguments_.promptDir)}`,
    arguments_.execLine,
  );
  return lines;
}

/**
 * Shared by the safehouse, srt, and sdx builders: render the `exec <agent> "$@"`
 * inner command and the optional status-reported prepareWorktree hook. The
 * `{{sandbox}}` template is filled from `sandboxName` (empty for safehouse/srt).
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
 * Shared host-shell prologue for the in-sandbox runners (safehouse, srt): when a
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
    lines.push(
      unsetEnvironmentLine([...BUILD_SECRET_NAMES, ...(arguments_.definition.preLaunchEnv ?? [])]),
      renderPreLaunch(arguments_.definition.preLaunch, arguments_.worktreeDir),
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
 * profile; srt uses it to pick the agent's credential profile in `srtPolicy`.
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
   * which case it is the subproject dir. The `{{worktree}}` template and the srt
   * filesystem grants keep using `worktreeDir` (the whole checkout).
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
   * Concrete local isolation backend chosen for this launch. Resolved
   * from `config.local.runner` via `resolveLocalRunner` before this
   * function is called — `auto` is never seen here.
   */
  runner: LocalRunner;
  /**
   * Network egress posture. The safehouse runner uses `"allowlisted"` for the
   * Clearance shim and `"open"` for bare `safehouse`; srt/sdx/unwrapped paths
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
   * Absolute path to the profile-neutral srt settings JSON for the
   * prepareWorktree wrap (no agent credential grants). Required when
   * `runner === "srt"`. Staged in `srtSettingsDir`.
   */
  srtPrepareSettingsFile?: string | undefined;
  /**
   * Absolute path to the full agent srt settings JSON for the agent wrap.
   * Required when `runner === "srt"`. Staged in `srtSettingsDir`.
   */
  srtAgentSettingsFile?: string | undefined;
  /**
   * Absolute temp dir holding the srt settings files. Required when
   * `runner === "srt"`; torn down by the launch command after srt exits.
   */
  srtSettingsDir?: string | undefined;
  /**
   * Env var that points the agent at its relocated, writable config home
   * (e.g. `{ name: "CODEX_HOME", value: "<settingsDir>/codex-home" }`).
   * Injected into the agent wrap's `env -i` (with an explicit value, not a
   * host-env passthrough) so the agent writes state to the staged dir instead
   * of its read-only real home. Only the agent wrap gets it — the prepare wrap
   * runs the repo hook, not the agent. Undefined for read-only agents (claude).
   */
  srtAgentConfigDirEnv?: { name: string; value: string } | undefined;
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
  if (arguments_.runner === "srt") {
    return buildSrtLaunchCommand(arguments_);
  }
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
 * Safehouse launch. The prepareWorktree hook runs on the **host shell**
 * (unsandboxed), and only the **agent** runs inside a Safehouse wrap:
 *
 *   1. **prepareWorktree (host)**: the repo preparation hook runs directly on
 *      the host launch shell — same as the `none` runner — so it has the host
 *      toolchain's full filesystem access. This is deliberate: the hook is
 *      trusted, pre-agent provisioning (a user-configured command run over a
 *      fresh base-branch checkout, before the agent has touched anything), so
 *      the agent's deny-by-default profile has no business constraining it.
 *      Wrapping it in the sandbox only made the operator's own setup script
 *      fail on host paths the profile masks (e.g. Ruby's XDG gem dirs).
 *      Omitted entirely when no hook command is configured.
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
 * then sourced into the host launch shell so the host-run prepareWorktree hook
 * inherits build secrets directly (for `npm install` etc.). After prepareWorktree
 * returns, `BUILD_SECRET_NAMES` are `unset` again on the host so they cannot
 * reach the agent wrap.
 *
 * PR #128's credential wall is preserved: `preLaunch` runs before the host
 * prepareWorktree line, so its minted `preLaunchEnv` credentials are already in
 * the host env. The host prepareWorktree line therefore `unset`s those declared
 * names inside its own status-reporting subshell, so the trusted hook still
 * cannot read them, while the parent shell retains them for the agent wrap's
 * `--env-pass`.
 */
function buildSafehouseLaunchCommand(arguments_: LaunchCommandArguments): string {
  const promptDir = path.dirname(arguments_.promptFile);
  const safehouseCommandName = inferAgentCommandName(arguments_.definition.cmd);
  // Only the agent command comes from here; the prepareWorktree hook runs on the
  // host shell (see below), not through a Safehouse wrap.
  const { agentCommand: rawAgentCommand } = renderPrepareAndAgentCommand(arguments_);
  const { safehouseAgentIntegration } = arguments_;
  const agentCommand = [
    ...(safehouseAgentIntegration?.commandPreludes ?? []),
    rawAgentCommand,
  ].join("; ");

  // The agent wrap forwards the user's preLaunchEnv (plus worker/integration
  // env). Build secrets are never forwarded to the agent wrap — they are sourced
  // into the host shell for the host-run prepareWorktree hook, then `unset` on
  // the host before this wrap. Keeps preLaunch credentials paired with the agent
  // only, and (with the host prepareWorktree scrub) out of the hook — see PR #128.
  const agentEnvPassFlag = envPassFlag([
    ...(arguments_.definition.preLaunchEnv ?? []),
    ...workerEnvironmentNames(arguments_.workerEnvironment),
    ...(safehouseAgentIntegration?.envPass ?? []),
  ]);
  // safehouse reads colon-separated paths from `--add-dirs`. Only the agent wrap
  // needs them now (the prepareWorktree hook runs unsandboxed on the host, so it
  // already has full git access). The base grant (`safehouseAddDirs` — worktree
  // root + git common dir; see `resolveSafehouseAddDirs`) is merged with the
  // agent-only paths. Quote the whole value so shell-special chars survive; the
  // trailing space separates it from the next argv token.
  const safehouseAgentAddDirs = uniqueStrings([
    ...(arguments_.safehouseAddDirs ?? []),
    ...(arguments_.safehouseAgentAddDirs ?? []),
  ]);
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
  if (arguments_.prepareWorktreeCommand !== undefined) {
    // Trusted, pre-agent provisioning: run the hook on the host shell, not in a
    // Safehouse wrap. Scrub the declared preLaunchEnv credential names so the
    // hook cannot read them (PR #128) while the agent wrap still can.
    lines.push(
      hostPrepareWorktreeLine(
        arguments_.prepareWorktreeCommand,
        arguments_.definition.preLaunchEnv ?? [],
      ),
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

/**
 * Benign baseline env the srt wraps run under (via `env -i`). This is an
 * allowlist on purpose: srt's CLI spawns its child with the *inherited* host
 * env, so — unlike safehouse (`--env=FILE` sanitized baseline) and sdx (clean
 * container env) — ambient secrets in the launch shell would otherwise reach
 * the agent and bypass the filesystem read mask. A denylist can't enumerate
 * every secret var, so we clear the env and re-add only these known-benign
 * names plus per-wrap forwarded vars (build secrets / `preLaunchEnv`). Values
 * are read from the host shell at runtime. Vars unset on the host become empty
 * (harmless for these). srt injects proxy + TMPDIR vars into the child itself.
 */
const SRT_ENV_BASELINE: readonly string[] = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "COLORTERM",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "PWD",
];

/** Render `env -i` forwarded assignments: ` NAME="$NAME"` per name (value taken from the host shell at runtime). */
function srtForwardedEnv(names: readonly string[]): string {
  return names.map((name) => ` ${name}="$${name}"`).join("");
}

/**
 * srt launch. Two srt wraps mirror the safehouse two-wrap design, so the
 * dependency/build phase is sandboxed too — not just the agent:
 *
 *   1. **prepareWorktree wrap**: `env -i <baseline+secrets> srt --settings <file> sh -c '<hook>'`.
 *   2. **Agent wrap**: `env -i <baseline+preLaunchEnv> srt --settings <file> sh -c 'exec <agent> "$@"' sh "$_p"`.
 *
 * Unlike safehouse there is no profile-by-basename selection, so no symlink
 * shim is needed — srt takes the policy as an explicit `--settings` file. Each
 * srt invocation runs under `env -i` (see `SRT_ENV_BASELINE`) so the agent gets
 * a sanitized env instead of the inherited host env: the prepareWorktree wrap
 * additionally forwards build secrets (for `npm ci` auth) and the agent wrap
 * forwards the user's opt-in `preLaunchEnv` names — matching safehouse's
 * sanitized baseline plus explicit pass-list posture. `preLaunch` and secret
 * sourcing still run on the host shell (full env), exactly as under safehouse.
 *
 * The settings file lives in `srtSettingsDir` (a dedicated temp dir, never the
 * prompt dir, which is wiped before the agent execs). The EXIT trap covers both
 * the settings dir and the prompt dir for every failure window; the happy path
 * removes the prompt dir before the agent wrap and the settings dir after it.
 */
function buildSrtLaunchCommand(arguments_: LaunchCommandArguments): string {
  if (
    arguments_.srtPrepareSettingsFile === undefined ||
    arguments_.srtAgentSettingsFile === undefined ||
    arguments_.srtSettingsDir === undefined
  ) {
    throw new Error(
      "buildLaunchCommand: runner='srt' requires srtPrepareSettingsFile, srtAgentSettingsFile, and srtSettingsDir (generate them with buildSrtSettings + stageSrtSettings before calling).",
    );
  }
  const promptDir = path.dirname(arguments_.promptFile);
  const { agentCommand, prepareWorktreeCommand } = renderPrepareAndAgentCommand(arguments_);
  const srtBin = shellSingleQuote(srtBinPath());
  // Distinct policies per wrap: the prepareWorktree hook is repo-controlled, so
  // it runs under the profile-neutral settings (no agent credential grants);
  // only the agent wrap gets the full agent policy.
  //
  // The trailing `--` is load-bearing: srt's CLI (commander) has its own `-c`,
  // `--settings`, `--debug`, and `--control-fd` options. Without `--`, srt would
  // capture the child's `sh -c '<cmd>'` as its OWN `-c` (dropping the trailing
  // prompt positionals entirely), and an option-looking prompt/hook value could
  // mutate srt's options (e.g. redirect `--settings`). `--` ends srt option
  // parsing so everything after is the child argv.
  const prepareTarget = `${srtBin} --settings ${shellSingleQuote(arguments_.srtPrepareSettingsFile)} --`;
  const agentTarget = `${srtBin} --settings ${shellSingleQuote(arguments_.srtAgentSettingsFile)} --`;

  // `env -i <baseline>` drops the inherited host env; each wrap re-adds only the
  // benign baseline plus its forwarded names (`VAR="$VAR"` — value from the host
  // shell at runtime; the names are safe identifiers, validated for
  // preLaunchEnv). env -i isolates the agent wrap from build secrets, so no
  // `unset` dance between wraps is needed.
  const baseline = SRT_ENV_BASELINE.map((name) => `${name}="$${name}"`).join(" ");
  const prepareForward =
    arguments_.secretsFile === undefined ? "" : srtForwardedEnv(BUILD_SECRET_NAMES);
  const prepareWrap = `env -i ${baseline}${prepareForward} ${prepareTarget}`;
  // The relocated config-home env (e.g. CODEX_HOME) is an explicit value, not a
  // `VAR="$VAR"` host passthrough — groundcrew computed the staged path, it is
  // not in the launch shell's env. The name is a fixed identifier; the value is
  // single-quoted. Only the agent wrap gets it.
  const agentConfigDirAssignment =
    arguments_.srtAgentConfigDirEnv === undefined
      ? ""
      : ` ${arguments_.srtAgentConfigDirEnv.name}=${shellSingleQuote(arguments_.srtAgentConfigDirEnv.value)}`;
  const agentWrap = `env -i ${baseline}${agentConfigDirAssignment}${srtForwardedEnv([
    ...(arguments_.definition.preLaunchEnv ?? []),
    ...workerEnvironmentNames(arguments_.workerEnvironment),
  ])} ${agentTarget}`;

  // One EXIT trap wipes both the settings dir and the prompt dir, covering
  // every failure window between here and the post-wrap cleanup.
  const cleanup = `rm -rf ${shellSingleQuote(arguments_.srtSettingsDir)}; rm -rf ${shellSingleQuote(promptDir)}`;
  const lines = [
    `trap ${shellSingleQuote(cleanup)} EXIT`,
    `cd ${shellSingleQuote(arguments_.workingDir)}`,
    ...hostPreLaunchSourceAndReadPrompt({
      definition: arguments_.definition,
      worktreeDir: arguments_.worktreeDir,
      promptFile: arguments_.promptFile,
      promptDir,
      secretsFile: arguments_.secretsFile,
    }),
  ];
  if (prepareWorktreeCommand !== undefined) {
    lines.push(`${prepareWrap} sh -c ${shellSingleQuote(prepareWorktreeCommand)}`);
  }
  lines.push(
    ...workerEnvironmentExports(arguments_.workerEnvironment),
    `{ ${agentWrap} sh -c ${shellSingleQuote(agentCommand)} sh${promptPositional(arguments_.omitPromptArgument)}; _srt_status=$?; rm -rf ${shellSingleQuote(arguments_.srtSettingsDir)}; trap - EXIT; exit "$_srt_status"; }`,
  );
  return lines.join(" && ");
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
