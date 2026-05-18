import { connect } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

import { runCommandAsync, type RunCommandOptions } from "./commandRunner.ts";
import type { RemoteRunnerConfig, RemoteRunnerProviderName } from "./config.ts";
import { shellSingleQuote } from "./shell.ts";

const LONG_RUNNING_COMMAND_OPTIONS = { stdio: "inherit", timeoutMs: 0 } as const;
const PROXY_CLOSE_SIGNAL = "SIGINT";
const PROXY_READY_HOST = "127.0.0.1";
const PROXY_READY_TIMEOUT_MS = 5000;
const PROXY_READY_RETRY_DELAY_MS = 25;

export const SPRITE_REMOTE_PROVIDER_DEFAULTS = {
  provider: "sprite",
  runnerName: "crew-claude-1",
  owner: "ClipboardHealth",
  repoRoot: "/home/sprite/dev",
  worktreeRoot: "/home/sprite/groundcrew/worktrees",
} as const satisfies Omit<RemoteRunnerConfig, "secretNames">;

interface RemoteFileUpload {
  localPath: string;
  remotePath: string;
}

interface RemoteRunArguments {
  config: RemoteRunnerConfig;
  remoteArguments: readonly string[];
  files?: readonly RemoteFileUpload[];
  workingDirectory?: string;
  options?: RunCommandOptions;
}

interface RemoteTtyCommandArguments {
  config: RemoteRunnerConfig;
  remoteArguments: readonly string[];
  files?: readonly RemoteFileUpload[];
  workingDirectory?: string;
}

interface RemoteWorktreeCreateArguments {
  config: RemoteRunnerConfig;
  repository: string;
  ticket: string;
  branchName: string;
  baseBranch: string;
  gitRemote: string;
  signal?: AbortSignal;
}

interface RemoteWorktreeLocation {
  remoteRepoDir: string;
  remoteWorktreeDir: string;
}

interface RemoteWorktreeRemoveArguments {
  config: RemoteRunnerConfig;
  entry: {
    branchName: string;
    dir: string;
    remoteRepoDir?: string;
    remoteRunnerName?: string;
  };
  force: boolean;
  signal?: AbortSignal;
}

export interface RemoteRunnerProvider {
  name: RemoteRunnerProviderName;
  runnerExists(config: RemoteRunnerConfig): Promise<boolean>;
  createRunner(config: RemoteRunnerConfig): Promise<void>;
  runCommand(arguments_: RemoteRunArguments): Promise<string | undefined>;
  runTtyCommand(arguments_: RemoteRunArguments): Promise<void>;
  buildTtyCommand(arguments_: RemoteTtyCommandArguments): string;
  startPortProxy(config: RemoteRunnerConfig, port: number): Promise<{ close(): Promise<void> }>;
  listSessions(config: RemoteRunnerConfig): Promise<string>;
  attachSession(config: RemoteRunnerConfig, target: string): Promise<void>;
  listProcesses(config: RemoteRunnerConfig): Promise<string>;
  interruptProcessGroup(config: RemoteRunnerConfig, processGroupId: string): Promise<void>;
  checkpoint(config: RemoteRunnerConfig, comment: string): Promise<void>;
  createWorktree(arguments_: RemoteWorktreeCreateArguments): Promise<RemoteWorktreeLocation>;
  removeWorktree(arguments_: RemoteWorktreeRemoveArguments): Promise<void>;
}

