/**
 * `crew init` — create a `crew.config.ts` in the current working directory or,
 * with `--global`, in the XDG groundcrew config dir. The contents come from
 * the shipped `crew.config.example.ts` so a fresh install skips the manual
 * `cp` dance documented in the README.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { LOCAL_RUNNER_SETTINGS, type LocalRunnerSetting } from "../lib/config.ts";
import { shellSingleQuote } from "../lib/shell.ts";
import { log, writeOutput } from "../lib/util.ts";
import { xdgConfigPath } from "../lib/xdg.ts";

const CONFIG_FILE_NAME = "crew.config.ts";
const EXAMPLE_FILE_NAME = "crew.config.example.ts";
const DEFAULT_EXAMPLE_PROJECT_DIR = "~/dev/groundcrew";
const INIT_USAGE =
  "Usage: crew init [--global | --local] [--force] [--dry-run] [--project-dir <dir>] [--repo <owner/repo>]... [--runner <auto|safehouse|sdx|none>] [--agent <claude|codex>]";
const INIT_AGENTS = ["claude", "codex"] as const;

type InitConfigScope = "global" | "local";
type InitAgent = (typeof INIT_AGENTS)[number];

interface InitConfigOptions {
  /** Where to write the config. Defaults to "local" (cwd). */
  scope?: InitConfigScope;
  /** Overwrite an existing destination. */
  force?: boolean;
  /** Report the planned action without touching the filesystem. */
  dryRun?: boolean;
  /** Override for the working directory; defaults to `process.cwd()`. */
  cwd?: string;
  /** Pre-fill workspace.projectDir in the generated config. */
  projectDir?: string;
  /** Pre-fill workspace.knownRepositories in the generated config. */
  repositories?: string[];
  /** Pre-fill local.runner in the generated config. */
  runner?: LocalRunnerSetting;
  /** Choose the single built-in agent preset enabled by the generated config. */
  agent?: InitAgent;
  /** Override the source template path. */
  examplePath?: string;
}

type InitConfigOutcome = "dry-run-would-write" | "exists" | "wrote";

interface InitConfigResult {
  destination: string;
  outcome: InitConfigOutcome;
}

export function initConfig(options: InitConfigOptions = {}): InitConfigResult {
  const scope = options.scope ?? "local";
  const cwd = options.cwd ?? process.cwd();
  const source = options.examplePath ?? resolveExamplePath();
  const destination = destinationFor({ scope, cwd });

  if (existsSync(destination) && options.force !== true) {
    log(`[exists] ${destination} — pass --force to overwrite`);
    return { destination, outcome: "exists" };
  }

  if (options.dryRun === true) {
    log(`[dry-run] would write ${destination}`);
    return { destination, outcome: "dry-run-would-write" };
  }

  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, renderConfig(source, options));
  log(`[wrote] ${destination}`);
  return { destination, outcome: "wrote" };
}

export async function initConfigCli(argv: string[]): Promise<void> {
  const options = parseArguments(argv);
  const result = initConfig(options);

  if (result.outcome === "exists") {
    process.exitCode = 1;
    return;
  }
  if (result.outcome === "wrote") {
    writeInitGuidance(result.destination, options);
  }
}

function parseArguments(argv: string[]): InitConfigOptions {
  let scope: InitConfigScope | undefined;
  let force = false;
  let dryRun = false;
  let projectDir: string | undefined;
  const repositories: string[] = [];
  let runner: LocalRunnerSetting | undefined;
  let agent: InitAgent | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    /* v8 ignore next 3 @preserve -- loop bounds keep argv[index] defined */
    if (argument === undefined) {
      continue;
    }
    if (argument === "--global" || argument === "--local") {
      const next: InitConfigScope = argument === "--global" ? "global" : "local";
      if (scope !== undefined && scope !== next) {
        throw new Error(`crew init: --global and --local are mutually exclusive.\n${INIT_USAGE}`);
      }
      scope = next;
      continue;
    }
    if (argument === "--force") {
      force = true;
      continue;
    }
    if (argument === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (argument === "--project-dir") {
      projectDir = readOptionValue(argv, index, argument);
      index += 1;
      continue;
    }
    if (argument === "--repo") {
      repositories.push(readOptionValue(argv, index, argument));
      index += 1;
      continue;
    }
    if (argument === "--runner") {
      runner = parseRunner(readOptionValue(argv, index, argument));
      index += 1;
      continue;
    }
    if (argument === "--agent") {
      agent = parseAgent(readOptionValue(argv, index, argument));
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${argument}\n${INIT_USAGE}`);
  }

  const parsed: InitConfigOptions = {
    scope: scope ?? "local",
    force,
    dryRun,
    repositories,
  };
  if (projectDir !== undefined) {
    parsed.projectDir = projectDir;
  }
  if (runner !== undefined) {
    parsed.runner = runner;
  }
  if (agent !== undefined) {
    parsed.agent = agent;
  }
  return parsed;
}

function destinationFor(args: { scope: InitConfigScope; cwd: string }): string {
  if (args.scope === "global") {
    return xdgConfigPath("groundcrew", CONFIG_FILE_NAME);
  }
  return path.resolve(args.cwd, CONFIG_FILE_NAME);
}

function resolveExamplePath(): string {
  // `init.ts` lives at src/commands/init.ts in source and dist/commands/init.js
  // after build; the example ships at the package root in both cases.
  return path.resolve(import.meta.dirname, "..", "..", EXAMPLE_FILE_NAME);
}

function readOptionValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.length === 0 || value.startsWith("-")) {
    throw new Error(`crew init ${flag}: value is required\n${INIT_USAGE}`);
  }
  return value;
}

function parseRunner(value: string): LocalRunnerSetting {
  if (isLocalRunnerSetting(value)) {
    return value;
  }
  throw new Error(`crew init --runner must be one of ${LOCAL_RUNNER_SETTINGS.join(", ")}`);
}

function parseAgent(value: string): InitAgent {
  if (isInitAgent(value)) {
    return value;
  }
  throw new Error(`crew init --agent must be one of ${INIT_AGENTS.join(", ")}`);
}

function isLocalRunnerSetting(value: string): value is LocalRunnerSetting {
  return value === "auto" || value === "safehouse" || value === "sdx" || value === "none";
}

function isInitAgent(value: string): value is InitAgent {
  return value === "claude" || value === "codex";
}

function tsString(value: string): string {
  return JSON.stringify(value);
}

function renderConfig(source: string, options: InitConfigOptions): string {
  let contents = readFileSync(source, "utf8");
  if (options.projectDir !== undefined) {
    contents = replaceRequired(
      contents,
      `projectDir: ${tsString(DEFAULT_EXAMPLE_PROJECT_DIR)}`,
      `projectDir: ${tsString(options.projectDir)}`,
      "--project-dir",
    );
  }
  if (options.repositories !== undefined && options.repositories.length > 0) {
    contents = replaceRequired(
      contents,
      'knownRepositories: ["your-org/your-repo"]',
      `knownRepositories: [${options.repositories.map(tsString).join(", ")}]`,
      "--repo",
    );
  }
  if (options.runner !== undefined) {
    contents = replaceRequired(
      contents,
      `  // local: { runner: "auto" },`,
      `  local: { runner: ${tsString(options.runner)} },`,
      "--runner",
    );
  }
  if (options.agent !== undefined) {
    contents = replaceRequired(
      contents,
      `    default: "claude",`,
      `    default: ${tsString(options.agent)},`,
      "--agent",
    );
    contents = replaceRequired(
      contents,
      "      claude: {},",
      `      ${options.agent}: {},`,
      "--agent",
    );
    contents = removeDuplicateAgentDefinitionLines(contents, options.agent);
  }
  return contents;
}

