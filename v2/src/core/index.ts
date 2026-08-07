import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { execa } from "execa";
import {
  SourceRegistry,
  type SourceHealth,
  type SourceInstance,
  type Task,
} from "../source/index.js";
import {
  launchAgent,
  presenterFor,
  RunStore,
  taskSlug,
  withFileLock,
  type AgentProfile,
  type Artifact,
  type RunRecord,
} from "../run/index.js";
import {
  DirtyWorkspaceError,
  PrepareWorktreeError,
  RepositoryMissingError,
  WorkspaceService,
  type ObservedWorkspace,
} from "../workspace/index.js";

export interface CoreConfig {
  readonly workspace: {
    readonly baseDirectory: string;
    readonly worktreeDirectory?: string | undefined;
    readonly prepareWorktree?: string | undefined;
    readonly repositories: Readonly<
      Record<string, { readonly prepareWorktree?: string | undefined }>
    >;
  };
  readonly sources: readonly SourceInstance[];
  readonly agents: {
    readonly default: string;
    readonly profiles: Readonly<Record<string, AgentProfile>>;
  };
  readonly orchestrator: {
    readonly maximumInProgress: number;
    readonly pollIntervalMilliseconds: number;
  };
  readonly git: {
    readonly remote: string;
    readonly defaultBranch: string;
    readonly branchPrefix: string;
  };
  readonly presenter: "cmux";
  readonly logging: { readonly file?: string | undefined };
}

export interface ApplicationPaths {
  readonly packageRoot: string;
  readonly configHome: string;
  readonly stateRoot: string;
}

export interface HealthCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface DoctorResult {
  readonly ok: boolean;
  readonly checks: readonly HealthCheck[];
  readonly sources: readonly SourceHealth[];
}

export type VerdictReason =
  | "blocked"
  | "slots-full"
  | "claim-rejected"
  | "repo-not-on-disk"
  | "agent-unavailable"
  | "run-exists"
  | "slug-collision"
  | "terminal";

export interface Verdict {
  readonly timestamp: string;
  readonly reason: VerdictReason;
  readonly detail: string;
}

export interface StatusEntry {
  readonly canonicalTaskId: string;
  readonly run?: RunRecord | undefined;
  readonly verdict?: Verdict | undefined;
  readonly observed?: ObservedWorkspace | undefined;
  readonly reported: {
    readonly artifacts: readonly Artifact[];
    readonly outcome?: "delivered" | "failed" | "stopped" | undefined;
    readonly reason?: string | undefined;
  };
  readonly accessHint?: string | undefined;
  readonly cleanup: {
    readonly wouldRemove: readonly string[];
    readonly refusesForDirtyPaths: readonly string[];
  };
}

export interface Application {
  doctor(): Promise<DoctorResult>;
  start(input: {
    readonly task?: string | undefined;
    readonly force: boolean;
    readonly agent?: string | undefined;
  }): Promise<{ readonly started: readonly string[]; readonly skipped: readonly string[] }>;
  status(input: {
    readonly task?: string | undefined;
  }): Promise<{ readonly tasks: readonly StatusEntry[] }>;
  artifactAdd(input: { readonly task: string; readonly artifact: Artifact }): Promise<RunRecord>;
  done(input: {
    readonly task: string;
    readonly outcome: "delivered" | "failed" | "stopped";
    readonly message?: string | undefined;
    readonly allowDirty: boolean;
  }): Promise<RunRecord>;
  repoAdd(input: { readonly task: string; readonly repository: string }): Promise<RunRecord>;
  cleanup(input: {
    readonly task?: string | undefined;
    readonly all: boolean;
    readonly allowDirty: boolean;
  }): Promise<{
    readonly cleaned: readonly string[];
    readonly preservedBranches: readonly string[];
  }>;
  reconcile(): Promise<void>;
}

interface Runtime {
  readonly config: CoreConfig;
  readonly environment: NodeJS.ProcessEnv;
  readonly paths: ApplicationPaths;
  readonly registry: SourceRegistry;
  readonly runs: RunStore;
  readonly workspaces: WorkspaceService;
}

