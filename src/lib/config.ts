import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { type ParseError, parse as parseJsonc, printParseErrorCode } from "jsonc-parser";
import { z } from "zod";

import { BUILD_SECRET_NAMES } from "./buildSecrets.ts";
import { SPRITE_REMOTE_PROVIDER_DEFAULTS } from "./spriteRemoteRunnerProvider.ts";
import { log, readEnvironmentVariable, setLogFile } from "./util.ts";

export { BUILD_SECRET_NAMES } from "./buildSecrets.ts";
export { DEFAULT_REMOTE_SETUP_COMMAND } from "./remoteSetupCommand.ts";

/**
 * Reserved model name. A ticket labeled `agent-any` resolves at runtime
 * to the configured model with the most available session capacity, so
 * `any` cannot itself be a model. orchestrator.ts imports this constant
 * so the reserved name lives in one place.
 */
export const AGENT_ANY_MODEL = "any";

export type WorkspaceRunner = "local" | "remote";

export const WORKSPACE_RUNNERS: readonly WorkspaceRunner[] = ["local", "remote"] as const;

export const REMOTE_RUNNER_PROVIDER_NAMES = ["sprite"] as const;

export type RemoteRunnerProviderName = (typeof REMOTE_RUNNER_PROVIDER_NAMES)[number];

export function isRemoteRunnerProviderName(value: unknown): value is RemoteRunnerProviderName {
  return (
    typeof value === "string" && (REMOTE_RUNNER_PROVIDER_NAMES as readonly string[]).includes(value)
  );
}

/**
 * Which terminal session manager hosts the agent process:
 *
 * - `auto`: pick the first available — cmux on macOS when installed,
 *   else tmux.
 * - `cmux`: require the cmux binary; fail loudly if missing.
 * - `tmux`: require the tmux binary; fail loudly if missing.
 */
export type WorkspaceKindSetting = "auto" | "cmux" | "tmux";

export const WORKSPACE_KIND_SETTINGS: readonly WorkspaceKindSetting[] = [
  "auto",
  "cmux",
  "tmux",
] as const;

export interface ModelDefinition {
  /**
   * Shell command launched for the model. For local runs this is wrapped
   * with Safehouse/clearance; for remote runs it executes inside the remote
   * runner workspace. The rendered prompt is appended as a single quoted
   * positional argument. `{{worktree}}` is replaced before launch.
   */
  cmd: string;
  color: string;
  usage?: {
    codexbar: { provider: string; source?: string };
  };
}

export interface RemoteRunnerConfig {
  provider: RemoteRunnerProviderName;
  runnerName: string;
  owner: string;
  repoRoot: string;
  worktreeRoot: string;
  secretNames: string[];
}

/**
 * Setup command run inside sibling worktrees on the host. The host is
 * assumed to already have the right Node and npm versions, so this skips
 * the `n`/global-npm bootstrap that the remote setup command does.
 */
export const DEFAULT_HOST_SETUP_COMMAND =
  "if [ -x .claude/setup.sh ]; then ./.claude/setup.sh --deps-only; elif [ -f .claude/setup.sh ] && command -v bash >/dev/null 2>&1; then bash .claude/setup.sh --deps-only; else npm clean-install; fi";

const PERCENT_MIN_EXCLUSIVE = 0;
const PERCENT_MAX = 100;

const ENV_VAR_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;
// Linear project URL slugs end with a 12-char lowercase hex `slugId`.
const SLUG_ID_RE = /-([\da-f]{12})$/i;

const stringNonEmpty = z.string().trim().min(1);

const StatusesSchema = z
  .object({
    todo: stringNonEmpty.optional(),
    inProgress: stringNonEmpty.optional(),
    done: stringNonEmpty.optional(),
    terminal: z.array(stringNonEmpty).optional(),
  })
  .strict();

const LinearSchema = z
  .object({
    /**
     * Project URL slug as it appears in Linear's URL bar — e.g.
     * `ai-strategy-5152195762f3`. The trailing 12-character hex `slugId`
     * is what's used for the GraphQL filter; the leading name segment
     * keeps the config self-documenting and survives project renames.
     */
    projectSlug: stringNonEmpty.refine((value: string) => SLUG_ID_RE.test(value), {
      error: (issue) =>
        `must end with a 12-character hex slugId (got ${JSON.stringify(issue.input)}). Copy the trailing segment from your Linear project URL, e.g. "ai-strategy-5152195762f3" from "https://linear.app/<workspace>/project/ai-strategy-5152195762f3".`,
    }),
    statuses: StatusesSchema.optional(),
  })
  .strict();

