import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import {
  DEFAULT_REMOTE_SETUP_COMMAND,
  loadConfig,
  type RemoteRunnerConfig,
} from "../lib/config.ts";
import { shellSingleQuote } from "../lib/shell.ts";
import {
  getRemoteRunnerProvider,
  remotePathJoin,
  remoteConfigWithRunnerName,
  remoteRepositoryDirectoryName,
  remoteRepositorySlug,
  type RemoteRunnerProvider,
} from "../lib/spriteRemoteRunnerProvider.ts";
import { log, readEnvironmentVariable, writeOutput } from "../lib/util.ts";

const KNOWN_MCP_SERVER_URLS: Record<string, string> = {
  linear: "https://mcp.linear.app/mcp",
  slack: "https://mcp.slack.com/mcp",
  notion: "https://mcp.notion.com/mcp",
};

export interface McpServer {
  name: string;
  url: string;
}

export interface RemoteSetupOptions {
  runnerName: string;
  shouldCreate: boolean;
  shouldAuthenticateClaude: boolean;
  shouldAuthenticateCodex: boolean;
  shouldCopyLocalCodexAuth?: boolean;
  shouldSetupDatadog?: boolean;
  shouldAuthenticateGithub: boolean;
  shouldAuthenticateMcp: boolean;
  shouldCheckpoint: boolean;
  checkpointComment: string;
  gitName?: string;
  gitEmail?: string;
  mcpServers: McpServer[];
}

export interface RemoteBootstrapOptions {
  runnerName: string;
  repository: string;
  owner: string;
  baseBranch: string;
  gitRemote?: string;
  repoRoot?: string;
  remoteConfig?: RemoteRunnerConfig;
  secretNames: string[];
  shouldRequireSelectedSecrets: boolean;
  shouldUseSecrets: boolean;
  branchName?: string;
}

interface ResolvedRemoteBootstrapOptions extends RemoteBootstrapOptions {
  gitRemote: string;
  repoRoot: string;
  remoteConfig: RemoteRunnerConfig;
}

interface ParsedRemoteBootstrapOptions extends Omit<
  RemoteBootstrapOptions,
  "baseBranch" | "gitRemote" | "owner" | "remoteConfig" | "repoRoot" | "secretNames"
> {
  owner?: string;
  baseBranch?: string;
  secretNames?: string[];
}

export interface RemoteSessionsOptions {
  runnerName?: string;
}

export interface RemoteAttachOptions {
  target: string;
  runnerName?: string;
}

export interface RemoteProcessOptions {
  runnerName?: string;
}

export interface RemoteInterruptOptions {
  processGroupId: string;
  runnerName?: string;
}

const DEFAULT_CHECKPOINT_COMMENT =
  "groundcrew remote runner baseline: selected agent auth, git identity, and MCP config";
const CLAUDE_SUBSCRIPTION_LOGIN_FLAG = ["--claude", "ai"].join("");
const DEFAULT_GIT_REMOTE = "origin";
const BOOTSTRAP_SECRET_FLAGS_CONFLICT_MESSAGE =
  "--secret and --no-secrets are mutually exclusive. Use --secret to forward selected build secrets or --no-secrets to disable secret forwarding.";
const DATADOG_PUP_VERSION = "0.63.0";
const DATADOG_OAUTH_CALLBACK_PORT = 8000;
const DATADOG_AUTH_STATUS_RETRY_ATTEMPTS = 5;
const DATADOG_AUTH_STATUS_RETRY_DELAY_MS = 250;
const REMOTE_SECRETS_FILE = "/tmp/groundcrew-build-secrets.env";
const REMOTE_CODEX_AUTH_UPLOAD_FILE = "/tmp/groundcrew-codex-auth.json";
const REMOTE_CODEX_AUTH_FILE = "/home/sprite/.codex/auth.json";

