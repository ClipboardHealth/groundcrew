import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { cosmiconfig, type CosmiconfigResult, type Loader } from "cosmiconfig";

import type { LinearAdapterConfig } from "./adapters/linear/schema.ts";
import type { ShellAdapterConfig } from "./adapters/shell/schema.ts";
import { debug, log, readEnvironmentVariable, setLogFile } from "./util.ts";
import { xdgConfigPath, xdgStatePath } from "./xdg.ts";

import { BUILD_SECRET_NAMES } from "./buildSecrets.ts";

export { BUILD_SECRET_NAMES } from "./buildSecrets.ts";

/**
 * Discriminated union of all built-in adapter config shapes. Used at
 * config-load time as the static type for `Config.sources[]` and
 * `ResolvedConfig.sources[]`. The runtime Zod validation lives in each
 * adapter's `schema.ts` and runs at `buildSources` time, not here.
 */
export type SourceConfig = LinearAdapterConfig | ShellAdapterConfig;

export interface HookCommands {
  prepareWorktree?: string;
}

/**
 * Reserved model name. A task labeled `agent-any` resolves at runtime
 * to the configured model with the most available session capacity, so
 * `any` cannot itself be a model. orchestrator.ts imports this constant
 * so the reserved name lives in one place.
 */
export const AGENT_ANY_MODEL = "any";

/**
 * Which terminal session manager hosts the agent process:
 *
 * - `auto`: pick the first available — cmux when installed, else tmux.
 * - `cmux`: require the cmux binary; fail loudly if missing.
 * - `tmux`: require the tmux binary; fail loudly if missing.
 */
export type WorkspaceKindSetting = "auto" | "cmux" | "tmux";

export const WORKSPACE_KIND_SETTINGS: readonly WorkspaceKindSetting[] = [
  "auto",
  "cmux",
  "tmux",
] as const;

/**
 * Concrete local isolation backend selected for a launch. `safehouse` is
 * macOS-only (clearance HTTP-egress + sandbox profile); `srt` is Anthropic's
 * sandbox-runtime (macOS `sandbox-exec` + Linux `bubblewrap`, with a built-in
 * network allowlist) — a fast, non-Docker option on both macOS and Linux/WSL;
 * `sdx` is Docker Sandboxes (`sbx` CLI) — works on Linux and macOS and is the
 * only known option that lets the agent use Docker safely without exposing the
 * host socket; `none` is an explicit unsandboxed escape hatch.
 */
export type LocalRunner = "safehouse" | "srt" | "sdx" | "none";

/**
 * User-facing local runner setting. `auto` resolves at launch time:
 * macOS picks `safehouse`, Linux picks `sdx`. `srt` and `none` are never
 * picked implicitly — both are opt-in via an explicit `local.runner`.
 */
export type LocalRunnerSetting = LocalRunner | "auto";

export const LOCAL_RUNNER_SETTINGS: readonly LocalRunnerSetting[] = [
  "auto",
  "safehouse",
  "srt",
  "sdx",
  "none",
] as const;

/**
 * Per-model Docker Sandboxes (sdx) binding. Required at launch when
 * `local.runner` resolves to `sdx` so groundcrew knows which existing
 * sbx sandbox to address.
 */
export interface SandboxDefinition {
  /** sbx agent name (e.g. "claude", "codex"). */
  agent: string;
}

export interface ModelDefinition {
  /**
   * Shell command launched for the model. Wrapped with Safehouse/clearance
   * for execution. The rendered prompt is appended as a single quoted
   * positional argument. `{{worktree}}` is replaced before launch.
   *
   * Keep this agent-native (e.g., `claude --permission-mode auto`).
   * Groundcrew adds the Safehouse wrapper.
   */
  cmd: string;
  /**
   * Optional shell snippet run in the launch shell **before** the agent is
   * exec'd and **outside** Safehouse/sdx. Use to mint short-lived credentials
   * (e.g. `export SESSION_TOKEN=...`) that the wrapped `cmd` inherits via
   * the process environment. `{{worktree}}` is replaced before launch.
   * Failures abort launch (unlike prepareWorktree, which logs and continues).
   * Not supported for `local.runner` `sdx` in v1.
   */
  preLaunch?: string;
  /**
   * Optional list of env var names to forward from the launch shell into
   * the agent under the safehouse runner. Companion to `preLaunch` —
   * names exported by `preLaunch` go here so groundcrew appends them to
   * the `safehouse-clearance` wrap's `--env-pass=` flag, preserving the
   * project's egress allowlist (`clearance-allow-hosts`) without forcing
   * the user to rewrite `cmd`. Under `local.runner: "none"` exports flow
   * through unchanged, so `preLaunchEnv` is a no-op. An empty array is a
   * uniform no-op in every runner (it forwards zero names, so the
   * unsupported-runner guards do not fire). A non-empty list is rejected
   * when `local.runner` resolves to `sdx` in v1, and when `cmd` already
   * starts with `safehouse` (the user owns env forwarding in that case).
   * Each name must match `[A-Za-z_][A-Za-z0-9_]*` (POSIX env var name).
   */
  preLaunchEnv?: string[];
  color: string;
  usage?: {
    codexbar: { provider: string; source?: string };
  };
  /**
   * Docker Sandboxes binding. Required when `local.runner` resolves to
   * `sdx` — pure additive: omitted models can still run under `safehouse`
   * or `none` without surprise.
   */
  sandbox?: SandboxDefinition;
}

