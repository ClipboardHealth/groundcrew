import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { cosmiconfig, type CosmiconfigResult, type Loader } from "cosmiconfig";

import { log, readEnvironmentVariable, setLogFile } from "./util.ts";

export { BUILD_SECRET_NAMES } from "./buildSecrets.ts";

/**
 * Reserved model name. A ticket labeled `agent-any` resolves at runtime
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
 * macOS-only (clearance HTTP-egress + sandbox profile); `sdx` is Docker
 * Sandboxes (`sbx` CLI) — works on Linux and macOS and is the only known
 * option that lets the agent use Docker safely without exposing the host
 * socket; `none` is an explicit unsandboxed escape hatch.
 */
export type LocalRunner = "safehouse" | "sdx" | "none";

/**
 * User-facing local runner setting. `auto` resolves at launch time:
 * macOS picks `safehouse`, Linux picks `sdx`. `none` is never picked
 * implicitly.
 */
export type LocalRunnerSetting = LocalRunner | "auto";

export const LOCAL_RUNNER_SETTINGS: readonly LocalRunnerSetting[] = [
  "auto",
  "safehouse",
  "sdx",
  "none",
] as const;

/**
 * Per-model Docker Sandboxes (sdx) binding. Required at launch when
 * `local.runner` resolves to `sdx` so groundcrew knows which sbx agent
 * to address and how to seed the sandbox.
 */
export interface SandboxDefinition {
  /** sbx agent name (e.g. "claude", "codex"). */
  agent: string;
  /** Optional `sbx run --template` value. */
  template?: string;
  /** Optional `sbx run --kit` values (each passed as a separate flag). */
  kits?: string[];
  /**
   * Setup command run **inside** the sandbox before the agent exec.
   * Defaults to the shared `.groundcrew/setup.sh --deps-only` convention
   * (see `launchCommand.ts`) when omitted.
   */
  setupCommand?: string;
}