function usage(): string {
  return [
    "Usage:",
    "  crew remote setup <runner-name> [options]",
    "  crew remote bootstrap <runner-name> <repository> [options]",
    "  crew remote sessions [<runner-name>]",
    "  crew remote attach <session-id-or-command> [--runner <runner-name>]",
    "  crew remote ps [<runner-name>]",
    "  crew remote interrupt <process-group-id> [--runner <runner-name>]",
    "",
    "Setup options:",
    "  --claude                    Authenticate Claude Code with a Claude subscription",
    "  --codex                     Authenticate Codex CLI",
    "  --copy-local-codex-auth     With --codex, copy local CODEX_HOME auth.json into the remote runner",
    "  --datadog                   Install pup, add dd-pup skills, and authenticate Datadog",
    "  --github                    Authenticate gh for GitHub PRs",
    "  --mcp <alias|name=url>      Add/authenticate one MCP server; repeat for multiple",
    "                              Known aliases: linear, slack, notion",
    "  --skip-mcp-auth             Add selected MCP servers but do not launch Claude /mcp",
    "  --git-name <name>           Set git user.name inside the remote runner",
    "  --git-email <email>         Set git user.email inside the remote runner",
    "  --checkpoint                Create a provider checkpoint after setup",
    "  --checkpoint-comment <text> Override the checkpoint comment",
    "  --no-create                 Require the remote runner to already exist",
    "",
    "Example:",
    "  crew remote setup crew-claude-1 --claude --github --mcp linear --mcp slack --checkpoint",
    "",
    "Bootstrap options:",
    "  --branch <branch>           Checkout/create a ticket branch before installing deps",
    "  --base <branch>             Base branch used when creating a missing branch (default: git.defaultBranch)",
    "  --owner <owner>             GitHub owner for bare repo names (default: remote.owner)",
    "  --secret <env-name>         Forward one required build secret; repeat for multiple",
    "  --no-secrets                Do not forward configured build secrets even if present",
    "",
    "Bootstrap example:",
    "  crew remote bootstrap crew-claude-1 core-utils --branch rocky-team-123",
    "",
    "Session examples:",
    "  crew remote sessions",
    "  crew remote attach 12345",
    "  crew remote ps crew-claude-1",
    "  crew remote interrupt 27673 --runner crew-claude-1",
  ].join("\n");
}

function requireValue(arguments_: readonly string[], index: number, flag: string): string {
  const value = arguments_[index + 1];
  if (value === undefined || value.length === 0 || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.\n${usage()}`);
  }
  return value;
}

function validateMcpName(name: string): void {
  if (!/^[a-z][a-z0-9_-]*$/i.test(name)) {
    throw new Error(`Invalid MCP server name "${name}". Use letters, numbers, "_" or "-".`);
  }
}

function validateMcpUrl(url: string): void {
  try {
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol === "https:") {
      return;
    }
  } catch {
    // Fall through to the user-facing validation error below.
  }
  throw new Error(`Invalid MCP server URL "${url}". Remote MCP URLs must start with https://.`);
}

function validateRepository(value: string): void {
  const parts = value.split("/");
  if (parts.length > 2 || parts.some((part) => part.length === 0)) {
    throw new Error(`Invalid repository "${value}". Use repo or owner/repo.`);
  }
  for (const part of parts) {
    validateRepositoryOwner(part);
  }
}

function validateRepositoryOwner(value: string): void {
  if (!/^[\w.-]+$/.test(value)) {
    throw new Error(`Invalid repository owner "${value}".`);
  }
}

function validateGitRef(value: string, label: string): void {
  if (!/^[\w./-]+$/.test(value) || value.includes("..") || value.startsWith("-")) {
    throw new Error(`Invalid ${label} "${value}".`);
  }
}

function validateSecretName(value: string): void {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(value)) {
    throw new Error(`Invalid secret name "${value}". Use an environment variable name.`);
  }
}

function parseMcpServer(value: string): McpServer {
  const separatorIndex = value.indexOf("=");
  if (separatorIndex !== -1) {
    const name = value.slice(0, separatorIndex).trim();
    const url = value.slice(separatorIndex + 1).trim();
    validateMcpName(name);
    validateMcpUrl(url);
    return { name, url };
  }

  const alias = value.toLowerCase();
  const url = KNOWN_MCP_SERVER_URLS[alias];
  if (url === undefined) {
    throw new Error(
      `Unknown MCP alias "${value}". Known aliases: ${Object.keys(KNOWN_MCP_SERVER_URLS).join(", ")}. Use name=https://example.com/mcp for custom servers.`,
    );
  }
  return { name: alias, url };
}