const GitSchema = z
  .object({
    remote: stringNonEmpty.optional(),
    defaultBranch: stringNonEmpty.optional(),
  })
  .strict();

const WorkspaceSchema = z
  .object({
    /** Parent directory under which groundcrew clones repos and creates per-ticket worktrees. */
    projectDir: stringNonEmpty,
    /** Repos searched for in ticket descriptions; non-empty. */
    knownRepositories: z.array(stringNonEmpty).min(1, "must be a non-empty array"),
  })
  .strict();

const OrchestratorSchema = z
  .object({
    maximumInProgress: z.number().int().min(1).optional(),
    pollIntervalMilliseconds: z.number().int().min(1).optional(),
    sessionLimitPercentage: z.number().gt(PERCENT_MIN_EXCLUSIVE).lte(PERCENT_MAX).optional(),
  })
  .strict();

const ModelUsageSchema = z
  .object({
    codexbar: z
      .object({
        provider: stringNonEmpty,
        source: stringNonEmpty.optional(),
      })
      .strict(),
  })
  .strict();

// `disabled` is allowed here as an optional literal `true` so legacy
// pre-validation can run first and produce specific errors for invalid
// shapes (e.g. `disabled: "true"`, `disabled: true` mixed with `cmd`).
// By the time zod sees the entry, either everything else is unset or
// preValidateDisabledFlag has already failed.
const ModelDefSchema = z
  .object({
    cmd: stringNonEmpty.optional(),
    color: stringNonEmpty.optional(),
    usage: ModelUsageSchema.optional(),
    disabled: z.literal(true).optional(),
  })
  .strict();

const ModelsSchema = z
  .object({
    default: stringNonEmpty.optional(),
    definitions: z.record(z.string(), ModelDefSchema).optional(),
  })
  .strict();

const PromptsSchema = z
  .object({
    initial: stringNonEmpty.optional(),
  })
  .strict();

const RemoteSchema = z
  .object({
    provider: z.enum(REMOTE_RUNNER_PROVIDER_NAMES).optional(),
    runnerName: stringNonEmpty.optional(),
    owner: stringNonEmpty.optional(),
    repoRoot: stringNonEmpty.optional(),
    worktreeRoot: stringNonEmpty.optional(),
    secretNames: z
      .array(stringNonEmpty.regex(ENV_VAR_NAME_RE, "must be a valid environment variable name"))
      .optional(),
  })
  .strict();

const LoggingSchema = z
  .object({
    file: stringNonEmpty.optional(),
  })
  .strict();

export const ConfigSchema = z
  .object({
    linear: LinearSchema,
    git: GitSchema.optional(),
    workspace: WorkspaceSchema,
    orchestrator: OrchestratorSchema.optional(),
    models: ModelsSchema.optional(),
    prompts: PromptsSchema.optional(),
    workspaceKind: z.enum(WORKSPACE_KIND_SETTINGS).optional(),
    remote: RemoteSchema.optional(),
    logging: LoggingSchema.optional(),
  })
  .strict();

/**
 * Loose user-facing shape — what a `config.jsonc` file declares.
 * Fields with defaults are optional; only `linear.projectSlug` and the
 * `workspace.*` fields are required.
 */
export type Config = z.input<typeof ConfigSchema>;

/**
 * Strict shape after defaults are applied — what scripts work with.
 */
export interface ResolvedConfig {
  linear: {
    /** Original full slug from `Config.linear.projectSlug` — for log lines. */
    projectSlug: string;
    /** 12-char hex tail of `projectSlug` — the value Linear filters on. */
    slugId: string;
    statuses: {
      todo: string;
      inProgress: string;
      done: string;
      terminal: string[];
    };
  };
  git: {
    remote: string;
    defaultBranch: string;
  };
  workspace: {
    projectDir: string;
    knownRepositories: string[];
  };
  orchestrator: {
    maximumInProgress: number;
    pollIntervalMilliseconds: number;
    sessionLimitPercentage: number;
  };
  models: {
    default: string;
    definitions: Record<string, ModelDefinition>;
  };
  prompts: {
    initial: string;
  };
  /**
   * Terminal session manager. Always present — defaults to `"auto"`.
   * `auto` resolves to cmux on macOS when installed, else tmux.
   */
  workspaceKind: WorkspaceKindSetting;
  remote: RemoteRunnerConfig;
  logging: {
    file: string;
  };
}