function removeDuplicateAgentDefinitionLines(contents: string, agent: InitAgent): string {
  const linePattern = new RegExp(`^\\s*(?://\\s*)?${escapeRegExp(agent)}:\\s*\\{\\},\\s*$`);
  let hasActiveEntry = false;
  return contents
    .split("\n")
    .filter((line) => {
      if (!linePattern.test(line)) {
        return true;
      }
      const isCommented = line.trimStart().startsWith("//");
      if (!isCommented && !hasActiveEntry) {
        hasActiveEntry = true;
        return true;
      }
      return false;
    })
    .join("\n");
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

function replaceRequired(
  contents: string,
  search: string,
  replacement: string,
  flag: string,
): string {
  if (!contents.includes(search)) {
    throw new Error(`crew init ${flag}: template anchor not found in ${EXAMPLE_FILE_NAME}`);
  }
  return contents.replace(search, replacement);
}

function writeInitGuidance(destination: string, options: InitConfigOptions): void {
  writeOutput("");
  writeOutput("Next steps:");
  writeOutput(`  - Review ${destination}`);
  if (
    options.projectDir === undefined ||
    options.repositories === undefined ||
    options.repositories.length === 0
  ) {
    writeOutput("  - Set workspace.projectDir and workspace.knownRepositories");
  }
  writeCloneGuidance(options);
  writeOutput("  - Add a task source to your config (required):");
  writeOutput("      # Zero credentials — uses a local todo.txt file:");
  writeOutput('      sources: [{ kind: "todo-txt" }]');
  writeOutput("      # Or use Linear (requires GROUNDCREW_LINEAR_API_KEY):");
  writeOutput('      sources: [{ kind: "linear" }]');
  writeOutput("  - Validate and start:");
  writeOutput("      crew doctor");
  writeOutput("      crew run --watch");
}

function writeCloneGuidance(options: InitConfigOptions): void {
  if (options.repositories === undefined || options.repositories.length === 0) {
    return;
  }
  writeOutput("  - Clone configured repositories:");
  writeOutput(`      ${projectDirAssignment(options.projectDir ?? DEFAULT_EXAMPLE_PROJECT_DIR)}`);
  for (const repository of options.repositories) {
    for (const command of cloneCommands(repository)) {
      writeOutput(`      ${command}`);
    }
  }
}

function projectDirAssignment(projectDir: string): string {
  if (projectDir === "~") {
    return 'PROJECT_DIR="$HOME"';
  }
  if (projectDir.startsWith("~/")) {
    return `PROJECT_DIR="$HOME/${escapeDoubleQuotedShellValue(projectDir.slice(2))}"`;
  }
  return `PROJECT_DIR=${shellSingleQuote(projectDir)}`;
}

function cloneCommands(repository: string): string[] {
  const parts = repository.split("/");
  const [owner, name, extra] = parts;
  if (owner !== undefined && name !== undefined && extra === undefined) {
    return [
      `mkdir -p "$PROJECT_DIR/${owner}"`,
      `git clone git@github.com:${owner}/${name}.git "$PROJECT_DIR/${owner}/${name}"`,
    ];
  }
  return [
    'mkdir -p "$PROJECT_DIR"',
    `git clone <REMOTE_URL_FOR_${repository}> "$PROJECT_DIR/${repository}"`,
  ];
}

function escapeDoubleQuotedShellValue(value: string): string {
  let escaped = "";
  for (const character of value) {
    escaped +=
      character === '"' || character === "\\" || character === "$" || character === "`"
        ? `\\${character}`
        : character;
  }
  return escaped;
}