function parseArguments(argv: readonly string[]): RemoteSetupOptions {
  const [runnerName] = argv;
  if (runnerName === undefined || runnerName.startsWith("--")) {
    throw new Error(usage());
  }

  let shouldCreate = true;
  let shouldAuthenticateClaude = false;
  let shouldAuthenticateCodex = false;
  let shouldCopyLocalCodexAuth = false;
  let shouldSetupDatadog = false;
  let shouldAuthenticateGithub = false;
  let shouldAuthenticateMcp = true;
  let shouldCheckpoint = false;
  let checkpointComment = DEFAULT_CHECKPOINT_COMMENT;
  let gitName: string | undefined;
  let gitEmail: string | undefined;
  const mcpServers: McpServer[] = [];

  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--claude") {
      shouldAuthenticateClaude = true;
      continue;
    }
    if (argument === "--codex") {
      shouldAuthenticateCodex = true;
      continue;
    }
    if (argument === "--copy-local-codex-auth") {
      shouldAuthenticateCodex = true;
      shouldCopyLocalCodexAuth = true;
      continue;
    }
    if (argument === "--datadog") {
      shouldSetupDatadog = true;
      continue;
    }
    if (argument === "--github") {
      shouldAuthenticateGithub = true;
      continue;
    }
    if (argument === "--mcp") {
      const value = requireValue(argv, index, "--mcp");
      mcpServers.push(parseMcpServer(value));
      index += 1;
      continue;
    }
    if (argument === "--skip-mcp-auth") {
      shouldAuthenticateMcp = false;
      continue;
    }
    if (argument === "--git-name") {
      gitName = requireValue(argv, index, "--git-name");
      index += 1;
      continue;
    }
    if (argument === "--git-email") {
      gitEmail = requireValue(argv, index, "--git-email");
      index += 1;
      continue;
    }
    if (argument === "--checkpoint") {
      shouldCheckpoint = true;
      continue;
    }
    if (argument === "--checkpoint-comment") {
      checkpointComment = requireValue(argv, index, "--checkpoint-comment");
      shouldCheckpoint = true;
      index += 1;
      continue;
    }
    if (argument === "--no-create") {
      shouldCreate = false;
      continue;
    }
    throw new Error(`Unknown remote setup argument: ${argument}\n${usage()}`);
  }

  return {
    runnerName,
    shouldCreate,
    shouldAuthenticateClaude,
    shouldAuthenticateCodex,
    shouldCopyLocalCodexAuth,
    shouldSetupDatadog,
    shouldAuthenticateGithub,
    shouldAuthenticateMcp,
    shouldCheckpoint,
    checkpointComment,
    mcpServers,
    ...(gitName === undefined ? {} : { gitName }),
    ...(gitEmail === undefined ? {} : { gitEmail }),
  };
}

function parseBootstrapArguments(argv: readonly string[]): ParsedRemoteBootstrapOptions {
  const [runnerName, repository] = argv;
  if (
    runnerName === undefined ||
    runnerName.startsWith("--") ||
    repository === undefined ||
    repository.startsWith("--")
  ) {
    throw new Error(usage());
  }
  validateRepository(repository);

  let owner: string | undefined;
  let baseBranch: string | undefined;
  let branchName: string | undefined;
  let shouldUseSecrets = true;
  let shouldRequireSelectedSecrets = false;
  const selectedSecretNames: string[] = [];

  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--branch") {
      branchName = requireValue(argv, index, "--branch");
      validateGitRef(branchName, "branch");
      index += 1;
      continue;
    }
    if (argument === "--base") {
      baseBranch = requireValue(argv, index, "--base");
      validateGitRef(baseBranch, "base branch");
      index += 1;
      continue;
    }
    if (argument === "--owner") {
      owner = requireValue(argv, index, "--owner");
      validateRepositoryOwner(owner);
      index += 1;
      continue;
    }
    if (argument === "--secret") {
      if (!shouldUseSecrets) {
        throw new Error(BOOTSTRAP_SECRET_FLAGS_CONFLICT_MESSAGE);
      }
      const secretName = requireValue(argv, index, "--secret");
      validateSecretName(secretName);
      selectedSecretNames.push(secretName);
      shouldRequireSelectedSecrets = true;
      index += 1;
      continue;
    }
    if (argument === "--no-secrets") {
      if (selectedSecretNames.length > 0 || shouldRequireSelectedSecrets) {
        throw new Error(BOOTSTRAP_SECRET_FLAGS_CONFLICT_MESSAGE);
      }
      shouldUseSecrets = false;
      continue;
    }
    throw new Error(`Unknown remote bootstrap argument: ${argument}\n${usage()}`);
  }

  return {
    runnerName,
    repository,
    shouldRequireSelectedSecrets,
    shouldUseSecrets,
    ...(owner === undefined ? {} : { owner }),
    ...(selectedSecretNames.length > 0 ? { secretNames: selectedSecretNames } : {}),
    ...(baseBranch === undefined ? {} : { baseBranch }),
    ...(branchName === undefined ? {} : { branchName }),
  };
}

function parseSessionsArguments(argv: readonly string[]): RemoteSessionsOptions {
  if (argv.length === 0) {
    return {};
  }

  const [runnerName, ...rest] = argv;
  if (
    runnerName === undefined ||
    runnerName.length === 0 ||
    runnerName.startsWith("--") ||
    rest.length > 0
  ) {
    throw new Error(usage());
  }

  return { runnerName };
}

function parseAttachArguments(argv: readonly string[]): RemoteAttachOptions {
  const [target] = argv;
  if (target === undefined || target.length === 0 || target.startsWith("--")) {
    throw new Error(usage());
  }

  const runnerName = parseOptionalRunnerFlag(argv, 1);

  return {
    target,
    ...(runnerName === undefined ? {} : { runnerName }),
  };
}