const DEFAULT_STATUSES: ResolvedConfig["linear"]["statuses"] = {
  todo: "Todo",
  inProgress: "In Progress",
  done: "Done",
  terminal: ["Done"],
};

const DEFAULT_GIT: ResolvedConfig["git"] = {
  remote: "origin",
  defaultBranch: "main",
};

const DEFAULT_ORCHESTRATOR: ResolvedConfig["orchestrator"] = {
  maximumInProgress: 4,
  pollIntervalMilliseconds: 120_000,
  sessionLimitPercentage: 85,
};

const DEFAULT_MODEL_DEFINITIONS: Record<string, ModelDefinition> = {
  claude: {
    cmd: "claude --permission-mode bypassPermissions",
    color: "#C15F3C",
    usage: { codexbar: { provider: "claude" } },
  },
  codex: {
    cmd: "codex --dangerously-bypass-approvals-and-sandbox",
    color: "#3267e3",
    usage: { codexbar: { provider: "codex" } },
  },
};

const DEFAULT_PROMPT_INITIAL = [
  "Begin work on {{ticket}} ({{title}}) in the {{worktree}} wt subdirectory.",
  "",
  "Ticket description:",
  "",
  "{{description}}",
].join("\n");

const DEFAULT_REMOTE: ResolvedConfig["remote"] = {
  ...SPRITE_REMOTE_PROVIDER_DEFAULTS,
  secretNames: [...BUILD_SECRET_NAMES],
};

const ALLOWED_PROMPT_PLACEHOLDERS = new Set([
  "{{ticket}}",
  "{{worktree}}",
  "{{title}}",
  "{{description}}",
]);
const PROMPT_PLACEHOLDER_RE = /{{[^{}]*}}/g;

// import.meta.dirname is `<package>/src/lib`; the user's `config.jsonc`
// lives at the package root (gitignored), two levels up. Last-resort
// fallback when neither GROUNDCREW_CONFIG nor the XDG path resolves to
// a file.
const PACKAGE_CONFIG_PATH = resolve(import.meta.dirname, "..", "..", "config.jsonc");

function xdgBase(envName: string, fallbackSegments: readonly string[]): string {
  const override = readEnvironmentVariable(envName);
  if (override !== undefined && override.length > 0) {
    return override;
  }
  return resolve(homedir(), ...fallbackSegments);
}

function xdgConfigPath(...segments: string[]): string {
  return resolve(xdgBase("XDG_CONFIG_HOME", [".config"]), ...segments);
}

function xdgStatePath(...segments: string[]): string {
  return resolve(xdgBase("XDG_STATE_HOME", [".local", "state"]), ...segments);
}

function defaultLogFile(): string {
  return xdgStatePath("groundcrew", "groundcrew.log");
}

function resolveConfigPath(): string {
  const override = readEnvironmentVariable("GROUNDCREW_CONFIG");
  if (override !== undefined && override.length > 0) {
    return resolve(override);
  }
  const xdgJsonc = xdgConfigPath("groundcrew", "config.jsonc");
  if (existsSync(xdgJsonc)) {
    return xdgJsonc;
  }
  const xdgLegacyTs = xdgConfigPath("groundcrew", "config.ts");
  if (existsSync(xdgLegacyTs)) {
    fail(
      `${xdgLegacyTs} is a legacy TypeScript config. Groundcrew now reads JSONC; convert it with \`node "$(npm root -g)/@clipboard-health/groundcrew/scripts/migrateConfigToJsonc.mts" ${xdgLegacyTs}\` (preserves comments) and then rerun \`crew doctor\`.`,
    );
  }
  return PACKAGE_CONFIG_PATH;
}

function expandHome(p: string): string {
  if (p === "~") {
    return homedir();
  }
  if (p.startsWith("~/")) {
    return resolve(homedir(), p.slice(2));
  }
  return p;
}

