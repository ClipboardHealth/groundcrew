/**
 * The source adapter (design §12.1): the SINGLE seam that turns the result-shaped
 * process boundary into the module's internal model. Given a discovered bundle
 * it returns a {@link SourceHandle} whose `list`/`get`/`update` spawn the bundle's
 * command scripts, write one JSON object on stdin, and read one result object
 * from stdout — mapping a nonzero exit, unparseable stdout, a timeout, or a spawn
 * failure to the SAME failure ({@link SourceProtocolError}). stderr is diagnostics,
 * logged only.
 */
import * as fs from "node:fs";
import path from "node:path";

import { execa } from "execa";
import type { z } from "zod";

import type { Logger } from "../logging/index.js";
import type { SandboxPolicy, WrapCommandInput, WrappedCommand } from "../sandbox/index.js";
import type { DiscoveredSource, DiscoveredSourceOk } from "./discover.js";
import { MissingSecretError, SourceProtocolError } from "./errors.js";
import type { SourceFailureKind } from "./errors.js";
import {
  getDataSchema,
  listDataSchema,
  protocolEnvelopeSchema,
  updateResultSchema,
} from "./protocol.js";
import type { SourceCommand, Task, UpdateResult, WritebackEvent } from "./protocol.js";
import { createSecretsResolver } from "./secrets.js";
import type { SecretsResolver } from "./secrets.js";

/** The sandbox wrap seam, injected so tests spawn unwrapped and wiring injects srt. */
export type WrapCommand = (input: WrapCommandInput) => Promise<WrappedCommand>;

/** Per-source config that Dispatch/Shell forward from `crew.config.jsonc` (contracts §5). */
export interface SourceConfig {
  /** Source name override; defaults to the discovered name. */
  readonly name?: string;
  /** Non-secret env merged OVER the manifest's `environment` (contracts §4.1). */
  readonly environment?: Readonly<Record<string, string>>;
  /** `false` opts this source out of the sandbox — loud in status/doctor (design §6). */
  readonly sandbox?: boolean;
}

/** The env name of the per-source scratch dir, granted read-write in the sandbox (contracts §4.1). */
export const SOURCE_SCRATCH_ENV = "GROUNDCREW_SOURCE_SCRATCH";

/** Default per-invocation budget (contracts leave this open; chosen: 30s). */
export const DEFAULT_SOURCE_TIMEOUT_MILLISECONDS = 30_000;

/**
 * A live source: the module's internal representation of a discovered bundle,
 * driving the versioned protocol. `list`/`get` throw {@link SourceProtocolError}
 * on any failure; `update` returns its result (a `rejected` claim is a value,
 * not a failure) and is a silent no-op on a read-only source.
 */
export interface SourceHandle {
  readonly name: string;
  /** No `update` command ⇒ read-only; `update()` no-ops with zero spawns (COMPLETE-05). */
  readonly readOnly: boolean;
  /** True when config set `sandbox: false`; status/doctor flags it (design §6). */
  readonly sandboxOptOut: boolean;
  /** Declared secrets that did not resolve; doctor surfaces these (not a spawn crash). */
  readonly missingSecrets: readonly string[];
  list(): Promise<Task[]>;
  get(id: string): Promise<Task>;
  update(id: string, event: WritebackEvent): Promise<UpdateResult>;
}

export interface OpenSourceInput {
  readonly discovered: DiscoveredSource;
  readonly sourceConfig?: SourceConfig;
  readonly stateRoot: string;
  readonly secretsResolver?: SecretsResolver;
  /** Injected sandbox wrap; omit for an unwrapped spawn (tests). */
  readonly wrapCommand?: WrapCommand;
  readonly logger?: Logger;
  /** Orchestrator env for PATH/HOME passthrough and default secret resolution. Default `process.env`. */
  readonly parentEnvironment?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMilliseconds?: number;
}

/**
 * Opens a discovered source for invocation. Pre-creates the per-source scratch
 * dir before any spawn (contracts §4.1) and resolves declared secrets eagerly so
 * a missing one is a recorded health finding, not a spawn-time crash.
 */