export async function createApplication(input: {
  readonly config: CoreConfig;
  readonly paths: ApplicationPaths;
  readonly environment: NodeJS.ProcessEnv;
}): Promise<Application> {
  const { config, environment, paths } = input;
  const registry = await SourceRegistry.create({
    configHome: paths.configHome,
    environment,
    instances: config.sources,
    packageRoot: paths.packageRoot,
  });
  const runs = new RunStore({ stateRoot: paths.stateRoot });
  const workspaces = new WorkspaceService({
    config: {
      baseDirectory: config.workspace.baseDirectory,
      prepareWorktree: config.workspace.prepareWorktree,
      repositories: config.workspace.repositories,
      worktreeDirectory:
        config.workspace.worktreeDirectory ??
        join(config.workspace.baseDirectory, ".groundcrew", "worktrees"),
    },
    environment,
    git: config.git,
  });
  const runtime: Runtime = { config, environment, paths, registry, runs, workspaces };
  await reconcile({ runtime });
  return {
    async doctor(): Promise<DoctorResult> {
      return await doctor({ runtime });
    },
    async start(
      startInput,
    ): Promise<{ readonly started: readonly string[]; readonly skipped: readonly string[] }> {
      return await start({ ...startInput, runtime });
    },
    async status(statusInput): Promise<{ readonly tasks: readonly StatusEntry[] }> {
      return await status({ ...statusInput, runtime });
    },
    async artifactAdd(artifactInput): Promise<RunRecord> {
      return await artifactAdd({ ...artifactInput, runtime });
    },
    async done(doneInput): Promise<RunRecord> {
      return await done({ ...doneInput, runtime });
    },
    async repoAdd(repoInput): Promise<RunRecord> {
      return await repoAdd({ ...repoInput, runtime });
    },
    async cleanup(cleanupInput): Promise<{
      readonly cleaned: readonly string[];
      readonly preservedBranches: readonly string[];
    }> {
      return await cleanup({ ...cleanupInput, runtime });
    },
    async reconcile(): Promise<void> {
      await reconcile({ runtime });
    },
  };
}

async function doctor(input: { readonly runtime: Runtime }): Promise<DoctorResult> {
  const { runtime } = input;
  const checks: HealthCheck[] = [
    {
      detail: process.versions.node,
      name: "Node.js 24+",
      ok: Number(process.versions.node.split(".")[0]) >= 24,
    },
  ];
  for (const command of [
    "git",
    "cmux",
    ...new Set(Object.values(runtime.config.agents.profiles).map((profile) => profile.kind)),
  ]) {
    // Prerequisite probes stay ordered for stable human output.
    // eslint-disable-next-line no-await-in-loop
    const available = await commandExists({ command, environment: runtime.environment });
    checks.push({
      detail: available ? "available" : `missing executable ${command}`,
      name: command,
      ok: available,
    });
  }
  const sources = await runtime.registry.health();
  return {
    checks,
    ok:
      checks.every((check) => check.ok) &&
      sources.every((source) => source.errors.length === 0 && source.probe?.ok === true),
    sources,
  };
}

