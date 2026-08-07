import { constants } from "node:fs";
import { access, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execa } from "execa";
import { z } from "zod";

const SourceTaskSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  priority: z.number().optional(),
  blocked: z.boolean(),
  terminal: z.boolean(),
  agentProfile: z.string().optional(),
  repositories: z.array(z.string()),
});

const ManifestSchema = z.object({
  name: z.string().min(1).optional(),
  protocolVersion: z.number().int(),
  commands: z.object({
    list: z.string().min(1),
    get: z.string().min(1).optional(),
    update: z.string().min(1).optional(),
  }),
  secrets: z.array(z.string()).default([]),
  environment: z.record(z.string(), z.string()).default({}),
  prerequisites: z.array(z.string()).default([]),
});

const UpdateResultSchema = z.object({
  result: z.enum(["ok", "rejected"]),
  reason: z.string().optional(),
});

export interface Artifact {
  readonly kind: string;
  readonly locator: string;
  readonly title?: string | undefined;
  readonly repository?: string | undefined;
}

export interface Task {
  readonly sourceName: string;
  readonly id: string;
  readonly title: string;
  readonly description?: string | undefined;
  readonly priority?: number | undefined;
  readonly blocked: boolean;
  readonly terminal: boolean;
  readonly agentProfile?: string | undefined;
  readonly repositories: readonly string[];
}

export type SourceEvent =
  | { readonly type: "claimed"; readonly runId: string }
  | {
      readonly type: "completed";
      readonly outcome: "delivered" | "failed" | "stopped";
      readonly artifacts: readonly Artifact[];
      readonly message?: string | undefined;
    };

export interface SourceInstance {
  readonly kind: string;
  readonly name?: string | undefined;
  readonly agentProfile?: string | undefined;
  readonly environment: Readonly<Record<string, string>>;
}

export type Result<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: { readonly message: string } };

export interface SourceHealth {
  readonly name: string;
  readonly kind: string;
  readonly origin: "package" | "user";
  readonly protocolVersion?: number | undefined;
  readonly errors: readonly string[];
  readonly probe?: Result<{ readonly taskCount: number }> | undefined;
}

interface Bundle {
  readonly directory: string;
  readonly kind: string;
  readonly origin: "package" | "user";
  readonly manifest: z.output<typeof ManifestSchema>;
}

interface DiscoveredBundle {
  readonly bundle?: Bundle | undefined;
  readonly errors: readonly string[];
  readonly origin: "package" | "user";
}

interface RegisteredSource {
  readonly bundle: Bundle | undefined;
  readonly instance: SourceInstance;
  readonly name: string;
  readonly origin: "package" | "user";
  readonly discoveryErrors: readonly string[];
  lastTasks: readonly Task[];
}

export class SourceRegistry {
  readonly #sources: readonly RegisteredSource[];
  readonly #environment: NodeJS.ProcessEnv;

  private constructor(input: {
    readonly sources: readonly RegisteredSource[];
    readonly environment: NodeJS.ProcessEnv;
  }) {
    this.#sources = input.sources;
    this.#environment = input.environment;
  }

  public static async create(input: {
    readonly packageRoot: string;
    readonly configHome: string;
    readonly instances: readonly SourceInstance[];
    readonly environment: NodeJS.ProcessEnv;
  }): Promise<SourceRegistry> {
    const bundles = await discoverBundles(input);
    const sources = input.instances.map((instance) => {
      const discovered = bundles.get(instance.kind);
      const bundle = discovered?.bundle;
      const name = instance.name ?? bundle?.manifest.name ?? instance.kind;
      const discoveryErrors =
        discovered === undefined
          ? [`source bundle '${instance.kind}' not found`]
          : discovered.errors;
      return {
        bundle,
        discoveryErrors: [...discoveryErrors],
        instance,
        lastTasks: [],
        name,
        origin: discovered?.origin ?? "package",
      };
    });
    for (const source of sources) {
      if (sources.filter((candidate) => candidate.name === source.name).length > 1) {
        source.discoveryErrors.push(`duplicate configured source name '${source.name}'`);
      }
    }
    return new SourceRegistry({ environment: input.environment, sources });
  }

  public sourceDefaultProfile(input: { readonly sourceName: string }): string | undefined {
    return this.#sources.find((source) => source.name === input.sourceName)?.instance.agentProfile;
  }

  public sourceNames(): readonly string[] {
    return this.#sources.map((source) => source.name);
  }

