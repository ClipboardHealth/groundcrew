import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createPresenter, type Presenter, type PresentedWorkspace } from "../presenter/index.js";

export interface Artifact {
  readonly kind: string;
  readonly locator: string;
  readonly title?: string | undefined;
  readonly repository?: string | undefined;
}

export interface RunEvent {
  readonly timestamp: string;
  readonly event: string;
}

export interface RunRecord {
  readonly version: 1;
  readonly canonicalTaskId: string;
  readonly runId: string;
  readonly agentProfile: string;
  readonly state: "provisioning" | "running" | "complete";
  readonly outcome?: "delivered" | "failed" | "stopped" | undefined;
  readonly reason?: string | undefined;
  readonly message?: string | undefined;
  readonly writebackPending?: boolean | undefined;
  readonly presenter: "cmux";
  readonly presentedWorkspaceName: string;
  readonly workspaceDirectory: string;
  readonly repositories: readonly string[];
  readonly pendingRepository?: string | undefined;
  readonly artifacts: readonly Artifact[];
  readonly events: readonly RunEvent[];
}

export interface AgentProfile {
  readonly kind: "claude" | "codex";
  readonly model?: string | undefined;
  readonly effort: "low" | "medium" | "high" | "xhigh" | "max";
}

export interface LaunchTask {
  readonly canonicalTaskId: string;
  readonly title: string;
  readonly description?: string | undefined;
  readonly repositories: readonly string[];
}

export interface RunChange<T extends RunHandle> {
  readonly run: T;
  readonly transitioned: boolean;
}

export interface BaseRun {
  readonly record: Readonly<RunRecord>;
  readonly state: RunRecord["state"];

  stopForCleanup(input: {
    readonly assertWorkspaceIdle: (record: Readonly<RunRecord>) => Promise<void>;
  }): Promise<RunChange<CompletedRun>>;
  reconcileWorkspaceOperation(input: {
    readonly clearDeadWhileLocked: (record: Readonly<RunRecord>) => Promise<void>;
  }): Promise<RunHandle>;
}

export interface ProvisioningRun extends BaseRun {
  readonly state: "provisioning";

  fail(input: { readonly reason: string }): Promise<RunChange<CompletedRun>>;
  discardUnclaimed(): Promise<void>;
  launch(input: {
    readonly task: LaunchTask;
    readonly profile: AgentProfile;
    readonly branch: string;
    readonly acquiredRepositories: readonly string[];
  }): Promise<RunChange<RunningRun>>;
}

export interface RunningRun extends BaseRun {
  readonly state: "running";

  reportArtifact(input: { readonly artifact: Artifact }): Promise<RunningRun>;
  finish(input: {
    readonly outcome: "delivered" | "failed" | "stopped";
    readonly message?: string | undefined;
    readonly assertWorkspaceIdle: (record: Readonly<RunRecord>) => Promise<void>;
  }): Promise<CompletedRun>;
  fail(input: { readonly reason: string }): Promise<RunChange<CompletedRun>>;
  reserveRepositoryOperation(input: {
    readonly repository: string;
    readonly reserveWhileLocked: (record: Readonly<RunRecord>) => Promise<void>;
  }): Promise<RunningRun>;
  recordRepositories(input: {
    readonly repository: string;
    readonly repositories: readonly string[];
  }): Promise<RunningRun>;
  accessHint(): Promise<string | undefined>;
}

export interface CompletedRun extends BaseRun {
  readonly state: "complete";

  acknowledgeSourceWriteback(input: {
    readonly expectedRunId: string;
    readonly expectedCompletionTimestamp: string;
  }): Promise<CompletedRun>;
  setPresentedStatus(): Promise<void>;
  closePresentedWorkspace(): Promise<void>;
  remove(): Promise<void>;
}

export type RunHandle = ProvisioningRun | RunningRun | CompletedRun;

export type PresentationChange =
  | { readonly type: "running"; readonly run: RunningRun }
  | {
      readonly type: "failed";
      readonly run: CompletedRun;
      readonly reason: "provisioning-interrupted" | "workspace-missing";
    };

const presentedWorkspaceSnapshot = Symbol("presentedWorkspaceSnapshot");

export interface PresentedWorkspaceSnapshot {
  readonly [presentedWorkspaceSnapshot]: {
    readonly available: boolean;
    readonly workspaces: readonly PresentedWorkspace[];
  };
}

export class RunModule {
  readonly #store: RunStore;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #presenterName: "cmux";
  readonly #presenter: Presenter;