async function start(input: {
  readonly runtime: Runtime;
  readonly task?: string | undefined;
  readonly force: boolean;
  readonly agent?: string | undefined;
}): Promise<{ readonly started: readonly string[]; readonly skipped: readonly string[] }> {
  const { runtime } = input;
  await reconcile({ runtime });
  const listed = await runtime.registry.list();
  if (!listed.ok) {
    throw new Error(listed.error.message);
  }
  await reapTerminalTasks({ runtime, tasks: listed.data.tasks });
  let tasks = listed.data.tasks;
  if (input.task === undefined) {
    tasks = tasks
      .map((task, index) => ({ index, task }))
      .toSorted(
        (left, right) =>
          (left.task.priority ?? Number.POSITIVE_INFINITY) -
            (right.task.priority ?? Number.POSITIVE_INFINITY) || left.index - right.index,
      )
      .map(({ task }) => task);
  } else {
    tasks = [await resolveExplicitTask({ query: input.task, registry: runtime.registry })];
  }
  const started: string[] = [];
  const skipped: string[] = [];
  let activeCount = (await runtime.runs.list()).filter(
    (run) => run.state === "provisioning" || run.state === "running",
  ).length;
  for (const task of tasks) {
    const canonicalTaskId = canonicalId({ task });
    const slug = taskSlug({ canonicalTaskId });
    const existing = await runtime.runs.getBySlug({ slug });
    if (existing !== undefined) {
      const reason: VerdictReason =
        existing.canonicalTaskId === canonicalTaskId ? "run-exists" : "slug-collision";
      await writeVerdict({ canonicalTaskId, detail: existing.canonicalTaskId, reason, runtime });
      skipped.push(canonicalTaskId);
      continue;
    }
    if (task.terminal) {
      await writeVerdict({
        canonicalTaskId,
        detail: "source reports the task as terminal",
        reason: "terminal",
        runtime,
      });
      skipped.push(canonicalTaskId);
      continue;
    }
    if (task.blocked && !input.force) {
      await writeVerdict({
        canonicalTaskId,
        detail: "task reports an open blocker",
        reason: "blocked",
        runtime,
      });
      skipped.push(canonicalTaskId);
      continue;
    }
    const profileName =
      input.agent ??
      task.agentProfile ??
      runtime.registry.sourceDefaultProfile({ sourceName: task.sourceName }) ??
      runtime.config.agents.default;
    const profile = runtime.config.agents.profiles[profileName];
    if (profile === undefined) {
      await writeVerdict({
        canonicalTaskId,
        detail: profileName,
        reason: "agent-unavailable",
        runtime,
      });
      skipped.push(canonicalTaskId);
      continue;
    }
    if (!(await commandExists({ command: profile.kind, environment: runtime.environment }))) {
      await writeVerdict({
        canonicalTaskId,
        detail: `missing harness executable ${profile.kind}`,
        reason: "agent-unavailable",
        runtime,
      });
      skipped.push(canonicalTaskId);
      continue;
    }
    const repositoryCheck = await runtime.workspaces.validateRepositories({
      repositories: task.repositories,
      slug,
    });
    if (!repositoryCheck.ok) {
      await writeVerdict({
        canonicalTaskId,
        detail: repositoryCheck.missing.join(", "),
        reason: "repo-not-on-disk",
        runtime,
      });
      if (input.task !== undefined) {
        throw new RepositoryMissingError(repositoryCheck.missing);
      }
      skipped.push(canonicalTaskId);
      continue;
    }
    if (!input.force && activeCount >= runtime.config.orchestrator.maximumInProgress) {
      await writeVerdict({
        canonicalTaskId,
        detail: "concurrency limit reached",
        reason: "slots-full",
        runtime,
      });
      skipped.push(canonicalTaskId);
      continue;
    }
    const workspaceDirectory = runtime.workspaces.workspaceDirectory({ slug });
    const record = await runtime.runs.create({
      agentProfile: profileName,
      canonicalTaskId,
      repositories: task.repositories,
      workspaceDirectory,
    });
    const claim = await runtime.registry.update({
      canonicalTaskId,
      event: { runId: record.runId, type: "claimed" },
    });
    if (!claim.ok || claim.data.result === "rejected") {
      await runtime.runs.remove({ canonicalTaskId });
      await writeVerdict({
        canonicalTaskId,
        detail: claim.ok ? (claim.data.reason ?? "source rejected claim") : claim.error.message,
        reason: "claim-rejected",
        runId: record.runId,
        runtime,
      });
      skipped.push(canonicalTaskId);
      continue;
    }
    try {
      const marker = await runtime.workspaces.provision({
        canonicalTaskId,
        repositories: task.repositories,
        slug,
      });
      await launchAgent({
        acquiredRepositories: marker.repositories,
        branch: marker.branch,
        environment: runtime.environment,
        presenterName: runtime.config.presenter,
        profile,
        record,
        task: {
          canonicalTaskId,
          description: task.description,
          repositories: task.repositories,
          title: task.title,
        },
      });
      let transitioned = false;
      await runtime.runs.mutate({
        canonicalTaskId,
        update: (current) => {
          if (current.state !== "provisioning") {
            return current;
          }
          transitioned = true;
          return transition({ event: "running", record: current, state: "running" });
        },
      });
      if (!transitioned) {
        continue;
      }
      await clearVerdict({ canonicalTaskId, runtime });
      await log({
        canonicalTaskId,
        event: "run_started",
        level: "info",
        module: "core",
        runId: record.runId,
        runtime,
      });
      started.push(canonicalTaskId);
      activeCount += 1;
    } catch (error) {
      const reason =
        error instanceof PrepareWorktreeError ? prepareFailureReason(error) : errorMessage(error);
      let failedNow = false;
      const failed = await runtime.runs.mutate({
        canonicalTaskId,
        update: (current) => {
          if (current.state === "complete") {
            return current;
          }
          failedNow = true;
          return {
            ...completeRecord({ outcome: "failed", reason, record: current }),
            writebackPending: true,
          };
        },
      });
      if (failedNow) {
        await log({
          canonicalTaskId,
          event: "run_failed",
          level: "error",
          module: "core",
          runId: failed.runId,
          runtime,
        });
        await writeCompletion({ record: failed, runtime });
      }
      if (input.task !== undefined) {
        throw error;
      }
    }
  }
  return { skipped, started };
}

