/**
 * The runtime context: the parsed config mapped onto every module's expected
 * shape, plus the shared logger, path roots, source discovery/opening, presenter
 * detection, and the sandbox-wrap policy seam. Commands take a context and stay
 * thin; the joins that differ per module live here in one place.
 *
 * Sandbox wrap policy: the wrap function is a seam (default: no wrap). Wrapping
 * source and agent commands with srt is the sandbox lane's concern; the core
 * lanes run unwrapped so a source's own journaling and store I/O are unconfined.
 */
import * as fs from "node:fs";
import path from "node:path";

import {
  type DiscoveredSource,
  type SourceConfig,
  type SourceHandle,
  type WrapCommand,
  createSecretsResolver,
  discoverSources,
  openSource,
  type SecretsResolver,
} from "../acquisition/index.js";
import { type Logger, type LogLevel, createLogger } from "../logging/index.js";
import type { WritebackCompletion, WritebackPort } from "../run/index.js";
import {
  type AgentProfileConfig,
  type AgentSandboxConfig,
  type PrepareHookSandbox,
  type Presenter,
  createPrepareHookSandbox,
  detectPresenter,
} from "../session/index.js";
import { wrapCommand as sandboxWrapCommand } from "../sandbox/index.js";
import type { AgentRouting, DispatchDeps, DispatchSource } from "../dispatch/index.js";
import type { WorkspaceConfig } from "../workspace/index.js";
import type { Config, SourceConfigSection } from "./config/schema.js";
import { loadConfig, type LoadConfigInput } from "./config/load.js";
import { ConfigError } from "./errors.js";
import {
  type PathEnvironment,
  dispatchFile,
  defaultLogFile,
  expandTilde,
  groundcrewConfigDirectory,
  packageBundlesDirectory,
  stateRoot,
  userBundlesDirectory,
} from "./config/paths.js";
import { effectiveAgents, effectiveSources } from "./detect.js";

/** A configured source joined to its discovered bundle (or the miss). */
export interface ResolvedSource {
  readonly entry: SourceConfigSection;
  /** Effective name (config `name` override, else the `kind`). */
  readonly name: string;
  readonly discovered: DiscoveredSource | undefined;
}

export interface ContextEnvironment extends PathEnvironment {
  readonly PATH?: string;
  readonly GROUNDCREW_WORKSPACE?: string;
  readonly GROUNDCREW_VERBOSE?: string;
  /** Test/CI seam: makes `crew upgrade` print-only (never touches global npm). */
  readonly GROUNDCREW_UPGRADE_PRINT_ONLY?: string;
  readonly [key: string]: string | undefined;
}

export interface LoadContextInput {
  readonly environment: ContextEnvironment;
  readonly cwd: string;
  readonly verbose: boolean;
  /** In-session commands own stdout; their console logging is silent by default. */
  readonly consoleLevel?: LogLevel | "silent";
  /** Sandbox wrap seam; omit for unwrapped spawns (core lanes). */
  readonly wrapCommand?: WrapCommand;
  /**
   * The launching crew's `bin` directory (contracts §9), prepended to each agent
   * session's PATH so in-session `crew` resolves to this installation. `main`
   * derives it from `process.argv[1]`; omit in tests to leave PATH untouched.
   */
  readonly crewBinDir?: string;
}

/** Everything a command needs, derived from the config once. */
export class Context {
  public readonly config: Config;
  public readonly configPath: string;
  public readonly environment: ContextEnvironment;
  public readonly cwd: string;
  public readonly stateRoot: string;
  public readonly dispatchFile: string;
  public readonly logger: Logger;
  public readonly crewBinDir: string | undefined;
  private readonly wrapCommand: WrapCommand | undefined;
  private discoveredCache: DiscoveredSource[] | undefined;
  private secretsResolverCache: SecretsResolver | undefined;

  public constructor(input: {
    config: Config;
    configPath: string;
    environment: ContextEnvironment;
    cwd: string;
    logger: Logger;
    wrapCommand: WrapCommand | undefined;
    crewBinDir: string | undefined;
  }) {
    this.config = input.config;
    this.configPath = input.configPath;
    this.environment = input.environment;
    this.cwd = input.cwd;
    this.stateRoot = stateRoot(input.environment);
    this.dispatchFile = dispatchFile(input.environment);
    this.logger = input.logger;
    this.wrapCommand = input.wrapCommand;
    this.crewBinDir = input.crewBinDir;
  }