/**
 * User-facing model entry shape. Built-in model names (`claude`, `codex`)
 * accept empty or partial entries because they merge over built-in presets.
 * Brand-new model names must supply enough fields to satisfy `validate()`.
 *
 * `usage` accepts an extra `{ disabled: true }` sentinel that strips the
 * usage block from the merged definition — the only way to opt a shipped
 * preset out of codexbar gating without removing the model entirely.
 */
type UserUsage = ModelDefinition["usage"] | { disabled: true };
type EnabledUserModelDefinition = Partial<Omit<ModelDefinition, "usage">> & {
  usage?: UserUsage;
};
type UserModelDefinition = EnabledUserModelDefinition;

/**
 * Loose user-facing shape — what a `config.ts` file declares.
 * Fields with defaults are optional; only `workspace.*` is required.
 *
 * Groundcrew's built-in Linear adapter is implicit and needs no config:
 * it picks up every Linear issue assigned to the API key's viewer that
 * carries an `agent-*` label. There is no project or view configuration.
 * Linear's default "In Progress" / "In Review" status names disambiguate
 * `started` workflow states; unmatched statuses fall back to `state.type`.
 */
/**
 * A configured repository. The bare-string form keeps the repo under
 * `workspace.projectDir`; the object form's optional `projectDirOverride`
 * overrides that parent directory so repos can live in more than one place.
 */
export interface KnownRepository {
  name: string;
  projectDirOverride?: string;
}

export interface Config {
  /**
   * Additional pluggable task sources beyond the built-in Linear adapter
   * (which is always implicit). Each entry is a `SourceConfig` discriminated
   * by `kind`. The most common use is a `kind: "shell"` adapter that wires
   * an external system (Jira, plan-keeper, etc.) by pointing at command
   * templates that emit/consume JSON.
   *
   * The implicit Linear source can be turned off with the opt-out sentinel
   * `{ kind: "linear", enabled: false }` — useful for shell-only setups with
   * no Linear API key, where a failing Linear probe would otherwise take down
   * the whole queue.
   *
   * Per-source Zod validation runs at `buildSources` time — config.ts only
   * verifies the structural shape (array of objects with a string `kind`).
   */
  sources?: SourceConfig[];
  git?: {
    remote?: string;
    defaultBranch?: string;
    /**
     * Overrides the prefix groundcrew puts in front of the task id when it
     * names a worktree branch (`<branchPrefix>-<task>`). Defaults to the OS
     * account username when unset. Must be a git-ref-safe, slash-free slug.
     */
    branchPrefix?: string;
  };
  workspace: {
    projectDir: string;
    /**
     * Parent directory all per-task worktrees are created under. Defaults
     * to `projectDir` when unset, so single-directory setups are unchanged.
     */
    worktreeDir?: string;
    knownRepositories: (string | KnownRepository)[];
  };
  defaults?: {
    hooks?: HookCommands;
  };
  orchestrator?: {
    maximumInProgress?: number;
    pollIntervalMilliseconds?: number;
    sessionLimitPercentage?: number;
  };
  models?: {
    default?: string;
    /**
     * Explicit enabled model set. Built-in keys (`claude`, `codex`) merge over
     * their presets, so `{ claude: {} }` enables Claude with the shipped
     * command/color/usage. Brand-new model names must supply enough fields to
     * satisfy `validate()`.
     */
    definitions?: Record<string, UserModelDefinition>;
  };
  prompts?: {
    initial?: string;
  };
  /**
   * Terminal session manager that hosts agent processes. Defaults to
   * `"auto"` — cmux on macOS when installed, else tmux. Set explicitly
   * to fail loudly when the chosen backend is missing.
   */
  workspaceKind?: WorkspaceKindSetting;
  /**
   * Local isolation backend selector. Defaults to `"auto"` (macOS →
   * safehouse, Linux → sdx). `"none"` is an explicit unsandboxed escape
   * hatch — never selected implicitly.
   */
  local?: {
    runner?: LocalRunnerSetting;
  };
  logging?: {
    /**
     * Append-mode log file destination. `log()` and `logEvent()` tee here
     * in addition to stdout, so a vanished workspace doesn't take the
     * evidence with it. Defaults to
     * `${XDG_STATE_HOME:-~/.local/state}/groundcrew/groundcrew.log`.
     */
    file?: string;
  };
}

/**
 * Strict shape after defaults are applied — what scripts work with.
 */