function parseInterruptArguments(argv: readonly string[]): RemoteInterruptOptions {
  const [processGroupId] = argv;
  if (
    processGroupId === undefined ||
    processGroupId.length === 0 ||
    processGroupId.startsWith("--") ||
    !/^[1-9]\d*$/.test(processGroupId)
  ) {
    throw new Error(usage());
  }

  const runnerName = parseOptionalRunnerFlag(argv, 1);

  return {
    processGroupId,
    ...(runnerName === undefined ? {} : { runnerName }),
  };
}

function parseOptionalRunnerFlag(argv: readonly string[], startIndex: number): string | undefined {
  let runnerName: string | undefined;
  for (let index = startIndex; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--runner") {
      runnerName = requireValue(argv, index, "--runner");
      index += 1;
      continue;
    }
    throw new Error(usage());
  }

  return runnerName;
}

function providerFor(config: RemoteRunnerConfig): RemoteRunnerProvider {
  return getRemoteRunnerProvider(config.provider);
}

async function commandSucceeds(arguments_: {
  provider: RemoteRunnerProvider;
  config: RemoteRunnerConfig;
  remoteArguments: readonly string[];
}): Promise<boolean> {
  try {
    await arguments_.provider.runCommand({
      config: arguments_.config,
      remoteArguments: arguments_.remoteArguments,
    });
    return true;
  } catch {
    return false;
  }
}

async function ensureRemoteRunner(arguments_: {
  provider: RemoteRunnerProvider;
  config: RemoteRunnerConfig;
  options: RemoteSetupOptions;
}): Promise<void> {
  const { provider, config, options } = arguments_;
  if (await provider.runnerExists(config)) {
    log(`Reusing existing remote runner ${config.runnerName}`);
    return;
  }
  if (!options.shouldCreate) {
    throw new Error(`Remote runner ${config.runnerName} does not exist and --no-create was set.`);
  }
  log(`Creating remote runner ${config.runnerName}`);
  await provider.createRunner(config);
}

async function prepareHome(
  provider: RemoteRunnerProvider,
  config: RemoteRunnerConfig,
): Promise<void> {
  await provider.runCommand({
    config,
    remoteArguments: [
      "bash",
      "-lc",
      "mkdir -p ~/dev ~/.config/groundcrew ~/.local/state/groundcrew",
    ],
  });
}

async function configureGit(arguments_: {
  provider: RemoteRunnerProvider;
  config: RemoteRunnerConfig;
  options: RemoteSetupOptions;
}): Promise<void> {
  const { provider, config, options } = arguments_;
  if (options.gitName !== undefined) {
    await provider.runCommand({
      config,
      remoteArguments: ["git", "config", "--global", "user.name", options.gitName],
    });
  }
  if (options.gitEmail !== undefined) {
    await provider.runCommand({
      config,
      remoteArguments: ["git", "config", "--global", "user.email", options.gitEmail],
    });
  }
}

async function authenticateGithub(
  provider: RemoteRunnerProvider,
  config: RemoteRunnerConfig,
): Promise<void> {
  const isAuthenticated = await commandSucceeds({
    provider,
    config,
    remoteArguments: ["gh", "auth", "status"],
  });
  if (!isAuthenticated) {
    log("Starting GitHub device auth inside the remote runner");
    await provider.runCommand({
      config,
      remoteArguments: ["gh", "auth", "login", "-h", "github.com", "-p", "https", "-w"],
      options: { stdio: "inherit", timeoutMs: 0 },
    });
  }
  await provider.runCommand({ config, remoteArguments: ["gh", "auth", "setup-git"] });
}

async function authenticateClaude(
  provider: RemoteRunnerProvider,
  config: RemoteRunnerConfig,
): Promise<void> {
  const isAuthenticated = await commandSucceeds({
    provider,
    config,
    remoteArguments: ["claude", "auth", "status"],
  });
  if (isAuthenticated) {
    return;
  }
  log("Starting Claude subscription auth inside the remote runner");
  await provider.runTtyCommand({
    config,
    remoteArguments: ["claude", "auth", "login", CLAUDE_SUBSCRIPTION_LOGIN_FLAG],
  });
}

function localCodexAuthFile(): string {
  const codexHome = readEnvironmentVariable("CODEX_HOME");
  /* v8 ignore next 2 @preserve -- tests pass CODEX_HOME explicitly to avoid depending on the developer's real home */
  const baseDir =
    codexHome === undefined || codexHome.length === 0 ? join(homedir(), ".codex") : codexHome;
  return resolve(baseDir, "auth.json");
}

async function validateCodexLogin(
  provider: RemoteRunnerProvider,
  config: RemoteRunnerConfig,
): Promise<boolean> {
  return await commandSucceeds({
    provider,
    config,
    remoteArguments: ["codex", "login", "status"],
  });
}