  /** The workspace-module view of the config (contracts §2/§5). */
  public workspaceConfig(): WorkspaceConfig {
    const workspace = this.config.workspace;
    const git = this.config.git;
    const repositories = workspace.repositories;
    return {
      baseDirectory: this.expand(workspace.baseDirectory),
      ...(workspace.worktreeDirectory === undefined
        ? {}
        : { worktreeDirectory: this.expand(workspace.worktreeDirectory) }),
      ...(workspace.environment === undefined ? {} : { environment: { ...workspace.environment } }),
      ...(workspace.prepareWorktree === undefined
        ? {}
        : { prepareWorktree: workspace.prepareWorktree }),
      ...(git?.branchPrefix === undefined ? {} : { branchPrefix: git.branchPrefix }),
      ...(git?.remote === undefined ? {} : { remote: git.remote }),
      ...(git?.defaultBranch === undefined ? {} : { defaultBranch: git.defaultBranch }),
      ...(repositories === undefined
        ? {}
        : {
            repositories: Object.fromEntries(
              Object.entries(repositories).map(([name, override]) => [
                name,
                override.prepareWorktree === undefined
                  ? {}
                  : { prepareWorktree: override.prepareWorktree },
              ]),
            ),
          }),
    };
  }

  /** All discovered bundles (package + user), cached (design §6). */
  public discovered(): DiscoveredSource[] {
    this.discoveredCache ??= discoverSources({
      packageBundlesDirectory: packageBundlesDirectory(),
      userBundlesDirectory: userBundlesDirectory(this.environment),
    });
    return this.discoveredCache;
  }

  /** The configured sources joined to their discovered bundles (config order). */
  public resolvedSources(): ResolvedSource[] {
    const discovered = this.discovered();
    return effectiveSources(this.config).map((entry) => {
      const match = discovered.find((source) => source.name === entry.kind);
      return {
        entry,
        name: entry.name ?? entry.kind,
        discovered: match,
      };
    });
  }

  /** Opens a live handle for a resolved source whose bundle is `ok`. */
  public openHandle(resolved: ResolvedSource): SourceHandle | undefined {
    if (resolved.discovered === undefined || resolved.discovered.status !== "ok") {
      return undefined;
    }

    const sourceConfig: SourceConfig = {
      name: resolved.name,
      ...(resolved.entry.environment === undefined
        ? {}
        : { environment: resolved.entry.environment }),
      ...(resolved.entry.sandbox === undefined ? {} : { sandbox: resolved.entry.sandbox }),
    };

    return openSource({
      discovered: resolved.discovered,
      sourceConfig,
      stateRoot: this.stateRoot,
      secretsResolver: this.secretsResolver(),
      parentEnvironment: this.environment,
      logger: this.logger,
      ...(this.wrapCommand === undefined ? {} : { wrapCommand: this.wrapCommand }),
    });
  }

  /** The source a task id belongs to: its `<sourceName>:` prefix (contracts §1). */
  public sourceNameForTask(taskId: string): string | undefined {
    const separator = taskId.indexOf(":");
    return separator === -1 ? undefined : taskId.slice(0, separator);
  }

  /**
   * A Writeback port for a task, driving the owning source's `update` (contracts
   * §4.4). A read-only or unresolvable source yields a silent no-op port.
   */
  public writebackPortForTask(taskId: string): WritebackPort {
    const sourceName = this.sourceNameForTask(taskId);
    const localId = sourceName === undefined ? taskId : taskId.slice(sourceName.length + 1);
    const resolved = this.resolvedSources().find((source) => source.name === sourceName);
    const handle = resolved === undefined ? undefined : this.openHandle(resolved);

    if (handle === undefined || handle.readOnly) {
      return {
        async completed(): Promise<void> {
          // No writable source: nothing to write back.
        },
      };
    }

    const logger = this.logger;
    return {
      async completed(completion: WritebackCompletion): Promise<void> {
        await handle.update(localId, {
          type: "completed",
          outcome: completion.outcome,
          artifacts: completion.artifacts,
          ...(completion.message === undefined ? {} : { message: completion.message }),
        });
        logger.log({
          level: "info",
          module: "shell",
          event: "writeback_sent",
          taskId,
          source: handle.name,
        });
      },
    };
  }

  /** Detect and construct the session presenter (contracts §5, design §8). */
  public presenter(): Presenter {
    return detectPresenter({
      ...(this.config.presenter === undefined ? {} : { configured: this.config.presenter }),
      ...(this.environment.PATH === undefined ? {} : { pathValue: this.environment.PATH }),
    }).presenter;
  }

  /** The optional on-disk secrets store (`secrets.env`); doctor checks its mode. */
  public secretsFilePath(): string {
    return path.join(groundcrewConfigDirectory(this.environment), "secrets.env");
  }