export interface ResolvedConfig {
  /**
   * Resolved list of additional task sources beyond the built-in Linear
   * adapter. Defaults to `[]` when the user omits `sources` in their config.
   * Each entry's per-adapter validation is the responsibility of `buildSources`,
   * not the config loader.
   */
  sources: SourceConfig[];
  git: {
    remote: string;
    defaultBranch: string;
    branchPrefix?: string;
  };
  workspace: {
    projectDir: string;
    /** Resolved worktree root; unset means "use projectDir". */
    worktreeDir?: string;
    /** Repository names only — the union's `projectDirOverride`s are lifted out. */
    knownRepositories: string[];
    /** name -> resolved parent dir, only for entries that override projectDir. */
    repositoryDirs?: Record<string, string>;
  };
  defaults: {
    hooks: HookCommands;
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
   * `auto` resolves to cmux when installed, else tmux.
   */
  workspaceKind: WorkspaceKindSetting;
  /**
   * Local isolation selection. The user-facing `auto` is preserved here
   * so `localRunner.resolve()` can pick the platform default later — the
   * resolver is the only place that knows the host capabilities.
   */
  local: {
    runner: LocalRunnerSetting;
  };
  logging: {
    file: string;
  };
}

/**
 * Parent directory under which a repository's clone lives. The per-repo
 * `projectDirOverride` wins; otherwise repos sit under `projectDir`.
 */
export function repositoryBaseDir(config: ResolvedConfig, repository: string): string {
  return config.workspace.repositoryDirs?.[repository] ?? config.workspace.projectDir;
}

/**
 * Parent directory all worktrees are created under, independent of where the
 * source repositories live. Falls back to `projectDir` when `worktreeDir` is
 * unset.
 */
export function worktreeBaseDir(config: ResolvedConfig): string {
  return config.workspace.worktreeDir ?? config.workspace.projectDir;
}

export type ConfigSourceKind = "env" | "project" | "xdg";

export interface ConfigSource {
  kind: ConfigSourceKind;
  filepath: string;
}

export interface LoadedConfig {
  config: Readonly<ResolvedConfig>;
  source: Readonly<ConfigSource>;
}

const DEFAULT_GIT: ResolvedConfig["git"] = {
  remote: "origin",
  defaultBranch: "main",
};

const DEFAULT_ORCHESTRATOR: ResolvedConfig["orchestrator"] = {
  maximumInProgress: 4,
  pollIntervalMilliseconds: 120_000,
  sessionLimitPercentage: 85,
};

const BUILT_IN_MODEL_DEFINITIONS: Record<string, ModelDefinition> = {
  claude: {
    cmd: "claude --permission-mode auto",
    color: "#C15F3C",
    usage: { codexbar: { provider: "claude" } },
  },
  codex: {
    cmd: "codex --dangerously-bypass-approvals-and-sandbox",
    color: "#3267e3",
    usage: { codexbar: { provider: "codex" } },
  },
};

const MODEL_DEFINITIONS_MIGRATION_MESSAGE = [
  "configuration migration required: models are no longer enabled by default.",
  "",
  "Add the models you want to use:",
  "",
  "models: {",
  '  default: "claude",',
  "  definitions: {",
  "    claude: {},",
  "  },",
  "},",
  "",
  "To keep the previous claude+codex behavior:",
  "",
  "models: {",
  '  default: "claude",',
  "  definitions: {",
  "    claude: {},",
  "    codex: {},",
  "  },",
  "},",
  "",
  "`disabled: true` is no longer supported; remove disabled model entries instead.",
].join("\n");

const DEFAULT_PROMPT_INITIAL = [
  "You are working on task {{task}} ({{title}}) in the {{worktree}} worktree subdirectory.",
  "",
  "Task description:",
  "",
  "{{description}}",
  "",
  "## Operating mode",
  "",
  "There is no human watching this session. Do not stop to ask clarifying questions. When the task is ambiguous or incomplete, choose the simplest reasonable interpretation consistent with the task and the codebase, then document that choice in the output.",
  "{{workspaceContinuationInstruction}}",
  "",
  "## Workflow",
  "",
  "1. Inspect the repo instructions and existing patterns before edits.",
  "2. Implement the smallest sensible change that completes the task.",
  "3. Run the repo's documented verification command. If no documented command exists, run the smallest relevant test suite you can find and fix failures you introduced before continuing.",
  "4. Follow the task description for output. If no output instructions exist, open a PR with `Closes {{task}}` in the description. If you cannot open one, leave the branch ready and record the blocker.",
].join("\n");

const ALLOWED_PROMPT_PLACEHOLDERS = new Set([
  "{{task}}",
  "{{worktree}}",
  "{{title}}",
  "{{description}}",
  "{{workspaceContinuationInstruction}}",
]);
const PROMPT_PLACEHOLDER_RE = /{{[^{}]*}}/g;

const PERCENT_MIN_EXCLUSIVE = 0;
const PERCENT_MAX = 100;

function defaultLogFile(): string {
  return xdgStatePath("groundcrew", "groundcrew.log");
}

function expandHome(p: string): string {
  if (p === "~") {
    return homedir();
  }
  if (p.startsWith("~/")) {
    return path.resolve(homedir(), p.slice(2));
  }
  return p;
}

function fail(message: string): never {
  throw new Error(`groundcrew config: ${message}`);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function requireString(value: unknown, configKey: string): asserts value is string {
  if (!isNonEmptyString(value)) {
    fail(`${configKey} must be a non-empty string (got ${JSON.stringify(value)})`);
  }
}

function requirePositiveInt(value: unknown, configKey: string, min = 1): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
    fail(`${configKey} must be an integer ≥ ${min} (got ${JSON.stringify(value)})`);
  }
}

function requirePercent(value: unknown, configKey: string): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value <= PERCENT_MIN_EXCLUSIVE ||
    value > PERCENT_MAX
  ) {
    fail(`${configKey} must be a finite number in (0, 100] (got ${JSON.stringify(value)})`);
  }
}

function cloneModelDefinition(definition: ModelDefinition): ModelDefinition {
  return structuredClone(definition);
}

function normalizeOptionalString(value: unknown, configKey: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(`${configKey} must be a non-empty string`);
  }
  return value.trim();
}

// Git-ref-safe, slash-free slug: must start alphanumeric/underscore (git rejects
// a leading '.', and `git worktree add -b` would read a leading '-' as a flag)
// and contain no `..` (git rejects it).
const BRANCH_PREFIX_RE = /^(?!.*\.\.)\w[\w.-]*$/;

function normalizeBranchPrefix(value: unknown): string | undefined {
  const normalized = normalizeOptionalString(value, "git.branchPrefix");
  if (normalized !== undefined && !BRANCH_PREFIX_RE.test(normalized)) {
    fail(
      `git.branchPrefix must be a slash-free slug of letters, digits, '.', '_', or '-' (got ${JSON.stringify(value)})`,
    );
  }
  return normalized;
}

