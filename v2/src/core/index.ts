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
  RunModule,
  completedRunRefusal,
  mintRunId,
  taskSlug,
  withFileLock,
  type AgentProfile,
  type Artifact,
  type CompletedRun,
  type RunHandle,
  type RunRecord,
  type RunningRun,
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

export interface DoctorInput {
  readonly onPrerequisiteChecks?: ((checks: readonly HealthCheck[]) => void) | undefined;
}

export interface DispatchSlotOccupant {
  readonly canonicalTaskId: string;
  readonly agentProfile: string;
}

export type DispatchProgress =
  | {
      readonly type: "slots";
      readonly active: readonly DispatchSlotOccupant[];
      readonly maximum: number;
      readonly force: boolean;
    }
  | {
      readonly type: "dispatching";
      readonly canonicalTaskId: string;
      readonly agentProfile: string;
      readonly slot: number;
      readonly maximum: number;
      readonly forced: boolean;
    }
  | {
      readonly type: "previewing";
      readonly canonicalTaskId: string;
      readonly agentProfile: string;
      readonly slot: number;
      readonly maximum: number;
      readonly forced: boolean;
    }
  | {
      readonly type: "skipped";
      readonly canonicalTaskId: string;
      readonly detail: string;
      readonly reason: VerdictReason;
    }
  | {
      readonly type: "cleaning";
      readonly canonicalTaskId: string;
    };

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
  doctor(input?: DoctorInput): Promise<DoctorResult>;
  start(input: {
    readonly task?: string | undefined;
    readonly force: boolean;
    readonly dryRun: boolean;
    readonly agent?: string | undefined;
    readonly onProgress?: ((progress: DispatchProgress) => void) | undefined;
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
  continueRun(input: { readonly task: string; readonly force: boolean }): Promise<RunRecord>;
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
  readonly runs: RunModule;
  readonly workspaces: WorkspaceService;
}

interface SkipTaskInput {
  readonly canonicalTaskId: string;
  readonly detail: string;
  readonly reason: VerdictReason;
  readonly runId?: string | undefined;
}

interface PrepareTerminalRunsForCleanupInput {
  readonly runtime: Runtime;
  readonly tasks: readonly Task[];
}

interface ReapTerminalTasksInput {
  readonly onProgress?: ((progress: DispatchProgress) => void) | undefined;
  readonly runs: readonly CompletedRun[];
  readonly runtime: Runtime;
}

export async function createApplication(input: {
  readonly config: CoreConfig;
  readonly paths: ApplicationPaths;
  readonly environment: NodeJS.ProcessEnv;
  readonly reconcileOnCreate?: boolean | undefined;
}): Promise<Application> {
  const { config, environment, paths } = input;
  const registry = await SourceRegistry.create({
    configHome: paths.configHome,
    environment,
    instances: config.sources,
    packageRoot: paths.packageRoot,
  });
  const runs = new RunModule({
    environment,
    presenterName: config.presenter,
    stateRoot: paths.stateRoot,
  });
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
  if (input.reconcileOnCreate !== false) {
    await reconcile({ runtime });
  }
  return {
    async doctor(doctorInput = {}): Promise<DoctorResult> {
      return await doctor({ ...doctorInput, runtime });
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
    async continueRun(continueInput): Promise<RunRecord> {
      return await continueRun({ ...continueInput, runtime });
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

async function doctor(input: DoctorInput & { readonly runtime: Runtime }): Promise<DoctorResult> {
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
  input.onPrerequisiteChecks?.(checks);
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
  readonly dryRun: boolean;
  readonly agent?: string | undefined;
  readonly onProgress?: ((progress: DispatchProgress) => void) | undefined;
}): Promise<{ readonly started: readonly string[]; readonly skipped: readonly string[] }> {
  const { runtime } = input;
  if (!input.dryRun) {
    await reconcile({ runtime });
  }
  const listed = await runtime.registry.list();
  if (!listed.ok) {
    throw new Error(listed.error.message);
  }
  const terminalRunsToClean = input.dryRun
    ? []
    : await prepareTerminalRunsForCleanup({ runtime, tasks: listed.data.tasks });
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
  async function skipTask(skipInput: SkipTaskInput): Promise<void> {
    if (!input.dryRun) {
      await writeVerdict({ ...skipInput, runtime });
    }
    input.onProgress?.({
      canonicalTaskId: skipInput.canonicalTaskId,
      detail: skipInput.detail,
      reason: skipInput.reason,
      type: "skipped",
    });
    skipped.push(skipInput.canonicalTaskId);
  }
  const activeRuns = input.dryRun
    ? await listActiveAfterPreviewReconciliation({ runtime, tasks: listed.data.tasks })
    : await runtime.runs.list();
  const active = activeRuns
    .filter((run) => run.state === "provisioning" || run.state === "running")
    .map((run) => ({
      agentProfile: run.record.agentProfile,
      canonicalTaskId: run.record.canonicalTaskId,
    }));
  input.onProgress?.({
    active,
    force: input.force,
    maximum: runtime.config.orchestrator.maximumInProgress,
    type: "slots",
  });
  let previewedCount = 0;
  for (const task of tasks) {
    const canonicalTaskId = canonicalId({ task });
    const slug = taskSlug({ canonicalTaskId });
    const existing = await runtime.runs.findBySlug({ slug });
    if (existing !== undefined) {
      const reason: VerdictReason =
        existing.record.canonicalTaskId === canonicalTaskId ? "run-exists" : "slug-collision";
      await skipTask({ canonicalTaskId, detail: existing.record.canonicalTaskId, reason });
      continue;
    }
    if (task.terminal) {
      await skipTask({
        canonicalTaskId,
        detail: "source reports the task as terminal",
        reason: "terminal",
      });
      continue;
    }
    if (task.blocked && !input.force) {
      await skipTask({
        canonicalTaskId,
        detail: "task reports an open blocker",
        reason: "blocked",
      });
      continue;
    }
    const profileName =
      input.agent ??
      task.agentProfile ??
      runtime.registry.sourceDefaultProfile({ sourceName: task.sourceName }) ??
      runtime.config.agents.default;
    const profile = runtime.config.agents.profiles[profileName];
    if (profile === undefined) {
      await skipTask({
        canonicalTaskId,
        detail: profileName,
        reason: "agent-unavailable",
      });
      continue;
    }
    if (!(await commandExists({ command: profile.kind, environment: runtime.environment }))) {
      await skipTask({
        canonicalTaskId,
        detail: `missing harness executable ${profile.kind}`,
        reason: "agent-unavailable",
      });
      continue;
    }
    const repositoryCheck = await runtime.workspaces.validateRepositories({
      repositories: task.repositories,
      slug,
    });
    if (!repositoryCheck.ok) {
      await skipTask({
        canonicalTaskId,
        detail: repositoryCheck.missing.join(", "),
        reason: "repo-not-on-disk",
      });
      if (input.task !== undefined) {
        throw new RepositoryMissingError(repositoryCheck.missing);
      }
      continue;
    }
    if (input.dryRun) {
      const activeCount = active.length + previewedCount;
      if (!input.force && activeCount >= runtime.config.orchestrator.maximumInProgress) {
        await skipTask({
          canonicalTaskId,
          detail: "concurrency limit reached",
          reason: "slots-full",
        });
        continue;
      }
      input.onProgress?.({
        agentProfile: profileName,
        canonicalTaskId,
        forced: input.force && activeCount >= runtime.config.orchestrator.maximumInProgress,
        maximum: runtime.config.orchestrator.maximumInProgress,
        slot: activeCount + 1,
        type: "previewing",
      });
      previewedCount += 1;
      continue;
    }
    const workspaceDirectory = runtime.workspaces.workspaceDirectory({ slug });
    const reservation = await runtime.runs.reserveDispatch({
      agentProfile: profileName,
      canonicalTaskId,
      force: input.force,
      maximumInProgress: runtime.config.orchestrator.maximumInProgress,
      repositories: task.repositories,
      workspaceDirectory,
    });
    if (reservation.type === "full") {
      await skipTask({
        canonicalTaskId,
        detail: "concurrency limit reached",
        reason: "slots-full",
      });
      continue;
    }
    const provisioning = reservation.run;
    const claim = await runtime.registry.update({
      canonicalTaskId,
      event: { runId: provisioning.record.runId, type: "claimed" },
    });
    if (!claim.ok || claim.data.result === "rejected") {
      await provisioning.discardUnclaimed();
      const detail = claim.ok
        ? (claim.data.reason ?? "source rejected claim")
        : claim.error.message;
      await skipTask({
        canonicalTaskId,
        detail,
        reason: "claim-rejected",
        runId: provisioning.record.runId,
      });
      continue;
    }
    input.onProgress?.({
      agentProfile: profileName,
      canonicalTaskId,
      forced:
        input.force && reservation.activeCount >= runtime.config.orchestrator.maximumInProgress,
      maximum: runtime.config.orchestrator.maximumInProgress,
      slot: reservation.activeCount + 1,
      type: "dispatching",
    });
    try {
      const marker = await runtime.workspaces.provision({
        canonicalTaskId,
        repositories: task.repositories,
        slug,
      });
      const launched = await provisioning.launch({
        acquiredRepositories: marker.repositories,
        branch: marker.branch,
        profile,
        task: {
          canonicalTaskId,
          description: task.description,
          repositories: task.repositories,
          title: task.title,
        },
      });
      await clearVerdict({ canonicalTaskId, runtime });
      if (!launched.transitioned) {
        continue;
      }
      await log({
        canonicalTaskId,
        event: "run_started",
        level: "info",
        module: "core",
        runId: launched.run.record.runId,
        runtime,
      });
      started.push(canonicalTaskId);
    } catch (error) {
      const reason =
        error instanceof PrepareWorktreeError ? prepareFailureReason(error) : errorMessage(error);
      const failed = await provisioning.fail({ reason });
      if (failed.transitioned) {
        await log({
          canonicalTaskId,
          event: "run_failed",
          level: "error",
          module: "core",
          runId: failed.run.record.runId,
          runtime,
        });
        await writeCompletion({ run: failed.run, runtime });
      }
      if (input.task !== undefined) {
        throw error;
      }
    }
  }
  if (!input.dryRun) {
    await reapTerminalTasks({
      onProgress: input.onProgress,
      runs: terminalRunsToClean,
      runtime,
    });
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
    ...runs.map((run) => run.record.canonicalTaskId),
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
  const entries = await Promise.all(
    selected.toSorted().map(async (canonicalTaskId): Promise<StatusEntry> => {
      const run = runs.find((candidate) => candidate.record.canonicalTaskId === canonicalTaskId);
      const record = run?.record;
      const observed =
        record === undefined
          ? undefined
          : await runtime.workspaces.observe({ slug: taskSlug({ canonicalTaskId }) });
      const accessHint = run?.state === "running" ? await run.accessHint() : undefined;
      return {
        accessHint,
        canonicalTaskId,
        cleanup: {
          refusesForDirtyPaths: observed?.dirtyPaths ?? [],
          wouldRemove: observed?.repositories.map((repository) => repository.path) ?? [],
        },
        observed,
        reported: {
          artifacts: record?.artifacts ?? [],
          outcome: record?.outcome,
          reason: record?.reason,
        },
        run: record,
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
  const run = await input.runtime.runs.resolve({ query: input.task });
  requireRunningRun(run);
  const updated = await run.reportArtifact({ artifact: input.artifact });
  await log({
    canonicalTaskId: updated.record.canonicalTaskId,
    event: "artifact_added",
    level: "info",
    module: "core",
    runId: updated.record.runId,
    runtime: input.runtime,
  });
  return updated.record;
}

async function done(input: {
  readonly runtime: Runtime;
  readonly task: string;
  readonly outcome: "delivered" | "failed" | "stopped";
  readonly message?: string | undefined;
  readonly allowDirty: boolean;
}): Promise<RunRecord> {
  const { runtime } = input;
  const run = await runtime.runs.resolve({ query: input.task });
  requireRunningRun(run);
  const canonicalTaskId = run.record.canonicalTaskId;
  const observed = await runtime.workspaces.observe({ slug: taskSlug({ canonicalTaskId }) });
  if (input.outcome === "delivered" && !input.allowDirty && observed.dirtyPaths.length > 0) {
    throw new DirtyWorkspaceError(observed.dirtyPaths);
  }
  let completed = await run.finish({
    assertWorkspaceIdle: workspaceIdleAssertion({ runtime }),
    message: input.message,
    outcome: input.outcome,
  });
  await log({
    canonicalTaskId,
    event: "run_completed",
    level: "info",
    module: "core",
    runId: completed.record.runId,
    runtime,
  });
  await completed.setPresentedStatus();
  completed = await writeCompletion({ run: completed, runtime });
  if (completed.record.writebackPending === true) {
    throw new Error("completion saved locally; source writeback is pending and will be retried");
  }
  return completed.record;
}

async function repoAdd(input: {
  readonly runtime: Runtime;
  readonly task: string;
  readonly repository: string;
}): Promise<RunRecord> {
  const resolved = await input.runtime.runs.resolve({ query: input.task });
  requireRunningRun(resolved);
  const canonicalTaskId = resolved.record.canonicalTaskId;
  const slug = taskSlug({ canonicalTaskId });
  const processId = process.pid;
  let run = await resolved.reserveRepositoryOperation({
    repository: input.repository,
    reserveWhileLocked: async (record) => {
      await input.runtime.workspaces.reserveRepositoryOperation({
        processId,
        repository: input.repository,
        workspaceDirectory: record.workspaceDirectory,
      });
    },
  });
  try {
    const marker = await input.runtime.workspaces.readMarker({
      workspaceDirectory: run.record.workspaceDirectory,
    });
    if (marker === undefined) {
      throw new Error(`task marker missing for ${canonicalTaskId}`);
    }
    const updatedMarker = await input.runtime.workspaces.addRepository({
      marker,
      repository: input.repository,
      slug,
    });
    run = await run.recordRepositories({
      repositories: updatedMarker.repositories,
      repository: input.repository,
    });
  } catch (error) {
    if (error instanceof PrepareWorktreeError) {
      await failPrepare({
        error,
        run,
        runtime: input.runtime,
      });
    }
    throw error;
  } finally {
    await input.runtime.workspaces.finishRepositoryOperation({
      processId,
      workspaceDirectory: run.record.workspaceDirectory,
    });
  }
  await log({
    canonicalTaskId,
    event: "repository_added",
    level: "info",
    module: "core",
    repository: input.repository,
    runId: run.record.runId,
    runtime: input.runtime,
  });
  return run.record;
}

async function continueRun(input: {
  readonly runtime: Runtime;
  readonly task: string;
  readonly force: boolean;
}): Promise<RunRecord> {
  const { runtime } = input;
  const resolved = await runtime.runs.resolve({ query: input.task });
  if (resolved.state !== "complete") {
    throw new Error(
      `run ${resolved.record.runId} is ${resolved.state}; crew continue resumes a completed run`,
    );
  }
  let run: CompletedRun = resolved;
  const canonicalTaskId = run.record.canonicalTaskId;
  if (run.record.cleanupPending === true) {
    run = await run.recoverAbandonedCleanup();
    if (run.record.cleanupPending === true) {
      throw new Error(`run ${run.record.runId} cleanup is pending`);
    }
  }
  // A pending completion must land under the prior run ID before a new attempt can claim.
  if (run.record.writebackPending === true) {
    run = await writeCompletion({ run, runtime });
    if (run.record.writebackPending === true) {
      throw new Error(
        `run ${run.record.runId} completion writeback is still pending; retry when the source accepts it`,
      );
    }
  }
  if (!(await runtime.runs.presentedWorkspaceExists({ record: run.record }))) {
    throw new Error(
      `presented workspace for ${canonicalTaskId} is gone; run crew cleanup and dispatch again instead`,
    );
  }
  const sourceTask = await runtime.registry.get({ canonicalTaskId });
  if (!sourceTask.ok) {
    throw new Error(sourceTask.error.message);
  }
  if (sourceTask.data.task.terminal) {
    throw new Error(`${canonicalTaskId} is terminal at its source; dispatch a new task instead`);
  }
  const marker = await runtime.workspaces.readMarker({
    workspaceDirectory: run.record.workspaceDirectory,
  });
  if (marker === undefined) {
    throw new Error(`task marker missing for ${canonicalTaskId}`);
  }
  // The local transition commits first, so the source is never told about a continuation
  // that admission (or a concurrent mutation) then refuses; a source rejection reverts it.
  const continuationRunId = mintRunId();
  const running = await run.continueRun({
    continuationRunId,
    force: input.force,
    maximumInProgress: runtime.config.orchestrator.maximumInProgress,
    repositories: marker.repositories,
  });
  const authorized = await runtime.registry.update({
    canonicalTaskId,
    event: { previousRunId: run.record.runId, runId: continuationRunId, type: "continued" },
  });
  if (!authorized.ok || authorized.data.result === "rejected") {
    await runtime.runs.revertContinuation({ continuationRunId, priorRecord: run.record });
    throw new Error(
      authorized.ok
        ? (authorized.data.reason ?? "source rejected the continuation")
        : `source did not accept the continued event (its bundle may predate crew continue): ${authorized.error.message}`,
    );
  }
  await log({
    canonicalTaskId,
    event: "run_continued",
    level: "info",
    module: "core",
    runId: running.record.runId,
    runtime,
  });
  return running.record;
}

function workspaceIdleAssertion(input: {
  readonly runtime: Runtime;
}): (record: Readonly<RunRecord>) => Promise<void> {
  return async (record) => {
    await input.runtime.workspaces.assertNoActiveRepositoryOperation({
      workspaceDirectory: record.workspaceDirectory,
    });
  };
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
  let runs = await runtime.runs.list();
  if (!input.all) {
    if (input.task === undefined) {
      throw new Error("cleanup requires a task or --all");
    }
    runs = [await runtime.runs.resolve({ query: input.task })];
  }
  const cleaned: string[] = [];
  const preservedBranches: string[] = [];
  for (const run of runs) {
    const canonicalTaskId = run.record.canonicalTaskId;
    const slug = taskSlug({ canonicalTaskId });
    // Check dirty state before stopping a running task.
    // eslint-disable-next-line no-await-in-loop
    const observed = await runtime.workspaces.observe({ slug });
    if (!input.allowDirty && observed.dirtyPaths.length > 0) {
      throw cleanupRefusedError({
        canonicalTaskId,
        paths: observed.dirtyPaths,
        query: input.task,
      });
    }
    // The operation check must run under the same run lock as repository reservation, including
    // for a run that reconciliation completed while acquisition was still active.
    // eslint-disable-next-line no-await-in-loop
    const stopped = await run.stopForCleanup({
      assertWorkspaceIdle: workspaceIdleAssertion({ runtime }),
    });
    let completed = stopped.run;
    if (stopped.transitioned || completed.record.writebackPending === true) {
      // eslint-disable-next-line no-await-in-loop
      completed = await writeCompletion({ run: completed, runtime });
    }
    // Presenter closes before its underlying directories disappear.
    // eslint-disable-next-line no-await-in-loop
    await completed.closePresentedWorkspace();
    try {
      // eslint-disable-next-line no-await-in-loop
      const result = await runtime.workspaces.cleanup({
        allowDirty: input.allowDirty,
        record: {
          canonicalTaskId: completed.record.canonicalTaskId,
          pendingRepository: completed.record.pendingRepository,
          repositories: completed.record.repositories,
          workspaceDirectory: completed.record.workspaceDirectory,
        },
        slug,
      });
      preservedBranches.push(...result.preservedBranches);
    } catch (error) {
      if (error instanceof DirtyWorkspaceError) {
        throw cleanupRefusedError({
          canonicalTaskId,
          paths: error.paths,
          query: input.task,
        });
      }
      throw error;
    }
    if (completed.record.writebackPending !== true) {
      // eslint-disable-next-line no-await-in-loop
      await completed.remove();
    }
    // eslint-disable-next-line no-await-in-loop
    await log({
      canonicalTaskId,
      event: "cleanup_completed",
      level: "info",
      module: "core",
      runId: completed.record.runId,
      runtime,
    });
    cleaned.push(canonicalTaskId);
  }
  return { cleaned, preservedBranches };
}

async function reconcile(input: { readonly runtime: Runtime }): Promise<void> {
  const { runtime } = input;
  const runs = await runtime.runs.list();
  if (runs.length === 0) {
    return;
  }
  const presentation = await runtime.runs.capturePresentedWorkspaces();
  for (let run of runs) {
    // Dead in-session acquisition processes leave a recoverable marker that reconciliation clears.
    // eslint-disable-next-line no-await-in-loop
    run = await run.reconcileWorkspaceOperation({
      clearDeadWhileLocked: async (record) => {
        await runtime.workspaces.clearDeadRepositoryOperation({
          workspaceDirectory: record.workspaceDirectory,
        });
      },
    });
    // A marker can recover only a repository that was durably reserved before acquisition.
    // eslint-disable-next-line no-await-in-loop
    const marker = await runtime.workspaces.readMarker({
      workspaceDirectory: run.record.workspaceDirectory,
    });
    if (marker !== undefined) {
      // eslint-disable-next-line no-await-in-loop
      const repaired = await runtime.runs.repairRepositories({
        canonicalTaskId: run.record.canonicalTaskId,
        expectedRunId: run.record.runId,
        repositories: marker.repositories,
      });
      if (repaired.run.record.runId !== run.record.runId) {
        continue;
      }
      run = repaired.run;
      if (repaired.transitioned) {
        // eslint-disable-next-line no-await-in-loop
        await log({
          canonicalTaskId: run.record.canonicalTaskId,
          event: "run_repaired",
          level: "info",
          module: "core",
          runId: run.record.runId,
          runtime,
        });
      }
    }
    if (run.state === "complete" && run.record.writebackPending === true) {
      // eslint-disable-next-line no-await-in-loop
      run = await writeCompletion({ run, runtime });
    }
    // eslint-disable-next-line no-await-in-loop
    const change = await runtime.runs.reconcilePresentedWorkspace({ run, snapshot: presentation });
    if (change !== undefined) {
      // eslint-disable-next-line no-await-in-loop
      await log({
        canonicalTaskId: change.run.record.canonicalTaskId,
        event: change.type === "running" ? "run_reconciled" : "run_failed",
        level: change.type === "running" ? "info" : "error",
        module: "core",
        runId: change.run.record.runId,
        runtime,
      });
      if (change.type === "failed") {
        // eslint-disable-next-line no-await-in-loop
        await change.run.setPresentedStatus();
        // eslint-disable-next-line no-await-in-loop
        await writeCompletion({ run: change.run, runtime });
      }
    }
    // Observe on every reconciliation so corrupt/missing worktrees fail loudly without mutation.
    // eslint-disable-next-line no-await-in-loop
    await runtime.workspaces.observe({
      slug: taskSlug({ canonicalTaskId: run.record.canonicalTaskId }),
    });
  }
}

async function prepareTerminalRunsForCleanup(
  input: PrepareTerminalRunsForCleanupInput,
): Promise<readonly CompletedRun[]> {
  const terminal = new Set(
    input.tasks.filter((task) => task.terminal).map((task) => canonicalId({ task })),
  );
  const prepared: CompletedRun[] = [];
  for (const run of await input.runtime.runs.list()) {
    if (!terminal.has(run.record.canonicalTaskId)) {
      continue;
    }
    const slug = taskSlug({ canonicalTaskId: run.record.canonicalTaskId });
    // eslint-disable-next-line no-await-in-loop
    const observed = await input.runtime.workspaces.observe({ slug });
    if (observed.dirtyPaths.length > 0) {
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const stopped = await run.stopForCleanup({
      assertWorkspaceIdle: workspaceIdleAssertion({ runtime: input.runtime }),
    });
    prepared.push(stopped.run);
  }
  return prepared;
}

async function reapTerminalTasks(input: ReapTerminalTasksInput): Promise<void> {
  for (const run of input.runs) {
    const slug = taskSlug({ canonicalTaskId: run.record.canonicalTaskId });
    // eslint-disable-next-line no-await-in-loop
    const observed = await input.runtime.workspaces.observe({ slug });
    if (observed.dirtyPaths.length > 0) {
      // Keep the presented workspace legible before allowing a later continuation.
      // eslint-disable-next-line no-await-in-loop
      await run.setPresentedStatus();
      // eslint-disable-next-line no-await-in-loop
      await run.cancelCleanup();
      continue;
    }
    input.onProgress?.({ canonicalTaskId: run.record.canonicalTaskId, type: "cleaning" });
    try {
      // eslint-disable-next-line no-await-in-loop
      await cleanup({
        all: false,
        allowDirty: false,
        runtime: input.runtime,
        task: run.record.canonicalTaskId,
      });
    } catch (cleanupError) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await run.cancelCleanup();
      } catch (cancelError) {
        throw new AggregateError(
          [cleanupError, cancelError],
          `cleanup failed for ${run.record.canonicalTaskId} and its reservation could not be released`,
        );
      }
      throw cleanupError;
    }
    // eslint-disable-next-line no-await-in-loop
    await writeVerdict({
      canonicalTaskId: run.record.canonicalTaskId,
      detail: "source reports the task as terminal",
      reason: "terminal",
      runtime: input.runtime,
    });
  }
}

async function listActiveAfterPreviewReconciliation(input: {
  readonly runtime: Runtime;
  readonly tasks: readonly Task[];
}): Promise<readonly RunHandle[]> {
  const active = await input.runtime.runs.listActiveAfterPresentationReconciliation();
  const terminal = new Set(
    input.tasks.filter((task) => task.terminal).map((task) => canonicalId({ task })),
  );
  const remaining: RunHandle[] = [];
  for (const run of active) {
    if (!terminal.has(run.record.canonicalTaskId)) {
      remaining.push(run);
      continue;
    }
    const slug = taskSlug({ canonicalTaskId: run.record.canonicalTaskId });
    // Repository observations stay ordered with lifecycle reconciliation.
    // eslint-disable-next-line no-await-in-loop
    const observed = await input.runtime.workspaces.observe({ slug });
    if (observed.dirtyPaths.length > 0) {
      remaining.push(run);
    }
  }
  return remaining;
}

async function writeCompletion(input: {
  readonly runtime: Runtime;
  readonly run: CompletedRun;
}): Promise<CompletedRun> {
  const { run, runtime } = input;
  const { record } = run;
  if (record.outcome === undefined) {
    return run;
  }
  const result = await runtime.registry.update({
    canonicalTaskId: record.canonicalTaskId,
    event: {
      artifacts: record.artifacts,
      message: record.message,
      outcome: record.outcome,
      runId: record.runId,
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
    return run;
  }
  const completion = record.events.findLast(({ event }) => event.startsWith("complete:"));
  if (completion === undefined) {
    throw new Error(`completion event missing for ${record.canonicalTaskId}`);
  }
  const updated = await run.acknowledgeSourceWriteback({
    expectedCompletionTimestamp: completion.timestamp,
    expectedRunId: record.runId,
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

function requireRunningRun(run: RunHandle): asserts run is RunningRun {
  if (run.state === "complete") {
    throw completedRunRefusal(run.record);
  }
  if (run.state !== "running") {
    throw new Error(
      `run ${run.record.runId} is ${run.state}; in-session commands require a running run`,
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

function cleanupRefusedError(input: {
  readonly canonicalTaskId: string;
  readonly paths: readonly string[];
  readonly query?: string | undefined;
}): Error {
  const task = input.query ?? input.canonicalTaskId;
  return new Error(
    [
      `Cleanup refused because ${input.canonicalTaskId} has uncommitted changes:`,
      ...input.paths.map((path) => `  ${path}`),
      "Review, commit, or stash them. To permanently discard these changes and any unique task-branch commits, rerun:",
      `  crew cleanup ${task} --force`,
    ].join("\n"),
  );
}

async function failPrepare(input: {
  readonly error: PrepareWorktreeError;
  readonly run: RunningRun;
  readonly runtime: Runtime;
}): Promise<CompletedRun> {
  const reason = prepareFailureReason(input.error);
  const failed = await input.run.fail({ reason });
  if (!failed.transitioned) {
    return failed.run;
  }
  await log({
    canonicalTaskId: failed.run.record.canonicalTaskId,
    event: "run_failed",
    level: "error",
    module: "core",
    repository: input.error.repository,
    runId: failed.run.record.runId,
    runtime: input.runtime,
  });
  return await writeCompletion({ run: failed.run, runtime: input.runtime });
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
