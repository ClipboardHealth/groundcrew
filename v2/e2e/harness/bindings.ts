/**
 * Command bindings: the single module that maps the catalog's abstract
 * operations (catalog §1.3) onto concrete `crew` invocations and computed
 * expectations. Scenarios speak only in these terms; the CLI surface is here.
 *
 * Every spawn uses the scenario's hermetic env and captures stdout/stderr/exit
 * code for assertion. Paths and expectations are computed from contracts §1–§2
 * (slug rules in `identity.ts`), never read back out of the tool.
 *
 * Contract assumptions flagged for scenario writers and core implementers:
 *  - The fixture source's store path is passed via the config source's
 *    `environment.FIXTURE_STORE`; core must forward `sources[].environment` to
 *    the source process (contracts §4.1/§5 support this).
 *  - The scripted agent's script directory is passed via the agent profile's
 *    `environment` (GROUNDCREW_TEST_AGENT_SCRIPT). Contracts §5 does not show an
 *    `environment` key on agent profiles; this harness assumes core injects it
 *    into the launched session. If core chooses another mechanism, only
 *    `configure` here changes.
 */

import * as fs from "node:fs";
import path from "node:path";

import { execa } from "execa";

import { run } from "./exec.js";
import type { RunResult } from "./exec.js";
import { installFixtureSource } from "./fixtureSource.js";
import type { FixtureSource, FixtureStore } from "./fixtureSource.js";
import { branchFor, sessionFor, taskSlug } from "./identity.js";
import type { Scenario } from "./scenario.js";
import { agentScriptsDirectory, installScriptedAgent } from "./scriptedAgent.js";
import type { Task } from "./schemas.js";

export interface SourceFixture {
  readonly name?: string;
  readonly kind?: string;
  readonly agent?: string;
  readonly sandbox?: boolean;
  readonly readOnly?: boolean;
  readonly environment?: Readonly<Record<string, string>>;
}

export interface AgentProfileFixture {
  readonly command?: string;
  readonly resume?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly environment?: Readonly<Record<string, string>>;
}

export interface ConfigFixture {
  readonly baseDirectory?: string;
  readonly worktreeDirectory?: string;
  readonly repositories?: Readonly<
    Record<string, { workingDirectory?: string; prepareWorktree?: string }>
  >;
  readonly sources?: readonly SourceFixture[];
  readonly defaultAgent?: string;
  readonly agentProfiles?: Readonly<Record<string, AgentProfileFixture>>;
  readonly maximumInProgress?: number;
  readonly pollIntervalMilliseconds?: number;
  readonly branchPrefix?: string;
  readonly presenter?: string;
  readonly sandbox?: { readonly readOnlyDirectories?: string[]; readonly network?: string[] };
  readonly initialPrompt?: string;
  readonly loggingFile?: string;
}

export interface CommandOptions {
  readonly force?: boolean;
  readonly agent?: string;
}

export interface CleanupOptions {
  readonly force?: boolean;
  readonly all?: boolean;
}

export interface HarnessPaths {
  worktreeFor(repo: string, taskId: string): string;
  workspaceFor(taskId: string): string;
  workspaceMarkerFor(taskId: string): string;
  stateFor(taskId: string): string;
  readonly logFile: string;
  readonly dispatchFile: string;
}

export interface HarnessExpectations {
  branchFor(taskId: string): string;
  sessionFor(taskId: string): string;
}

export interface OrchestratorHandle {
  /** Sends a signal to the watch process (default SIGKILL). */
  kill(signal?: NodeJS.Signals): void;
  /** Resolves when the watch process has exited. Never rejects. */
  whenExited(): Promise<void>;
}

export interface Bindings {
  readonly scenario: Scenario;
  /** The installed fixture sources, in config order. */
  readonly sources: readonly FixtureSource[];
  /** The first (usually only) fixture source. */
  readonly source: FixtureSource;
  readonly configPath: string;
  readonly paths: HarnessPaths;
  readonly expect: HarnessExpectations;

