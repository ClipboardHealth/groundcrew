import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createPresenter, type Presenter } from "../presenter/index.js";

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

export class RunStore {
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
      presentedWorkspaceName: `crew-${slug}`,
      presenter: "cmux",
      repositories: input.repositories,
      runId: `r_${randomBytes(4).toString("hex")}`,
      state: "provisioning",
      version: 1,
      workspaceDirectory: input.workspaceDirectory,
    };
    await this.write({ path, record });
    return record;
  }

  public async get(input: { readonly canonicalTaskId: string }): Promise<RunRecord | undefined> {
    return await this.getBySlug({ slug: taskSlug(input) });
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
    readonly update: (record: RunRecord) => RunRecord;
  }): Promise<RunRecord> {
    const slug = taskSlug(input);
    return await this.withLock({
      operation: async () => {
        const current = await this.getBySlug({ slug });
        if (current === undefined) {
          throw new Error(`no run exists for ${input.canonicalTaskId}`);
        }
        const updated = input.update(current);
        await this.write({ path: this.path({ slug }), record: updated });
        return updated;
      },
      slug,
    });
  }

  public async remove(input: { readonly canonicalTaskId: string }): Promise<void> {
    const slug = taskSlug(input);
    await this.withLock({
      operation: async () => {
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
    await mkdir(this.#runsDirectory, { recursive: true });
    for (;;) {
      try {
        await mkdir(lockPath);
        break;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
          throw error;
        }
        const metadata = await stat(lockPath);
        if (Date.now() - metadata.mtimeMs > 30_000) {
          await rm(lockPath, { recursive: true, force: true });
          continue;
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
      }
    }
    try {
      return await input.operation();
    } finally {
      await rm(lockPath, { recursive: true, force: true });
    }
  }
}

export function taskSlug(input: { readonly canonicalTaskId: string }): string {
  return input.canonicalTaskId
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "");
}

export function composeAgentCommand(input: {
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

export function renderPrompt(input: {
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

export async function launchAgent(input: {
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
  await presenter.open({
    command: composeAgentCommand({ profile: input.profile, prompt }),
    environment: {
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
    return;
  }
  const codexHome = input.environment["CODEX_HOME"] ?? join(homeDirectory, ".codex");
  const path = join(codexHome, "config.toml");
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
  const start = lines.indexOf(header);
  if (start < 0) {
    const separator = existing.length > 0 && !existing.endsWith("\n\n") ? "\n" : "";
    existing = `${existing}${separator}${header}\ntrust_level = "trusted"\n`;
  } else {
    let end = lines.findIndex((line, index) => index > start && line.startsWith("["));
    if (end < 0) {
      end = lines.length;
    }
    const trustIndex = lines.findIndex(
      (line, index) => index > start && index < end && line.startsWith("trust_level ="),
    );
    if (trustIndex < 0) {
      lines.splice(start + 1, 0, 'trust_level = "trusted"');
    } else {
      lines[trustIndex] = 'trust_level = "trusted"';
    }
    existing = lines.join("\n");
  }
  await atomicWrite({ path, value: existing });
}

export function presenterFor(input: {
  readonly environment: NodeJS.ProcessEnv;
  readonly name: "cmux";
}): Presenter {
  return createPresenter(input);
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