function normalizeHookCommands(value: unknown, configKey: string): HookCommands {
  if (value === undefined) {
    return {};
  }
  if (!isPlainObject(value)) {
    fail(`${configKey} must be an object`);
  }
  const hooks: HookCommands = {};
  const prepareWorktree = normalizeOptionalString(
    value["prepareWorktree"],
    `${configKey}.prepareWorktree`,
  );
  if (prepareWorktree !== undefined) {
    hooks.prepareWorktree = prepareWorktree;
  }
  return hooks;
}

function normalizeDefaults(value: unknown): ResolvedConfig["defaults"] {
  if (value === undefined) {
    return { hooks: {} };
  }
  if (!isPlainObject(value)) {
    fail("defaults must be an object");
  }
  return {
    hooks: normalizeHookCommands(value["hooks"], "defaults.hooks"),
  };
}

const ENV_VAR_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function validatePreLaunchEnv(modelName: string, value: unknown): asserts value is string[] {
  const configPath = `models.definitions.${modelName}.preLaunchEnv`;
  if (!Array.isArray(value)) {
    fail(`${configPath} must be an array of env var names (got ${JSON.stringify(value)})`);
  }
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "string" || !ENV_VAR_NAME_PATTERN.test(entry)) {
      fail(
        `${configPath}[${index}] must be a POSIX env var name matching ${ENV_VAR_NAME_PATTERN.source} (got ${JSON.stringify(entry)})`,
      );
    }
    // Build secrets are sourced into the host launch shell, forwarded only to
    // the Safehouse *prepareWorktree* wrap, and `unset` on the host before the agent
    // wrap is exec'd. Listing one here would silently never reach the agent —
    // fail loudly so the operator picks a different name (or removes the
    // entry) instead of debugging a missing env var at runtime.
    if ((BUILD_SECRET_NAMES as readonly string[]).includes(entry)) {
      fail(
        `${configPath}[${index}] cannot be a BUILD_SECRET_NAMES entry (${BUILD_SECRET_NAMES.join(", ")}); ` +
          "those are unset on the host before the agent wrap is exec'd, so forwarding them via --env-pass would be a no-op.",
      );
    }
  }
}

/**
 * Single source of truth for "is preLaunchEnv asking us to forward anything?"
 *
 * An empty array forwards zero names, so it is a uniform no-op in every
 * runner. The unsupported-runner guards (sdx, safehouse-prefixed cmd) only
 * fire when there is actually something to forward — rejecting `[]` only on
 * those runners would make an empty list accepted under `safehouse`/`none`
 * but fatal elsewhere, which is a worse asymmetry than what the helper
 * collapses. Centralized so all four call sites stay in lockstep.
 */
export function hasPreLaunchEnv(definition: Pick<ModelDefinition, "preLaunchEnv">): boolean {
  return definition.preLaunchEnv !== undefined && definition.preLaunchEnv.length > 0;
}

function isWorkspaceKindSetting(value: unknown): value is WorkspaceKindSetting {
  return (
    typeof value === "string" && (WORKSPACE_KIND_SETTINGS as readonly string[]).includes(value)
  );
}

function normalizeWorkspaceKind(
  value: unknown,
  configKey: string,
): WorkspaceKindSetting | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isWorkspaceKindSetting(value)) {
    fail(
      `${configKey} must be one of ${WORKSPACE_KIND_SETTINGS.join(", ")} (got ${JSON.stringify(value)})`,
    );
  }
  return value;
}

function isLocalRunnerSetting(value: unknown): value is LocalRunnerSetting {
  return typeof value === "string" && (LOCAL_RUNNER_SETTINGS as readonly string[]).includes(value);
}

function normalizeLocalRunner(value: unknown, configKey: string): LocalRunnerSetting | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isLocalRunnerSetting(value)) {
    fail(
      `${configKey} must be one of ${LOCAL_RUNNER_SETTINGS.join(", ")} (got ${JSON.stringify(value)})`,
    );
  }
  return value;
}

function normalizeSandbox(value: unknown, configKey: string): SandboxDefinition {
  if (!isPlainObject(value)) {
    fail(`${configKey} must be an object`);
  }
  if (Object.hasOwn(value, "template")) {
    failRemovedConfigKey(
      `${configKey}.template`,
      "Groundcrew no longer creates or re-templates sdx sandboxes.",
    );
  }
  if (Object.hasOwn(value, "kits")) {
    failRemovedConfigKey(
      `${configKey}.kits`,
      "Groundcrew no longer creates sdx sandboxes or applies sandbox kits.",
    );
  }
  if (Object.hasOwn(value, "setupCommand")) {
    fail(
      `${configKey}.setupCommand is no longer supported: use repo-local \`.groundcrew/config.json\` \`hooks.prepareWorktree\`, or \`defaults.hooks.prepareWorktree\` in crew.config.ts when you need a fallback for repos without their own hook.`,
    );
  }
  const { agent } = value;
  requireString(agent, `${configKey}.agent`);
  const trimmedAgent = agent.trim();
  if (trimmedAgent.length === 0) {
    fail(`${configKey}.agent must be a non-empty string (got ${JSON.stringify(agent)})`);
  }
  return { agent: trimmedAgent };
}