function longRunningCommandOptions(signal?: AbortSignal): RunCommandOptions & { stdio: "inherit" } {
  return signal === undefined
    ? LONG_RUNNING_COMMAND_OPTIONS
    : { ...LONG_RUNNING_COMMAND_OPTIONS, signal };
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

function spriteFileArguments(files: readonly RemoteFileUpload[] = []): string[] {
  return files.flatMap((file) => ["--file", `${file.localPath}:${file.remotePath}`]);
}

function spriteExecArguments(
  arguments_: RemoteRunArguments,
  options: { isTty?: boolean } = {},
): string[] {
  const args = [
    "exec",
    ...(options.isTty === true ? ["--tty"] : []),
    "-s",
    arguments_.config.runnerName,
    ...spriteFileArguments(arguments_.files),
  ];
  if (arguments_.workingDirectory !== undefined) {
    args.push("--dir", arguments_.workingDirectory);
  }
  args.push("--", ...arguments_.remoteArguments);
  return args;
}

function spriteTtyExecArguments(arguments_: RemoteRunArguments): string[] {
  return spriteExecArguments(arguments_, { isTty: true });
}

async function runSprite(
  args: readonly string[],
  options: RunCommandOptions | undefined,
): Promise<string | undefined> {
  if (options?.stdio === "inherit") {
    const inheritedOptions: RunCommandOptions & { stdio: "inherit" } = {
      ...options,
      stdio: "inherit",
    };
    await runCommandAsync("sprite", args, inheritedOptions);
    return undefined;
  }
  return await runCommandAsync("sprite", args, capturedRunOptions(options));
}

function capturedRunOptions(
  options: RunCommandOptions | undefined,
): (RunCommandOptions & { stdio?: "captured" }) | undefined {
  if (options === undefined) {
    return undefined;
  }
  const { stdio, ...rest } = options;
  if (stdio === undefined) {
    return rest;
  }
  /* v8 ignore next 3 @preserve -- runSprite handles inherited stdio before capturedRunOptions */
  if (stdio === "inherit") {
    throw new Error("Inherited stdio options must be handled before capturedRunOptions.");
  }
  return { ...rest, stdio };
}

function buildSpriteTtyCommand(arguments_: RemoteTtyCommandArguments): string {
  const files = (arguments_.files ?? []).map(
    (file) => `--file ${shellSingleQuote(`${file.localPath}:${file.remotePath}`)}`,
  );
  const workingDirectory =
    arguments_.workingDirectory === undefined
      ? []
      : ["--dir", shellSingleQuote(arguments_.workingDirectory)];
  return [
    "sprite exec --tty",
    "-s",
    shellSingleQuote(arguments_.config.runnerName),
    ...files,
    ...workingDirectory,
    "--",
    ...arguments_.remoteArguments.map(shellSingleQuote),
  ].join(" ");
}

export function remotePathJoin(root: string, leaf: string): string {
  let end = root.length;
  while (end > 0 && root[end - 1] === "/") {
    end -= 1;
  }
  return `${root.slice(0, end)}/${leaf}`;
}

export function remoteRepositorySlug(owner: string, repository: string): string {
  return repository.includes("/") ? repository : `${owner}/${repository}`;
}

export function remoteRepositoryDirectoryName(owner: string, repository: string): string {
  const slug = remoteRepositorySlug(owner, repository);
  const normalizedSlug = slug.endsWith(".git") ? slug.slice(0, -4) : slug;
  return normalizedSlug.replaceAll("/", "--");
}

function worktreeTicketComponent(ticket: string): string {
  if (ticket.includes("/") || ticket.includes("\\") || ticket.includes("..")) {
    throw new Error(`Invalid ticket for remote worktree path: ${JSON.stringify(ticket)}`);
  }
  return ticket;
}

function spriteCreateWorktreeCommand(arguments_: {
  owner: string;
  repository: string;
  repoDir: string;
  worktreeDir: string;
  branchName: string;
  baseBranch: string;
  gitRemote: string;
  repoRoot: string;
  worktreeRoot: string;
}): string {
  const slug = remoteRepositorySlug(arguments_.owner, arguments_.repository);
  const branchRemoteRef = `refs/remotes/${arguments_.gitRemote}/${arguments_.branchName}`;
  const branchRef = `${arguments_.gitRemote}/${arguments_.branchName}`;
  const baseRef = `${arguments_.gitRemote}/${arguments_.baseBranch}`;
  return [
    "set -euo pipefail",
    `repo_root=${shellSingleQuote(arguments_.repoRoot)}`,
    `worktree_root=${shellSingleQuote(arguments_.worktreeRoot)}`,
    `repo_dir=${shellSingleQuote(arguments_.repoDir)}`,
    `worktree_dir=${shellSingleQuote(arguments_.worktreeDir)}`,
    `branch=${shellSingleQuote(arguments_.branchName)}`,
    `git_remote=${shellSingleQuote(arguments_.gitRemote)}`,
    `branch_remote_ref=${shellSingleQuote(branchRemoteRef)}`,
    `branch_ref=${shellSingleQuote(branchRef)}`,
    `base_ref=${shellSingleQuote(baseRef)}`,
    'mkdir -p "$repo_root" "$worktree_root"',
    'if [ ! -d "$repo_dir/.git" ]; then',
    `  gh repo clone ${shellSingleQuote(slug)} "$repo_dir"`,
    "fi",
    'if ! git -C "$repo_dir" remote get-url "$git_remote" >/dev/null 2>&1; then',
    '  origin_url="$(git -C "$repo_dir" remote get-url origin)"',
    '  git -C "$repo_dir" remote add "$git_remote" "$origin_url"',
    "fi",
    'git -C "$repo_dir" fetch "$git_remote" --prune',
    'if [ -e "$worktree_dir" ]; then',
    '  echo "Remote worktree already exists: $worktree_dir" >&2',
    "  exit 1",
    "fi",
    'if git -C "$repo_dir" show-ref --verify --quiet "$branch_remote_ref"; then',
    '  git -C "$repo_dir" worktree add -B "$branch" "$worktree_dir" "$branch_ref"',
    "else",
    '  git -C "$repo_dir" worktree add -b "$branch" "$worktree_dir" "$base_ref"',
    "fi",
  ].join("\n");
}

function spriteRemoveWorktreeCommand(
  entry: RemoteWorktreeRemoveArguments["entry"],
  force: boolean,
): string {
  if (entry.remoteRepoDir === undefined) {
    throw new Error(`Remote worktree entry missing remoteRepoDir: ${entry.dir}`);
  }
  const removeArguments = [
    "git",
    "-C",
    shellSingleQuote(entry.remoteRepoDir),
    "worktree",
    "remove",
  ];
  if (force) {
    removeArguments.push("--force");
  }
  removeArguments.push(shellSingleQuote(entry.dir));
  return [
    "set -euo pipefail",
    removeArguments.join(" "),
    `git -C ${shellSingleQuote(entry.remoteRepoDir)} branch -D ${shellSingleQuote(entry.branchName)} || true`,
    `git -C ${shellSingleQuote(entry.remoteRepoDir)} worktree prune`,
  ].join("\n");
}

async function spriteRunnerExists(config: RemoteRunnerConfig): Promise<boolean> {
  const output = await runCommandAsync("sprite", ["list", "--sprite", config.runnerName]);
  return new RegExp(`(^|\\s)${escapeRegExp(config.runnerName)}(\\s|$)`, "m").test(output);
}

async function createSpriteRunner(config: RemoteRunnerConfig): Promise<void> {
  await runCommandAsync("sprite", ["create", "--skip-console", config.runnerName], {
    stdio: "inherit",
    timeoutMs: 0,
  });
}

async function startSpritePortProxy(
  config: RemoteRunnerConfig,
  port: number,
): Promise<{ close(): Promise<void> }> {
  const controller = new AbortController();
  let closeWasRequested = false;
  let proxyError: Error | undefined;
  const proxy = (async () => {
    try {
      await runCommandAsync("sprite", ["proxy", "-s", config.runnerName, String(port)], {
        signal: controller.signal,
        stdio: "inherit",
        timeoutMs: 0,
      });
      if (!closeWasRequested) {
        proxyError = new Error("Sprite proxy exited before it was closed.");
      }
    } catch (error) {
      if (closeWasRequested && errorHasSignal(error, PROXY_CLOSE_SIGNAL)) {
        return;
      }
      proxyError = new Error(`Sprite proxy exited before it was closed: ${String(error)}`, {
        cause: error,
      });
    }
  })();

  try {
    await waitForSpritePortProxy({ port, proxy, proxyError: () => proxyError });
  } catch (error) {
    closeWasRequested = true;
    controller.abort();
    await proxy;
    throw error;
  }

  return {
    async close() {
      closeWasRequested = true;
      controller.abort();
      await proxy;
      if (proxyError !== undefined) {
        throw new Error(proxyError.message, { cause: proxyError });
      }
    },
  };
}

async function waitForSpritePortProxy(arguments_: {
  port: number;
  proxy: Promise<void>;
  proxyError: () => Error | undefined;
}): Promise<void> {
  const deadline = Date.now() + PROXY_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    throwIfProxyExited(arguments_.proxyError());
    // eslint-disable-next-line no-await-in-loop -- readiness polling must observe attempts sequentially.
    if (await canConnectToLocalPort(arguments_.port)) {
      throwIfProxyExited(arguments_.proxyError());
      return;
    }
    throwIfProxyExited(arguments_.proxyError());
    // eslint-disable-next-line no-await-in-loop -- retry delay is bounded and stops early if the proxy exits.
    await Promise.race([sleep(PROXY_READY_RETRY_DELAY_MS), arguments_.proxy]);
  }
  throwIfProxyExited(arguments_.proxyError());
  throw new Error(
    `Timed out waiting for Sprite proxy on ${PROXY_READY_HOST}:${arguments_.port} to accept connections.`,
  );
}