async function status(input: {
  readonly runtime: Runtime;
  readonly task?: string | undefined;
}): Promise<{ readonly tasks: readonly StatusEntry[] }> {
  const { runtime } = input;
  await reconcile({ runtime });
  const health = await runtime.registry.health();
  const protocolError = health
    .flatMap((source) => source.errors)
    .find((error) => error.includes("unsupported protocol version"));
  if (protocolError !== undefined) {
    throw new Error(protocolError);
  }
  const [runs, verdicts, listed] = await Promise.all([
    runtime.runs.list(),
    readVerdicts({ runtime }),
    runtime.registry.list(),
  ]);
  const visibleTasks = listed.ok ? listed.data.tasks.map((task) => canonicalId({ task })) : [];
  const identities = new Set([
    ...visibleTasks,
    ...runs.map((run) => run.canonicalTaskId),
    ...Object.keys(verdicts),
  ]);
  let selected = [...identities];
  if (input.task !== undefined) {
    selected = selected.filter(
      (identity) =>
        identity === input.task || identity.slice(identity.indexOf(":") + 1) === input.task,
    );
    if (selected.length === 0) {
      selected = [input.task];
    }
  }
  const presenter = presenterFor({
    environment: runtime.environment,
    name: runtime.config.presenter,
  });
  const entries = await Promise.all(
    selected.toSorted().map(async (canonicalTaskId): Promise<StatusEntry> => {
      const run = runs.find((candidate) => candidate.canonicalTaskId === canonicalTaskId);
      const observed =
        run === undefined
          ? undefined
          : await runtime.workspaces.observe({ slug: taskSlug({ canonicalTaskId }) });
      const accessHint =
        run?.state === "running"
          ? await presenter.accessHint({ name: run.presentedWorkspaceName })
          : undefined;
      return {
        accessHint,
        canonicalTaskId,
        cleanup: {
          refusesForDirtyPaths: observed?.dirtyPaths ?? [],
          wouldRemove: observed?.repositories.map((repository) => repository.path) ?? [],
        },
        observed,
        reported: { artifacts: run?.artifacts ?? [], outcome: run?.outcome, reason: run?.reason },
        run,
        verdict: verdicts[canonicalTaskId],
      };
    }),
  );
  return { tasks: entries };
}

async function artifactAdd(input: {
  readonly runtime: Runtime;
  readonly task: string;
  readonly artifact: Artifact;
}): Promise<RunRecord> {
  const canonicalTaskId = await resolveRunIdentity({ query: input.task, runtime: input.runtime });
  const record = await input.runtime.runs.mutate({
    canonicalTaskId,
    update: (record) => {
      requireRunningRun(record);
      return {
        ...record,
        artifacts: [...record.artifacts, input.artifact],
        events: [
          ...record.events,
          { event: "artifact-added", timestamp: new Date().toISOString() },
        ],
      };
    },
  });
  await log({
    canonicalTaskId,
    event: "artifact_added",
    level: "info",
    module: "core",
    runId: record.runId,
    runtime: input.runtime,
  });
  return record;
}

async function done(input: {
  readonly runtime: Runtime;
  readonly task: string;
  readonly outcome: "delivered" | "failed" | "stopped";
  readonly message?: string | undefined;
  readonly allowDirty: boolean;
}): Promise<RunRecord> {
  const { runtime } = input;
  const canonicalTaskId = await resolveRunIdentity({ query: input.task, runtime });
  const observed = await runtime.workspaces.observe({ slug: taskSlug({ canonicalTaskId }) });
  if (input.outcome === "delivered" && !input.allowDirty && observed.dirtyPaths.length > 0) {
    throw new DirtyWorkspaceError(observed.dirtyPaths);
  }
  let record = await runtime.runs.mutate({
    canonicalTaskId,
    update: async (current) => {
      requireRunningRun(current);
      await runtime.workspaces.assertNoActiveRepositoryOperation({
        workspaceDirectory: current.workspaceDirectory,
      });
      return {
        ...completeRecord({ outcome: input.outcome, record: current }),
        message: input.message,
        writebackPending: true,
      };
    },
  });
  await log({
    canonicalTaskId,
    event: "run_completed",
    level: "info",
    module: "core",
    runId: record.runId,
    runtime,
  });
  const presenter = presenterFor({
    environment: runtime.environment,
    name: runtime.config.presenter,
  });
  await presenter.setStatus?.({ name: record.presentedWorkspaceName, text: input.outcome });
  record = await writeCompletion({ record, runtime });
  if (record.writebackPending === true) {
    throw new Error("completion saved locally; source writeback is pending and will be retried");
  }
  return record;
}