function failRemovedConfigKey(configKey: string, reason: string): never {
  fail(
    `${configKey} is no longer supported: ${reason} ` +
      "Provision and manage the sandbox yourself with `sbx` (for example `sbx create --name groundcrew-<agent> <agent> <projectDir>`), then keep only `models.definitions.<model>.sandbox.agent` in crew.config.ts.",
  );
}

function failIfLegacyModelKeys(
  name: string,
  override: unknown,
): asserts override is UserModelDefinition {
  if (!isPlainObject(override)) {
    fail(`models.definitions.${name} must be an object`);
  }
  if (Object.hasOwn(override, "isolation")) {
    fail(
      `models.definitions.${name}.isolation is no longer supported: per-model isolation is no longer supported`,
    );
  }
  if (Object.hasOwn(override, "disabled")) {
    fail(MODEL_DEFINITIONS_MIGRATION_MESSAGE);
  }
}

/**
 * True when `name` is a built-in preset but not present in the enabled
 * definitions. Consumers use this to distinguish `agent-codex` when codex is
 * not enabled from an arbitrary unknown label like `agent-typo`.
 */
export function isBuiltInModelNotEnabled(
  config: Pick<ResolvedConfig, "models">,
  name: string,
): boolean {
  return (
    Object.hasOwn(BUILT_IN_MODEL_DEFINITIONS, name) &&
    !Object.hasOwn(config.models.definitions, name)
  );
}

function isUsageDisableSentinel(usage: UserUsage): usage is { disabled: true } {
  return isPlainObject(usage) && "disabled" in usage && usage.disabled;
}

function buildOverrideCandidate(
  name: string,
  override: EnabledUserModelDefinition,
  existing: ModelDefinition | undefined,
): Partial<ModelDefinition> {
  const base: Partial<ModelDefinition> =
    existing === undefined ? {} : cloneModelDefinition(existing);
  // Per-key spread so overriding `cmd` alone preserves the default
  // `color` / `usage`. Brand-new entries must supply both required fields.
  const candidate: Partial<ModelDefinition> = { ...base };
  if (override.cmd !== undefined) {
    candidate.cmd = override.cmd;
  }
  if (override.color !== undefined) {
    candidate.color = override.color;
  }
  if (override.usage !== undefined) {
    if (isUsageDisableSentinel(override.usage)) {
      delete candidate.usage;
    } else {
      candidate.usage = override.usage;
    }
  }
  if (override.sandbox !== undefined) {
    candidate.sandbox = normalizeSandbox(override.sandbox, `models.definitions.${name}.sandbox`);
  }
  if (override.preLaunch !== undefined) {
    candidate.preLaunch = override.preLaunch;
  }
  if (override.preLaunchEnv !== undefined) {
    candidate.preLaunchEnv = override.preLaunchEnv;
  }
  return candidate;
}