export function openSource(input: OpenSourceInput): SourceHandle {
  const discovered = requireOk(input.discovered);
  const sourceConfig = input.sourceConfig ?? {};
  // oxlint-disable-next-line node/no-process-env -- default passthrough of the orchestrator env (PATH/HOME, ambient secrets) for source spawns
  const parentEnvironment = input.parentEnvironment ?? process.env;
  const name = sourceConfig.name ?? discovered.name;

  const scratchDirectory = path.join(input.stateRoot, "source-scratch", name);
  fs.mkdirSync(scratchDirectory, { recursive: true });

  const resolver =
    input.secretsResolver ?? createSecretsResolver({ environment: parentEnvironment });
  const { secretEnvironment, missingSecrets } = resolveSecrets({
    declared: discovered.manifest.secrets,
    resolver,
  });

  const environment = composeEnvironment({
    manifestEnvironment: discovered.manifest.environment,
    configEnvironment: sourceConfig.environment ?? {},
    secretEnvironment,
    scratchDirectory,
    parentEnvironment,
  });

  const sandboxOptOut = sourceConfig.sandbox === false;
  const effectiveWrap = sandboxOptOut ? undefined : input.wrapCommand;
  const policy: SandboxPolicy = {
    readOnlyPaths: [discovered.bundleDirectory],
    writablePaths: [scratchDirectory],
    network: discovered.manifest.network,
  };
  const timeoutMilliseconds = input.timeoutMilliseconds ?? DEFAULT_SOURCE_TIMEOUT_MILLISECONDS;

  async function invoke(input2: {
    readonly command: SourceCommand;
    readonly commandPath: string;
    readonly payload: unknown;
  }): Promise<unknown> {
    const absoluteCommand = path.resolve(discovered.bundleDirectory, input2.commandPath);
    const result = await spawn({
      source: name,
      command: input2.command,
      absoluteCommand,
      payload: input2.payload,
      environment,
      timeoutMilliseconds,
      wrapCommand: effectiveWrap,
      policy,
      logger: input.logger,
    });
    return result;
  }

  return {
    name,
    readOnly: discovered.readOnly,
    sandboxOptOut,
    missingSecrets,
    async list(): Promise<Task[]> {
      const data = await invoke({
        command: "list",
        commandPath: discovered.manifest.commands.list,
        payload: {},
      });
      return parseData({ source: name, command: "list", schema: listDataSchema, data }).tasks;
    },
    async get(id: string): Promise<Task> {
      const getCommand = discovered.manifest.commands.get;
      if (getCommand === undefined) {
        throw new SourceProtocolError({
          source: name,
          command: "get",
          kind: "spawn-failure",
          message: "source exposes no `get` command",
        });
      }

      const data = await invoke({ command: "get", commandPath: getCommand, payload: { id } });
      return parseData({ source: name, command: "get", schema: getDataSchema, data }).task;
    },
    async update(id: string, event: WritebackEvent): Promise<UpdateResult> {
      const updateCommand = discovered.manifest.commands.update;
      // Read-only by omission: no spawn, silent no-op (COMPLETE-05 journals zero update calls).
      if (updateCommand === undefined) {
        return { result: "ok" };
      }

      const data = await invoke({
        command: "update",
        commandPath: updateCommand,
        payload: { id, event },
      });
      return parseData({ source: name, command: "update", schema: updateResultSchema, data });
    },
  };
}

/**
 * Builds the {@link MissingSecretError} for a handle's unresolved secrets, or
 * `undefined` when none are missing. Doctor uses this to render the finding.
 */
export function missingSecretError(handle: SourceHandle): MissingSecretError | undefined {
  if (handle.missingSecrets.length === 0) {
    return undefined;
  }

  return new MissingSecretError({ source: handle.name, secretNames: handle.missingSecrets });
}

function requireOk(discovered: DiscoveredSource): DiscoveredSourceOk {
  if (discovered.status !== "ok") {
    throw new Error(
      `openSource requires a supported source; ${discovered.name} is ${discovered.status}`,
    );
  }

  return discovered;
}

function resolveSecrets(input: {
  readonly declared: readonly string[];
  readonly resolver: SecretsResolver;
}): { secretEnvironment: Record<string, string>; missingSecrets: string[] } {
  const secretEnvironment: Record<string, string> = {};
  const missingSecrets: string[] = [];

  for (const secretName of input.declared) {
    const value = input.resolver.resolve(secretName);
    if (value === undefined) {
      missingSecrets.push(secretName);
    } else {
      secretEnvironment[secretName] = value;
    }
  }

  return { secretEnvironment, missingSecrets };
}

/**
 * The source env is NOT the parent env wholesale (deny-by-default). It is built
 * as: manifest.environment ← config environment ← resolved secrets ←
 * GROUNDCREW_SOURCE_SCRATCH ← a minimal PATH/HOME passthrough needed to run node
 * scripts (contracts §4.1).
 */
