import { Command } from "@commander-js/extra-typings";
import { CommanderError } from "commander";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "jsonc-parser";
import { z } from "zod";
import { createApplication, type DispatchProgress } from "../core/index.js";

const AgentProfileSchema = z.object({
  kind: z.enum(["claude", "codex"]),
  model: z.string().min(1).optional(),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).default("high"),
});

const DEFAULT_AGENT_PROFILES = {
  "claude-fable": { effort: "high", kind: "claude", model: "fable" },
  "claude-opus": { effort: "high", kind: "claude", model: "opus" },
  codex: { effort: "high", kind: "codex" },
} as const;

const ConfigSchema = z.object({
  $schema: z.string().optional(),
  workspace: z.object({
    baseDirectory: z.string().min(1),
    worktreeDirectory: z.string().min(1).optional(),
    prepareWorktree: z.string().optional(),
    repositories: z
      .record(z.string(), z.object({ prepareWorktree: z.string().optional() }))
      .default({}),
  }),
  sources: z
    .array(
      z.object({
        kind: z.string().min(1),
        name: z.string().min(1).optional(),
        agentProfile: z.string().min(1).optional(),
        environment: z.record(z.string(), z.string()).default({}),
      }),
    )
    .min(1),
  agents: z
    .object({
      default: z.string().min(1).default("claude-fable"),
      profiles: z.record(z.string(), AgentProfileSchema).default(DEFAULT_AGENT_PROFILES),
    })
    .default({ default: "claude-fable", profiles: DEFAULT_AGENT_PROFILES }),
  orchestrator: z
    .object({
      maximumInProgress: z.number().int().positive().default(4),
      pollIntervalMilliseconds: z.number().int().positive().default(120_000),
    })
    .default({ maximumInProgress: 4, pollIntervalMilliseconds: 120_000 }),
  git: z
    .object({
      remote: z.string().min(1).default("origin"),
      defaultBranch: z.string().min(1).default("main"),
      branchPrefix: z.string().min(1).default("crew"),
    })
    .default({ branchPrefix: "crew", defaultBranch: "main", remote: "origin" }),
  presenter: z.literal("cmux").default("cmux"),
  logging: z.object({ file: z.string().min(1).optional() }).default({}),
});

export type Config = z.output<typeof ConfigSchema>;

export function configurationJsonSchema(): Record<string, unknown> {
  return {
    ...z.toJSONSchema(ConfigSchema, { target: "draft-2020-12" }),
    $id: "https://clipboardhealth.com/schemas/groundcrew-v2.schema.json",
    title: "Groundcrew v2 configuration",
  };
}

interface MainInput {
  readonly arguments: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
}

interface PathContext {
  readonly configHome: string;
  readonly stateRoot: string;
  readonly packageRoot: string;
  readonly homeDirectory: string;
}