  seedSource(tasks: readonly Task[] | FixtureStore): void;

  tick(): Promise<RunResult>;
  start(taskId: string, options?: CommandOptions): Promise<RunResult>;
  pause(taskId: string): Promise<RunResult>;
  resume(taskId: string, options?: { fresh?: boolean }): Promise<RunResult>;
  cleanup(taskId?: string, options?: CleanupOptions): Promise<RunResult>;
  status(taskId?: string): Promise<RunResult>;
  doctor(): Promise<RunResult>;
  sourceDoctor(): Promise<RunResult>;
  sourceList(): Promise<RunResult>;
  init(args?: readonly string[]): Promise<RunResult>;
  /** Runs the `crew` binary with arbitrary args (for surfaces not yet bound). */
  crew(args: readonly string[]): Promise<RunResult>;

  startWatch(): OrchestratorHandle;
  killOrchestrator(signal?: NodeJS.Signals): void;
  restart(): OrchestratorHandle;
}

const DEFAULT_SOURCE_NAME = "fixture";
const DEFAULT_AGENT = "scripted";
const DEFAULT_BRANCH_PREFIX = "crew";
const DEFAULT_PRESENTER = "tmux";

/**
 * Writes `crew.config.jsonc` into the scenario, installs the fixture sources
 * and the scripted agent, and returns the bound command surface. This is the
 * catalog's `configure(fixture)` operation plus setup the CLI needs.
 */
export function configure(input: {
  readonly scenario: Scenario;
  readonly config?: ConfigFixture;
}): Bindings {
  const { scenario } = input;
  const config = input.config ?? {};

  const baseDirectory = config.baseDirectory ?? scenario.baseDirectory;
  const worktreeDirectory =
    config.worktreeDirectory ?? path.join(baseDirectory, ".groundcrew", "worktrees");
  const branchPrefix = config.branchPrefix ?? DEFAULT_BRANCH_PREFIX;
  const logFile = config.loggingFile ?? path.join(scenario.stateRoot, "groundcrew.jsonl");
  const dispatchFile = path.join(scenario.stateRoot, "dispatch.json");

  installScriptedAgent({ scenario });

  const { installed, sourceEntries } = installSources({ scenario, config });
  const firstSource = installed[0];
  if (firstSource === undefined) {
    throw new Error("configure requires at least one source fixture");
  }

  const configObject = buildConfigObject({
    scenario,
    config,
    baseDirectory,
    worktreeDirectory,
    branchPrefix,
    logFile,
    sourceEntries,
  });
  const configPath = path.join(scenario.groundcrewConfigDirectory, "crew.config.jsonc");
  writeConfig({ configPath, configObject });

  return buildBindings({
    scenario,
    sources: installed,
    firstSource,
    configPath,
    worktreeDirectory,
    branchPrefix,
    logFile,
    dispatchFile,
  });
}

function installSources(input: {
  readonly scenario: Scenario;
  readonly config: ConfigFixture;
}): { installed: FixtureSource[]; sourceEntries: Array<Record<string, unknown>> } {
  const { scenario, config } = input;
  const installed: FixtureSource[] = [];
  const sourceEntries: Array<Record<string, unknown>> = [];

  for (const fixture of config.sources ?? [{}]) {
    const name = fixture.name ?? DEFAULT_SOURCE_NAME;
    const handle = installFixtureSource({
      scenario,
      name,
      ...(fixture.readOnly === undefined ? {} : { readOnly: fixture.readOnly }),
    });
    installed.push(handle);

    sourceEntries.push({
      kind: fixture.kind ?? name,
      name,
      agent: fixture.agent ?? DEFAULT_AGENT,
      sandbox: fixture.sandbox ?? true,
      environment: { FIXTURE_STORE: handle.storePath, ...fixture.environment },
    });
  }

  return { installed, sourceEntries };
}