function composeEnvironment(input: {
  readonly manifestEnvironment: Readonly<Record<string, string>>;
  readonly configEnvironment: Readonly<Record<string, string>>;
  readonly secretEnvironment: Readonly<Record<string, string>>;
  readonly scratchDirectory: string;
  readonly parentEnvironment: Readonly<Record<string, string | undefined>>;
}): Record<string, string> {
  const environment: Record<string, string> = {
    ...input.manifestEnvironment,
    ...input.configEnvironment,
    ...input.secretEnvironment,
    [SOURCE_SCRATCH_ENV]: withTrailingSeparator(input.scratchDirectory),
  };

  for (const key of ["PATH", "HOME"]) {
    const value = input.parentEnvironment[key];
    if (value !== undefined) {
      environment[key] = value;
    }
  }

  return environment;
}

function withTrailingSeparator(directory: string): string {
  return directory.endsWith(path.sep) ? directory : directory + path.sep;
}

async function spawn(input: {
  readonly source: string;
  readonly command: SourceCommand;
  readonly absoluteCommand: string;
  readonly payload: unknown;
  readonly environment: Readonly<Record<string, string>>;
  readonly timeoutMilliseconds: number;
  readonly wrapCommand: WrapCommand | undefined;
  readonly policy: SandboxPolicy;
  readonly logger: Logger | undefined;
}): Promise<unknown> {
  const stdin = JSON.stringify(input.payload);
  const commonOptions = {
    reject: false as const,
    extendEnv: false as const,
    stripFinalNewline: false as const,
    env: input.environment,
    input: stdin,
    timeout: input.timeoutMilliseconds,
  };

  const result =
    input.wrapCommand === undefined
      ? await execa(input.absoluteCommand, [], commonOptions)
      : await execa((await input.wrapCommand({ command: input.absoluteCommand, policy: input.policy })).command, [], {
          ...commonOptions,
          shell: true,
        });

  logStderr({
    logger: input.logger,
    source: input.source,
    command: input.command,
    stderr: asString(result.stderr),
  });

  return interpret({
    source: input.source,
    command: input.command,
    exitCode: typeof result.exitCode === "number" ? result.exitCode : undefined,
    timedOut: result.timedOut,
    failed: result.failed,
    stdout: asString(result.stdout),
  });
}

/** Maps a finished process to protocol data, or throws the one failure shape. */
function interpret(input: {
  readonly source: string;
  readonly command: SourceCommand;
  readonly exitCode: number | undefined;
  readonly timedOut: boolean;
  readonly failed: boolean;
  readonly stdout: string;
}): unknown {
  if (input.timedOut) {
    throw failure(input, "timeout", "invocation timed out");
  }

  if (input.exitCode === undefined) {
    throw failure(input, "spawn-failure", input.failed ? "process could not be started" : "process did not report an exit code");
  }

  if (input.exitCode !== 0) {
    throw failure(input, "nonzero-exit", `exited with code ${String(input.exitCode)}`, input.exitCode);
  }

  let json: unknown;
  try {
    json = JSON.parse(input.stdout.trim());
  } catch {
    throw failure(input, "unparseable-stdout", "stdout was not valid JSON");
  }

  const envelope = protocolEnvelopeSchema.safeParse(json);
  if (!envelope.success) {
    throw failure(input, "unparseable-stdout", "stdout was not a result-shaped object");
  }

  if (!envelope.data.ok) {
    throw failure(input, "protocol-failure", envelope.data.error.message);
  }

  return envelope.data.data;
}

function parseData<Schema extends z.ZodType>(input: {
  readonly source: string;
  readonly command: SourceCommand;
  readonly schema: Schema;
  readonly data: unknown;
}): z.infer<Schema> {
  const parsed = input.schema.safeParse(input.data);
  if (!parsed.success) {
    throw new SourceProtocolError({
      source: input.source,
      command: input.command,
      kind: "unparseable-stdout",
      message: "success data did not match the protocol shape",
    });
  }

  return parsed.data;
}

function failure(
  context: { readonly source: string; readonly command: SourceCommand },
  kind: SourceFailureKind,
  message: string,
  exitCode?: number,
): SourceProtocolError {
  return new SourceProtocolError({
    source: context.source,
    command: context.command,
    kind,
    message,
    exitCode,
  });
}

function logStderr(input: {
  readonly logger: Logger | undefined;
  readonly source: string;
  readonly command: SourceCommand;
  readonly stderr: string;
}): void {
  const trimmed = input.stderr.trim();
  if (input.logger === undefined || trimmed === "") {
    return;
  }

  input.logger.log({
    level: "debug",
    module: "acquisition",
    event: "source_stderr",
    source: input.source,
    msg: trimmed,
    fields: { command: input.command },
  });
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}