function mergeDefinitions(
  user: Record<string, UserModelDefinition> | undefined,
): Record<string, ModelDefinition> {
  if (user === undefined) {
    fail(MODEL_DEFINITIONS_MIGRATION_MESSAGE);
  }
  if (!isPlainObject(user)) {
    fail("models.definitions must be an object");
  }
  const merged: Record<string, ModelDefinition> = {};
  for (const [name, override] of Object.entries(user)) {
    failIfLegacyModelKeys(name, override);

    const builtIn = BUILT_IN_MODEL_DEFINITIONS[name];
    const candidate = buildOverrideCandidate(name, override, builtIn);
    const { cmd, color, usage, sandbox, preLaunch, preLaunchEnv } = candidate;
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
    if (sandbox !== undefined) {
      definition.sandbox = sandbox;
    }
    if (preLaunch !== undefined) {
      definition.preLaunch = preLaunch;
    }
    if (preLaunchEnv !== undefined) {
      definition.preLaunchEnv = preLaunchEnv;
    }
    merged[name] = definition;
  }
  return merged;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireObject(value: unknown, configKey: string): void {
  if (!isPlainObject(value)) {
    fail(`${configKey} must be an object (got ${JSON.stringify(value)})`);
  }
}

function failOnLegacyLinearShape(user: Record<string, unknown>): void {
  if (!Object.hasOwn(user, "linear")) {
    return;
  }
  fail(
    [
      "The `linear` config block is no longer supported.",
      "Groundcrew now picks up every Linear issue assigned to your API key's viewer that carries an `agent-*` label —",
      "remove the `linear: { ... }` block from your config.",
      'To customize Linear status names, declare `sources: [{ kind: "linear", statuses: { ... } }]` instead.',
      "If you only want a subset of your Linear tasks to be picked up, leave the unwanted tasks unassigned or remove their `agent-*` label.",
    ].join("\n"),
  );
}

function failOnRemovedSandboxSettings(user: Record<string, unknown>): void {
  const { sandbox } = user;
  if (sandbox === undefined) {
    return;
  }
  if (!isPlainObject(sandbox)) {
    fail("sandbox must be an object");
  }
  if (Object.hasOwn(sandbox, "authRecipes")) {
    failRemovedConfigKey(
      "sandbox.authRecipes",
      "Groundcrew no longer drives in-sandbox auth flows.",
    );
  }
  if (Object.hasOwn(sandbox, "gitDefaults")) {
    failRemovedConfigKey(
      "sandbox.gitDefaults",
      "Groundcrew no longer seeds git defaults inside sdx sandboxes.",
    );
  }
}

function normalizeSources(raw: unknown): SourceConfig[] {
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    fail("sources must be an array");
  }
  const names = new Map<string, number>();
  for (const [index, entry] of raw.entries()) {
    const configPath = `sources[${index}]`;
    if (!isPlainObject(entry)) {
      fail(`${configPath} must be an object`);
    }
    const { kind, name } = entry;
    requireString(kind, `${configPath}.kind`);
    // Per-adapter Zod validation runs in `buildSources`. Here we check name
    // uniqueness — the Board composer relies on it for writeback routing.
    // When `name` is omitted, the adapter's runtime default is `kind` (the
    // built-in Linear and shell adapters both follow this convention), so we
    // dedup on the effective runtime name to catch e.g. two `{kind: "linear"}`
    // entries that would both produce a source named `"linear"`.
    if (name !== undefined) {
      requireString(name, `${configPath}.name`);
    }
    /* v8 ignore next @preserve -- both `name`-set and `name`-unset paths are covered by separate dedup tests; coverage for the fallback's `kind` arm only fires when both entries in the dedup set come from `name`, which the second test already covers */
    const effectiveName = name ?? kind;
    const previous = names.get(effectiveName);
    if (previous !== undefined) {
      /* v8 ignore next 3 @preserve -- the `name === undefined` ternary arm requires two unnamed entries colliding; we keep the conditional for the better error message but only one path is exercised in tests */
      fail(
        `${configPath} would produce a source named "${effectiveName}" (from ${name === undefined ? "default `kind` since `name` is omitted" : "`name`"}), duplicating sources[${previous}]. Configure distinct \`name\` fields.`,
      );
    }
    names.set(effectiveName, index);
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- structural validation above guarantees array of {kind: string} entries; per-source Zod validation lives in buildSources
  return raw as SourceConfig[];
}

/**
 * Resolve one `knownRepositories` entry to its name and (optional) resolved
 * base dir. Bare strings live under `projectDir`; the object form's
 * `projectDirOverride` overrides that parent directory. This is the seam later
 * per-repo options hang off — add new `KnownRepository` fields here.
 */
function normalizeKnownRepository(
  entry: string | KnownRepository,
  index: number,
): { name: string; projectDirOverride?: string } {
  if (typeof entry === "string") {
    return { name: entry };
  }
  requireObject(entry, `workspace.knownRepositories[${index}]`);
  requireString(entry.name, `workspace.knownRepositories[${index}].name`);
  if (entry.projectDirOverride === undefined) {
    return { name: entry.name };
  }
  requireString(
    entry.projectDirOverride,
    `workspace.knownRepositories[${index}].projectDirOverride`,
  );
  return { name: entry.name, projectDirOverride: expandHome(entry.projectDirOverride) };
}

/**
 * Flatten the loose `(string | KnownRepository)[]` union into the strict
 * resolved shape: a `string[]` of names every downstream consumer reads, plus
 * a separate `repositoryDirs` map holding only the entries that override
 * `projectDir`. Types are validated here, at the resolution edge, before any
 * `expandHome` runs (which would otherwise throw a raw TypeError on a
 * non-string `worktreeDir`).
 */
function normalizeWorkspace(workspace: Config["workspace"]): ResolvedConfig["workspace"] {
  requireObject(workspace, "workspace");
  requireString(workspace.projectDir, "workspace.projectDir");
  // Track the first index each name was seen at so a duplicate (which would
  // silently overwrite its `projectDirOverride` in `repositoryDirs`) fails
  // loudly instead of resolving order-dependently.
  const seen = new Map<string, number>();
  const repositoryDirs: Record<string, string> = {};
  const entries = Array.isArray(workspace.knownRepositories) ? workspace.knownRepositories : [];
  entries.forEach((entry, index) => {
    const { name, projectDirOverride } = normalizeKnownRepository(entry, index);
    const previous = seen.get(name);
    if (previous !== undefined) {
      fail(
        `workspace.knownRepositories[${index}] duplicates ${JSON.stringify(name)} from workspace.knownRepositories[${previous}]. Configure distinct repository names.`,
      );
    }
    seen.set(name, index);
    if (projectDirOverride !== undefined) {
      repositoryDirs[name] = projectDirOverride;
    }
  });
  const names = [...seen.keys()];
  let worktreeDir: string | undefined;
  if (workspace.worktreeDir !== undefined) {
    requireString(workspace.worktreeDir, "workspace.worktreeDir");
    worktreeDir = expandHome(workspace.worktreeDir);
  }
  return {
    projectDir: expandHome(workspace.projectDir),
    ...(worktreeDir === undefined ? {} : { worktreeDir }),
    knownRepositories: names,
    ...(Object.keys(repositoryDirs).length === 0 ? {} : { repositoryDirs }),
  };
}

function applyDefaults(user: Config): ResolvedConfig {
  // Guard the top-level shape before reading nested fields, so a
  // malformed runtime config produces a `groundcrew config: ...` error
  // instead of a raw `TypeError: Cannot read properties of undefined`.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `user` is loosely typed input from the loader; we narrow with requireObject below
  const rawUser = user as unknown as Record<string, unknown>;
  failOnLegacyLinearShape(rawUser);
  failOnRemovedSandboxSettings(rawUser);
  requireObject(user.workspace, "workspace");
  if (isPlainObject(user.models) && Object.hasOwn(user.models, "isolation")) {
    fail(
      "models.isolation is no longer supported: set `local.runner` ('safehouse' | 'sdx' | 'none' | 'auto') instead",
    );
  }
  if (Object.hasOwn(user, "remote")) {
    fail(
      "remote is no longer supported: groundcrew runs locally via safehouse/sdx/none; remove the remote block from your config",
    );
  }
  const userLocal = (user as { local?: { runner?: unknown } }).local;
  if (userLocal !== undefined && !isPlainObject(userLocal)) {
    fail("local must be an object");
  }

  const sources = normalizeSources((user as { sources?: unknown }).sources);
  const branchPrefix = normalizeBranchPrefix(user.git?.branchPrefix);
  return {
    sources,
    // Only carry the key when set so `git.branchPrefix` stays truly optional
    // under exactOptionalPropertyTypes.
    git: {
      ...DEFAULT_GIT,
      ...user.git,
      ...(branchPrefix === undefined ? {} : { branchPrefix }),
    },
    workspace: normalizeWorkspace(user.workspace),
    defaults: normalizeDefaults((user as { defaults?: unknown }).defaults),
    orchestrator: { ...DEFAULT_ORCHESTRATOR, ...user.orchestrator },
    models: {
      default: user.models?.default ?? "claude",
      definitions: mergeDefinitions(user.models?.definitions),
    },
    prompts: {
      initial: user.prompts?.initial ?? DEFAULT_PROMPT_INITIAL,
    },
    workspaceKind: normalizeWorkspaceKind(user.workspaceKind, "workspaceKind") ?? "auto",
    local: {
      runner: normalizeLocalRunner(userLocal?.runner, "local.runner") ?? "auto",
    },
    logging: {
      file: expandHome(
        normalizeOptionalString(user.logging?.file, "logging.file") ?? defaultLogFile(),
      ),
    },
  };
}

function validatePromptPlaceholders(template: string): void {
  /* v8 ignore next @preserve -- a no-placeholder prompt is unusual but tests with placeholders consistently match at least once */
  const placeholders = template.match(PROMPT_PLACEHOLDER_RE) ?? [];
  const unknown = placeholders.find((placeholder) => !ALLOWED_PROMPT_PLACEHOLDERS.has(placeholder));
  if (unknown !== undefined) {
    fail(
      `prompts.initial contains unknown placeholder ${JSON.stringify(unknown)}. Allowed placeholders: ${[...ALLOWED_PROMPT_PLACEHOLDERS].join(", ")}`,
    );
  }
}

function validate(config: ResolvedConfig): void {
  requireString(config.git.remote, "git.remote");
  requireString(config.git.defaultBranch, "git.defaultBranch");

  requireString(config.workspace.projectDir, "workspace.projectDir");

  if (
    !Array.isArray(config.workspace.knownRepositories) ||
    config.workspace.knownRepositories.length === 0
  ) {
    fail("workspace.knownRepositories must be a non-empty array");
  }
  config.workspace.knownRepositories.forEach((repository, index) => {
    requireString(repository, `workspace.knownRepositories[${index}]`);
  });

  requirePositiveInt(config.orchestrator.maximumInProgress, "orchestrator.maximumInProgress");
  requirePositiveInt(
    config.orchestrator.pollIntervalMilliseconds,
    "orchestrator.pollIntervalMilliseconds",
  );

  requirePercent(config.orchestrator.sessionLimitPercentage, "orchestrator.sessionLimitPercentage");

  const { definitions } = config.models;
  if (Object.keys(definitions).length === 0) {
    fail("models.definitions must contain at least one model");
  }
  if (AGENT_ANY_MODEL in definitions) {
    fail(
      `models.definitions cannot contain "${AGENT_ANY_MODEL}" — it is reserved for the agent-any label, which routes to the model with the most available session capacity`,
    );
  }
  for (const [name, definition] of Object.entries(definitions)) {
    requireString(definition.cmd, `models.definitions.${name}.cmd`);
    requireString(definition.color, `models.definitions.${name}.color`);
    if (definition.usage !== undefined) {
      const usagePath = `models.definitions.${name}.usage`;
      /* v8 ignore next 3 @preserve -- mergeDefinitions only assigns usage from validated overrides or built-in presets; reaching this guard requires hand-mutating the resolved config */
      if (typeof definition.usage !== "object" || definition.usage === null) {
        fail(`${usagePath} must be an object`);
      }
      const { codexbar } = definition.usage;
      /* v8 ignore next 3 @preserve -- mergeDefinitions only assigns usage from validated overrides or built-in presets; reaching this guard requires hand-mutating the resolved config */
      if (typeof codexbar !== "object" || codexbar === null) {
        fail(`${usagePath}.codexbar must be an object`);
      }
      requireString(codexbar.provider, `${usagePath}.codexbar.provider`);
    }
    if (definition.sandbox !== undefined) {
      requireString(definition.sandbox.agent, `models.definitions.${name}.sandbox.agent`);
    }
    if (definition.preLaunch !== undefined) {
      requireString(definition.preLaunch, `models.definitions.${name}.preLaunch`);
      if (definition.preLaunch.trim().length === 0) {
        fail(`models.definitions.${name}.preLaunch must contain non-whitespace characters`);
      }
    }
    if (definition.preLaunchEnv !== undefined) {
      validatePreLaunchEnv(name, definition.preLaunchEnv);
    }
  }

  /* v8 ignore next 5 @preserve -- normalizeLocalRunner rejects invalid strings before validate() runs; this is a belt-and-suspenders guard */
  if (!(LOCAL_RUNNER_SETTINGS as readonly string[]).includes(config.local.runner)) {
    fail(
      `local.runner must be one of ${LOCAL_RUNNER_SETTINGS.join(", ")} (got ${JSON.stringify(config.local.runner)})`,
    );
  }

  // Built-in-not-enabled check must run before the generic "not a key" check
  // so the user gets the specific migration-oriented message for `codex`
  // instead of a stale-list message.
  if (isBuiltInModelNotEnabled(config, config.models.default)) {
    fail(
      `models.default ("${config.models.default}") is not enabled. Add \`models.definitions.${config.models.default}: {}\` or set models.default to an enabled model.`,
    );
  }
  if (!(config.models.default in definitions)) {
    fail(
      `models.default ("${config.models.default}") is not a key in models.definitions (have: ${Object.keys(definitions).join(", ")})`,
    );
  }

  requireString(config.prompts.initial, "prompts.initial");
  validatePromptPlaceholders(config.prompts.initial);

  requireString(config.logging.file, "logging.file");
}

const COSMICONFIG_MODULE_NAME = "crew";

const SEARCH_PLACES: readonly string[] = [
  "crew.config.ts",
  "crew.config.mjs",
  "crew.config.js",
  "crew.config.json",
  ".crewrc",
  ".crewrc.json",
  ".crewrc.ts",
  ".config/crew.config.ts",
  ".config/crew.config.json",
  ".config/crewrc",
  ".config/crewrc.json",
];

// `config.ts` is the legacy single-name convention from the bespoke loader;
// kept for one release so existing users don't have to rename.
const XDG_FALLBACK_NAMES: readonly string[] = [
  "crew.config.ts",
  "crew.config.mjs",
  "crew.config.js",
  "crew.config.json",
  "config.ts",
];

// cosmiconfig's built-in `.ts` loader requires the `typescript` package;
// we already rely on Node 24's native TS-stripping for `bin/run.js`, so
// doing the same here keeps the dependency footprint tiny.
const loadExecutableModule: Loader = async (filepath) => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- runtime fields are validated by applyDefaults/validate below
  const module_ = (await import(pathToFileURL(filepath).href)) as {
    default?: unknown;
    config?: unknown;
  };
  if (module_.default !== undefined) {
    return module_.default;
  }
  if (module_.config !== undefined) {
    log(
      `Config at ${filepath} uses the legacy \`export const config\` shape. Switch to \`export default\` — the legacy form will be removed in the next major.`,
    );
    return module_.config;
  }
  return null;
};