  /** The secrets resolver over the parent env plus an optional `secrets.env`. */
  public secretsResolver(): SecretsResolver {
    if (this.secretsResolverCache === undefined) {
      const secretsPath = this.secretsFilePath();
      const contents = fs.existsSync(secretsPath)
        ? fs.readFileSync(secretsPath, "utf8")
        : undefined;
      this.secretsResolverCache = createSecretsResolver({
        environment: this.environment,
        ...(contents === undefined ? {} : { secretsFileContents: contents }),
      });
    }

    return this.secretsResolverCache;
  }

  /** The declarative profile config for an agent name (contracts §5). */
  public agentProfile(name: string): AgentProfileConfig {
    const profile = this.config.agents?.profiles?.[name];
    if (profile === undefined) {
      return {};
    }

    return {
      ...(profile.command === undefined ? {} : { command: profile.command }),
      ...(profile.resume === undefined ? {} : { resume: profile.resume }),
      ...(profile.model === undefined ? {} : { model: profile.model }),
      ...(profile.effort === undefined ? {} : { effort: profile.effort }),
      ...(profile.environment === undefined ? {} : { environment: { ...profile.environment } }),
    };
  }

  /** The default agent name (`agents.default`), if configured. */
  public defaultAgentName(): string | undefined {
    return this.config.agents?.default;
  }

  /**
   * The Dispatch input model: the parsed config and opened source handles mapped
   * onto {@link DispatchDeps}. Built fresh each call (opens sources, constructs a
   * presenter); `start --watch` builds it once and reuses it across ticks.
   */
  public dispatchDeps(): DispatchDeps {
    const sources: DispatchSource[] = [];
    for (const resolved of this.resolvedSources()) {
      const handle = this.openHandle(resolved);
      if (handle === undefined) {
        continue;
      }

      sources.push({
        handle,
        ...(resolved.entry.agent === undefined ? {} : { defaultAgent: resolved.entry.agent }),
      });
    }

    const detected = effectiveAgents({ config: this.config, pathValue: this.environment.PATH ?? "" });
    const profiles: Record<string, AgentProfileConfig> = {};
    for (const name of Object.keys(detected.profiles)) {
      profiles[name] = this.agentProfile(name);
    }

    const agents: AgentRouting = {
      profiles,
      ...(detected.default === undefined ? {} : { default: detected.default }),
    };

    const sessionEnvironment = this.sessionEnvironment();
    const promptTemplate = this.promptTemplate();

    return {
      stateRoot: this.stateRoot,
      workspaceConfig: this.workspaceConfig(),
      presenter: this.presenter(),
      sources,
      agents,
      maximumInProgress: this.config.orchestrator?.maximumInProgress ?? 4,
      environment: this.ambientEnvironment(),
      // workspace.environment is layered into the agent session env between the
      // ambient env and the profile's own environment (contracts §5/§9).
      ...(sessionEnvironment === undefined ? {} : { sessionEnvironment }),
      // The prompt template rendered per task by dispatch (contracts §5/§9);
      // omitted ⇒ dispatch renders the built-in default template.
      ...(promptTemplate === undefined ? {} : { promptTemplate }),
      // The launching crew's bin dir, prepended to each session's PATH so
      // in-session `crew` is this installation (contracts §9).
      ...(this.crewBinDir === undefined ? {} : { crewBinDir: this.crewBinDir }),
      // Agent sandbox: omit config+wrap when the kill-switch is set (unwrapped),
      // else pass the config slice + agent kinds so Dispatch can compose the full
      // per-task policy at launch (workspace/state/repo grants, contracts §7/§9).
      ...(this.sandboxDisabled()
        ? {}
        : {
            agentSandbox: this.agentSandboxConfig(),
            agentKinds: Object.keys(profiles),
            wrapCommand: sandboxWrapCommand,
          }),
      logger: this.logger,
    };
  }

  /**
   * The config-derived agent sandbox slice: the host-wide read-only dirs and the
   * optional egress allowlist. `network` is present only when the config
   * specifies it, so `composeAgentPolicy` can tell "omitted (⇒ baseline)" from
   * "specified empty (⇒ deny all)".
   */
  public agentSandboxConfig(): AgentSandboxConfig {
    return {
      readOnlyPaths: (this.config.sandbox?.readOnlyDirectories ?? []).map((directory) =>
        this.expand(directory),
      ),
      ...(this.config.sandbox?.network === undefined
        ? {}
        : { network: this.config.sandbox.network }),
      ...(this.config.sandbox?.additionalNetwork === undefined
        ? {}
        : { additionalNetwork: this.config.sandbox.additionalNetwork }),
    };
  }