  public async health(): Promise<readonly SourceHealth[]> {
    return await Promise.all(
      this.#sources.map(async (source) => {
        const errors = [...source.discoveryErrors];
        const bundle = source.bundle;
        if (bundle === undefined) {
          return { errors, kind: source.instance.kind, name: source.name, origin: source.origin };
        }
        if (bundle.manifest.protocolVersion !== 1) {
          errors.push(
            `unsupported protocol version ${bundle.manifest.protocolVersion}; groundcrew accepts 1`,
          );
        }
        for (const secret of bundle.manifest.secrets) {
          if (this.#environment[secret] === undefined) {
            errors.push(`missing secret ${secret}`);
          }
        }
        for (const prerequisite of bundle.manifest.prerequisites) {
          if (!(await commandExists({ command: prerequisite, environment: this.#environment }))) {
            errors.push(`missing prerequisite ${prerequisite}`);
          }
        }
        if (errors.length > 0) {
          return {
            errors,
            kind: source.instance.kind,
            name: source.name,
            origin: bundle.origin,
            protocolVersion: bundle.manifest.protocolVersion,
          };
        }
        const listed = await this.listOne({ source });
        return {
          errors,
          kind: source.instance.kind,
          name: source.name,
          origin: bundle.origin,
          probe: listed.ok ? { data: { taskCount: listed.data.length }, ok: true } : listed,
          protocolVersion: bundle.manifest.protocolVersion,
        };
      }),
    );
  }

  public async list(): Promise<Result<{ readonly tasks: readonly Task[] }>> {
    const tasks: Task[] = [];
    for (const source of this.#sources) {
      // Source order is the dispatch tie-breaker, so invocation is intentionally sequential.
      // eslint-disable-next-line no-await-in-loop
      const result = await this.listOne({ source });
      if (!result.ok) {
        return result;
      }
      tasks.push(...result.data);
    }
    return { data: { tasks }, ok: true };
  }

  public async get(input: {
    readonly canonicalTaskId: string;
  }): Promise<Result<{ readonly task: Task }>> {
    const resolved = this.resolveSource(input);
    if (!resolved.ok) {
      return resolved;
    }
    const { localId, source } = resolved.data;
    const command = source.bundle?.manifest.commands.get;
    if (command === undefined) {
      const task = source.lastTasks.find((candidate) => candidate.id === localId);
      return task === undefined
        ? failure({ message: `task ${input.canonicalTaskId} was not present in the latest list` })
        : { data: { task }, ok: true };
    }
    const invoked = await this.invoke({ command, payload: { id: localId }, source });
    if (!invoked.ok) {
      return invoked;
    }
    const parsed = z.object({ task: SourceTaskSchema }).safeParse(invoked.data);
    return parsed.success
      ? {
          data: { task: normalizeTask({ sourceName: source.name, task: parsed.data.task }) },
          ok: true,
        }
      : failure({ message: "source get returned invalid task data" });
  }

  public async update(input: {
    readonly canonicalTaskId: string;
    readonly event: SourceEvent;
  }): Promise<
    Result<{ readonly result: "ok" | "rejected"; readonly reason?: string | undefined }>
  > {
    const resolved = this.resolveSource(input);
    if (!resolved.ok) {
      return resolved;
    }
    const { localId, source } = resolved.data;
    const command = source.bundle?.manifest.commands.update;
    if (command === undefined) {
      return { data: { result: "ok" }, ok: true };
    }
    const invoked = await this.invoke({
      command,
      payload: { event: input.event, id: localId },
      source,
    });
    if (!invoked.ok) {
      return invoked;
    }
    const parsed = UpdateResultSchema.safeParse(invoked.data);
    return parsed.success
      ? { data: parsed.data, ok: true }
      : failure({ message: "source update returned invalid result data" });
  }

  private async listOne(input: {
    readonly source: RegisteredSource;
  }): Promise<Result<readonly Task[]>> {
    const { source } = input;
    const command = source.bundle?.manifest.commands.list;
    if (command === undefined) {
      return failure({ message: source.discoveryErrors.join("; ") });
    }
    if (source.bundle?.manifest.protocolVersion !== 1) {
      return failure({ message: `source ${source.name} uses unsupported protocol version` });
    }
    const invoked = await this.invoke({ command, payload: {}, source });
    if (!invoked.ok) {
      return invoked;
    }
    const parsed = z.object({ tasks: z.array(SourceTaskSchema) }).safeParse(invoked.data);
    if (!parsed.success) {
      return failure({ message: "source list returned invalid task data" });
    }
    source.lastTasks = parsed.data.tasks.map((task) =>
      normalizeTask({ sourceName: source.name, task }),
    );
    return { data: source.lastTasks, ok: true };
  }

  private async invoke(input: {
    readonly source: RegisteredSource;
    readonly command: string;
    readonly payload: unknown;
  }): Promise<Result<unknown>> {
    const { command, payload, source } = input;
    const bundle = source.bundle;
    if (bundle === undefined) {
      return failure({ message: `source bundle ${source.instance.kind} not found` });
    }
    const executable = resolve(bundle.directory, command);
    try {
      await access(executable, constants.X_OK);
      const result = await execa(executable, [], {
        cwd: bundle.directory,
        env: {
          ...this.#environment,
          ...bundle.manifest.environment,
          ...source.instance.environment,
        },
        input: JSON.stringify(payload),
        reject: false,
        timeout: 120_000,
      });
      if (result.exitCode !== 0) {
        return failure({
          message: result.stderr.trim() || `source command exited ${result.exitCode}`,
        });
      }
      const parsed: unknown = JSON.parse(result.stdout);
      const envelope = z
        .union([
          z.object({ ok: z.literal(true), data: z.unknown() }),
          z.object({ ok: z.literal(false), error: z.object({ message: z.string() }) }),
        ])
        .safeParse(parsed);
      return envelope.success
        ? envelope.data
        : failure({ message: "source command returned invalid JSON result" });
    } catch (error) {
      return failure({ message: error instanceof Error ? error.message : String(error) });
    }
  }

  private resolveSource(input: {
    readonly canonicalTaskId: string;
  }): Result<{ readonly source: RegisteredSource; readonly localId: string }> {
    const separator = input.canonicalTaskId.indexOf(":");
    if (separator < 1) {
      return failure({ message: `invalid canonical task ID ${input.canonicalTaskId}` });
    }
    const sourceName = input.canonicalTaskId.slice(0, separator);
    const localId = input.canonicalTaskId.slice(separator + 1);
    const source = this.#sources.find((candidate) => candidate.name === sourceName);
    return source === undefined
      ? failure({ message: `source ${sourceName} is not configured` })
      : { data: { localId, source }, ok: true };
  }
}

async function discoverBundles(input: {
  readonly packageRoot: string;
  readonly configHome: string;
}): Promise<Map<string, DiscoveredBundle>> {
  const bundles = new Map<string, DiscoveredBundle>();
  await discoverDirectory({
    bundles,
    directory: join(input.packageRoot, "task-sources"),
    origin: "package",
  });
  await discoverDirectory({
    bundles,
    directory: join(input.configHome, "groundcrew", "task-sources"),
    origin: "user",
  });
  return bundles;
}

async function discoverDirectory(input: {
  readonly bundles: Map<string, DiscoveredBundle>;
  readonly directory: string;
  readonly origin: "package" | "user";
}): Promise<void> {
  let entries;
  try {
    entries = await readdir(input.directory, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const directory = join(input.directory, entry.name);
    const manifestPath = join(directory, "source.json");
    try {
      // eslint-disable-next-line no-await-in-loop
      const raw = await readFile(manifestPath, "utf8");
      const parsed = ManifestSchema.safeParse(JSON.parse(raw));
      if (parsed.success) {
        input.bundles.set(entry.name, {
          bundle: {
            directory,
            kind: entry.name,
            manifest: parsed.data,
            origin: input.origin,
          },
          errors: [],
          origin: input.origin,
        });
      } else {
        input.bundles.set(entry.name, {
          errors: [formatManifestError({ error: parsed.error, manifestPath })],
          origin: input.origin,
        });
      }
    } catch (error) {
      input.bundles.set(entry.name, {
        errors: [formatManifestError({ error, manifestPath })],
        origin: input.origin,
      });
    }
  }
}

function formatManifestError(input: {
  readonly error: unknown;
  readonly manifestPath: string;
}): string {
  const detail =
    input.error instanceof z.ZodError
      ? input.error.issues
          .map((issue) => `${issue.path.join(".") || "manifest"}: ${issue.message}`)
          .join("; ")
      : input.error instanceof Error
        ? input.error.message
        : String(input.error);
  return `invalid source manifest ${input.manifestPath}: ${detail}`;
}

function normalizeTask(input: {
  readonly sourceName: string;
  readonly task: z.output<typeof SourceTaskSchema>;
}): Task {
  return { sourceName: input.sourceName, ...input.task };
}

function failure(input: { readonly message: string }): Result<never> {
  return { error: { message: input.message }, ok: false };
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
