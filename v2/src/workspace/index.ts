import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { execa } from "execa";

export interface WorkspaceConfig {
  readonly baseDirectory: string;
  readonly worktreeDirectory: string;
  readonly prepareWorktree?: string | undefined;
  readonly repositories: Readonly<
    Record<string, { readonly prepareWorktree?: string | undefined }>
  >;
}

export interface GitConfig {
  readonly remote: string;
  readonly defaultBranch: string;
  readonly branchPrefix: string;
}

export interface TaskMarker {
  readonly version: 1;
  readonly canonicalTaskId: string;
  readonly branch: string;
  readonly repositories: readonly string[];
}

export interface ObservedRepository {
  readonly repository: string;
  readonly path: string;
  readonly branch: string;
  readonly dirtyPaths: readonly string[];
  readonly commitsAhead: number;
}

export interface ObservedWorkspace {
  readonly exists: boolean;
  readonly repositories: readonly ObservedRepository[];
  readonly dirtyPaths: readonly string[];
}

interface ResolvedRepository {
  readonly name: string;
  readonly checkout: string;
  readonly worktree: string;
}

interface RepositoryOperation {
  readonly processId: number;
  readonly repository: string;
}

export class WorkspaceService {
  readonly #config: WorkspaceConfig;
  readonly #git: GitConfig;
  readonly #environment: NodeJS.ProcessEnv;

  public constructor(input: {
    readonly config: WorkspaceConfig;
    readonly git: GitConfig;
    readonly environment: NodeJS.ProcessEnv;
  }) {
    this.#config = input.config;
    this.#git = input.git;
    this.#environment = input.environment;
  }