function fail(message: string): never {
  throw new Error(`groundcrew config: ${message}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    out.push(value);
  }
  return out;
}

function cloneModelDefinition(definition: ModelDefinition): ModelDefinition {
  return structuredClone(definition);
}

function formatPath(path: readonly PropertyKey[]): string {
  let out = "";
  for (const segment of path) {
    /* v8 ignore next 3 @preserve -- JSON keys are never symbols, defensive only */
    if (typeof segment === "symbol") {
      continue;
    }
    if (typeof segment === "number") {
      out += `[${segment}]`;
    } else if (out.length === 0) {
      out += segment;
    } else {
      out += `.${segment}`;
    }
  }
  return out;
}

function formatZodIssue(issue: z.core.$ZodIssue): string {
  const path = formatPath(issue.path);
  // Rewrite zod's default messages for the cases tests rely on. Anything
  // else falls back to zod's own message — still readable, just less
  // tailored to the CLI's path-prefixed conventions.
  let humanMessage = issue.message;
  if (issue.code === "invalid_type") {
    if (issue.expected === "object") {
      humanMessage = "must be an object";
    } else if (issue.expected === "array") {
      humanMessage = "must be an array";
    }
  } else if (issue.code === "too_small" && issue.origin === "string") {
    humanMessage = "must be a non-empty string";
  }
  /* v8 ignore next @preserve -- the root object is gated by isPlainObject, so every issue has a non-empty path */
  return path.length > 0 ? `${path} ${humanMessage}` : humanMessage;
}

function failFromZod(error: z.ZodError): never {
  /* v8 ignore next @preserve -- zod always reports at least one issue on failure */
  const first = error.issues[0] ?? {
    code: "custom",
    message: "unknown validation error",
    path: [],
  };
  fail(formatZodIssue(first));
}

function preValidateLegacyKeys(raw: unknown): void {
  /* v8 ignore next 3 @preserve -- loadConfig already enforces raw is a plain object */
  if (!isPlainObject(raw)) {
    return;
  }
  const { models, remote } = raw;
  if (isPlainObject(models) && Object.hasOwn(models, "isolation")) {
    fail(
      "models.isolation is no longer supported: local isolation is always Safehouse; remove this key",
    );
  }
  if (isPlainObject(models) && isPlainObject(models["definitions"])) {
    for (const [name, override] of Object.entries(models["definitions"])) {
      if (!isPlainObject(override)) {
        continue;
      }
      if (Object.hasOwn(override, "isolation")) {
        fail(
          `models.definitions.${name}.isolation is no longer supported: per-model isolation is no longer supported`,
        );
      }
      if (Object.hasOwn(override, "sandbox")) {
        fail(
          `models.definitions.${name}.sandbox is no longer supported: Docker Sandboxes are no longer supported`,
        );
      }
    }
  }
  if (isPlainObject(remote) && Object.hasOwn(remote, "sprite")) {
    fail(
      "remote.sprite is no longer supported: use remote.provider, remote.runnerName, remote.owner, remote.repoRoot, remote.worktreeRoot, and remote.secretNames",
    );
  }
}

function preValidateDisabledFlag(raw: unknown): void {
  /* v8 ignore next 3 @preserve -- loadConfig already enforces raw is a plain object */
  if (!isPlainObject(raw)) {
    return;
  }
  const { models } = raw as { models?: unknown };
  if (!isPlainObject(models)) {
    return;
  }
  const { definitions } = models as { definitions?: unknown };
  if (!isPlainObject(definitions)) {
    return;
  }
  for (const [name, override] of Object.entries(definitions)) {
    if (!isPlainObject(override)) {
      continue;
    }
    if (!Object.hasOwn(override, "disabled")) {
      continue;
    }
    if (override["disabled"] !== true) {
      fail(
        `models.definitions.${name}.disabled must be exactly \`true\` when set (got ${JSON.stringify(override["disabled"])})`,
      );
    }
    const conflicting = (["cmd", "color", "usage"] as const).filter((key) =>
      Object.hasOwn(override, key),
    );
    if (conflicting.length > 0) {
      fail(
        `models.definitions.${name}: cannot combine \`disabled: true\` with other fields (${conflicting.join(", ")}). Either disable the model or override its fields, not both.`,
      );
    }
  }
}

/**
 * True when `name` is a shipped default the user removed via `disabled: true`.
 * Derived from absence in `definitions` — that's the only path that removes a
 * shipped default. Consumers needing to distinguish disabled-by-user from
 * unknown-label use this.
 */
export function isShippedDefaultDisabled(
  config: Pick<ResolvedConfig, "models">,
  name: string,
): boolean {
  return (
    Object.hasOwn(DEFAULT_MODEL_DEFINITIONS, name) &&
    !Object.hasOwn(config.models.definitions, name)
  );
}