export async function main(input: MainInput): Promise<void> {
  const { arguments: cliArguments, environment } = input;
  const paths = resolvePaths({ environment });
  const program = new Command()
    .name("crew")
    .description("Dispatch local AI coding agents from task sources")
    .showHelpAfterError()
    .option("--verbose", "include debug diagnostics");

  program
    .command("init")
    .description("detect prerequisites and write a minimal config")
    .option("--yes", "accept detected defaults")
    .option("--verbose", "include debug diagnostics")
    .action(async (options) => {
      await initialize({ overwrite: options.yes === true, paths });
    });

  program
    .command("doctor")
    .description("check prerequisites, configuration, and live sources")
    .option("--verbose", "include debug diagnostics")
    .action(async () => {
      const loaded = await loadConfig({ environment });
      const application = await createApplication({
        config: loaded.config,
        environment,
        paths: loaded.paths,
      });
      const result = await application.doctor({
        onPrerequisiteChecks(checks) {
          for (const check of checks) {
            process.stdout.write(`${check.ok ? "✓" : "✗"} ${check.name}: ${check.detail}\n`);
          }
          process.stdout.write("… waiting for live source probes\n");
        },
      });
      for (const source of result.sources) {
        process.stdout.write(
          `${source.name} (${source.origin}, protocol ${source.protocolVersion ?? "unknown"})\n`,
        );
        for (const error of source.errors) {
          process.stdout.write(`✗ ${error}\n`);
        }
        if (source.probe !== undefined) {
          process.stdout.write(
            source.probe.ok
              ? `✓ live list probe: healthy (${source.probe.data.taskCount} tasks)\n`
              : `✗ live list probe: ${source.probe.error.message}\n`,
          );
        }
      }
      if (!result.ok) {
        process.exitCode = 1;
      }
    });

  program
    .command("start")
    .description("dispatch eligible tasks")
    .argument("[task]", "canonical or source-local task ID")
    .option("--watch", "repeat at the configured polling interval")
    .option("--force", "bypass blocked status and the concurrency limit")
    .option("--agent <profile>", "override agent routing")
    .option("--verbose", "include debug diagnostics")
    .action(async (task, options) => {
      const loaded = await loadConfig({ environment });
      const application = await createConfiguredApplication({ environment, loaded });
      do {
        const result = await application.start({
          agent: options.agent,
          force: options.force === true,
          onProgress: (progress) => renderDispatchProgress({ progress }),
          task,
        });
        for (const canonicalTaskId of result.started) {
          process.stdout.write(`Started ${canonicalTaskId}\n`);
        }
        if (options.watch !== true) {
          break;
        }
        await delay({ milliseconds: loaded.config.orchestrator.pollIntervalMilliseconds });
      } while (true);
    });

  program
    .command("status")
    .description("show run, source, Git, and cleanup state")
    .argument("[task]", "canonical or source-local task ID")
    .option("--json", "emit one stable JSON object")
    .option("--verbose", "include debug diagnostics")
    .action(async (task, options) => {
      const application = await configuredApplication({ environment });
      const result = await application.status({ task });
      if (options.json === true) {
        process.stdout.write(`${JSON.stringify(result)}\n`);
      } else {
        renderStatus({ result });
      }
    });

  program
    .command("cleanup")
    .description("close presenters and safely remove task worktrees")
    .argument("[task]", "canonical or source-local task ID")
    .option("--all", "clean every local task")
    .option("--allow-dirty", "permit deletion of dirty worktrees and unique branches")
    .option("--verbose", "include debug diagnostics")
    .action(async (task, options) => {
      const application = await configuredApplication({ environment });
      const result = await application.cleanup({
        all: options.all === true,
        allowDirty: options.allowDirty === true,
        task,
      });
      for (const canonicalTaskId of result.cleaned) {
        process.stdout.write(`Cleaned ${canonicalTaskId}\n`);
      }
      for (const branch of result.preservedBranches) {
        process.stdout.write(`Preserved branch ${branch}\n`);
      }
    });

  const repo = program.command("repo").description("manage repositories in an active workspace");
  repo
    .command("add")
    .argument("<repo>", "local repository name or owner/name")
    .option("--task <task>", "canonical or source-local task ID")
    .option("--verbose", "include debug diagnostics")
    .action(async (repository, options) => {
      const task = await resolveTaskContext({ environment, explicitTask: options.task });
      const application = await configuredApplication({ environment });
      await application.repoAdd({ repository, task });
      process.stdout.write(`Added ${repository} to ${task}\n`);
    });

  const artifact = program.command("artifact").description("record agent-reported artifacts");
  artifact
    .command("add")
    .argument("<locator>", "durable artifact locator")
    .option("--kind <kind>", "artifact kind", "file")
    .option("--title <title>", "artifact title")
    .option("--repo <repository>", "repository name")
    .option("--task <task>", "canonical or source-local task ID")
    .option("--verbose", "include debug diagnostics")
    .action(async (locator, options) => {
      const task = await resolveTaskContext({ environment, explicitTask: options.task });
      const application = await configuredApplication({ environment });
      await application.artifactAdd({
        artifact: {
          kind: options.kind,
          locator,
          repository: options.repo,
          title: options.title,
        },
        task,
      });
      process.stdout.write(`Recorded ${options.kind} ${locator}\n`);
    });

  program
    .command("done")
    .description("complete the active run and write back to its source")
    .option("--outcome <outcome>", "delivered, failed, or stopped", "delivered")
    .option("--message <text>", "completion message")
    .option("--allow-dirty", "permit delivered completion with dirty worktrees")
    .option("--task <task>", "canonical or source-local task ID")
    .option("--verbose", "include debug diagnostics")
    .action(async (options) => {
      const outcome = z.enum(["delivered", "failed", "stopped"]).parse(options.outcome);
      const task = await resolveTaskContext({ environment, explicitTask: options.task });
      const application = await configuredApplication({ environment });
      await application.done({
        allowDirty: options.allowDirty === true,
        message: options.message,
        outcome,
        task,
      });
      process.stdout.write(`Completed ${task} as ${outcome}\n`);
    });

  program.exitOverride();
  try {
    await program.parseAsync([...cliArguments]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!(error instanceof CommanderError && error.exitCode === 0)) {
      process.stderr.write(`${message}\n`);
    }
    process.exitCode =
      error instanceof CommanderError
        ? error.exitCode
        : error instanceof TaskContextError
          ? 3
          : error instanceof Error && error.name === "RepositoryMissingError"
            ? 2
            : 1;
  }
}