async function copyLocalCodexAuth(
  provider: RemoteRunnerProvider,
  config: RemoteRunnerConfig,
): Promise<void> {
  const authFile = localCodexAuthFile();
  if (!existsSync(authFile)) {
    throw new Error(`Local Codex auth file not found: ${authFile}`);
  }
  log("Copying local Codex auth into the remote runner");
  await provider.runCommand({
    config,
    files: [{ localPath: authFile, remotePath: REMOTE_CODEX_AUTH_UPLOAD_FILE }],
    remoteArguments: [
      "bash",
      "-lc",
      [
        "mkdir -p /home/sprite/.codex",
        `install -m 600 ${shellSingleQuote(REMOTE_CODEX_AUTH_UPLOAD_FILE)} ${shellSingleQuote(REMOTE_CODEX_AUTH_FILE)}`,
        `rm -f ${shellSingleQuote(REMOTE_CODEX_AUTH_UPLOAD_FILE)}`,
      ].join(" && "),
    ],
  });
}

async function authenticateCodex(arguments_: {
  provider: RemoteRunnerProvider;
  config: RemoteRunnerConfig;
  shouldCopyLocalAuth: boolean;
}): Promise<void> {
  const { provider, config, shouldCopyLocalAuth } = arguments_;
  if (await validateCodexLogin(provider, config)) {
    return;
  }
  if (shouldCopyLocalAuth) {
    await copyLocalCodexAuth(provider, config);
    if (await validateCodexLogin(provider, config)) {
      return;
    }
    throw new Error(
      "Codex auth copy completed, but `codex login status` still reports not logged in inside the remote runner. Re-run `crew remote setup <runner-name> --codex --copy-local-codex-auth` after refreshing local Codex auth.",
    );
  }
  log("Starting Codex auth inside the remote runner");
  await provider.runTtyCommand({ config, remoteArguments: ["codex", "login"] });
  if (await validateCodexLogin(provider, config)) {
    return;
  }
  throw new Error(
    "Codex login finished, but `codex login status` still reports not logged in inside the remote runner. Try `crew remote setup <runner-name> --codex --copy-local-codex-auth`.",
  );
}

function datadogPupInstallCommand(): string {
  const shellVariable = "$";
  return [
    "set -euo pipefail",
    `version=${shellSingleQuote(DATADOG_PUP_VERSION)}`,
    'case "$(uname -m)" in',
    "  x86_64|amd64) arch=x86_64 ;;",
    "  aarch64|arm64) arch=arm64 ;;",
    '  *) echo "Unsupported Linux architecture: $(uname -m)" >&2; exit 1 ;;',
    "esac",
    `asset="pup_${shellVariable}{version}_Linux_${shellVariable}{arch}.tar.gz"`,
    `base_url="https://github.com/DataDog/pup/releases/download/v${shellVariable}{version}"`,
    'binary="$HOME/.local/bin/pup"',
    'mkdir -p "$HOME/.local/bin"',
    `if [ -x "$binary" ] && "$binary" version | grep -q "Pup ${shellVariable}{version} "; then "$binary" version; exit 0; fi`,
    'install_dir="$(mktemp -d)"',
    "trap 'rm -rf \"$install_dir\"' EXIT",
    `archive="${shellVariable}{install_dir}/${shellVariable}{asset}"`,
    `checksums="${shellVariable}{install_dir}/pup_${shellVariable}{version}_checksums.txt"`,
    'curl -fsSL -o "$archive" "$base_url/$asset"',
    `curl -fsSL -o "$checksums" "$base_url/pup_${shellVariable}{version}_checksums.txt"`,
    `(cd "$install_dir" && grep " ${shellVariable}{asset}$" "$checksums" | sha256sum -c -)`,
    'tar -xzf "$archive" -C "$HOME/.local/bin" pup',
    'chmod 755 "$binary"',
    '"$binary" version',
  ].join("\n");
}

async function installDatadogPup(
  provider: RemoteRunnerProvider,
  config: RemoteRunnerConfig,
): Promise<void> {
  log(`Installing Datadog pup ${DATADOG_PUP_VERSION} inside the remote runner`);
  await provider.runCommand({
    config,
    remoteArguments: ["bash", "-lc", datadogPupInstallCommand()],
  });
}

async function installDatadogPupSkills(
  provider: RemoteRunnerProvider,
  config: RemoteRunnerConfig,
): Promise<void> {
  for (const platform of ["claude-code", "codex"] as const) {
    // oxlint-disable-next-line no-await-in-loop -- installs are quick and ordered so logs stay readable.
    await provider.runCommand({
      config,
      remoteArguments: ["pup", "skills", "install", platform, "--name", "dd-pup", "--yes"],
    });
  }
}

async function validateDatadogLogin(
  provider: RemoteRunnerProvider,
  config: RemoteRunnerConfig,
): Promise<boolean> {
  return await commandSucceeds({
    provider,
    config,
    remoteArguments: ["pup", "auth", "status"],
  });
}