function mergeDefinitions(
  user: NonNullable<Config["models"]>["definitions"] | undefined,
): Record<string, ModelDefinition> {
  const merged: Record<string, ModelDefinition> = Object.fromEntries(
    Object.entries(DEFAULT_MODEL_DEFINITIONS).map(([name, definition]) => [
      name,
      cloneModelDefinition(definition),
    ]),
  );
  for (const [name, override] of Object.entries(user ?? {})) {
    /* v8 ignore next 3 @preserve -- Object.entries never yields undefined values for plain objects */
    if (override === undefined) {
      continue;
    }
    if ("disabled" in override && override.disabled === true) {
      if (!Object.hasOwn(DEFAULT_MODEL_DEFINITIONS, name)) {
        fail(
          `models.definitions.${name}: \`disabled: true\` is only valid for shipped defaults (${Object.keys(DEFAULT_MODEL_DEFINITIONS).join(", ")}). Remove the entry instead.`,
        );
      }
      // oxlint-disable-next-line typescript/no-dynamic-delete -- `merged` is a fresh function-local clone of DEFAULT_MODEL_DEFINITIONS
      delete merged[name];
      continue;
    }

    const base: Partial<ModelDefinition> =
      merged[name] === undefined ? {} : cloneModelDefinition(merged[name]);
    const candidate: Partial<ModelDefinition> = { ...base };
    if ("cmd" in override && override.cmd !== undefined) {
      candidate.cmd = override.cmd;
    }
    if ("color" in override && override.color !== undefined) {
      candidate.color = override.color;
    }
    if ("usage" in override && override.usage !== undefined) {
      candidate.usage =
        override.usage.codexbar.source === undefined
          ? { codexbar: { provider: override.usage.codexbar.provider } }
          : {
              codexbar: {
                provider: override.usage.codexbar.provider,
                source: override.usage.codexbar.source,
              },
            };
    }
    const { cmd, color, usage } = candidate;
    if (typeof cmd !== "string" || cmd.length === 0) {
      fail(`models.definitions.${name}.cmd must be a non-empty string`);
    }
    if (typeof color !== "string" || color.length === 0) {
      fail(`models.definitions.${name}.color must be a non-empty string`);
    }
    const definition: ModelDefinition = { cmd, color };
    if (usage !== undefined) {
      definition.usage = usage;
    }
    merged[name] = definition;
  }
  return merged;
}

function normalizeStatuses(
  user: NonNullable<Config["linear"]>["statuses"],
): ResolvedConfig["linear"]["statuses"] {
  const todo = user?.todo ?? DEFAULT_STATUSES.todo;
  const inProgress = user?.inProgress ?? DEFAULT_STATUSES.inProgress;
  const done = user?.done ?? DEFAULT_STATUSES.done;
  const terminal = user?.terminal ?? [];
  return {
    todo,
    inProgress,
    done,
    terminal: uniqueStrings([...terminal, done]),
  };
}

function normalizeRemote(user: Config["remote"]): ResolvedConfig["remote"] {
  return {
    provider: user?.provider ?? DEFAULT_REMOTE.provider,
    runnerName: user?.runnerName ?? DEFAULT_REMOTE.runnerName,
    owner: user?.owner ?? DEFAULT_REMOTE.owner,
    repoRoot: user?.repoRoot ?? DEFAULT_REMOTE.repoRoot,
    worktreeRoot: user?.worktreeRoot ?? DEFAULT_REMOTE.worktreeRoot,
    secretNames: [...(user?.secretNames ?? DEFAULT_REMOTE.secretNames)],
  };
}

function extractSlugId(slug: string): string {
  const match = SLUG_ID_RE.exec(slug);
  /* v8 ignore next 3 @preserve -- LinearSchema's refine rejects bad slugs before we get here */
  if (match?.[1] === undefined) {
    fail(`linear.projectSlug missing slugId tail (got ${JSON.stringify(slug)})`);
  }
  return match[1].toLowerCase();
}