  public constructor(input: {
    readonly stateRoot: string;
    readonly environment: NodeJS.ProcessEnv;
    readonly presenterName: "cmux";
  }) {
    this.#store = new RunStore({ stateRoot: input.stateRoot });
    this.#environment = input.environment;
    this.#presenterName = input.presenterName;
    this.#presenter = createPresenter({
      environment: input.environment,
      name: input.presenterName,
    });
  }

  public async beginDispatch(input: {
    readonly canonicalTaskId: string;
    readonly agentProfile: string;
    readonly workspaceDirectory: string;
    readonly repositories: readonly string[];
  }): Promise<ProvisioningRun> {
    const record = await this.#store.create(input);
    return new ProvisioningRunHandle({ module: this, record });
  }

  public async findBySlug(input: { readonly slug: string }): Promise<RunHandle | undefined> {
    const record = await this.#store.getBySlug(input);
    return record === undefined ? undefined : createRunHandle({ module: this, record });
  }

  public async resolve(input: { readonly query: string }): Promise<RunHandle> {
    const normalizedQuery = input.query.toLowerCase();
    const matches = (await this.#store.list()).filter((record) => {
      const canonicalTaskId = record.canonicalTaskId.toLowerCase();
      return (
        canonicalTaskId === normalizedQuery ||
        canonicalTaskId.slice(canonicalTaskId.indexOf(":") + 1) === normalizedQuery
      );
    });
    const match = matches.at(0);
    if (match === undefined) {
      throw new Error(`No local run matches ${input.query}. Run crew status to list local runs.`);
    }
    if (matches.length > 1) {
      throw new Error(
        `Multiple local runs match ${input.query}: ${matches.map((record) => record.canonicalTaskId).join(", ")}. Retry with a canonical task ID.`,
      );
    }
    return createRunHandle({ module: this, record: match });
  }

  public async list(): Promise<readonly RunHandle[]> {
    return (await this.#store.list()).map((record) => createRunHandle({ module: this, record }));
  }

  public async capturePresentedWorkspaces(): Promise<PresentedWorkspaceSnapshot> {
    const probe = await this.#presenter.probe();
    return { [presentedWorkspaceSnapshot]: probe };
  }

  public async reconcilePresentedWorkspace(input: {
    readonly run: RunHandle;
    readonly snapshot: PresentedWorkspaceSnapshot;
  }): Promise<PresentationChange | undefined> {
    const probe = input.snapshot[presentedWorkspaceSnapshot];
    if (!probe.available || input.run.state === "complete") {
      return undefined;
    }
    const expected = input.run.record;
    const presented = probe.workspaces.some(
      (workspace) =>
        workspace.name === expected.presentedWorkspaceName ||
        workspace.description === expected.presentedWorkspaceName ||
        workspace.description === `groundcrew:${expected.canonicalTaskId}`,
    );
    if (expected.state === "provisioning" && presented) {
      let transitioned = false;
      const record = await this.#store.mutate({
        canonicalTaskId: expected.canonicalTaskId,
        update: (current) => {
          if (current.runId !== expected.runId || current.state !== "provisioning") {
            return current;
          }
          transitioned = true;
          return {
            ...current,
            events: [...current.events, { event: "running", timestamp: new Date().toISOString() }],
            state: "running",
          };
        },
      });
      return transitioned
        ? { run: new RunningRunHandle({ module: this, record }), type: "running" }
        : undefined;
    }
    if (presented) {
      return undefined;
    }
    const reason =
      expected.state === "provisioning" ? "provisioning-interrupted" : "workspace-missing";
    let transitioned = false;
    const record = await this.#store.mutate({
      canonicalTaskId: expected.canonicalTaskId,
      update: (current) => {
        if (current.runId !== expected.runId || current.state === "complete") {
          return current;
        }
        transitioned = true;
        return completeRunRecord({ outcome: "failed", reason, record: current });
      },
    });
    return transitioned
      ? {
          reason,
          run: new CompletedRunHandle({ module: this, record }),
          type: "failed",
        }
      : undefined;
  }

  public async fail(input: {
    readonly record: Readonly<RunRecord>;
    readonly reason: string;
  }): Promise<RunChange<CompletedRun>> {
    let transitioned = false;
    const record = await this.#store.mutate({
      canonicalTaskId: input.record.canonicalTaskId,
      update: (current) => {
        if (current.runId !== input.record.runId) {
          throw new Error(`run ${input.record.runId} is stale`);
        }
        if (current.state === "complete") {
          return current;
        }
        transitioned = true;
        return completeRunRecord({ outcome: "failed", reason: input.reason, record: current });
      },
    });
    return {
      run: new CompletedRunHandle({ module: this, record }),
      transitioned,
    };
  }

  public async launch(input: {
    readonly record: RunRecord;
    readonly task: LaunchTask;
    readonly profile: AgentProfile;
    readonly branch: string;
    readonly acquiredRepositories: readonly string[];
  }): Promise<RunChange<RunningRun>> {
    const current = await this.#store.getBySlug({
      slug: taskSlug({ canonicalTaskId: input.record.canonicalTaskId }),
    });
    if (current === undefined || current.runId !== input.record.runId) {
      throw new Error(`run ${input.record.runId} is stale`);
    }
    if (current.state === "running") {
      return {
        run: new RunningRunHandle({ module: this, record: current }),
        transitioned: false,
      };
    }
    if (current.state !== "provisioning") {
      throw new Error(`run ${input.record.runId} is no longer provisioning`);
    }
    await launchAgent({
      acquiredRepositories: input.acquiredRepositories,
      branch: input.branch,
      environment: this.#environment,
      presenterName: this.#presenterName,
      profile: input.profile,
      record: input.record,
      task: input.task,
    });
    let transitioned = false;
    const record = await this.#store.mutate({
      canonicalTaskId: input.record.canonicalTaskId,
      update: (current) => {
        if (current.runId !== input.record.runId) {
          throw new Error(`run ${input.record.runId} is stale`);
        }
        if (current.state === "running") {
          return current;
        }
        if (current.state !== "provisioning") {
          throw new Error(`run ${input.record.runId} is no longer provisioning`);
        }
        transitioned = true;
        return {
          ...current,
          events: [...current.events, { event: "running", timestamp: new Date().toISOString() }],
          state: "running",
        };
      },
    });
    return { run: new RunningRunHandle({ module: this, record }), transitioned };
  }

  public async discardUnclaimed(input: { readonly record: Readonly<RunRecord> }): Promise<void> {
    await this.#store.removeWhen({
      canonicalTaskId: input.record.canonicalTaskId,
      validate: (current) => {
        if (current.runId !== input.record.runId) {
          throw new Error(`run ${input.record.runId} is stale`);
        }
      },
    });
  }

  public async reportArtifact(input: {
    readonly record: Readonly<RunRecord>;
    readonly artifact: Artifact;
  }): Promise<RunningRun> {
    const record = await this.#store.mutate({
      canonicalTaskId: input.record.canonicalTaskId,
      update: (current) => {
        requireCurrentRun({ current, expected: input.record, state: "running" });
        return {
          ...current,
          artifacts: [...current.artifacts, input.artifact],
          events: [
            ...current.events,
            { event: "artifact-added", timestamp: new Date().toISOString() },
          ],
        };
      },
    });
    return new RunningRunHandle({ module: this, record });
  }

  public async finish(input: {
    readonly record: Readonly<RunRecord>;
    readonly outcome: "delivered" | "failed" | "stopped";
    readonly message?: string | undefined;
    readonly assertWorkspaceIdle: (record: Readonly<RunRecord>) => Promise<void>;
  }): Promise<CompletedRun> {
    const record = await this.#store.mutate({
      canonicalTaskId: input.record.canonicalTaskId,
      update: async (current) => {
        requireCurrentRun({ current, expected: input.record, state: "running" });
        await input.assertWorkspaceIdle(current);
        return completeRunRecord({
          message: input.message,
          outcome: input.outcome,
          record: current,
        });
      },
    });
    return new CompletedRunHandle({ module: this, record });
  }

  public async reserveRepositoryOperation(input: {
    readonly record: Readonly<RunRecord>;
    readonly repository: string;
    readonly reserveWhileLocked: (record: Readonly<RunRecord>) => Promise<void>;
  }): Promise<RunningRun> {
    const record = await this.#store.mutate({
      canonicalTaskId: input.record.canonicalTaskId,
      update: async (current) => {
        requireCurrentRun({ current, expected: input.record, state: "running" });
        await input.reserveWhileLocked(current);
        return { ...current, pendingRepository: input.repository };
      },
    });
    return new RunningRunHandle({ module: this, record });
  }

  public async recordRepositories(input: {
    readonly record: Readonly<RunRecord>;
    readonly repository: string;
    readonly repositories: readonly string[];
  }): Promise<RunningRun> {
    const record = await this.#store.mutate({
      canonicalTaskId: input.record.canonicalTaskId,
      update: (current) => {
        requireCurrentRun({ current, expected: input.record, state: "running" });
        return {
          ...current,
          events: [
            ...current.events,
            { event: `repository-added:${input.repository}`, timestamp: new Date().toISOString() },
          ],
          pendingRepository: undefined,
          repositories: input.repositories,
        };
      },
    });
    return new RunningRunHandle({ module: this, record });
  }

  public async repairRepositories(input: {
    readonly canonicalTaskId: string;
    readonly expectedRunId: string;
    readonly repositories: readonly string[];
  }): Promise<RunChange<RunHandle>> {
    let transitioned = false;
    const record = await this.#store.mutate({
      canonicalTaskId: input.canonicalTaskId,
      update: (current) => {
        if (
          current.runId !== input.expectedRunId ||
          current.pendingRepository === undefined ||
          !sameStringSets({
            left: input.repositories,
            right: [...current.repositories, current.pendingRepository].map(repositoryName),
          })
        ) {
          return current;
        }
        transitioned = true;
        return {
          ...current,
          pendingRepository: undefined,
          repositories: input.repositories,
        };
      },
    });
    return { run: createRunHandle({ module: this, record }), transitioned };
  }

  public async acknowledgeSourceWriteback(input: {
    readonly record: Readonly<RunRecord>;
    readonly expectedRunId: string;
    readonly expectedCompletionTimestamp: string;
  }): Promise<CompletedRun> {
    const record = await this.#store.mutate({
      canonicalTaskId: input.record.canonicalTaskId,
      update: (current) => {
        const currentCompletionTimestamp = completionTimestamp({ record: current });
        if (
          current.runId !== input.expectedRunId ||
          currentCompletionTimestamp !== input.expectedCompletionTimestamp
        ) {
          throw new Error(`stale source writeback acknowledgement for ${current.canonicalTaskId}`);
        }
        if (current.state !== "complete" || current.outcome === undefined) {
          throw new Error(`run ${current.runId} is not complete`);
        }
        return current.writebackPending === false
          ? current
          : { ...current, writebackPending: false };
      },
    });
    return new CompletedRunHandle({ module: this, record });
  }

  public async stopForCleanup(input: {
    readonly record: Readonly<RunRecord>;
    readonly assertWorkspaceIdle: (record: Readonly<RunRecord>) => Promise<void>;
  }): Promise<RunChange<CompletedRun>> {
    let transitioned = false;
    const record = await this.#store.mutate({
      canonicalTaskId: input.record.canonicalTaskId,
      update: async (current) => {
        if (current.runId !== input.record.runId) {
          throw new Error(`run ${input.record.runId} is stale`);
        }
        await input.assertWorkspaceIdle(current);
        if (current.state === "complete") {
          return current;
        }
        transitioned = true;
        return completeRunRecord({ outcome: "stopped", record: current });
      },
    });
    return { run: new CompletedRunHandle({ module: this, record }), transitioned };
  }

  public async reconcileWorkspaceOperation(input: {
    readonly record: Readonly<RunRecord>;
    readonly clearDeadWhileLocked: (record: Readonly<RunRecord>) => Promise<void>;
  }): Promise<RunHandle> {
    const record = await this.#store.mutate({
      canonicalTaskId: input.record.canonicalTaskId,
      update: async (current) => {
        if (current.runId !== input.record.runId) {
          throw new Error(`run ${input.record.runId} is stale`);
        }
        await input.clearDeadWhileLocked(current);
        return current;
      },
    });
    return createRunHandle({ module: this, record });
  }

  public async remove(input: { readonly record: Readonly<RunRecord> }): Promise<void> {
    await this.#store.removeWhen({
      allowMissing: true,
      canonicalTaskId: input.record.canonicalTaskId,
      validate: (current) => {
        if (current.runId !== input.record.runId) {
          throw new Error(`run ${input.record.runId} is stale`);
        }
        if (current.state !== "complete") {
          throw new Error(`run ${current.runId} is not complete`);
        }
        if (current.writebackPending === true) {
          throw new Error(`run ${current.runId} source writeback is pending`);
        }
      },
    });
  }

  public async accessHint(input: {
    readonly record: Readonly<RunRecord>;
  }): Promise<string | undefined> {
    requireState({ record: input.record, state: "running" });
    return await this.#presenter.accessHint({ name: input.record.presentedWorkspaceName });
  }

  public async setPresentedStatus(input: { readonly record: Readonly<RunRecord> }): Promise<void> {
    if (input.record.state !== "complete" || input.record.outcome === undefined) {
      throw new Error(`run ${input.record.runId} is not complete`);
    }
    await this.#presenter.setStatus?.({
      name: input.record.presentedWorkspaceName,
      text: input.record.outcome,
    });
  }

  public async closePresentedWorkspace(input: {
    readonly record: Readonly<RunRecord>;
  }): Promise<void> {
    await this.#presenter.close({ name: input.record.presentedWorkspaceName });
  }
}