function buildConfigObject(input: {
  readonly scenario: Scenario;
  readonly config: ConfigFixture;
  readonly baseDirectory: string;
  readonly worktreeDirectory: string;
  readonly branchPrefix: string;
  readonly logFile: string;
  readonly sourceEntries: ReadonlyArray<Record<string, unknown>>;
}): Record<string, unknown> {
  const { scenario, config, baseDirectory, worktreeDirectory, branchPrefix, logFile, sourceEntries } =
    input;

  return {
    workspace: {
      baseDirectory,
      worktreeDirectory,
      ...(config.repositories === undefined ? {} : { repositories: config.repositories }),
    },
    sources: sourceEntries,
    agents: {
      default: config.defaultAgent ?? DEFAULT_AGENT,
      profiles: buildAgentProfiles({
        config,
        scriptsDirectory: agentScriptsDirectory({ scenario }),
      }),
    },
    orchestrator: {
      maximumInProgress: config.maximumInProgress ?? 4,
      ...(config.pollIntervalMilliseconds === undefined
        ? {}
        : { pollIntervalMilliseconds: config.pollIntervalMilliseconds }),
    },
    git: { remote: "origin", defaultBranch: "main", branchPrefix },
    presenter: config.presenter ?? DEFAULT_PRESENTER,
    ...(config.sandbox === undefined ? {} : { sandbox: config.sandbox }),
    ...(config.initialPrompt === undefined
      ? {}
      : { prompts: { initial: config.initialPrompt } }),
    logging: { file: logFile },
  };
}

function buildAgentProfiles(input: {
  readonly config: ConfigFixture;
  readonly scriptsDirectory: string;
}): Record<string, Record<string, unknown>> {
  const { config, scriptsDirectory } = input;
  const fixtures = config.agentProfiles ?? { [DEFAULT_AGENT]: {} };
  const profiles: Record<string, Record<string, unknown>> = {};

  for (const [name, fixture] of Object.entries(fixtures)) {
    const profile: Record<string, unknown> = {
      command: fixture.command ?? "scripted-agent {{prompt}}",
      resume: fixture.resume ?? "scripted-agent --resume {{sessionId}}",
      environment: {
        GROUNDCREW_TEST_AGENT_SCRIPT: scriptsDirectory,
        ...fixture.environment,
      },
    };
    if (fixture.model !== undefined) {
      profile["model"] = fixture.model;
    }

    if (fixture.effort !== undefined) {
      profile["effort"] = fixture.effort;
    }

    profiles[name] = profile;
  }

  return profiles;
}