async function repoAdd(input: {
  readonly runtime: Runtime;
  readonly task: string;
  readonly repository: string;
}): Promise<RunRecord> {
  const canonicalTaskId = await resolveRunIdentity({ query: input.task, runtime: input.runtime });
  const slug = taskSlug({ canonicalTaskId });
  const processId = process.pid;
  let record = await input.runtime.runs.mutate({
    canonicalTaskId,
    update: async (current) => {
      requireRunningRun(current);
      await input.runtime.workspaces.reserveRepositoryOperation({
        processId,
        repository: input.repository,
        workspaceDirectory: current.workspaceDirectory,
      });
      return current;
    },
  });
  try {
    const marker = await input.runtime.workspaces.readMarker({
      workspaceDirectory: record.workspaceDirectory,
    });
    if (marker === undefined) {
      throw new Error(`task marker missing for ${canonicalTaskId}`);
    }
    const updatedMarker = await input.runtime.workspaces.addRepository({
      marker,
      repository: input.repository,
      slug,
    });
    record = await input.runtime.runs.mutate({
      canonicalTaskId,
      update: (current) => {
        requireRunningRun(current);
        return {
          ...current,
          events: [
            ...current.events,
            { event: `repository-added:${input.repository}`, timestamp: new Date().toISOString() },
          ],
          repositories: updatedMarker.repositories,
        };
      },
    });
  } catch (error) {
    if (error instanceof PrepareWorktreeError) {
      record = await failPrepare({
        canonicalTaskId,
        error,
        runtime: input.runtime,
      });
    }
    throw error;
  } finally {
    await input.runtime.workspaces.finishRepositoryOperation({
      processId,
      workspaceDirectory: record.workspaceDirectory,
    });
  }
  await log({
    canonicalTaskId,
    event: "repository_added",
    level: "info",
    module: "core",
    repository: input.repository,
    runId: record.runId,
    runtime: input.runtime,
  });
  return record;
}

async function cleanup(input: {
  readonly runtime: Runtime;
  readonly task?: string | undefined;
  readonly all: boolean;
  readonly allowDirty: boolean;
}): Promise<{
  readonly cleaned: readonly string[];
  readonly preservedBranches: readonly string[];
}> {
  const { runtime } = input;
  let records = await runtime.runs.list();
  if (!input.all) {
    if (input.task === undefined) {
      throw new Error("cleanup requires a task or --all");
    }
    const canonicalTaskId = await resolveRunIdentity({ query: input.task, runtime });
    records = records.filter((record) => record.canonicalTaskId === canonicalTaskId);
  }
  const cleaned: string[] = [];
  const preservedBranches: string[] = [];
  for (let record of records) {
    const slug = taskSlug({ canonicalTaskId: record.canonicalTaskId });
    // Check dirty state before stopping a running task.
    // eslint-disable-next-line no-await-in-loop
    const observed = await runtime.workspaces.observe({ slug });
    if (!input.allowDirty && observed.dirtyPaths.length > 0) {
      throw new DirtyWorkspaceError(observed.dirtyPaths);
    }
    // The operation check must run under the same run lock as repository reservation, including
    // for a run that reconciliation completed while acquisition was still active.
    // eslint-disable-next-line no-await-in-loop
    let stoppedNow = false;
    record = await runtime.runs.mutate({
      canonicalTaskId: record.canonicalTaskId,
      update: async (current) => {
        await runtime.workspaces.assertNoActiveRepositoryOperation({
          workspaceDirectory: current.workspaceDirectory,
        });
        if (current.state === "complete") {
          return current;
        }
        stoppedNow = true;
        return {
          ...completeRecord({ outcome: "stopped", record: current }),
          writebackPending: true,
        };
      },
    });
    if (stoppedNow || record.writebackPending === true) {
      // eslint-disable-next-line no-await-in-loop
      record = await writeCompletion({ record, runtime });
    }
    const presenter = presenterFor({
      environment: runtime.environment,
      name: runtime.config.presenter,
    });
    // Presenter closes before its underlying directories disappear.
    // eslint-disable-next-line no-await-in-loop
    await presenter.close({ name: record.presentedWorkspaceName });
    // eslint-disable-next-line no-await-in-loop
    const result = await runtime.workspaces.cleanup({ allowDirty: input.allowDirty, slug });
    preservedBranches.push(...result.preservedBranches);
    if (record.writebackPending !== true) {
      // eslint-disable-next-line no-await-in-loop
      await runtime.runs.remove({ canonicalTaskId: record.canonicalTaskId });
    }
    // eslint-disable-next-line no-await-in-loop
    await log({
      canonicalTaskId: record.canonicalTaskId,
      event: "cleanup_completed",
      level: "info",
      module: "core",
      runId: record.runId,
      runtime,
    });
    cleaned.push(record.canonicalTaskId);
  }
  return { cleaned, preservedBranches };
}