// One explorer per process. `loadConfig` caches its resolved result via
// the `cached` singleton below, so cosmiconfig's internal cache state
// is harmless across the at-most-two calls (search + maybe load).
const explorer = cosmiconfig(COSMICONFIG_MODULE_NAME, {
  searchPlaces: [...SEARCH_PLACES],
  searchStrategy: "project",
  loaders: {
    ".ts": loadExecutableModule,
    ".mjs": loadExecutableModule,
    ".js": loadExecutableModule,
  },
});

type CosmiconfigDiscovery = NonNullable<CosmiconfigResult>;

interface DiscoveredConfig {
  result: CosmiconfigDiscovery;
  source: ConfigSource;
}

async function loadAt(filepath: string): Promise<CosmiconfigDiscovery> {
  const result = await explorer.load(filepath);
  if (result === null) {
    fail(
      `${filepath} must export a config object (e.g. \`export default { ... } satisfies Config\`)`,
    );
  }
  return result;
}

function findXdgConfigFile(): string | undefined {
  return XDG_FALLBACK_NAMES.map((name) => xdgConfigPath("groundcrew", name)).find((p) =>
    existsSync(p),
  );
}

async function discoverUserConfig(): Promise<DiscoveredConfig> {
  const override = readEnvironmentVariable("GROUNDCREW_CONFIG");
  if (override !== undefined && override.length > 0) {
    const overridePath = path.resolve(override);
    if (!existsSync(overridePath)) {
      fail(`GROUNDCREW_CONFIG=${overridePath} not found`);
    }
    const result = await loadAt(overridePath);
    return { result, source: { kind: "env", filepath: result.filepath } };
  }

  const project = await explorer.search(process.cwd());
  if (project !== null && project.isEmpty !== true) {
    return { result: project, source: { kind: "project", filepath: project.filepath } };
  }

  const xdgPath = findXdgConfigFile();
  if (xdgPath !== undefined) {
    const result = await loadAt(xdgPath);
    return { result, source: { kind: "xdg", filepath: result.filepath } };
  }

  // Throw directly so oxlint's `consistent-return` rule sees a
  // terminating statement; it doesn't track `fail()`'s `never` return.
  throw new Error(
    `groundcrew config: no crew config found. Create crew.config.ts in your project root, or ${xdgConfigPath(
      "groundcrew",
      "crew.config.ts",
    )}, or set GROUNDCREW_CONFIG.`,
  );
}

let cached: Readonly<LoadedConfig> | undefined;

export async function loadConfigWithSource(): Promise<Readonly<LoadedConfig>> {
  if (cached) {
    return cached;
  }

  const { result, source } = await discoverUserConfig();
  const { filepath, isEmpty } = result;
  const userConfig: unknown = result.config;
  if (isEmpty === true || !isPlainObject(userConfig)) {
    fail(
      `${filepath} must export a config object (e.g. \`export default { ... } satisfies Config\`)`,
    );
  }
  debug(`Loaded config from ${filepath}`);

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- runtime fields are validated by applyDefaults/validate
  const resolved = applyDefaults(userConfig as unknown as Config);

  validate(resolved);

  setLogFile(resolved.logging.file);

  cached = Object.freeze({
    config: Object.freeze(resolved),
    source: Object.freeze(source),
  });
  return cached;
}

export async function loadConfig(): Promise<Readonly<ResolvedConfig>> {
  const loadedConfig = await loadConfigWithSource();
  return loadedConfig.config;
}