async function waitForDatadogLogin(
  provider: RemoteRunnerProvider,
  config: RemoteRunnerConfig,
): Promise<boolean> {
  for (let attempt = 1; attempt <= DATADOG_AUTH_STATUS_RETRY_ATTEMPTS; attempt += 1) {
    // oxlint-disable-next-line no-await-in-loop -- bounded polling smooths over Datadog OAuth propagation delay.
    if (await validateDatadogLogin(provider, config)) {
      return true;
    }
    if (attempt < DATADOG_AUTH_STATUS_RETRY_ATTEMPTS) {
      // oxlint-disable-next-line no-await-in-loop -- retries are intentionally spaced.
      await sleep(DATADOG_AUTH_STATUS_RETRY_DELAY_MS);
    }
  }
  return false;
}

async function authenticateDatadog(
  provider: RemoteRunnerProvider,
  config: RemoteRunnerConfig,
): Promise<void> {
  if (await validateDatadogLogin(provider, config)) {
    return;
  }

  writeOutput();
  writeOutput("Datadog OAuth will run inside the remote runner.");
  writeOutput(
    `Groundcrew is forwarding local port ${DATADOG_OAUTH_CALLBACK_PORT} to the remote callback server while login runs.`,
  );
  writeOutput("Open the Datadog URL printed by pup if your terminal does not open it for you.");
  writeOutput();

  const proxy = await provider.startPortProxy(config, DATADOG_OAUTH_CALLBACK_PORT);
  try {
    await provider.runTtyCommand({
      config,
      remoteArguments: [
        "pup",
        "auth",
        "login",
        "--read-only",
        "--callback-port",
        String(DATADOG_OAUTH_CALLBACK_PORT),
      ],
    });
  } finally {
    await proxy.close();
  }

  if (await waitForDatadogLogin(provider, config)) {
    return;
  }
  throw new Error(
    "Datadog auth finished, but `pup auth status` still reports not logged in inside the remote runner.",
  );
}

async function setupDatadog(
  provider: RemoteRunnerProvider,
  config: RemoteRunnerConfig,
): Promise<void> {
  await installDatadogPup(provider, config);
  await installDatadogPupSkills(provider, config);
  await authenticateDatadog(provider, config);
}

async function addMcpServer(arguments_: {
  provider: RemoteRunnerProvider;
  config: RemoteRunnerConfig;
  server: McpServer;
}): Promise<void> {
  const { provider, config, server } = arguments_;
  const exists = await commandSucceeds({
    provider,
    config,
    remoteArguments: ["claude", "mcp", "get", server.name],
  });
  if (exists) {
    log(`MCP server ${server.name} already exists`);
    return;
  }
  log(`Adding MCP server ${server.name} (${server.url})`);
  await provider.runCommand({
    config,
    remoteArguments: [
      "claude",
      "mcp",
      "add",
      "--transport",
      "http",
      "--scope",
      "user",
      server.name,
      server.url,
    ],
  });
}

async function authenticateMcpServers(arguments_: {
  provider: RemoteRunnerProvider;
  config: RemoteRunnerConfig;
  options: RemoteSetupOptions;
}): Promise<void> {
  const { provider, config, options } = arguments_;
  if (options.mcpServers.length === 0 || !options.shouldAuthenticateMcp) {
    return;
  }

  writeOutput();
  writeOutput(
    "Claude will open inside the remote runner so you can authenticate only these MCP servers:",
  );
  for (const server of options.mcpServers) {
    writeOutput(`  - ${server.name}`);
  }
  writeOutput(
    "Inside Claude, run /mcp, select each listed server, choose Authenticate, then /exit.",
  );
  writeOutput(
    "If the browser redirects to localhost and cannot connect, paste that callback URL into Claude when prompted.",
  );
  writeOutput();

  await provider.runTtyCommand({
    config,
    remoteArguments: ["claude", "--permission-mode", "auto"],
  });
}

async function checkpoint(arguments_: {
  provider: RemoteRunnerProvider;
  config: RemoteRunnerConfig;
  options: RemoteSetupOptions;
}): Promise<void> {
  const { provider, config, options } = arguments_;
  if (!options.shouldCheckpoint) {
    return;
  }
  await provider.checkpoint(config, options.checkpointComment);
}

function validateRemoteBootstrapOptions(options: ResolvedRemoteBootstrapOptions): void {
  validateRepository(options.repository);
  validateRepositoryOwner(options.owner);
  validateGitRef(options.baseBranch, "base branch");
  validateGitRef(options.gitRemote, "git remote");
  if (options.branchName !== undefined) {
    validateGitRef(options.branchName, "branch");
  }
  for (const name of options.secretNames) {
    validateSecretName(name);
  }
}