class RunStore {
  readonly #runsDirectory: string;

  public constructor(input: { readonly stateRoot: string }) {
    this.#runsDirectory = join(input.stateRoot, "runs");
  }

  public async create(input: {
    readonly canonicalTaskId: string;
    readonly agentProfile: string;
    readonly workspaceDirectory: string;
    readonly repositories: readonly string[];
  }): Promise<RunRecord> {
    const slug = taskSlug({ canonicalTaskId: input.canonicalTaskId });
    return await this.withLock({
      operation: async () => {
        const path = this.path({ slug });
        try {
          await stat(path);
          throw new Error(`run already exists for ${input.canonicalTaskId}`);
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
            throw error;
          }
        }
        const record: RunRecord = {
          agentProfile: input.agentProfile,
          artifacts: [],
          canonicalTaskId: input.canonicalTaskId,
          events: [{ event: "provisioning", timestamp: new Date().toISOString() }],
          presentedWorkspaceName: `groundcrew:${input.canonicalTaskId}`,
          presenter: "cmux",
          repositories: input.repositories,
          runId: `r_${randomBytes(4).toString("hex")}`,
          state: "provisioning",
          version: 1,
          workspaceDirectory: input.workspaceDirectory,
        };
        await this.write({ path, record });
        return record;
      },
      slug,
    });
  }

  public async getBySlug(input: { readonly slug: string }): Promise<RunRecord | undefined> {
    try {
      return JSON.parse(await readFile(this.path(input), "utf8")) as RunRecord;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  }

  public async list(): Promise<readonly RunRecord[]> {
    try {
      const entries = await readdir(this.#runsDirectory);
      const records = await Promise.all(
        entries
          .filter((entry) => entry.endsWith(".json"))
          .map(
            async (entry) =>
              JSON.parse(await readFile(join(this.#runsDirectory, entry), "utf8")) as RunRecord,
          ),
      );
      return records.toSorted((left, right) =>
        left.canonicalTaskId.localeCompare(right.canonicalTaskId),
      );
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  public async mutate(input: {
    readonly canonicalTaskId: string;
    readonly update: (record: RunRecord) => RunRecord | Promise<RunRecord>;
  }): Promise<RunRecord> {
    const slug = taskSlug(input);
    return await this.withLock({
      operation: async () => {
        const current = await this.getBySlug({ slug });
        if (current === undefined) {
          throw new Error(`no run exists for ${input.canonicalTaskId}`);
        }
        const updated = await input.update(current);
        await this.write({ path: this.path({ slug }), record: updated });
        return updated;
      },
      slug,
    });
  }

  public async removeWhen(input: {
    readonly allowMissing?: boolean | undefined;
    readonly canonicalTaskId: string;
    readonly validate: (record: RunRecord) => void;
  }): Promise<void> {
    const slug = taskSlug(input);
    await this.withLock({
      operation: async () => {
        const current = await this.getBySlug({ slug });
        if (current === undefined) {
          if (input.allowMissing === true) {
            return;
          }
          throw new Error(`no run exists for ${input.canonicalTaskId}`);
        }
        input.validate(current);
        await rm(this.path({ slug }), { force: true });
      },
      slug,
    });
  }

  private path(input: { readonly slug: string }): string {
    return join(this.#runsDirectory, `${input.slug}.json`);
  }

  private async write(input: { readonly path: string; readonly record: RunRecord }): Promise<void> {
    await atomicWrite({
      path: input.path,
      value: `${JSON.stringify(input.record, undefined, 2)}\n`,
    });
  }

  private async withLock<T>(input: {
    readonly slug: string;
    readonly operation: () => Promise<T>;
  }): Promise<T> {
    const lockPath = join(this.#runsDirectory, `${input.slug}.lock`);
    return await withFileLock({ operation: input.operation, path: lockPath });
  }
}

class ProvisioningRunHandle implements ProvisioningRun {
  public readonly record: Readonly<RunRecord>;
  public readonly state = "provisioning" as const;
  readonly #module: RunModule;

  public constructor(input: { readonly module: RunModule; readonly record: RunRecord }) {
    this.#module = input.module;
    this.record = input.record;
  }

  public async fail(input: { readonly reason: string }): Promise<RunChange<CompletedRun>> {
    return await this.#module.fail({ reason: input.reason, record: this.record });
  }

  public async discardUnclaimed(): Promise<void> {
    await this.#module.discardUnclaimed({ record: this.record });
  }

  public async launch(input: {
    readonly task: LaunchTask;
    readonly profile: AgentProfile;
    readonly branch: string;
    readonly acquiredRepositories: readonly string[];
  }): Promise<RunChange<RunningRun>> {
    return await this.#module.launch({ ...input, record: this.record });
  }

  public async stopForCleanup(input: {
    readonly assertWorkspaceIdle: (record: Readonly<RunRecord>) => Promise<void>;
  }): Promise<RunChange<CompletedRun>> {
    return await this.#module.stopForCleanup({ ...input, record: this.record });
  }

  public async reconcileWorkspaceOperation(input: {
    readonly clearDeadWhileLocked: (record: Readonly<RunRecord>) => Promise<void>;
  }): Promise<RunHandle> {
    return await this.#module.reconcileWorkspaceOperation({ ...input, record: this.record });
  }
}

class RunningRunHandle implements RunningRun {
  public readonly record: Readonly<RunRecord>;
  public readonly state = "running" as const;
  readonly #module: RunModule;

  public constructor(input: { readonly module: RunModule; readonly record: RunRecord }) {
    this.#module = input.module;
    this.record = input.record;
  }

  public async reportArtifact(input: { readonly artifact: Artifact }): Promise<RunningRun> {
    return await this.#module.reportArtifact({ artifact: input.artifact, record: this.record });
  }

  public async finish(input: {
    readonly outcome: "delivered" | "failed" | "stopped";
    readonly message?: string | undefined;
    readonly assertWorkspaceIdle: (record: Readonly<RunRecord>) => Promise<void>;
  }): Promise<CompletedRun> {
    return await this.#module.finish({ ...input, record: this.record });
  }

  public async fail(input: { readonly reason: string }): Promise<RunChange<CompletedRun>> {
    return await this.#module.fail({ reason: input.reason, record: this.record });
  }

  public async reserveRepositoryOperation(input: {
    readonly repository: string;
    readonly reserveWhileLocked: (record: Readonly<RunRecord>) => Promise<void>;
  }): Promise<RunningRun> {
    return await this.#module.reserveRepositoryOperation({ ...input, record: this.record });
  }

  public async recordRepositories(input: {
    readonly repository: string;
    readonly repositories: readonly string[];
  }): Promise<RunningRun> {
    return await this.#module.recordRepositories({ ...input, record: this.record });
  }

  public async accessHint(): Promise<string | undefined> {
    return await this.#module.accessHint({ record: this.record });
  }

  public async stopForCleanup(input: {
    readonly assertWorkspaceIdle: (record: Readonly<RunRecord>) => Promise<void>;
  }): Promise<RunChange<CompletedRun>> {
    return await this.#module.stopForCleanup({ ...input, record: this.record });
  }

  public async reconcileWorkspaceOperation(input: {
    readonly clearDeadWhileLocked: (record: Readonly<RunRecord>) => Promise<void>;
  }): Promise<RunHandle> {
    return await this.#module.reconcileWorkspaceOperation({ ...input, record: this.record });
  }
}

class CompletedRunHandle implements CompletedRun {
  public readonly record: Readonly<RunRecord>;
  public readonly state = "complete" as const;
  readonly #module: RunModule;

  public constructor(input: { readonly module: RunModule; readonly record: RunRecord }) {
    this.#module = input.module;
    this.record = input.record;
  }

  public async acknowledgeSourceWriteback(input: {
    readonly expectedRunId: string;
    readonly expectedCompletionTimestamp: string;
  }): Promise<CompletedRun> {
    return await this.#module.acknowledgeSourceWriteback({ ...input, record: this.record });
  }

  public async remove(): Promise<void> {
    await this.#module.remove({ record: this.record });
  }

  public async setPresentedStatus(): Promise<void> {
    await this.#module.setPresentedStatus({ record: this.record });
  }

  public async closePresentedWorkspace(): Promise<void> {
    await this.#module.closePresentedWorkspace({ record: this.record });
  }

  public async stopForCleanup(input: {
    readonly assertWorkspaceIdle: (record: Readonly<RunRecord>) => Promise<void>;
  }): Promise<RunChange<CompletedRun>> {
    return await this.#module.stopForCleanup({ ...input, record: this.record });
  }

  public async reconcileWorkspaceOperation(input: {
    readonly clearDeadWhileLocked: (record: Readonly<RunRecord>) => Promise<void>;
  }): Promise<RunHandle> {
    return await this.#module.reconcileWorkspaceOperation({ ...input, record: this.record });
  }
}

function createRunHandle(input: {
  readonly module: RunModule;
  readonly record: RunRecord;
}): RunHandle {
  if (input.record.state === "provisioning") {
    return new ProvisioningRunHandle(input);
  }
  if (input.record.state === "running") {
    return new RunningRunHandle(input);
  }
  return new CompletedRunHandle(input);
}

export async function withFileLock<T>(input: {
  readonly path: string;
  readonly operation: () => Promise<T>;
}): Promise<T> {
  const owner = randomUUID();
  const ownerPath = join(input.path, "owner");
  await mkdir(dirname(input.path), { recursive: true });
  for (;;) {
    try {
      await mkdir(input.path);
      await writeFile(ownerPath, owner, "utf8");
      break;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
        throw error;
      }
      let metadata;
      try {
        metadata = await stat(input.path);
      } catch (statError) {
        if (statError instanceof Error && "code" in statError && statError.code === "ENOENT") {
          continue;
        }
        throw statError;
      }
      if (Date.now() - metadata.mtimeMs > 30_000) {
        const stalePath = `${input.path}.${randomUUID()}.stale`;
        try {
          await rename(input.path, stalePath);
        } catch (renameError) {
          if (
            renameError instanceof Error &&
            "code" in renameError &&
            renameError.code === "ENOENT"
          ) {
            continue;
          }
          throw renameError;
        }
        await rm(stalePath, { recursive: true, force: true });
        continue;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    }
  }
  const release = async (): Promise<void> => {
    try {
      if ((await readFile(ownerPath, "utf8")) === owner) {
        await rm(input.path, { recursive: true, force: true });
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
  };
  let result: T;
  try {
    result = await input.operation();
  } catch (operationError) {
    await release().catch(() => {});
    throw operationError;
  }
  await release();
  return result;
}

export function taskSlug(input: { readonly canonicalTaskId: string }): string {
  return input.canonicalTaskId
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "");
}

function composeAgentCommand(input: {
  readonly profile: AgentProfile;
  readonly prompt: string;
}): readonly string[] {
  const { profile, prompt } = input;
  if (profile.kind === "claude") {
    const command = ["claude", "--permission-mode", "auto"];
    if (profile.model !== undefined) {
      command.push("--model", profile.model);
    }
    command.push("--effort", profile.effort, prompt);
    return command;
  }
  const command = ["codex"];
  if (profile.model !== undefined) {
    command.push("--model", profile.model);
  }
  command.push("-c", `model_reasoning_effort="${profile.effort}"`, prompt);
  return command;
}

function renderPrompt(input: {
  readonly task: LaunchTask;
  readonly workspaceDirectory: string;
  readonly branch: string;
  readonly acquiredRepositories: readonly string[];
}): string {
  const { acquiredRepositories, branch, task, workspaceDirectory } = input;
  const repositories = [...new Set([...task.repositories, ...acquiredRepositories])];
  return [
    `Task: ${task.canonicalTaskId}`,
    `Title: ${task.title}`,
    "",
    task.description ?? "No description was provided.",
    "",
    `Workspace: ${workspaceDirectory}`,
    `Branch: ${branch}`,
    `Repositories: ${repositories.length === 0 ? "none (empty workspace)" : repositories.join(", ")}`,
    "",
    "Inspect repository instructions before changing code.",
    "Acquire another repository with: crew repo add <repo>",
    "Report every durable output with: crew artifact add <locator> --kind <kind>",
    "Complete the run with: crew done [--outcome delivered|failed|stopped]",
    "Report each durable output before completing.",
  ].join("\n");
}

async function launchAgent(input: {
  readonly environment: NodeJS.ProcessEnv;
  readonly presenterName: "cmux";
  readonly record: RunRecord;
  readonly profile: AgentProfile;
  readonly task: LaunchTask;
  readonly branch: string;
  readonly acquiredRepositories: readonly string[];
}): Promise<void> {
  const { environment, record } = input;
  const presenter = createPresenter({ environment, name: input.presenterName });
  const prompt = renderPrompt({
    acquiredRepositories: input.acquiredRepositories,
    branch: input.branch,
    task: input.task,
    workspaceDirectory: record.workspaceDirectory,
  });
  await seedWorkspaceTrust({
    environment,
    kind: input.profile.kind,
    workspaceDirectory: record.workspaceDirectory,
  });
  const inheritedEnvironment = Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  await presenter.open({
    command: composeAgentCommand({ profile: input.profile, prompt }),
    displayName: presenterWorkspaceName({ canonicalTaskId: record.canonicalTaskId }),
    environment: {
      ...inheritedEnvironment,
      GROUNDCREW_TASK_ID: record.canonicalTaskId,
      GROUNDCREW_WORKSPACE: record.workspaceDirectory,
    },
    name: record.presentedWorkspaceName,
    status: "running",
    workingDirectory: record.workspaceDirectory,
  });
}

export async function seedWorkspaceTrust(input: {
  readonly environment: NodeJS.ProcessEnv;
  readonly kind: "claude" | "codex";
  readonly workspaceDirectory: string;
}): Promise<void> {
  const homeDirectory = input.environment["HOME"] ?? homedir();
  if (input.kind === "claude") {
    const path = join(homeDirectory, ".claude.json");
    await withFileLock({
      path: `${path}.groundcrew.lock`,
      operation: async () => {
        let existing: Record<string, unknown> = {};
        try {
          existing = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
            throw error;
          }
        }
        const projects = isObject(existing["projects"]) ? existing["projects"] : {};
        const current = isObject(projects[input.workspaceDirectory])
          ? projects[input.workspaceDirectory]
          : {};
        projects[input.workspaceDirectory] = {
          ...current,
          hasCompletedProjectOnboarding: true,
          hasTrustDialogAccepted: true,
        };
        await atomicWrite({
          path,
          value: `${JSON.stringify({ ...existing, projects }, undefined, 2)}\n`,
        });
      },
    });
    return;
  }
  const codexHome = input.environment["CODEX_HOME"] ?? join(homeDirectory, ".codex");
  const path = join(codexHome, "config.toml");
  await withFileLock({
    path: `${path}.groundcrew.lock`,
    operation: async () => {
      let existing = "";
      try {
        existing = await readFile(path, "utf8");
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
          throw error;
        }
      }
      const header = `[projects.${JSON.stringify(input.workspaceDirectory)}]`;
      const lines = existing.split("\n");
      const start = lines.findIndex((line) => line.trim() === header);
      if (start < 0) {
        const separator = existing.length > 0 && !existing.endsWith("\n\n") ? "\n" : "";
        existing = `${existing}${separator}${header}\ntrust_level = "trusted"\n`;
      } else {
        let end = lines.findIndex(
          (line, index) => index > start && line.trimStart().startsWith("["),
        );
        if (end < 0) {
          end = lines.length;
        }
        const trustIndex = lines.findIndex(
          (line, index) =>
            index > start && index < end && line.trimStart().startsWith("trust_level ="),
        );
        if (trustIndex < 0) {
          lines.splice(start + 1, 0, 'trust_level = "trusted"');
        } else {
          lines[trustIndex] = 'trust_level = "trusted"';
        }
        existing = lines.join("\n");
      }
      await atomicWrite({ path, value: existing });
    },
  });
}

function presenterWorkspaceName(input: { readonly canonicalTaskId: string }): string {
  const separatorIndex = input.canonicalTaskId.indexOf(":");
  const sourceLocalTaskId = input.canonicalTaskId.slice(separatorIndex + 1);
  return taskSlug({ canonicalTaskId: sourceLocalTaskId });
}

function completeRunRecord(input: {
  readonly record: RunRecord;
  readonly outcome: "delivered" | "failed" | "stopped";
  readonly reason?: string | undefined;
  readonly message?: string | undefined;
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
    message: input.message,
    outcome: input.outcome,
    reason: input.reason,
    state: "complete",
    writebackPending: true,
  };
}

function requireCurrentRun(input: {
  readonly current: RunRecord;
  readonly expected: Readonly<RunRecord>;
  readonly state: RunRecord["state"];
}): void {
  if (input.current.runId !== input.expected.runId) {
    throw new Error(`run ${input.expected.runId} is stale`);
  }
  if (input.current.state !== input.state) {
    if (input.state === "running") {
      throw new Error(
        `run ${input.current.runId} is ${input.current.state}; in-session commands require a running run`,
      );
    }
    throw new Error(
      `run ${input.current.runId} is ${input.current.state}; expected ${input.state}`,
    );
  }
}

function requireState(input: {
  readonly record: Readonly<RunRecord>;
  readonly state: RunRecord["state"];
}): void {
  if (input.record.state !== input.state) {
    throw new Error(`run ${input.record.runId} is ${input.record.state}; expected ${input.state}`);
  }
}

function completionTimestamp(input: { readonly record: RunRecord }): string | undefined {
  return input.record.events.findLast(({ event }) => event.startsWith("complete:"))?.timestamp;
}

function repositoryName(repository: string): string {
  return basename(repository);
}

function sameStringSets(input: {
  readonly left: readonly string[];
  readonly right: readonly string[];
}): boolean {
  const left = new Set(input.left);
  const right = new Set(input.right);
  return left.size === right.size && [...left].every((value) => right.has(value));
}

async function atomicWrite(input: {
  readonly path: string;
  readonly value: string;
}): Promise<void> {
  await mkdir(dirname(input.path), { recursive: true });
  const temporaryPath = `${input.path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, input.value, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, input.path);
}

function isObject(value: unknown): value is Record<string, Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