export interface ModelDefinition {
  /**
   * Shell command launched for the model. Wrapped with Safehouse/clearance
   * for execution. The rendered prompt is appended as a single quoted
   * positional argument. `{{worktree}}` is replaced before launch.
   *
   * Keep this agent-native (e.g., `claude --permission-mode bypassPermissions`).
   * Groundcrew adds the Safehouse wrapper.
   */
  cmd: string;
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
 * User-facing model entry shape. Discriminated union so the type system
 * mirrors the runtime contract: an entry is either a pure overlay
 * (every concrete field optional, no `disabled` key) or a pure
 * disable directive (`{ disabled: true }` and nothing else).
 *
 * `usage` accepts an extra `{ disabled: true }` sentinel that strips the
 * usage block from the merged definition — the only way to opt a shipped
 * default out of codexbar gating without disabling the model entirely.
 */
type UserUsage = ModelDefinition["usage"] | { disabled: true };
type EnabledUserModelDefinition = Partial<Omit<ModelDefinition, "usage">> & {
  usage?: UserUsage;
  disabled?: never;
};
interface DisabledUserModelDefinition {
  disabled: true;
}
type UserModelDefinition = EnabledUserModelDefinition | DisabledUserModelDefinition;

/**
 * One Linear project the orchestrator should watch. Each project has its
 * own status name overrides so multi-team setups with divergent workflow
 * state names (e.g. "Todo" vs "To Do", "Shipped" vs "Done") can coexist
 * under one `crew` process.
 */
export interface ProjectConfig {
  /**
   * Project URL slug as it appears in Linear's URL bar — e.g.
   * `ai-strategy-5152195762f3` from
   * `https://linear.app/<workspace>/project/ai-strategy-5152195762f3`.
   * The trailing 12-character hex `slugId` is what's used for the
   * GraphQL filter; the leading name segment is kept intact in the
   * config so `config.ts` is self-documenting at a glance, and so it
   * survives Linear project renames.
   */
  projectSlug: string;
  statuses?: {
    todo?: string;
    inProgress?: string;
    done?: string;
    terminal?: string[];
  };
}

/**
 * Loose user-facing shape — what a `config.ts` file declares.
 * Fields with defaults are optional; only `linear.projects` and the
 * `workspace.*` fields are required.
 */
export interface Config {
  linear: {
    /**
     * One or more Linear projects to watch. A single `crew` process
     * dispatches across all configured projects under a shared
     * `orchestrator.maximumInProgress` budget.
     */
    projects: ProjectConfig[];
  };
  git?: {
    remote?: string;
    defaultBranch?: string;
  };
  workspace: {
    projectDir: string;
    knownRepositories: string[];
  };
  orchestrator?: {
    maximumInProgress?: number;
    pollIntervalMilliseconds?: number;
    sessionLimitPercentage?: number;
  };
  models?: {
    default?: string;
    /**
     * Additive: each entry merges over the shipped default for that key.
     * Override `claude.cmd` only by declaring `{ claude: { cmd: "..." } }` —
     * the other fields stay at their default values. Brand-new model
     * names must supply enough fields to satisfy `validate()`.
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

export interface ResolvedProjectConfig {
  /** Original full slug from `ProjectConfig.projectSlug` — for log lines. */
  projectSlug: string;
  /** 12-char hex tail of `projectSlug` — the value Linear filters on. */
  slugId: string;
  statuses: {
    todo: string;
    inProgress: string;
    done: string;
    terminal: string[];
  };
}

/**
 * Strict shape after defaults are applied — what scripts work with.
 */
export interface ResolvedConfig {
  linear: {
    projects: ResolvedProjectConfig[];
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

const DEFAULT_STATUSES: ResolvedProjectConfig["statuses"] = {
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
  "You are working on Linear ticket {{ticket}} ({{title}}) in the {{worktree}} worktree subdirectory.",
  "",
  "Ticket description:",
  "",
  "{{description}}",
  "",
  "## Operating mode",
  "",
  "There is no human watching this session. Do not stop to ask clarifying questions. When the ticket is ambiguous or incomplete, choose the simplest reasonable interpretation consistent with the ticket and the codebase, then document that choice in the PR description.",
  "",
  "## Workflow",
  "",
  "1. Inspect the repository instructions and existing patterns before editing.",
  "2. Implement the smallest sensible change that completes the ticket.",
  "3. Run the repository's documented verification command. If no documented verification exists, run the smallest relevant test suite you can find. Fix failures you introduced before continuing.",
  "4. Review your own diff before stopping. Look for bugs, regressions, missing tests, security issues, and convention violations, then fix any issues you find.",
  "5. If this repository uses GitHub and the `gh` CLI is available and authenticated, open a pull request. If you cannot open one, leave the branch ready and record the blocker.",
  "6. Include `Closes {{ticket}}` in the PR description.",
  "7. Include a short continuation note in the PR body when you know how to reattach to this workspace. For the tmux backend, use `tmux attach -t groundcrew:{{ticket}}`.",
  "",
  "Stop after the branch is ready or the PR is open.",
].join("\n");

const ALLOWED_PROMPT_PLACEHOLDERS = new Set([
  "{{ticket}}",
  "{{worktree}}",
  "{{title}}",
  "{{description}}",
]);
const PROMPT_PLACEHOLDER_RE = /{{[^{}]*}}/g;

const PERCENT_MIN_EXCLUSIVE = 0;
const PERCENT_MAX = 100;

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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function requireString(value: unknown, path: string): asserts value is string {
  if (!isNonEmptyString(value)) {
    fail(`${path} must be a non-empty string (got ${JSON.stringify(value)})`);
  }
}

function requirePositiveInt(value: unknown, path: string, min = 1): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
    fail(`${path} must be an integer ≥ ${min} (got ${JSON.stringify(value)})`);
  }
}

function requirePercent(value: unknown, path: string): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value <= PERCENT_MIN_EXCLUSIVE ||
    value > PERCENT_MAX
  ) {
    fail(`${path} must be a finite number in (0, 100] (got ${JSON.stringify(value)})`);
  }
}