function buildBindings(input: {
  readonly scenario: Scenario;
  readonly sources: readonly FixtureSource[];
  readonly firstSource: FixtureSource;
  readonly configPath: string;
  readonly worktreeDirectory: string;
  readonly branchPrefix: string;
  readonly logFile: string;
  readonly dispatchFile: string;
}): Bindings {
  const { scenario, sources, firstSource, configPath, worktreeDirectory, branchPrefix, logFile, dispatchFile } =
    input;

  const paths: HarnessPaths = {
    worktreeFor(repo: string, taskId: string): string {
      return path.join(worktreeDirectory, taskSlug({ taskId }), repo);
    },
    workspaceFor(taskId: string): string {
      return path.join(worktreeDirectory, taskSlug({ taskId }));
    },
    workspaceMarkerFor(taskId: string): string {
      return path.join(worktreeDirectory, taskSlug({ taskId }), ".groundcrew", "task.json");
    },
    stateFor(taskId: string): string {
      return path.join(scenario.stateRoot, "runs", `${taskSlug({ taskId })}.json`);
    },
    logFile,
    dispatchFile,
  };

  const expect: HarnessExpectations = {
    branchFor(taskId: string): string {
      return branchFor({ taskId, branchPrefix });
    },
    sessionFor(taskId: string): string {
      return sessionFor({ taskId });
    },
  };

  async function crew(args: readonly string[]): Promise<RunResult> {
    const [executable, ...baseArgs] = scenario.crewBinCommand;
    if (executable === undefined) {
      throw new Error("scenario.crewBinCommand is empty");
    }

    return await run({
      command: executable,
      args: [...baseArgs, ...args],
      cwd: scenario.baseDirectory,
      env: scenario.env,
      timeoutMilliseconds: 60_000,
    });
  }

  let orchestrator: OrchestratorHandle | undefined;

  function startWatch(): OrchestratorHandle {
    const [executable, ...baseArgs] = scenario.crewBinCommand;
    if (executable === undefined) {
      throw new Error("scenario.crewBinCommand is empty");
    }

    const child = execa(executable, [...baseArgs, "start", "--watch"], {
      cwd: scenario.baseDirectory,
      env: scenario.env,
      extendEnv: false,
      reject: false,
    });

    const handle: OrchestratorHandle = {
      kill(signal: NodeJS.Signals = "SIGKILL"): void {
        child.kill(signal);
      },
      async whenExited(): Promise<void> {
        await child;
      },
    };
    orchestrator = handle;
    return handle;
  }

  return {
    scenario,
    sources,
    source: firstSource,
    configPath,
    paths,
    expect,

    seedSource(tasks: readonly Task[] | FixtureStore): void {
      if (isFixtureStore(tasks)) {
        firstSource.seed(tasks);
      } else {
        firstSource.seed({ tasks: [...tasks] });
      }
    },

    async tick(): Promise<RunResult> {
      return await crew(["start"]);
    },
    async start(taskId: string, options?: CommandOptions): Promise<RunResult> {
      const args = ["start", taskId];
      if (options?.force === true) {
        args.push("--force");
      }

      if (options?.agent !== undefined) {
        args.push("--agent", options.agent);
      }

      return await crew(args);
    },
    async pause(taskId: string): Promise<RunResult> {
      return await crew(["pause", taskId]);
    },
    async resume(taskId: string, options?: { fresh?: boolean }): Promise<RunResult> {
      const args = ["resume", taskId];
      if (options?.fresh === true) {
        args.push("--fresh");
      }

      return await crew(args);
    },
    async cleanup(taskId?: string, options?: CleanupOptions): Promise<RunResult> {
      const args = ["cleanup"];
      if (options?.all === true) {
        args.push("--all");
      } else if (taskId !== undefined) {
        args.push(taskId);
      }

      if (options?.force === true) {
        args.push("--force");
      }

      return await crew(args);
    },
    async status(taskId?: string): Promise<RunResult> {
      return await crew(taskId === undefined ? ["status"] : ["status", taskId]);
    },
    async doctor(): Promise<RunResult> {
      return await crew(["doctor"]);
    },
    async sourceDoctor(): Promise<RunResult> {
      return await crew(["source", "doctor"]);
    },
    async sourceList(): Promise<RunResult> {
      return await crew(["source", "list"]);
    },
    async init(args?: readonly string[]): Promise<RunResult> {
      return await crew(["init", ...(args ?? [])]);
    },
    crew,

    startWatch,
    killOrchestrator(signal: NodeJS.Signals = "SIGKILL"): void {
      orchestrator?.kill(signal);
    },
    restart(): OrchestratorHandle {
      return startWatch();
    },
  };
}

function isFixtureStore(value: readonly Task[] | FixtureStore): value is FixtureStore {
  return !Array.isArray(value);
}

function writeConfig(input: {
  readonly configPath: string;
  readonly configObject: unknown;
}): void {
  const header =
    "// Generated by the groundcrew e2e harness (contracts §5). JSONC; comments allowed.\n";
  fs.writeFileSync(
    input.configPath,
    header + JSON.stringify(input.configObject, undefined, 2) + "\n",
  );
}