  /**
   * The sandbox wrapper for the repo-controlled `prepareWorktree` hook, or
   * `undefined` when the kill-switch is set (hook runs unwrapped, like agents and
   * sources). Provisioning injects this DOWN into Workspace so the hook policy is
   * composed at this layer (Workspace imports stay git-only). The policy is
   * profile-neutral and credential-free (see `composeHookPolicy`).
   */
  public prepareHookSandbox(): PrepareHookSandbox | undefined {
    if (this.sandboxDisabled()) {
      return undefined;
    }

    return createPrepareHookSandbox({
      wrapCommand: sandboxWrapCommand,
      configPolicy: this.agentSandboxConfig(),
      environment: this.ambientEnvironment(),
    });
  }

  /**
   * The sandbox kill-switch (contracts §7): `GROUNDCREW_SANDBOX=off` in crew's own
   * environment disables ALL srt wrapping — agent sessions and source processes
   * both run unwrapped. Any other value (or unset) means sandboxing is on.
   */
  public sandboxDisabled(): boolean {
    return isSandboxDisabled(this.environment);
  }

  /** The configured poll cadence (`orchestrator.pollIntervalMilliseconds`). */
  public pollIntervalMilliseconds(): number {
    return this.config.orchestrator?.pollIntervalMilliseconds ?? 120_000;
  }

  /**
   * The non-secret `workspace.environment` layered into agent sessions beneath
   * the profile env (contracts §5/§9); `undefined` when unset.
   */
  public sessionEnvironment(): Record<string, string> | undefined {
    return this.config.workspace.environment === undefined
      ? undefined
      : { ...this.config.workspace.environment };
  }

  /**
   * The per-task prompt template (contracts §5/§9): the `prompts.promptFile`
   * contents (read here, resolved relative to the config file) or the inline
   * `prompts.initial`. Setting both is a config error. `undefined` when neither
   * is set — dispatch then renders the built-in default template.
   */
  public promptTemplate(): string | undefined {
    const prompts = this.config.prompts;
    if (prompts === undefined) {
      return undefined;
    }

    if (prompts.initial !== undefined && prompts.promptFile !== undefined) {
      throw new ConfigError("prompts: set either `initial` or `promptFile`, not both");
    }

    if (prompts.promptFile !== undefined) {
      const expanded = this.expand(prompts.promptFile);
      const resolved = path.isAbsolute(expanded)
        ? expanded
        : path.resolve(path.dirname(this.configPath), expanded);
      try {
        return fs.readFileSync(resolved, "utf8");
      } catch (error) {
        throw new ConfigError(
          `prompts.promptFile could not be read at ${resolved}: ${String(error)}`,
        );
      }
    }

    return prompts.initial;
  }

  /** The ambient (orchestrator) environment as a defined string map for launches. */
  public ambientEnvironment(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(this.environment)) {
      if (value !== undefined) {
        result[key] = value;
      }
    }

    return result;
  }

  /** Expand a leading `~` in a config path against `$HOME`. */
  public expand(value: string): string {
    return expandTilde({ value, environment: this.environment });
  }
}

/** Loads config and builds the runtime context (throws ConfigError/V1ConfigError). */
export function loadContext(input: LoadContextInput): Context {
  const loaded = loadConfig(loadConfigInput(input));
  const logger = buildLogger({
    config: loaded.config,
    environment: input.environment,
    verbose: input.verbose,
    ...(input.consoleLevel === undefined ? {} : { consoleLevel: input.consoleLevel }),
  });

  // Source-process wrapping honours the kill-switch too (precedence: kill-switch
  // → per-source `sandbox:false`, applied inside openSource → wrap).
  const wrapCommand =
    input.wrapCommand ?? (isSandboxDisabled(input.environment) ? undefined : sandboxWrapCommand);

  return new Context({
    config: loaded.config,
    configPath: loaded.path,
    environment: input.environment,
    cwd: input.cwd,
    logger,
    wrapCommand,
    crewBinDir: input.crewBinDir,
  });
}

/** The `GROUNDCREW_SANDBOX=off` kill-switch predicate (contracts §7). */
export function isSandboxDisabled(environment: ContextEnvironment): boolean {
  return environment["GROUNDCREW_SANDBOX"] === "off";
}

/** Builds the logger from config + verbosity (contracts §6, design §10.3). */
export function buildLogger(input: {
  readonly config: Config;
  readonly environment: PathEnvironment;
  readonly verbose: boolean;
  readonly consoleLevel?: LogLevel | "silent";
}): Logger {
  const filePath =
    input.config.logging?.file === undefined
      ? defaultLogFile(input.environment)
      : expandTilde({ value: input.config.logging.file, environment: input.environment });
  const consoleLevel: LogLevel | "silent" = input.verbose
    ? "debug"
    : (input.consoleLevel ?? "silent");

  return createLogger({ filePath, consoleLevel });
}

function loadConfigInput(input: LoadContextInput): LoadConfigInput {
  return { environment: input.environment, cwd: input.cwd };
}