function throwIfProxyExited(error: Error | undefined): void {
  if (error !== undefined) {
    throw new Error(error.message, { cause: error });
  }
}

async function canConnectToLocalPort(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = connect({ host: PROXY_READY_HOST, port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function errorHasSignal(error: unknown, signal: string): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  if ("signal" in error && error.signal === signal) {
    return true;
  }
  if (error instanceof Error && error.cause !== undefined) {
    return errorHasSignal(error.cause, signal);
  }
  return false;
}

export const spriteRemoteRunnerProvider: RemoteRunnerProvider = {
  name: "sprite",
  async runnerExists(config) {
    return await spriteRunnerExists(config);
  },
  async createRunner(config) {
    await createSpriteRunner(config);
  },
  async runCommand(arguments_) {
    return await runSprite(spriteExecArguments(arguments_), arguments_.options);
  },
  async runTtyCommand(arguments_) {
    await runSprite(spriteTtyExecArguments(arguments_), {
      ...arguments_.options,
      stdio: "inherit",
      timeoutMs: arguments_.options?.timeoutMs ?? 0,
    });
  },
  buildTtyCommand: buildSpriteTtyCommand,
  async startPortProxy(config, port) {
    return await startSpritePortProxy(config, port);
  },
  async listSessions(config) {
    const output = await runCommandAsync("sprite", ["sessions", "list", "-s", config.runnerName], {
      trim: false,
    });
    return output;
  },
  async attachSession(config, target) {
    await runCommandAsync("sprite", ["attach", "-s", config.runnerName, target], {
      stdio: "inherit",
      timeoutMs: 0,
    });
  },
  async listProcesses(config) {
    return await runCommandAsync(
      "sprite",
      [
        "exec",
        "-s",
        config.runnerName,
        "--",
        "ps",
        "-eo",
        "pid,ppid,pgid,sid,stat,etime,pcpu,pmem,cmd",
      ],
      { trim: false },
    );
  },
  async interruptProcessGroup(config, processGroupId) {
    await runCommandAsync(
      "sprite",
      ["exec", "-s", config.runnerName, "--", "kill", "-INT", "--", `-${processGroupId}`],
      { stdio: "inherit" },
    );
  },
  async checkpoint(config, comment) {
    await runCommandAsync(
      "sprite",
      ["checkpoint", "create", "-s", config.runnerName, "--comment", comment],
      {
        stdio: "inherit",
        timeoutMs: 0,
      },
    );
  },
  async createWorktree(arguments_) {
    const { config, repository, ticket, branchName, baseBranch, gitRemote, signal } = arguments_;
    const remoteRepositoryName = remoteRepositoryDirectoryName(config.owner, repository);
    const remoteRepoDir = remotePathJoin(config.repoRoot, remoteRepositoryName);
    const remoteWorktreeDir = remotePathJoin(
      config.worktreeRoot,
      `${remoteRepositoryName}-${worktreeTicketComponent(ticket)}`,
    );

    await runCommandAsync(
      "sprite",
      [
        "exec",
        "-s",
        config.runnerName,
        "--",
        "bash",
        "-lc",
        spriteCreateWorktreeCommand({
          owner: config.owner,
          repository,
          repoDir: remoteRepoDir,
          worktreeDir: remoteWorktreeDir,
          branchName,
          baseBranch,
          gitRemote,
          repoRoot: config.repoRoot,
          worktreeRoot: config.worktreeRoot,
        }),
      ],
      longRunningCommandOptions(signal),
    );

    return { remoteRepoDir, remoteWorktreeDir };
  },
  async removeWorktree(arguments_) {
    const { entry, force, signal } = arguments_;
    if (entry.remoteRunnerName === undefined) {
      throw new Error(`Remote worktree entry missing remoteRunnerName: ${entry.dir}`);
    }
    await runCommandAsync(
      "sprite",
      [
        "exec",
        "-s",
        entry.remoteRunnerName,
        "--",
        "bash",
        "-lc",
        spriteRemoveWorktreeCommand(entry, force),
      ],
      longRunningCommandOptions(signal),
    );
  },
};

export function remoteConfigWithRunnerName(runnerName: string): RemoteRunnerConfig {
  return {
    ...SPRITE_REMOTE_PROVIDER_DEFAULTS,
    runnerName,
    secretNames: [],
  };
}

export function getRemoteRunnerProvider(provider: RemoteRunnerProviderName): RemoteRunnerProvider {
  if (provider === "sprite") {
    return spriteRemoteRunnerProvider;
  }
  throw new Error(`Unknown remote provider: ${JSON.stringify(provider)}`);
}