async function reconcile(input: { readonly runtime: Runtime }): Promise<void> {
  const { runtime } = input;
  const records = await runtime.runs.list();
  if (records.length === 0) {
    return;
  }
  const presenter = presenterFor({
    environment: runtime.environment,
    name: runtime.config.presenter,
  });
  const probe = await presenter.probe();
  for (let record of records) {
    const slug = taskSlug({ canonicalTaskId: record.canonicalTaskId });
    // Dead in-session acquisition processes leave a recoverable marker that reconciliation clears.
    // eslint-disable-next-line no-await-in-loop
    record = await runtime.runs.mutate({
      canonicalTaskId: record.canonicalTaskId,
      update: async (current) => {
        await runtime.workspaces.clearDeadRepositoryOperation({
          workspaceDirectory: current.workspaceDirectory,
        });
        return current;
      },
    });
    // Marker repositories are authoritative after runtime acquisition.
    // eslint-disable-next-line no-await-in-loop
    const marker = await runtime.workspaces.readMarker({
      workspaceDirectory: record.workspaceDirectory,
    });
    if (marker !== undefined && !sameStrings(marker.repositories, record.repositories)) {
      // eslint-disable-next-line no-await-in-loop
      record = await runtime.runs.mutate({
        canonicalTaskId: record.canonicalTaskId,
        update: (current) => ({ ...current, repositories: marker.repositories }),
      });
      // eslint-disable-next-line no-await-in-loop
      await log({
        canonicalTaskId: record.canonicalTaskId,
        event: "run_repaired",
        level: "info",
        module: "core",
        runId: record.runId,
        runtime,
      });
    }
    if (record.writebackPending === true) {
      // eslint-disable-next-line no-await-in-loop
      record = await writeCompletion({ record, runtime });
    }
    if (!probe.available || record.state === "complete") {
      continue;
    }
    const exists = probe.workspaces.some(
      (workspace) =>
        workspace.name === record.presentedWorkspaceName ||
        workspace.description === record.presentedWorkspaceName ||
        workspace.description === `groundcrew:${record.canonicalTaskId}`,
    );
    if (record.state === "provisioning" && exists) {
      let reconciledNow = false;
      // eslint-disable-next-line no-await-in-loop
      const running = await runtime.runs.mutate({
        canonicalTaskId: record.canonicalTaskId,
        update: (current) => {
          if (current.state !== "provisioning") {
            return current;
          }
          reconciledNow = true;
          return transition({ event: "running", record: current, state: "running" });
        },
      });
      if (reconciledNow) {
        // eslint-disable-next-line no-await-in-loop
        await log({
          canonicalTaskId: running.canonicalTaskId,
          event: "run_reconciled",
          level: "info",
          module: "core",
          runId: running.runId,
          runtime,
        });
      }
    } else if (!exists) {
      const reason =
        record.state === "provisioning" ? "provisioning-interrupted" : "workspace-missing";
      // eslint-disable-next-line no-await-in-loop
      let failedNow = false;
      const failed = await runtime.runs.mutate({
        canonicalTaskId: record.canonicalTaskId,
        update: (current) => {
          if (current.state === "complete") {
            return current;
          }
          failedNow = true;
          return {
            ...completeRecord({ outcome: "failed", reason, record: current }),
            writebackPending: true,
          };
        },
      });
      if (failedNow) {
        // eslint-disable-next-line no-await-in-loop
        await log({
          canonicalTaskId: failed.canonicalTaskId,
          event: "run_failed",
          level: "error",
          module: "core",
          runId: failed.runId,
          runtime,
        });
        // eslint-disable-next-line no-await-in-loop
        await writeCompletion({ record: failed, runtime });
      }
    }
    // Observe on every reconciliation so corrupt/missing worktrees fail loudly without mutation.
    // eslint-disable-next-line no-await-in-loop
    await runtime.workspaces.observe({ slug });
  }
}