function cloneModelDefinition(definition: ModelDefinition): ModelDefinition {
  return structuredClone(definition);
}

function normalizeOptionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(`${path} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeOptionalStringArray(value: unknown, path: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    fail(`${path} must be an array`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      fail(`${path}[${index}] must be a non-empty string`);
    }
    return entry.trim();
  });
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

function normalizeStatusName(value: unknown, fallback: string, path: string): string {
  return normalizeOptionalString(value, path) ?? fallback;
}

function normalizeStatuses(
  user: ProjectConfig["statuses"],
  path: string,
): ResolvedProjectConfig["statuses"] {
  const todo = normalizeStatusName(user?.todo, DEFAULT_STATUSES.todo, `${path}.todo`);
  const inProgress = normalizeStatusName(
    user?.inProgress,
    DEFAULT_STATUSES.inProgress,
    `${path}.inProgress`,
  );
  const done = normalizeStatusName(user?.done, DEFAULT_STATUSES.done, `${path}.done`);
  const terminal = normalizeOptionalStringArray(user?.terminal, `${path}.terminal`) ?? [];
  return {
    todo,
    inProgress,
    done,
    terminal: uniqueStrings([...terminal, done]),
  };
}

function isWorkspaceKindSetting(value: unknown): value is WorkspaceKindSetting {
  return (
    typeof value === "string" && (WORKSPACE_KIND_SETTINGS as readonly string[]).includes(value)
  );
}

function normalizeWorkspaceKind(value: unknown, path: string): WorkspaceKindSetting | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isWorkspaceKindSetting(value)) {
    fail(
      `${path} must be one of ${WORKSPACE_KIND_SETTINGS.join(", ")} (got ${JSON.stringify(value)})`,
    );
  }
  return value;
}

function isLocalRunnerSetting(value: unknown): value is LocalRunnerSetting {
  return typeof value === "string" && (LOCAL_RUNNER_SETTINGS as readonly string[]).includes(value);
}

function normalizeLocalRunner(value: unknown, path: string): LocalRunnerSetting | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isLocalRunnerSetting(value)) {
    fail(
      `${path} must be one of ${LOCAL_RUNNER_SETTINGS.join(", ")} (got ${JSON.stringify(value)})`,
    );
  }
  return value;
}

function normalizeSandbox(value: unknown, path: string): SandboxDefinition {
  if (!isPlainObject(value)) {
    fail(`${path} must be an object`);
  }
  const { agent, template, kits, setupCommand } = value;
  requireString(agent, `${path}.agent`);
  const trimmedAgent = agent.trim();
  if (trimmedAgent.length === 0) {
    fail(`${path}.agent must be a non-empty string (got ${JSON.stringify(agent)})`);
  }
  const sandbox: SandboxDefinition = { agent: trimmedAgent };
  const normalizedTemplate = normalizeOptionalString(template, `${path}.template`);
  if (normalizedTemplate !== undefined) {
    sandbox.template = normalizedTemplate;
  }
  const normalizedKits = normalizeOptionalStringArray(kits, `${path}.kits`);
  if (normalizedKits !== undefined) {
    sandbox.kits = normalizedKits;
  }
  const normalizedSetup = normalizeOptionalString(setupCommand, `${path}.setupCommand`);
  if (normalizedSetup !== undefined) {
    sandbox.setupCommand = normalizedSetup;
  }
  return sandbox;
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
    if (override["disabled"] !== true) {
      fail(
        `models.definitions.${name}.disabled must be exactly \`true\` when set (got ${JSON.stringify(override["disabled"])})`,
      );
    }
    const conflicting = (["cmd", "color", "usage", "sandbox"] as const).filter((key) =>
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
 * shipped default, codified in `failIfLegacyModelKeys` + `mergeDefinitions`.
 * Consumers needing to distinguish disabled-by-user from unknown-label use this.
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

function isUsageDisableSentinel(usage: UserUsage): usage is { disabled: true } {
  return isPlainObject(usage) && "disabled" in usage && usage.disabled;
}

function mergeDefinitions(
  user: Record<string, UserModelDefinition> | undefined,
): Record<string, ModelDefinition> {
  if (user !== undefined && !isPlainObject(user)) {
    fail("models.definitions must be an object");
  }
  const merged: Record<string, ModelDefinition> = Object.fromEntries(
    Object.entries(DEFAULT_MODEL_DEFINITIONS).map(([name, definition]) => [
      name,
      cloneModelDefinition(definition),
    ]),
  );
  for (const [name, override] of Object.entries(user ?? {})) {
    failIfLegacyModelKeys(name, override);

    if (override.disabled === true) {
      if (!Object.hasOwn(DEFAULT_MODEL_DEFINITIONS, name)) {
        fail(
          `models.definitions.${name}: \`disabled: true\` is only valid for shipped defaults (${Object.keys(DEFAULT_MODEL_DEFINITIONS).join(", ")}). Remove the entry instead.`,
        );
      }
      // Drop the key so downstream iterators (doctor, eligibility, usage) ignore
      // the model automatically; `isShippedDefaultDisabled` lets the few consumers
      // that need to distinguish disabled from unknown re-derive the set.
      // oxlint-disable-next-line typescript/no-dynamic-delete -- `merged` is a fresh function-local clone of DEFAULT_MODEL_DEFINITIONS; no V8 dictionary-mode/pollution concerns
      delete merged[name];
      continue;
    }

    const base: Partial<ModelDefinition> =
      merged[name] === undefined ? {} : cloneModelDefinition(merged[name]);
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
    const { cmd, color, usage, sandbox } = candidate;
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
    merged[name] = definition;
  }
  return merged;
}

// Linear project URL slugs end with a 12-char lowercase hex `slugId`.
const SLUG_ID_RE = /-([\da-f]{12})$/i;

function extractSlugId(slug: string): string | undefined {
  return SLUG_ID_RE.exec(slug)?.[1]?.toLowerCase();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireObject(value: unknown, path: string): void {
  if (!isPlainObject(value)) {
    fail(`${path} must be an object (got ${JSON.stringify(value)})`);
  }
}

function normalizeProject(value: unknown, index: number): ResolvedProjectConfig {
  const path = `linear.projects[${index}]`;
  if (!isPlainObject(value)) {
    fail(`${path} must be an object (got ${JSON.stringify(value)})`);
  }
  const { projectSlug, statuses } = value;
  requireString(projectSlug, `${path}.projectSlug`);
  const slugId = extractSlugId(projectSlug);
  if (slugId === undefined) {
    fail(
      `${path}.projectSlug must end with a 12-character hex slugId (got ${JSON.stringify(projectSlug)}). Copy the trailing segment from your Linear project URL, e.g. "ai-strategy-5152195762f3" from "https://linear.app/<workspace>/project/ai-strategy-5152195762f3".`,
    );
  }
  if (statuses !== undefined && !isPlainObject(statuses)) {
    fail(`${path}.statuses must be an object`);
  }
  return {
    projectSlug,
    slugId,
    statuses: normalizeStatuses(statuses as ProjectConfig["statuses"], `${path}.statuses`),
  };
}

function failOnLegacyLinearShape(user: Record<string, unknown>): void {
  const { linear } = user;
  if (!isPlainObject(linear)) {
    return;
  }
  if (!Object.hasOwn(linear, "projectSlug") && !Object.hasOwn(linear, "statuses")) {
    return;
  }
  const legacySlug = linear["projectSlug"];
  const { projects } = linear;
  const firstProject: unknown = Array.isArray(projects) ? projects[0] : undefined;
  const migratedSlug =
    isPlainObject(firstProject) && typeof firstProject["projectSlug"] === "string"
      ? firstProject["projectSlug"]
      : undefined;
  let slugLiteral = `"your-project-name-0123456789ab"`;
  if (typeof legacySlug === "string") {
    slugLiteral = JSON.stringify(legacySlug);
  } else if (migratedSlug !== undefined) {
    slugLiteral = JSON.stringify(migratedSlug);
  }
  const statusesBlock = isPlainObject(linear["statuses"])
    ? `, statuses: ${JSON.stringify(linear["statuses"])}`
    : "";
  fail(
    [
      "linear.projectSlug / linear.statuses are no longer supported — wrap them in linear.projects[].",
      "Migrate by replacing your `linear` block with:",
      `  linear: { projects: [{ projectSlug: ${slugLiteral}${statusesBlock} }] }`,
      "See crew.config.example.ts for the multi-project shape.",
    ].join("\n"),
  );
}

function normalizeProjects(linear: Record<string, unknown>): ResolvedProjectConfig[] {
  const { projects } = linear;
  if (!Array.isArray(projects)) {
    fail("linear.projects must be a non-empty array");
  }
  if (projects.length === 0) {
    fail("linear.projects must be a non-empty array");
  }
  const resolved = projects.map((entry, index) => normalizeProject(entry, index));
  const seen = new Map<string, number>();
  resolved.forEach((project, index) => {
    const previous = seen.get(project.slugId);
    if (previous !== undefined) {
      fail(
        `linear.projects[${index}].projectSlug duplicates the slugId "${project.slugId}" already used by linear.projects[${previous}]`,
      );
    }
    seen.set(project.slugId, index);
  });
  return resolved;
}

function applyDefaults(user: Config): ResolvedConfig {
  // Guard the top-level shape before reading nested fields, so a
  // malformed runtime config produces a `groundcrew config: ...` error
  // instead of a raw `TypeError: Cannot read properties of undefined`.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `user` is loosely typed input from the loader; we narrow with requireObject below
  failOnLegacyLinearShape(user as unknown as Record<string, unknown>);
  requireObject(user.linear, "linear");
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

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- runtime fields validated by normalizeProjects below
  const projects = normalizeProjects(user.linear as unknown as Record<string, unknown>);
  return {
    linear: { projects },
    git: { ...DEFAULT_GIT, ...user.git },
    workspace: {
      projectDir: expandHome(user.workspace.projectDir),
      knownRepositories: user.workspace.knownRepositories,
    },
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
  const placeholders = template.match(PROMPT_PLACEHOLDER_RE) ?? [];
  const unknown = placeholders.find((placeholder) => !ALLOWED_PROMPT_PLACEHOLDERS.has(placeholder));
  if (unknown !== undefined) {
    fail(
      `prompts.initial contains unknown placeholder ${JSON.stringify(unknown)}. Allowed placeholders: ${[...ALLOWED_PROMPT_PLACEHOLDERS].join(", ")}`,
    );
  }
}

function validate(config: ResolvedConfig): void {
  /* v8 ignore next 3 @preserve -- normalizeProjects already enforces non-empty; belt-and-suspenders */
  if (config.linear.projects.length === 0) {
    fail("linear.projects must be a non-empty array");
  }
  config.linear.projects.forEach((project, index) => {
    const path = `linear.projects[${index}]`;
    requireString(project.projectSlug, `${path}.projectSlug`);
    requireString(project.slugId, `${path}.slugId`);
    requireString(project.statuses.todo, `${path}.statuses.todo`);
    requireString(project.statuses.inProgress, `${path}.statuses.inProgress`);
    requireString(project.statuses.done, `${path}.statuses.done`);
    project.statuses.terminal.forEach((status, terminalIndex) => {
      requireString(status, `${path}.statuses.terminal[${terminalIndex}]`);
    });
  });

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
  /* v8 ignore next 3 @preserve -- mergeDefinitions seeds claude+codex defaults, so an empty map is unreachable */
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
      if (typeof definition.usage !== "object" || definition.usage === null) {
        fail(`${usagePath} must be an object`);
      }
      const { codexbar } = definition.usage;
      if (typeof codexbar !== "object" || codexbar === null) {
        fail(`${usagePath}.codexbar must be an object`);
      }
      requireString(codexbar.provider, `${usagePath}.codexbar.provider`);
    }
    if (definition.sandbox !== undefined) {
      requireString(definition.sandbox.agent, `models.definitions.${name}.sandbox.agent`);
    }
  }

  /* v8 ignore next 5 @preserve -- normalizeLocalRunner rejects invalid strings before validate() runs; this is a belt-and-suspenders guard */
  if (!(LOCAL_RUNNER_SETTINGS as readonly string[]).includes(config.local.runner)) {
    fail(
      `local.runner must be one of ${LOCAL_RUNNER_SETTINGS.join(", ")} (got ${JSON.stringify(config.local.runner)})`,
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

type DiscoveredConfig = NonNullable<CosmiconfigResult>;

async function loadAt(filepath: string): Promise<DiscoveredConfig> {
  const result = await explorer.load(filepath);
  if (result === null) {
    fail(
      `${filepath} must export a config object (e.g. \`export default { ... } satisfies Config\`)`,
    );
  }
  return result;
}

function findXdgConfigFile(): string | undefined {
  return XDG_FALLBACK_NAMES.map((name) => xdgConfigPath("groundcrew", name)).find((path) =>
    existsSync(path),
  );
}

async function discoverUserConfig(): Promise<DiscoveredConfig> {
  const override = readEnvironmentVariable("GROUNDCREW_CONFIG");
  if (override !== undefined && override.length > 0) {
    const overridePath = resolve(override);
    if (!existsSync(overridePath)) {
      fail(`GROUNDCREW_CONFIG=${overridePath} not found`);
    }
    return await loadAt(overridePath);
  }

  const project = await explorer.search(process.cwd());
  if (project !== null && project.isEmpty !== true) {
    return project;
  }

  const xdgPath = findXdgConfigFile();
  if (xdgPath !== undefined) {
    return await loadAt(xdgPath);
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

/**
 * Returns the resolved project the issue belongs to, or `undefined` when
 * its slugId isn't in `linear.projects[]`. Callers in the dispatcher
 * path expect a project to always exist (the board fetch only surfaces
 * issues from configured projects); callers in the manual-ticket path
 * (`setupWorkspace`, `ticketDoctor`) use this to detect off-config
 * tickets and surface a clear error.
 */
export function findProjectBySlugId(
  config: Pick<ResolvedConfig, "linear">,
  slugId: string,
): ResolvedProjectConfig | undefined {
  return config.linear.projects.find((project) => project.slugId === slugId);
}

// Memoize per-config so blocker checks (called per blocker per tick) don't
// rebuild the same Set on every call. The resolved config is frozen and
// long-lived, so the WeakMap key is stable.
const terminalUnionCache = new WeakMap<Pick<ResolvedConfig, "linear">, ReadonlySet<string>>();

/**
 * Union of every terminal status name configured across all watched
 * projects. Used for blocker terminal checks when the blocker belongs
 * to a project we don't watch — matches today's single-project "is the
 * status terminal under any configured project?" behavior so off-config
 * blockers don't regress.
 */
export function unionTerminalStatuses(config: Pick<ResolvedConfig, "linear">): ReadonlySet<string> {
  const cached_ = terminalUnionCache.get(config);
  if (cached_ !== undefined) {
    return cached_;
  }
  const set = new Set<string>();
  for (const project of config.linear.projects) {
    for (const status of project.statuses.terminal) {
      set.add(status);
    }
  }
  terminalUnionCache.set(config, set);
  return set;
}

let cached: Readonly<ResolvedConfig> | undefined;

export async function loadConfig(): Promise<Readonly<ResolvedConfig>> {
  if (cached) {
    return cached;
  }

  const result = await discoverUserConfig();
  const { filepath, isEmpty } = result;
  const userConfig: unknown = result.config;
  if (isEmpty === true || !isPlainObject(userConfig)) {
    fail(
      `${filepath} must export a config object (e.g. \`export default { ... } satisfies Config\`)`,
    );
  }
  log(`Loaded config from ${filepath}`);

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- runtime fields are validated by applyDefaults/validate
  const resolved = applyDefaults(userConfig as unknown as Config);

  validate(resolved);

  setLogFile(resolved.logging.file);

  cached = Object.freeze(resolved);
  return cached;
}