export async function loadConfig(input: {
  readonly environment: NodeJS.ProcessEnv;
  readonly workingDirectory?: string;
}): Promise<{ readonly config: Config; readonly configPath: string; readonly paths: PathContext }> {
  const { environment, workingDirectory = process.cwd() } = input;
  const paths = resolvePaths({ environment });
  const explicitPath = environment["GROUNDCREW_CONFIG"];
  const projectPath = join(workingDirectory, "crew.config.jsonc");
  const globalPath = join(paths.configHome, "groundcrew", "crew.config.jsonc");
  const candidates = explicitPath === undefined ? [projectPath, globalPath] : [explicitPath];
  let raw: string | undefined;
  let configPath = "";
  for (const candidate of candidates) {
    try {
      raw = await readFile(candidate, "utf8");
      configPath = candidate;
      break;
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }
    }
  }
  if (raw === undefined) {
    throw new Error(`No config found. Run crew init or set GROUNDCREW_CONFIG.`);
  }

  const parsed: unknown = parse(raw);
  const expanded = expandPathsInConfig({ input: parsed, homeDirectory: paths.homeDirectory });
  return { config: ConfigSchema.parse(expanded), configPath, paths };
}

function resolvePaths(input: { readonly environment: NodeJS.ProcessEnv }): PathContext {
  const { environment } = input;
  const homeDirectory = environment["HOME"] ?? homedir();
  const configHome = environment["XDG_CONFIG_HOME"] ?? join(homeDirectory, ".config");
  const stateHome = environment["XDG_STATE_HOME"] ?? join(homeDirectory, ".local", "state");
  const packageRoot = resolve(import.meta.dirname, "..", "..");
  return { configHome, homeDirectory, packageRoot, stateRoot: join(stateHome, "groundcrew") };
}

async function initialize(input: {
  readonly paths: PathContext;
  readonly overwrite: boolean;
}): Promise<void> {
  const { paths } = input;
  const configPath = join(paths.configHome, "groundcrew", "crew.config.jsonc");
  if (!input.overwrite) {
    try {
      await readFile(configPath, "utf8");
      throw new Error(`${configPath} already exists; pass --yes to replace it`);
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }
    }
  }
  const schemaPath = join(paths.packageRoot, "schema.json");
  const baseDirectory = join(paths.homeDirectory, "dev");
  const config = {
    $schema: pathToFileURL(schemaPath).href,
    workspace: { baseDirectory },
    sources: [{ kind: "linear" }],
  };
  ConfigSchema.parse(config);
  await atomicWrite({ path: configPath, value: `${JSON.stringify(config, undefined, 2)}\n` });
  process.stdout.write(`Created ${configPath}\n`);
}

async function atomicWrite(input: {
  readonly path: string;
  readonly value: string;
}): Promise<void> {
  const { path, value } = input;
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, value, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, path);
}

function expandPathsInConfig(input: {
  readonly input: unknown;
  readonly homeDirectory: string;
}): unknown {
  const { input: value, homeDirectory } = input;
  if (typeof value === "string") {
    return value === "~"
      ? homeDirectory
      : value.startsWith("~/")
        ? join(homeDirectory, value.slice(2))
        : value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => expandPathsInConfig({ homeDirectory, input: entry }));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        expandPathsInConfig({ homeDirectory, input: entry }),
      ]),
    );
  }
  return value;
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function configuredApplication(input: { readonly environment: NodeJS.ProcessEnv }) {
  const loaded = await loadConfig({ environment: input.environment });
  return await createConfiguredApplication({ environment: input.environment, loaded });
}

async function createConfiguredApplication(input: {
  readonly environment: NodeJS.ProcessEnv;
  readonly loaded: Awaited<ReturnType<typeof loadConfig>>;
}) {
  return await createApplication({
    config: input.loaded.config,
    environment: input.environment,
    paths: input.loaded.paths,
  });
}