function remoteBootstrapCommand(options: ResolvedRemoteBootstrapOptions): string {
  const slug = remoteRepositorySlug(options.owner, options.repository);
  const directoryName = remoteRepositoryDirectoryName(options.owner, options.repository);
  const repoDir = remotePathJoin(options.repoRoot, directoryName);
  const baseRef = `${options.gitRemote}/${options.baseBranch}`;
  const unsetSecretsLine =
    options.secretNames.length === 0 ? ":" : `unset ${options.secretNames.join(" ")}`;
  const checkoutLines =
    options.branchName === undefined
      ? [`git checkout -B ${shellSingleQuote(options.baseBranch)} ${shellSingleQuote(baseRef)}`]
      : [
          `if git show-ref --verify --quiet ${shellSingleQuote(`refs/remotes/${options.gitRemote}/${options.branchName}`)}; then`,
          `  git checkout -B ${shellSingleQuote(options.branchName)} ${shellSingleQuote(`${options.gitRemote}/${options.branchName}`)}`,
          "else",
          `  git checkout -B ${shellSingleQuote(options.branchName)} ${shellSingleQuote(baseRef)}`,
          "fi",
        ];

  return [
    "set -euo pipefail",
    `cleanup() { rm -f ${shellSingleQuote(REMOTE_SECRETS_FILE)}; ${unsetSecretsLine}; }`,
    "trap cleanup EXIT",
    `repo_root=${shellSingleQuote(options.repoRoot)}`,
    `repo_dir=${shellSingleQuote(repoDir)}`,
    `git_remote=${shellSingleQuote(options.gitRemote)}`,
    'mkdir -p "$repo_root"',
    'if [ ! -d "$repo_dir/.git" ]; then',
    `  gh repo clone ${shellSingleQuote(slug)} "$repo_dir"`,
    "fi",
    'cd "$repo_dir"',
    'if ! git remote get-url "$git_remote" >/dev/null 2>&1; then',
    '  origin_url="$(git remote get-url origin)"',
    '  git remote add "$git_remote" "$origin_url"',
    "fi",
    'git fetch "$git_remote" --prune',
    ...checkoutLines,
    `if [ -f ${shellSingleQuote(REMOTE_SECRETS_FILE)} ]; then set -a && . ${shellSingleQuote(REMOTE_SECRETS_FILE)} && set +a; fi`,
    DEFAULT_REMOTE_SETUP_COMMAND,
  ].join("\n");
}

async function resolveBootstrapOptions(
  options: ParsedRemoteBootstrapOptions,
): Promise<ResolvedRemoteBootstrapOptions> {
  const config = await loadConfig();
  const remoteConfig: RemoteRunnerConfig = {
    ...config.remote,
    runnerName: options.runnerName,
    secretNames: [...config.remote.secretNames],
  };
  return {
    ...options,
    owner: options.owner ?? remoteConfig.owner,
    baseBranch: options.baseBranch ?? config.git.defaultBranch,
    gitRemote: config.git.remote,
    repoRoot: remoteConfig.repoRoot,
    remoteConfig,
    secretNames: options.secretNames ?? [...remoteConfig.secretNames],
  };
}

interface StagedSecrets {
  filePath: string | undefined;
  names: string[];
  cleanup(): void;
}

function noSecretCleanup(): void {
  // No staged secrets file was created.
}