  public workspaceDirectory(input: { readonly slug: string }): string {
    return join(this.#config.worktreeDirectory, input.slug);
  }

  public branch(input: { readonly slug: string }): string {
    return `${this.#git.branchPrefix}/${input.slug}`;
  }

  public async validateRepositories(input: {
    readonly slug: string;
    readonly repositories: readonly string[];
  }): Promise<{ readonly ok: true } | { readonly ok: false; readonly missing: readonly string[] }> {
    const missing: string[] = [];
    for (const repository of input.repositories) {
      // Repository checks are kept ordered for deterministic diagnostics.
      // eslint-disable-next-line no-await-in-loop
      const resolved = await this.resolveRepository({ repository, slug: input.slug });
      if (resolved === undefined) {
        missing.push(repository);
      }
    }
    return missing.length === 0 ? { ok: true } : { missing, ok: false };
  }

  public async provision(input: {
    readonly canonicalTaskId: string;
    readonly slug: string;
    readonly repositories: readonly string[];
  }): Promise<TaskMarker> {
    const resolved = await this.resolveAll({ repositories: input.repositories, slug: input.slug });
    await Promise.all(
      resolved.map(async (repository) => {
        await this.fetch({ repository });
      }),
    );
    const branch = this.branch({ slug: input.slug });
    const branchStates = await Promise.all(
      resolved.map(async (repository) => ({
        existing: await this.prepareBranch({ branch, repository }),
        repository,
      })),
    );
    const workspaceDirectory = this.workspaceDirectory({ slug: input.slug });
    await mkdir(workspaceDirectory, { recursive: true });
    const partialRepositories: string[] = [];
    for (const branchState of branchStates) {
      partialRepositories.push(branchState.repository.name);
      // Recovery metadata is written before Git mutation. The task marker remains reserved for a
      // fully prepared workspace, while status and cleanup can still see interrupted worktrees.
      // eslint-disable-next-line no-await-in-loop
      await this.writeRecoveryMarker({
        marker: {
          branch,
          canonicalTaskId: input.canonicalTaskId,
          repositories: partialRepositories,
          version: 1,
        },
        workspaceDirectory,
      });
      // Worktree creation and prepare commands are intentionally sequential and diagnosable.
      // eslint-disable-next-line no-await-in-loop
      await this.createWorktree({ branch, ...branchState });
      // eslint-disable-next-line no-await-in-loop
      await this.prepareWorktree({ repository: branchState.repository });
    }
    const marker: TaskMarker = {
      branch,
      canonicalTaskId: input.canonicalTaskId,
      repositories: resolved.map((repository) => repository.name),
      version: 1,
    };
    await this.writeMarker({ marker, workspaceDirectory });
    await this.removeRecoveryMarker({ workspaceDirectory });
    return marker;
  }

  public async addRepository(input: {
    readonly marker: TaskMarker;
    readonly slug: string;
    readonly repository: string;
  }): Promise<TaskMarker> {
    if (input.marker.repositories.includes(stripOwner(input.repository))) {
      return input.marker;
    }
    const resolved = await this.resolveRepository({
      repository: input.repository,
      slug: input.slug,
    });
    if (resolved === undefined) {
      throw new RepositoryMissingError([input.repository]);
    }
    await this.fetch({ repository: resolved });
    const existing = await this.prepareBranch({
      branch: input.marker.branch,
      repository: resolved,
    });
    const workspaceDirectory = this.workspaceDirectory({ slug: input.slug });
    const marker: TaskMarker = {
      ...input.marker,
      repositories: [...input.marker.repositories, resolved.name],
    };
    await this.writeRecoveryMarker({ marker, workspaceDirectory });
    await this.createWorktree({ branch: input.marker.branch, existing, repository: resolved });
    await this.prepareWorktree({ repository: resolved });
    await this.writeMarker({ marker, workspaceDirectory });
    await this.removeRecoveryMarker({ workspaceDirectory });
    return marker;
  }

  public async readMarker(input: {
    readonly workspaceDirectory: string;
  }): Promise<TaskMarker | undefined> {
    try {
      return JSON.parse(
        await readFile(join(input.workspaceDirectory, ".groundcrew", "task.json"), "utf8"),
      ) as TaskMarker;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  }

  public async reserveRepositoryOperation(input: {
    readonly workspaceDirectory: string;
    readonly repository: string;
    readonly processId: number;
  }): Promise<void> {
    const current = await this.readRepositoryOperation(input);
    if (current !== undefined && processExists(current.processId)) {
      throw new Error(`repository acquisition for ${current.repository} is already in progress`);
    }
    await atomicWrite({
      path: this.repositoryOperationPath(input),
      value: `${JSON.stringify({
        processId: input.processId,
        repository: input.repository,
      })}\n`,
    });
  }

  public async assertNoActiveRepositoryOperation(input: {
    readonly workspaceDirectory: string;
  }): Promise<void> {
    const operation = await this.readRepositoryOperation(input);
    if (operation === undefined) {
      return;
    }
    if (!processExists(operation.processId)) {
      await rm(this.repositoryOperationPath(input), { force: true });
      return;
    }
    throw new Error(`repository acquisition for ${operation.repository} is in progress; retry`);
  }

  public async finishRepositoryOperation(input: {
    readonly workspaceDirectory: string;
    readonly processId: number;
  }): Promise<void> {
    const operation = await this.readRepositoryOperation(input);
    if (operation?.processId === input.processId) {
      await rm(this.repositoryOperationPath(input), { force: true });
    }
  }

  public async clearDeadRepositoryOperation(input: {
    readonly workspaceDirectory: string;
  }): Promise<void> {
    const operation = await this.readRepositoryOperation(input);
    if (operation !== undefined && !processExists(operation.processId)) {
      await rm(this.repositoryOperationPath(input), { force: true });
    }
  }

  public async observe(input: { readonly slug: string }): Promise<ObservedWorkspace> {
    const workspaceDirectory = this.workspaceDirectory(input);
    const marker = await this.readWorkspaceMetadata({ workspaceDirectory });
    if (marker === undefined) {
      return { dirtyPaths: [], exists: await pathExists(workspaceDirectory), repositories: [] };
    }
    const repositories: ObservedRepository[] = [];
    for (const repositoryName of marker.repositories) {
      const worktree = join(workspaceDirectory, repositoryName);
      // A recovery marker is deliberately written before worktree creation, so an interrupted Git
      // command may leave a planned entry without a directory to observe.
      // eslint-disable-next-line no-await-in-loop
      if (!(await pathExists(worktree))) {
        continue;
      }
      // Git observations are kept ordered to preserve marker order.
      // eslint-disable-next-line no-await-in-loop
      const statusResult = await git({ arguments: ["status", "--porcelain"], cwd: worktree });
      const dirtyPaths = statusResult.stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => line.slice(3));
      // eslint-disable-next-line no-await-in-loop
      const ahead = await git({
        arguments: [
          "rev-list",
          "--count",
          `${this.#git.remote}/${this.#git.defaultBranch}..${marker.branch}`,
        ],
        cwd: worktree,
      });
      repositories.push({
        branch: marker.branch,
        commitsAhead: Number(ahead.stdout.trim()),
        dirtyPaths,
        path: worktree,
        repository: repositoryName,
      });
    }
    return {
      dirtyPaths: repositories.flatMap((repository) =>
        repository.dirtyPaths.map((path) => `${repository.repository}/${path}`),
      ),
      exists: true,
      repositories,
    };
  }

  public async cleanup(input: { readonly slug: string; readonly allowDirty: boolean }): Promise<{
    readonly preservedBranches: readonly string[];
    readonly removedRepositories: readonly string[];
  }> {
    const workspaceDirectory = this.workspaceDirectory(input);
    const marker = await this.readWorkspaceMetadata({ workspaceDirectory });
    if (marker === undefined) {
      await rm(workspaceDirectory, { recursive: true, force: true });
      return { preservedBranches: [], removedRepositories: [] };
    }
    const observed = await this.observe(input);
    if (!input.allowDirty && observed.dirtyPaths.length > 0) {
      throw new DirtyWorkspaceError(observed.dirtyPaths);
    }
    const preservedBranches: string[] = [];
    const removedRepositories: string[] = [];
    for (const repositoryName of marker.repositories) {
      const checkout = join(this.#config.baseDirectory, repositoryName);
      const worktree = join(workspaceDirectory, repositoryName);
      // Cleanup is sequential so a partial failure remains obvious and recoverable.
      // eslint-disable-next-line no-await-in-loop
      if (await pathExists(worktree)) {
        // eslint-disable-next-line no-await-in-loop
        await git({
          arguments: ["worktree", "remove", ...(input.allowDirty ? ["--force"] : []), worktree],
          cwd: checkout,
        });
        removedRepositories.push(repositoryName);
      }
      // A failed worktree creation may not have created the local branch.
      // eslint-disable-next-line no-await-in-loop
      const branchExists = await gitSucceeds({
        arguments: ["show-ref", "--verify", `refs/heads/${marker.branch}`],
        cwd: checkout,
      });
      if (!branchExists) {
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const safe =
        input.allowDirty || (await this.branchHasNoUniqueWork({ branch: marker.branch, checkout }));
      if (safe) {
        // eslint-disable-next-line no-await-in-loop
        await git({ arguments: ["branch", "-D", marker.branch], cwd: checkout });
      } else {
        preservedBranches.push(`${repositoryName}:${marker.branch}`);
      }
    }
    await rm(workspaceDirectory, { recursive: true, force: true });
    return { preservedBranches, removedRepositories };
  }

  private async resolveAll(input: {
    readonly repositories: readonly string[];
    readonly slug: string;
  }): Promise<readonly ResolvedRepository[]> {
    const resolved = await Promise.all(
      input.repositories.map(
        async (repository) => await this.resolveRepository({ repository, slug: input.slug }),
      ),
    );
    const missing = input.repositories.filter((_, index) => resolved[index] === undefined);
    if (missing.length > 0) {
      throw new RepositoryMissingError(missing);
    }
    return resolved.filter(
      (repository): repository is ResolvedRepository => repository !== undefined,
    );
  }

  private async resolveRepository(input: {
    readonly repository: string;
    readonly slug: string;
  }): Promise<ResolvedRepository | undefined> {
    const name = stripOwner(input.repository);
    const checkout = resolve(this.#config.baseDirectory, name);
    if (!(await pathExists(join(checkout, ".git")))) {
      return undefined;
    }
    const result = await execa("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: checkout,
      reject: false,
    });
    if (result.exitCode !== 0) {
      return undefined;
    }
    return { checkout, name, worktree: join(this.workspaceDirectory({ slug: input.slug }), name) };
  }

  private async fetch(input: { readonly repository: ResolvedRepository }): Promise<void> {
    await git({
      arguments: ["fetch", "--prune", this.#git.remote, this.#git.defaultBranch],
      cwd: input.repository.checkout,
    });
  }

  private async prepareBranch(input: {
    readonly branch: string;
    readonly repository: ResolvedRepository;
  }): Promise<boolean> {
    const exists = await gitSucceeds({
      arguments: ["show-ref", "--verify", `refs/heads/${input.branch}`],
      cwd: input.repository.checkout,
    });
    if (!exists) {
      return false;
    }
    const worktrees = await git({
      arguments: ["worktree", "list", "--porcelain"],
      cwd: input.repository.checkout,
    });
    if (worktrees.stdout.includes(`branch refs/heads/${input.branch}`)) {
      throw new Error(`branch ${input.branch} is checked out in another worktree`);
    }
    const unique = await git({
      arguments: [
        "rev-list",
        input.branch,
        "--not",
        `${this.#git.remote}/${this.#git.defaultBranch}`,
      ],
      cwd: input.repository.checkout,
    });
    if (unique.stdout.trim().length > 0) {
      throw new Error(
        `branch ${input.branch} contains commits absent from ${this.#git.remote}/${this.#git.defaultBranch}`,
      );
    }
    await git({
      arguments: ["branch", "-f", input.branch, `${this.#git.remote}/${this.#git.defaultBranch}`],
      cwd: input.repository.checkout,
    });
    return true;
  }

  private async createWorktree(input: {
    readonly branch: string;
    readonly existing: boolean;
    readonly repository: ResolvedRepository;
  }): Promise<void> {
    await mkdir(dirname(input.repository.worktree), { recursive: true });
    const arguments_ = input.existing
      ? ["worktree", "add", input.repository.worktree, input.branch]
      : [
          "worktree",
          "add",
          "-b",
          input.branch,
          input.repository.worktree,
          `${this.#git.remote}/${this.#git.defaultBranch}`,
        ];
    await git({ arguments: arguments_, cwd: input.repository.checkout });
  }

  private async prepareWorktree(input: { readonly repository: ResolvedRepository }): Promise<void> {
    const command =
      this.#config.repositories[input.repository.name]?.prepareWorktree ??
      this.#config.prepareWorktree;
    if (command === undefined || command.trim().length === 0) {
      return;
    }
    const result = await execa("/bin/zsh", ["-lc", command], {
      cwd: input.repository.worktree,
      env: this.#environment,
      reject: false,
    });
    if (result.exitCode !== 0) {
      throw new PrepareWorktreeError({
        command,
        repository: input.repository.name,
        stderr: result.stderr,
      });
    }
  }

  private async writeMarker(input: {
    readonly workspaceDirectory: string;
    readonly marker: TaskMarker;
  }): Promise<void> {
    await atomicWrite({
      path: join(input.workspaceDirectory, ".groundcrew", "task.json"),
      value: `${JSON.stringify(input.marker, undefined, 2)}\n`,
    });
  }

  private async readRecoveryMarker(input: {
    readonly workspaceDirectory: string;
  }): Promise<TaskMarker | undefined> {
    try {
      return JSON.parse(
        await readFile(join(input.workspaceDirectory, ".groundcrew", "provisioning.json"), "utf8"),
      ) as TaskMarker;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  }

  private async readRepositoryOperation(input: {
    readonly workspaceDirectory: string;
  }): Promise<RepositoryOperation | undefined> {
    try {
      return JSON.parse(
        await readFile(this.repositoryOperationPath(input), "utf8"),
      ) as RepositoryOperation;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  }

  private repositoryOperationPath(input: { readonly workspaceDirectory: string }): string {
    return join(input.workspaceDirectory, ".groundcrew", "repository-operation.json");
  }

  private async readWorkspaceMetadata(input: {
    readonly workspaceDirectory: string;
  }): Promise<TaskMarker | undefined> {
    const [marker, recovery] = await Promise.all([
      this.readMarker(input),
      this.readRecoveryMarker(input),
    ]);
    if (marker === undefined) {
      return recovery;
    }
    if (recovery === undefined) {
      return marker;
    }
    return {
      ...marker,
      repositories: [...new Set([...marker.repositories, ...recovery.repositories])],
    };
  }

  private async writeRecoveryMarker(input: {
    readonly workspaceDirectory: string;
    readonly marker: TaskMarker;
  }): Promise<void> {
    await atomicWrite({
      path: join(input.workspaceDirectory, ".groundcrew", "provisioning.json"),
      value: `${JSON.stringify(input.marker, undefined, 2)}\n`,
    });
  }

  private async removeRecoveryMarker(input: {
    readonly workspaceDirectory: string;
  }): Promise<void> {
    await rm(join(input.workspaceDirectory, ".groundcrew", "provisioning.json"), { force: true });
  }

  private async branchHasNoUniqueWork(input: {
    readonly checkout: string;
    readonly branch: string;
  }): Promise<boolean> {
    const unique = await git({
      arguments: [
        "rev-list",
        input.branch,
        "--not",
        `${this.#git.remote}/${this.#git.defaultBranch}`,
      ],
      cwd: input.checkout,
    });
    if (unique.stdout.trim().length === 0) {
      return true;
    }
    const remoteBranch = `${this.#git.remote}/${input.branch}`;
    if (
      !(await gitSucceeds({
        arguments: ["show-ref", "--verify", `refs/remotes/${remoteBranch}`],
        cwd: input.checkout,
      }))
    ) {
      return false;
    }
    const [localTip, remoteTip] = await Promise.all([
      git({ arguments: ["rev-parse", input.branch], cwd: input.checkout }),
      git({ arguments: ["rev-parse", remoteBranch], cwd: input.checkout }),
    ]);
    return localTip.stdout.trim() === remoteTip.stdout.trim();
  }
}

export class RepositoryMissingError extends Error {
  public readonly repositories: readonly string[];

  public constructor(repositories: readonly string[]) {
    super(`designated repositories not present: ${repositories.join(", ")}`);
    this.name = "RepositoryMissingError";
    this.repositories = repositories;
  }
}

export class DirtyWorkspaceError extends Error {
  public readonly paths: readonly string[];

  public constructor(paths: readonly string[]) {
    super(`workspace has dirty paths: ${paths.join(", ")}`);
    this.name = "DirtyWorkspaceError";
    this.paths = paths;
  }
}

export class PrepareWorktreeError extends Error {
  public readonly repository: string;
  public readonly command: string;

  public constructor(input: {
    readonly repository: string;
    readonly command: string;
    readonly stderr: string;
  }) {
    super(
      `prepare command failed for ${input.repository}: ${input.command}\n${input.stderr}`.trim(),
    );
    this.name = "PrepareWorktreeError";
    this.command = input.command;
    this.repository = input.repository;
  }
}

async function git(input: {
  readonly arguments: readonly string[];
  readonly cwd: string;
}): Promise<{ readonly stdout: string }> {
  const result = await execa("git", input.arguments, { cwd: input.cwd, reject: false });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `git ${input.arguments.join(" ")} failed`);
  }
  return { stdout: result.stdout };
}

async function gitSucceeds(input: {
  readonly arguments: readonly string[];
  readonly cwd: string;
}): Promise<boolean> {
  const result = await execa("git", input.arguments, { cwd: input.cwd, reject: false });
  return result.exitCode === 0;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function atomicWrite(input: {
  readonly path: string;
  readonly value: string;
}): Promise<void> {
  await mkdir(dirname(input.path), { recursive: true });
  const temporaryPath = `${input.path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, input.value, "utf8");
  await rename(temporaryPath, input.path);
}

function stripOwner(repository: string): string {
  const name = basename(repository);
  if (name === "." || name === "..") {
    throw new RepositoryMissingError([repository]);
  }
  return name;
}

function processExists(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}