async function reapTerminalTasks(input: {
  readonly runtime: Runtime;
  readonly tasks: readonly Task[];
}): Promise<void> {
  const terminal = new Set(
    input.tasks.filter((task) => task.terminal).map((task) => canonicalId({ task })),
  );
  for (const record of await input.runtime.runs.list()) {
    if (!terminal.has(record.canonicalTaskId)) {
      continue;
    }
    const slug = taskSlug({ canonicalTaskId: record.canonicalTaskId });
    // eslint-disable-next-line no-await-in-loop
    const observed = await input.runtime.workspaces.observe({ slug });
    if (observed.dirtyPaths.length > 0) {
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    await cleanup({
      allowDirty: false,
      all: false,
      runtime: input.runtime,
      task: record.canonicalTaskId,
    });
  }
}

async function writeCompletion(input: {
  readonly runtime: Runtime;
  readonly record: RunRecord;
}): Promise<RunRecord> {
  const { record, runtime } = input;
  if (record.outcome === undefined) {
    return record;
  }
  const result = await runtime.registry.update({
    canonicalTaskId: record.canonicalTaskId,
    event: {
      artifacts: record.artifacts,
      message: record.message,
      outcome: record.outcome,
      type: "completed",
    },
  });
  if (!result.ok || result.data.result === "rejected") {
    await log({
      canonicalTaskId: record.canonicalTaskId,
      event: "writeback_pending",
      level: "warn",
      module: "core",
      runId: record.runId,
      runtime,
    });
    return record;
  }
  const updated = await runtime.runs.mutate({
    canonicalTaskId: record.canonicalTaskId,
    update: (current) => ({ ...current, writebackPending: false }),
  });
  await log({
    canonicalTaskId: record.canonicalTaskId,
    event: "writeback_completed",
    level: "info",
    module: "core",
    runId: record.runId,
    runtime,
  });
  return updated;
}

async function resolveRunIdentity(input: {
  readonly query: string;
  readonly runtime: Runtime;
}): Promise<string> {
  const records = await input.runtime.runs.list();
  const matches = records.filter(
    (record) =>
      record.canonicalTaskId === input.query ||
      record.canonicalTaskId.slice(record.canonicalTaskId.indexOf(":") + 1) === input.query,
  );
  const match = matches.at(0);
  if (matches.length !== 1 || match === undefined) {
    throw new Error(`could not resolve exactly one run for ${input.query}`);
  }
  return match.canonicalTaskId;
}

function requireRunningRun(record: RunRecord): void {
  if (record.state !== "running") {
    throw new Error(
      `run ${record.runId} is ${record.state}; in-session commands require a running run`,
    );
  }
}

async function resolveExplicitTask(input: {
  readonly query: string;
  readonly registry: SourceRegistry;
}): Promise<Task> {
  if (input.query.includes(":")) {
    const result = await input.registry.get({ canonicalTaskId: input.query });
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    return result.data.task;
  }
  const matches: Task[] = [];
  for (const sourceName of input.registry.sourceNames()) {
    // Sources are queried independently to disambiguate a source-local task ID.
    // eslint-disable-next-line no-await-in-loop
    const result = await input.registry.get({ canonicalTaskId: `${sourceName}:${input.query}` });
    if (result.ok) {
      matches.push(result.data.task);
    }
  }
  const match = matches.at(0);
  if (matches.length !== 1 || match === undefined) {
    throw new Error(`could not resolve exactly one task for ${input.query}`);
  }
  return match;
}

function canonicalId(input: { readonly task: Task }): string {
  return `${input.task.sourceName}:${input.task.id}`;
}

function transition(input: {
  readonly record: RunRecord;
  readonly state: "running";
  readonly event: string;
}): RunRecord {
  if (input.record.state !== "provisioning") {
    throw new Error(`cannot transition ${input.record.state} run ${input.record.runId} to running`);
  }
  return {
    ...input.record,
    events: [...input.record.events, { event: input.event, timestamp: new Date().toISOString() }],
    state: input.state,
  };
}

function completeRecord(input: {
  readonly record: RunRecord;
  readonly outcome: "delivered" | "failed" | "stopped";
  readonly reason?: string | undefined;
}): RunRecord {
  if (input.record.state === "complete") {
    throw new Error(`run ${input.record.runId} is already complete`);
  }
  return {
    ...input.record,
    events: [
      ...input.record.events,
      { event: `complete:${input.outcome}`, timestamp: new Date().toISOString() },
    ],
    outcome: input.outcome,
    reason: input.reason,
    state: "complete",
  };
}

async function failPrepare(input: {
  readonly canonicalTaskId: string;
  readonly error: PrepareWorktreeError;
  readonly runtime: Runtime;
}): Promise<RunRecord> {
  const reason = prepareFailureReason(input.error);
  let failedNow = false;
  let record = await input.runtime.runs.mutate({
    canonicalTaskId: input.canonicalTaskId,
    update: (current) => {
      if (current.state === "complete") {
        return current;
      }
      failedNow = true;
      return {
        ...completeRecord({ outcome: "failed", reason, record: current }),
        writebackPending: true,
      };
    },
  });
  if (!failedNow) {
    return record;
  }
  await log({
    canonicalTaskId: input.canonicalTaskId,
    event: "run_failed",
    level: "error",
    module: "core",
    repository: input.error.repository,
    runId: record.runId,
    runtime: input.runtime,
  });
  record = await writeCompletion({ record, runtime: input.runtime });
  return record;
}

function prepareFailureReason(error: PrepareWorktreeError): string {
  return `prepare-failed:${error.repository}: ${error.command}`;
}

async function readVerdicts(input: {
  readonly runtime: Runtime;
}): Promise<Record<string, Verdict>> {
  try {
    return JSON.parse(
      await readFile(join(input.runtime.paths.stateRoot, "dispatch.json"), "utf8"),
    ) as Record<string, Verdict>;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

async function writeVerdict(input: {
  readonly runtime: Runtime;
  readonly canonicalTaskId: string;
  readonly reason: VerdictReason;
  readonly detail: string;
  readonly runId?: string | undefined;
}): Promise<void> {
  const path = join(input.runtime.paths.stateRoot, "dispatch.json");
  await withFileLock({
    path: `${path}.lock`,
    operation: async () => {
      const verdicts = await readVerdicts({ runtime: input.runtime });
      verdicts[input.canonicalTaskId] = {
        detail: input.detail,
        reason: input.reason,
        timestamp: new Date().toISOString(),
      };
      await atomicWrite({ path, value: `${JSON.stringify(verdicts, undefined, 2)}\n` });
    },
  });
  await log({
    canonicalTaskId: input.canonicalTaskId,
    event: "dispatch_verdict",
    level: "warn",
    module: "core",
    runId: input.runId,
    runtime: input.runtime,
  });
}

async function clearVerdict(input: {
  readonly runtime: Runtime;
  readonly canonicalTaskId: string;
}): Promise<void> {
  const path = join(input.runtime.paths.stateRoot, "dispatch.json");
  await withFileLock({
    path: `${path}.lock`,
    operation: async () => {
      const verdicts = await readVerdicts({ runtime: input.runtime });
      if (!(input.canonicalTaskId in verdicts)) {
        return;
      }
      delete verdicts[input.canonicalTaskId];
      await atomicWrite({ path, value: `${JSON.stringify(verdicts, undefined, 2)}\n` });
    },
  });
}

async function log(input: {
  readonly runtime: Runtime;
  readonly level: "debug" | "info" | "warn" | "error";
  readonly module: string;
  readonly event: string;
  readonly canonicalTaskId?: string | undefined;
  readonly repository?: string | undefined;
  readonly runId?: string | undefined;
}): Promise<void> {
  const path =
    input.runtime.config.logging.file ?? join(input.runtime.paths.stateRoot, "groundcrew.jsonl");
  await withFileLock({
    path: `${path}.lock`,
    operation: async () => {
      await mkdir(dirname(path), { recursive: true });
      try {
        const metadata = await stat(path);
        if (metadata.size >= 10 * 1024 * 1024) {
          await rm(`${path}.3`, { force: true });
          for (const number of [2, 1]) {
            // Log rotation is intentionally newest-to-oldest.
            // eslint-disable-next-line no-await-in-loop
            await rename(`${path}.${number}`, `${path}.${number + 1}`).catch(() => {});
          }
          await rename(path, `${path}.1`);
        }
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
          throw error;
        }
      }
      await appendFile(
        path,
        `${JSON.stringify({
          canonicalTaskId: input.canonicalTaskId,
          event: input.event,
          level: input.level,
          module: input.module,
          repository: input.repository,
          runId: input.runId,
          sourceName: input.canonicalTaskId?.slice(0, input.canonicalTaskId.indexOf(":")),
          timestamp: new Date().toISOString(),
        })}\n`,
      );
    },
  });
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

async function commandExists(input: {
  readonly command: string;
  readonly environment: NodeJS.ProcessEnv;
}): Promise<boolean> {
  const result = await execa("/usr/bin/env", ["which", input.command], {
    env: input.environment,
    reject: false,
  });
  return result.exitCode === 0;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