function stageBuildSecrets(options: RemoteBootstrapOptions): StagedSecrets {
  if (!options.shouldUseSecrets || options.secretNames.length === 0) {
    return { filePath: undefined, names: [], cleanup: noSecretCleanup };
  }

  const lines: string[] = [];
  const names: string[] = [];
  for (const name of options.secretNames) {
    const value = readEnvironmentVariable(name);
    if (value === undefined || value.length === 0) {
      if (options.shouldRequireSelectedSecrets) {
        throw new Error(`${name} is not set in the local environment.`);
      }
      continue;
    }
    lines.push(`${name}=${shellSingleQuote(value)}`);
    names.push(name);
  }
  if (lines.length === 0) {
    return { filePath: undefined, names, cleanup: noSecretCleanup };
  }

  const directory = mkdtempSync(join(tmpdir(), "groundcrew-remote-secrets-"));
  const filePath = join(directory, "secrets.env");
  writeFileSync(filePath, `${lines.join("\n")}\n`, { mode: 0o600 });
  return {
    filePath,
    names,
    cleanup() {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

export async function bootstrapRemoteRepository(options: RemoteBootstrapOptions): Promise<void> {
  const config = options.remoteConfig ?? remoteConfigWithRunnerName(options.runnerName);
  const bootstrapOptions: ResolvedRemoteBootstrapOptions = {
    ...options,
    gitRemote: options.gitRemote ?? DEFAULT_GIT_REMOTE,
    repoRoot: options.repoRoot ?? config.repoRoot,
    remoteConfig: config,
  };
  validateRemoteBootstrapOptions(bootstrapOptions);
  const provider = providerFor(config);
  if (!(await provider.runnerExists(config))) {
    throw new Error(
      `Remote runner ${options.runnerName} does not exist. Run crew remote setup first.`,
    );
  }

  const stagedSecrets = stageBuildSecrets(bootstrapOptions);
  try {
    if (stagedSecrets.names.length > 0) {
      log(`Forwarding build secret names for setup only: ${stagedSecrets.names.join(", ")}`);
    }
    const files =
      stagedSecrets.filePath === undefined
        ? []
        : [{ localPath: stagedSecrets.filePath, remotePath: REMOTE_SECRETS_FILE }];

    log(
      `Bootstrapping ${remoteRepositorySlug(bootstrapOptions.owner, bootstrapOptions.repository)} in ${options.runnerName}`,
    );
    await provider.runCommand({
      config,
      files,
      remoteArguments: ["bash", "-lc", remoteBootstrapCommand(bootstrapOptions)],
      options: { stdio: "inherit", timeoutMs: 0 },
    });
  } finally {
    stagedSecrets.cleanup();
  }
}

async function resolveRemoteConfig(runnerName: string | undefined): Promise<RemoteRunnerConfig> {
  if (runnerName !== undefined) {
    return remoteConfigWithRunnerName(runnerName);
  }
  const config = await loadConfig();
  return config.remote;
}

export async function listRemoteSessions(options: RemoteSessionsOptions): Promise<void> {
  const config = await resolveRemoteConfig(options.runnerName);
  const output = await providerFor(config).listSessions(config);
  writeOutput(rewriteSessionsFooter(output, config).trimEnd());
}

export async function attachRemoteSession(options: RemoteAttachOptions): Promise<void> {
  const config = await resolveRemoteConfig(options.runnerName);
  await providerFor(config).attachSession(config, options.target);
}

export async function listRemoteProcesses(options: RemoteProcessOptions): Promise<void> {
  const config = await resolveRemoteConfig(options.runnerName);
  const output = await providerFor(config).listProcesses(config);
  writeOutput(output.trimEnd());
}

export async function interruptRemoteProcessGroup(options: RemoteInterruptOptions): Promise<void> {
  const config = await resolveRemoteConfig(options.runnerName);
  await providerFor(config).interruptProcessGroup(config, options.processGroupId);
}

function rewriteSessionsFooter(output: string, config: RemoteRunnerConfig): string {
  return output.replace(
    "  sprite exec -id <session_id>",
    [
      `  crew remote attach <session_id> --runner ${config.runnerName}`,
      `  sprite sessions attach <session_id> -s ${config.runnerName}`,
    ].join("\n"),
  );
}

export async function setupRemoteRunner(options: RemoteSetupOptions): Promise<void> {
  const config = remoteConfigWithRunnerName(options.runnerName);
  const provider = providerFor(config);
  await ensureRemoteRunner({ provider, config, options });
  await prepareHome(provider, config);
  await configureGit({ provider, config, options });

  if (options.shouldAuthenticateGithub) {
    await authenticateGithub(provider, config);
  }
  if (options.shouldAuthenticateClaude) {
    await authenticateClaude(provider, config);
  }
  if (options.shouldAuthenticateCodex) {
    await authenticateCodex({
      provider,
      config,
      shouldCopyLocalAuth: options.shouldCopyLocalCodexAuth === true,
    });
  }
  if (options.shouldSetupDatadog === true) {
    await setupDatadog(provider, config);
  }

  for (const server of options.mcpServers) {
    // oxlint-disable-next-line no-await-in-loop -- MCP additions are sequential so auth instructions stay ordered.
    await addMcpServer({ provider, config, server });
  }
  await authenticateMcpServers({ provider, config, options });
  await checkpoint({ provider, config, options });

  log(`Remote runner ${options.runnerName} setup complete`);
}

export async function remoteCli(argv: string[]): Promise<void> {
  const [action, ...rest] = argv;
  if (action === "setup") {
    await setupRemoteRunner(parseArguments(rest));
    return;
  }
  if (action === "bootstrap") {
    await bootstrapRemoteRepository(await resolveBootstrapOptions(parseBootstrapArguments(rest)));
    return;
  }
  if (action === "sessions") {
    await listRemoteSessions(parseSessionsArguments(rest));
    return;
  }
  if (action === "attach") {
    await attachRemoteSession(parseAttachArguments(rest));
    return;
  }
  if (action === "ps") {
    await listRemoteProcesses(parseSessionsArguments(rest));
    return;
  }
  if (action === "interrupt") {
    await interruptRemoteProcessGroup(parseInterruptArguments(rest));
    return;
  }
  throw new Error(usage());
}