async function resolveTaskContext(input: {
  readonly environment: NodeJS.ProcessEnv;
  readonly explicitTask?: string | undefined;
}): Promise<string> {
  if (input.explicitTask !== undefined) {
    return input.explicitTask;
  }
  const launchedWorkspace = input.environment["GROUNDCREW_WORKSPACE"];
  if (launchedWorkspace !== undefined) {
    const marker = await readTaskMarker({ directory: launchedWorkspace });
    if (marker !== undefined) {
      return marker.canonicalTaskId;
    }
  }
  let directory = process.cwd();
  for (;;) {
    const marker = await readTaskMarker({ directory });
    if (marker !== undefined) {
      return marker.canonicalTaskId;
    }
    const parent = dirname(directory);
    if (parent === directory) {
      break;
    }
    directory = parent;
  }
  throw new TaskContextError();
}

async function readTaskMarker(input: {
  readonly directory: string;
}): Promise<{ readonly canonicalTaskId: string } | undefined> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(join(input.directory, ".groundcrew", "task.json"), "utf8"),
    );
    return z.object({ canonicalTaskId: z.string() }).parse(parsed);
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined;
    }
    throw error;
  }
}

function renderDispatchProgress(input: { readonly progress: DispatchProgress }): void {
  const { progress } = input;
  if (progress.type === "dispatching") {
    const task = `${progress.canonicalTaskId}(${progress.agentProfile})`;
    process.stdout.write(
      progress.forced
        ? `Dispatching ${task} with concurrency override (${progress.slot - 1}/${progress.maximum} slots used)\n`
        : `Dispatching ${task} into slot ${progress.slot}/${progress.maximum}\n`,
    );
    return;
  }

  const activeTasks =
    progress.active.length === 0
      ? ""
      : ` [${progress.active
          .map(({ agentProfile, canonicalTaskId }) => `${canonicalTaskId}(${agentProfile})`)
          .join(", ")}]`;
  const activeCount = progress.active.length;
  if (activeCount >= progress.maximum && !progress.force) {
    process.stdout.write(
      `At capacity (${activeCount}/${progress.maximum})${activeTasks}, no new work to start\n`,
    );
    return;
  }

  const openCount = Math.max(0, progress.maximum - activeCount);
  process.stdout.write(
    `Slots ${activeCount}/${progress.maximum} used${activeTasks} (${openCount} open)\n`,
  );
}

function renderStatus(input: {
  readonly result: Awaited<ReturnType<Awaited<ReturnType<typeof configuredApplication>>["status"]>>;
}): void {
  if (input.result.tasks.length === 0) {
    process.stdout.write("No local runs or dispatch verdicts.\n");
    return;
  }
  for (const task of input.result.tasks) {
    process.stdout.write(`${task.canonicalTaskId}\n`);
    if (task.verdict !== undefined) {
      process.stdout.write(`  verdict: ${task.verdict.reason} — ${task.verdict.detail}\n`);
    }
    if (task.run !== undefined) {
      process.stdout.write(
        `  run: ${task.run.state}${task.run.outcome === undefined ? "" : ` (${task.run.outcome})`}\n`,
      );
      if (task.accessHint !== undefined) {
        process.stdout.write(`  access: ${task.accessHint}\n`);
      }
    }
    process.stdout.write("  observed Git facts:\n");
    for (const repository of task.observed?.repositories ?? []) {
      process.stdout.write(
        `    ${repository.repository}: ${repository.dirtyPaths.length} dirty paths, ${repository.commitsAhead} commits ahead\n`,
      );
    }
    process.stdout.write("  reported artifacts:\n");
    for (const reportedArtifact of task.reported.artifacts) {
      process.stdout.write(`    ${reportedArtifact.kind}: ${reportedArtifact.locator}\n`);
    }
    if (task.cleanup.refusesForDirtyPaths.length > 0) {
      process.stdout.write(`  cleanup refuses: ${task.cleanup.refusesForDirtyPaths.join(", ")}\n`);
    } else {
      process.stdout.write(
        `  cleanup would remove: ${task.cleanup.wouldRemove.join(", ") || "local task state"}\n`,
      );
    }
  }
}

async function delay(input: { readonly milliseconds: number }): Promise<void> {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, input.milliseconds));
}

class TaskContextError extends Error {
  public constructor() {
    super("no task context; pass --task, set GROUNDCREW_WORKSPACE, or run inside a task workspace");
    this.name = "TaskContextError";
  }
}