function applyDefaults(user: Config): ResolvedConfig {
  return {
    linear: {
      projectSlug: user.linear.projectSlug,
      slugId: extractSlugId(user.linear.projectSlug),
      statuses: normalizeStatuses(user.linear.statuses),
    },
    git: {
      remote: user.git?.remote ?? DEFAULT_GIT.remote,
      defaultBranch: user.git?.defaultBranch ?? DEFAULT_GIT.defaultBranch,
    },
    workspace: {
      projectDir: expandHome(user.workspace.projectDir),
      knownRepositories: [...user.workspace.knownRepositories],
    },
    orchestrator: {
      maximumInProgress:
        user.orchestrator?.maximumInProgress ?? DEFAULT_ORCHESTRATOR.maximumInProgress,
      pollIntervalMilliseconds:
        user.orchestrator?.pollIntervalMilliseconds ??
        DEFAULT_ORCHESTRATOR.pollIntervalMilliseconds,
      sessionLimitPercentage:
        user.orchestrator?.sessionLimitPercentage ?? DEFAULT_ORCHESTRATOR.sessionLimitPercentage,
    },
    models: {
      default: user.models?.default ?? "claude",
      definitions: mergeDefinitions(user.models?.definitions),
    },
    prompts: {
      initial: user.prompts?.initial ?? DEFAULT_PROMPT_INITIAL,
    },
    workspaceKind: user.workspaceKind ?? "auto",
    remote: normalizeRemote(user.remote),
    logging: {
      file: expandHome(user.logging?.file ?? defaultLogFile()),
    },
  };
}

function validatePromptPlaceholders(template: string): void {
  const placeholders = template.match(PROMPT_PLACEHOLDER_RE) ?? [];
  const unknown = placeholders.find((placeholder) => !ALLOWED_PROMPT_PLACEHOLDERS.has(placeholder));
  if (unknown !== undefined) {
    fail(
      `prompts.initial contains unknown placeholder ${JSON.stringify(unknown)}. Allowed placeholders: ${[...ALLOWED_PROMPT_PLACEHOLDERS].join(", ")}`,
    );
  }
}

function validate(config: ResolvedConfig): void {
  const { definitions } = config.models;
  /* v8 ignore next 3 @preserve -- mergeDefinitions seeds claude+codex defaults */
  if (Object.keys(definitions).length === 0) {
    fail("models.definitions must contain at least one model");
  }
  if (AGENT_ANY_MODEL in definitions) {
    fail(
      `models.definitions cannot contain "${AGENT_ANY_MODEL}" — it is reserved for the agent-any label, which routes to the model with the most available session capacity`,
    );
  }

  // Disabled-default check must run before the generic "not a key" check so
  // the user gets the specific "is disabled" message instead of a stale-list
  // message they can't act on without realizing they need to re-enable.
  if (isShippedDefaultDisabled(config, config.models.default)) {
    fail(
      `models.default ("${config.models.default}") is disabled. Either re-enable it or set models.default to an enabled model.`,
    );
  }
  if (!(config.models.default in definitions)) {
    fail(
      `models.default ("${config.models.default}") is not a key in models.definitions (have: ${Object.keys(definitions).join(", ")})`,
    );
  }

  validatePromptPlaceholders(config.prompts.initial);
}

function describeJsoncErrors(path: string, errors: ParseError[]): never {
  const messages = errors
    .map((error) => `${printParseErrorCode(error.error)} at offset ${error.offset}`)
    .join("; ");
  fail(`${path} is not valid JSONC: ${messages}`);
}

let cached: Readonly<ResolvedConfig> | undefined;

export async function loadConfig(): Promise<Readonly<ResolvedConfig>> {
  if (cached) {
    return cached;
  }

  const path = resolveConfigPath();
  if (!existsSync(path)) {
    fail(
      `${path} not found. Copy configExample.jsonc to ${xdgConfigPath("groundcrew", "config.jsonc")} (or set GROUNDCREW_CONFIG to a different path) and edit it.`,
    );
  }
  log(`Loaded config from ${path}`);

  const source = readFileSync(path, "utf8");
  const errors: ParseError[] = [];
  const raw: unknown = parseJsonc(source, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    describeJsoncErrors(path, errors);
  }
  if (!isPlainObject(raw)) {
    fail(`${path} must contain a JSON object at the top level`);
  }

  preValidateLegacyKeys(raw);
  preValidateDisabledFlag(raw);

  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    failFromZod(parsed.error);
  }

  const resolved = applyDefaults(parsed.data);
  validate(resolved);

  setLogFile(resolved.logging.file);

  cached = Object.freeze(resolved);
  return cached;
}
