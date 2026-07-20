/**
 * `crew init` (design §7.1/§7.3, contracts §7): interactive setup, safe to
 * re-run. Picks a baseDirectory, detects agents on PATH and sources whose
 * secrets resolve, writes crew.config.jsonc (global by default, `--local` for
 * ./), and closes by running `crew doctor`. Detecting a v1 `crew.config.ts`
 * offers conversion — the surviving keys are mapped and every dropped or renamed
 * key is printed with why (design §11). `--yes` accepts detected defaults,
 * `--force` overwrites, `--dry-run` prints without writing.
 */
import * as fs from "node:fs";
import * as readline from "node:readline";
import path from "node:path";

import { runDoctor } from "./doctor.js";
import {
  type DiscoveredSourceOk,
  createSecretsResolver,
  discoverSources,
} from "../../acquisition/index.js";
import type { ContextEnvironment } from "../context.js";
import { CliError } from "../errors.js";
import {
  V1_CONFIG_FILENAMES,
  globalConfigPath,
  groundcrewConfigDirectory,
  homeDirectory,
  localConfigPath,
  packageBundlesDirectory,
  userBundlesDirectory,
} from "../config/paths.js";
import { onPath } from "../detect.js";
import type { Io } from "../io.js";

interface InitSource {
  readonly kind: string;
  readonly name?: string;
  readonly environment?: Record<string, string>;
}

/** An `agents.profiles` map after conversion (pure presets are `{}`). */
type ConvertedProfiles = Record<string, Record<string, never>>;

interface ConvertedAgents {
  readonly default: string | undefined;
  readonly profiles: ConvertedProfiles;
}

const SCHEMA_URL = "https://unpkg.com/@clipboard-health/groundcrew/schema.json";

export interface InitOptions {
  readonly local?: boolean;
  readonly yes?: boolean;
  readonly force?: boolean;
  readonly dryRun?: boolean;
}

export async function runInit(input: {
  readonly environment: ContextEnvironment;
  readonly cwd: string;
  readonly options: InitOptions;
  readonly io: Io;
}): Promise<number> {
  const { environment, cwd, options, io } = input;
  const target = options.local === true ? localConfigPath(cwd) : globalConfigPath(environment);

  if (fs.existsSync(target) && options.force !== true && options.dryRun !== true) {
    throw new CliError(`config already exists at ${target}. Re-run with --force to overwrite.`);
  }

  const v1 = findV1(environment, cwd);
  const converted = v1 === undefined ? undefined : convertV1Config(fs.readFileSync(v1, "utf8"));
  if (v1 !== undefined && converted !== undefined) {
    io.out(`Detected a groundcrew v1 config at ${v1}. Converting:`);
    for (const note of converted.notes) {
      io.out(`  ${note}`);
    }

    io.out("");
  }

  const baseDirectory = await chooseBaseDirectory({ environment, cwd, options, io, converted });
  const config = buildConfig({ environment, baseDirectory, converted });
  const rendered = renderConfig(config);

  if (options.dryRun === true) {
    io.out(`Would write ${target}:`);
    io.out(rendered);
    return 0;
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, rendered);
  io.out(`Wrote ${target}.`);
  io.out("");

  io.out("Running crew doctor …");
  const doctorCode = await runDoctor({
    environment,
    cwd,
    verbose: false,
    json: false,
    io,
  });

  io.out("");
  io.out("Next steps (deliberately manual): clone repos into the base directory, mint any");
  io.out("API tokens, and install agent CLIs. See `crew doctor` for what is still missing.");

  return doctorCode;
}

interface ConvertedV1 {
  readonly notes: string[];
  readonly baseDirectory: string | undefined;
  readonly worktreeDirectory: string | undefined;
  /** `undefined` ⇒ v1 declared no `sources` (fall back to the detected default). */
  readonly sources: InitSource[] | undefined;
  /** `undefined` ⇒ v1 declared no `agents` (leave agents to runtime detection). */
  readonly agents: ConvertedAgents | undefined;
  /** v1 `defaults.hooks.prepareWorktree` → `workspace.prepareWorktree`. */
  readonly prepareWorktree: string | undefined;
  /** Collected from v1 `preLaunch` pure-export strings → `workspace.environment`. */
  readonly environment: Record<string, string> | undefined;
}

/**
 * Best-effort v1 → v2 conversion. The v1 config is TS, not data, so this is a
 * structural text parse (balanced-brace slicing, not `eval`): it produces the
 * v2 shapes the caller actually writes, and every `notes` line is derived from
 * what was produced or dropped — the announcement and the file cannot diverge
 * (Bug 1, DEVOP dogfood). Every dropped or renamed key names why (design §11).
 */
export function convertV1Config(rawText: string): ConvertedV1 {
  const text = stripComments(rawText);
  const notes: string[] = [];

  const workspaceBody = sliceBlock(text, "workspace", "{", "}") ?? text;
  const projectDir = extractString(workspaceBody, "projectDir");
  const explicitBase = extractString(workspaceBody, "baseDirectory");
  const baseDirectory = explicitBase ?? projectDir;
  const worktreeDirectory =
    extractString(workspaceBody, "worktreesDirectory") ??
    extractString(workspaceBody, "worktreeDirectory");

  if (projectDir !== undefined) {
    notes.push(`renamed projectDir → workspace.baseDirectory (${projectDir})`);
  } else if (baseDirectory !== undefined) {
    notes.push(`kept workspace.baseDirectory = ${baseDirectory}`);
  }

  if (worktreeDirectory !== undefined) {
    notes.push(`kept workspace.worktreeDirectory = ${worktreeDirectory}`);
  }

  const prepareWorktree = convertDefaultHook(text, notes);
  const agents = convertAgents(text, notes);
  const environment = collectEnvironment(text, notes);
  const sources = convertSources(text, notes);

  if (/multiplexer/u.test(text)) {
    notes.push("renamed multiplexer → presenter (config field rename, DEVOP-5976)");
  }

  announceDrops(text, notes);

  if (notes.length === 0) {
    notes.push("no recognizable v1 keys found; wrote defaults");
  }

  return { notes, baseDirectory, worktreeDirectory, sources, agents, prepareWorktree, environment };
}

/** v1 `defaults.hooks.prepareWorktree` → `workspace.prepareWorktree`. */
function convertDefaultHook(text: string, notes: string[]): string | undefined {
  const defaultsBody = sliceBlock(text, "defaults", "{", "}");
  const hooksBody = defaultsBody === undefined ? undefined : sliceBlock(defaultsBody, "hooks", "{", "}");
  const hook = hooksBody === undefined ? undefined : extractString(hooksBody, "prepareWorktree");
  if (hook !== undefined) {
    notes.push(`mapped defaults.hooks.prepareWorktree → workspace.prepareWorktree (${hook})`);
  }

  return hook;
}

/**
 * v1 `agents.default` + `agents.definitions` → `{ default, profiles }`. Each
 * definition becomes a pure-preset `{}` entry (its env moves to
 * workspace.environment via {@link collectEnvironment}). Returns `undefined`
 * when v1 declared no agents so the caller leaves agent detection to runtime.
 */
function convertAgents(text: string, notes: string[]): ConvertedAgents | undefined {
  const agentsBody = sliceBlock(text, "agents", "{", "}");
  if (agentsBody === undefined) {
    return undefined;
  }

  const defaultAgent = extractString(agentsBody, "default");
  const definitionsBody = sliceBlock(agentsBody, "definitions", "{", "}");
  const profiles: ConvertedProfiles = {};
  if (definitionsBody !== undefined) {
    for (const entry of topLevelEntries(definitionsBody)) {
      profiles[entry.key] = {};
    }
  }

  const names = Object.keys(profiles);
  if (names.length > 0) {
    notes.push(`renamed agents.definitions → agents.profiles (${names.join(", ")})`);
  }

  if (defaultAgent === undefined && names.length === 0) {
    return undefined;
  }

  return { default: defaultAgent, profiles };
}

/**
 * v1 `preLaunch` pure-export strings across all agent definitions → a deduped
 * `workspace.environment`. A `preLaunch` that is NOT purely `export KEY=VALUE`
 * statements is dropped with a named warning (v2 has no `preLaunch`).
 */
function collectEnvironment(text: string, notes: string[]): Record<string, string> | undefined {
  const definitionsBody = sliceBlock(sliceBlock(text, "agents", "{", "}") ?? "", "definitions", "{", "}");
  if (definitionsBody === undefined) {
    return undefined;
  }

  const environment: Record<string, string> = {};
  for (const definition of topLevelEntries(definitionsBody)) {
    const preLaunch = extractString(definition.value, "preLaunch");
    if (preLaunch === undefined) {
      continue;
    }

    const parsed = parseExports(preLaunch);
    if (!parsed.pure) {
      notes.push(
        `dropped preLaunch for agent "${definition.key}": not pure \`export KEY=VALUE\` ` +
          `(v2 has no preLaunch): ${preLaunch}`,
      );
      continue;
    }

    for (const [key, value] of parsed.pairs) {
      environment[key] = value;
    }
  }

  const keys = Object.keys(environment);
  if (keys.length === 0) {
    return undefined;
  }

  notes.push(`collected preLaunch exports → workspace.environment (${keys.join(", ")})`);
  return environment;
}

/**
 * v1 `sources` → v2 source entries: non-`shell` kinds pass through (kind + name),
 * `shell` sources are dropped with a reason. Returns `undefined` when v1 declared
 * no `sources` (so the caller keeps the detected default), an empty array when
 * every declared source was dropped (default then applies — never a silent swap).
 */
function convertSources(text: string, notes: string[]): InitSource[] | undefined {
  const sourcesBody = sliceBlock(text, "sources", "[", "]");
  if (sourcesBody === undefined) {
    return undefined;
  }

  const sources: InitSource[] = [];
  for (const objectText of splitTopLevelObjects(sourcesBody)) {
    const kind = extractString(objectText, "kind");
    if (kind === undefined) {
      continue;
    }

    const name = extractString(objectText, "name");
    if (kind === "shell") {
      notes.push(
        `dropped shell source${name === undefined ? "" : ` "${name}"`}: ` +
          "bring-your-own-scripts is now a user-dir bundle (DEVOP-5973)",
      );
      continue;
    }

    const entry: InitSource = name === undefined ? { kind } : { kind, name };
    sources.push(entry);
    notes.push(`kept source ${kind}${name === undefined ? "" : ` (name: ${name})`}`);
  }

  return sources;
}

/** Keys that have no v2 home: named as dropped, with why (design §11). */
function announceDrops(text: string, notes: string[]): void {
  const drops: Array<[RegExp, string]> = [
    [/knownRepositories/u, "dropped knownRepositories: the disk under baseDirectory is the repo universe (DEVOP-5967)"],
    [/networkEgress/u, "dropped networkEgress: egress moved into source manifests (DEVOP-5973)"],
    [/safehouse/u, "dropped safehouse.*: srt is the only runner (DEVOP-5973)"],
    [/\brunner\b/u, "dropped local.runner: srt is the only runner"],
    [/clearance/u, "dropped clearance/crew-clearance-ensure: the bin is gone"],
  ];
  for (const [pattern, note] of drops) {
    if (pattern.test(text)) {
      notes.push(note);
    }
  }
}

function findV1(environment: ContextEnvironment, cwd: string): string | undefined {
  for (const directory of [cwd, groundcrewConfigDirectory(environment)]) {
    for (const filename of V1_CONFIG_FILENAMES) {
      const candidate = path.join(directory, filename);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return undefined;
}

async function chooseBaseDirectory(input: {
  readonly environment: ContextEnvironment;
  readonly cwd: string;
  readonly options: InitOptions;
  readonly io: Io;
  readonly converted: ConvertedV1 | undefined;
}): Promise<string> {
  const detected =
    input.converted?.baseDirectory ?? detectBaseDirectory(input.environment, input.cwd);

  if (input.options.yes === true) {
    return detected;
  }

  const answer = await prompt(`Base directory for repositories [${detected}]: `);
  return answer.trim() === "" ? detected : answer.trim();
}

function detectBaseDirectory(environment: ContextEnvironment, cwd: string): string {
  const home = homeDirectory(environment);
  for (const candidate of ["dev", "code", "src", "projects"]) {
    const directory = path.join(home, candidate);
    if (fs.existsSync(directory)) {
      return directory;
    }
  }

  return cwd;
}

interface InitConfig {
  readonly baseDirectory: string;
  readonly worktreeDirectory: string | undefined;
  readonly environment: Record<string, string> | undefined;
  readonly prepareWorktree: string | undefined;
  readonly sources: readonly InitSource[];
  readonly agents: ConvertedAgents | undefined;
  readonly presenter: string | undefined;
}

function buildConfig(input: {
  readonly environment: ContextEnvironment;
  readonly baseDirectory: string;
  readonly converted: ConvertedV1 | undefined;
}): InitConfig {
  const { converted } = input;
  const pathValue = input.environment.PATH ?? "";
  const presenter = ["cmux", "tmux", "zellij"].find((name) => onPath({ name, pathValue }));

  // Converted sources win when v1 declared any that survived; the detected
  // default applies only when v1 had no sources or all were dropped — never a
  // silent swap over configured sources (Bug 1).
  const sources =
    converted?.sources !== undefined && converted.sources.length > 0
      ? converted.sources
      : detectSources(input.environment);

  return {
    baseDirectory: input.baseDirectory,
    worktreeDirectory: converted?.worktreeDirectory,
    environment: converted?.environment,
    prepareWorktree: converted?.prepareWorktree,
    sources,
    agents: converted?.agents,
    presenter,
  };
}

/**
 * The sources init enables (design §7.2/§7.3): every discovered USER bundle the
 * operator explicitly installed whose declared secrets resolve, plus a package
 * default — linear when its secret resolves, else todo-txt. Package bundles the
 * operator did not opt into (jira, …) are left out so doctor stays green.
 */
function detectSources(environment: ContextEnvironment): InitSource[] {
  const discovered = discoverSources({
    packageBundlesDirectory: packageBundlesDirectory(),
    userBundlesDirectory: userBundlesDirectory(environment),
  });
  const resolver = createSecretsResolver({ environment });
  const resolves = (secrets: readonly string[]): boolean =>
    secrets.every((name) => resolver.resolve(name) !== undefined);

  const enabled: InitSource[] = [];
  for (const source of discovered) {
    if (source.status === "ok" && source.origin === "user" && resolves(source.manifest.secrets)) {
      enabled.push(sourceEntry(source));
    }
  }

  const linear = discovered.find(
    (source): source is DiscoveredSourceOk => source.status === "ok" && source.name === "linear",
  );
  if (linear !== undefined && resolves(linear.manifest.secrets)) {
    enabled.push({ kind: "linear" });
  } else if (enabled.length === 0) {
    enabled.push({ kind: "todo-txt" });
  }

  return enabled;
}

function sourceEntry(source: DiscoveredSourceOk): InitSource {
  const environment = source.manifest.environment;
  return Object.keys(environment).length === 0
    ? { kind: source.name }
    : { kind: source.name, environment };
}

function renderConfig(config: InitConfig): string {
  const workspace: Record<string, unknown> = { baseDirectory: config.baseDirectory };
  if (config.worktreeDirectory !== undefined) {
    workspace["worktreeDirectory"] = config.worktreeDirectory;
  }
  if (config.environment !== undefined) {
    workspace["environment"] = config.environment;
  }
  if (config.prepareWorktree !== undefined) {
    workspace["prepareWorktree"] = config.prepareWorktree;
  }

  const object: Record<string, unknown> = {
    $schema: SCHEMA_URL,
    workspace,
    sources: config.sources,
  };
  if (config.agents !== undefined) {
    object["agents"] = renderAgents(config.agents);
  }
  if (config.presenter !== undefined) {
    object["presenter"] = config.presenter;
  }

  return (
    "// crew.config.jsonc — generated by `crew init`. JSONC: comments allowed.\n" +
    `${JSON.stringify(object, undefined, 2)}\n`
  );
}

function renderAgents(agents: ConvertedAgents): Record<string, unknown> {
  const rendered: Record<string, unknown> = {};
  if (agents.default !== undefined) {
    rendered["default"] = agents.default;
  }
  rendered["profiles"] = agents.profiles;
  return rendered;
}

function extractString(text: string, key: string): string | undefined {
  const match = new RegExp(`\\b${key}\\s*:\\s*["'\`]([^"'\`]*)["'\`]`, "u").exec(text);
  return match?.[1];
}

/**
 * Strip `//` and block comments from TS source, preserving string literals so a
 * `//` inside a URL or an `/* *\/` inside a quoted value is not mistaken for a
 * comment. Keeps the parse below honest on real, commented v1 configs.
 */
function stripComments(text: string): string {
  let out = "";
  let quote: string | undefined;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (quote !== undefined) {
      out += char;
      if (char === "\\") {
        out += next ?? "";
        i += 1;
      } else if (char === quote) {
        quote = undefined;
      }

      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      out += char;
      continue;
    }

    if (char === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") {
        i += 1;
      }
      out += "\n";
      continue;
    }

    if (char === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
        i += 1;
      }
      i += 1; // land on the closing '/', the loop increment steps past it
      out += " ";
      continue;
    }

    out += char;
  }

  return out;
}

/** The balanced region after `key: <open>` (inner text, no brackets); else undefined. */
function sliceBlock(text: string, key: string, open: "{" | "[", close: "}" | "]"): string | undefined {
  const re = new RegExp(`\\b${key}\\s*:\\s*\\${open}`, "u");
  const match = re.exec(text);
  if (match === null) {
    return undefined;
  }

  const openIndex = match.index + match[0].length - 1;
  return matchBalanced(text, openIndex, open, close)?.inner;
}

/** From an opening bracket, the inner text and the index of its matching close. */
function matchBalanced(
  text: string,
  openIndex: number,
  open: string,
  close: string,
): { inner: string; end: number } | undefined {
  let depth = 0;
  let quote: string | undefined;
  for (let i = openIndex; i < text.length; i += 1) {
    const char = text[i];
    if (quote !== undefined) {
      if (char === "\\") {
        i += 1;
      } else if (char === quote) {
        quote = undefined;
      }

      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      quote = char;
    } else if (char === open) {
      depth += 1;
    } else if (char === close) {
      depth -= 1;
      if (depth === 0) {
        return { inner: text.slice(openIndex + 1, i), end: i };
      }
    }
  }

  return undefined;
}

/** Split an object-array body (inside `[...]`) into its top-level object bodies. */
function splitTopLevelObjects(body: string): string[] {
  const objects: string[] = [];
  let i = 0;
  while (i < body.length) {
    if (body[i] !== "{") {
      i += 1;
      continue;
    }

    const matched = matchBalanced(body, i, "{", "}");
    if (matched === undefined) {
      break;
    }

    objects.push(matched.inner);
    i = matched.end + 1;
  }

  return objects;
}

/** Top-level `key: value` entries of an object body (value text kept verbatim). */
function topLevelEntries(body: string): Array<{ key: string; value: string }> {
  const entries: Array<{ key: string; value: string }> = [];
  const length = body.length;
  let i = 0;
  while (i < length) {
    while (i < length && /[\s,]/u.test(body[i] ?? "")) {
      i += 1;
    }
    if (i >= length) {
      break;
    }

    const key = readKey(body, i);
    if (key === undefined) {
      break;
    }
    i = key.end;

    while (i < length && /\s/u.test(body[i] ?? "")) {
      i += 1;
    }
    if (body[i] !== ":") {
      break;
    }
    i += 1;
    while (i < length && /\s/u.test(body[i] ?? "")) {
      i += 1;
    }

    const value = readValue(body, i);
    entries.push({ key: key.value, value: body.slice(value.start, value.end).trim() });
    i = value.end;
  }

  return entries;
}

function readKey(body: string, start: number): { value: string; end: number } | undefined {
  const char = body[start];
  if (char === '"' || char === "'" || char === "`") {
    let i = start + 1;
    let value = "";
    while (i < body.length && body[i] !== char) {
      value += body[i];
      i += 1;
    }

    return { value, end: i + 1 };
  }

  let i = start;
  let value = "";
  while (i < body.length && /[A-Za-z0-9_$]/u.test(body[i] ?? "")) {
    value += body[i];
    i += 1;
  }

  return value.length === 0 ? undefined : { value, end: i };
}

/** The span of a value from `start` up to the next top-level comma. */
function readValue(body: string, start: number): { start: number; end: number } {
  let depth = 0;
  let quote: string | undefined;
  let i = start;
  for (; i < body.length; i += 1) {
    const char = body[i];
    if (quote !== undefined) {
      if (char === "\\") {
        i += 1;
      } else if (char === quote) {
        quote = undefined;
      }

      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      quote = char;
    } else if (char === "{" || char === "[" || char === "(") {
      depth += 1;
    } else if (char === "}" || char === "]" || char === ")") {
      depth -= 1;
    } else if (char === "," && depth === 0) {
      break;
    }
  }

  return { start, end: i };
}

/**
 * Parse a v1 `preLaunch` string as `export KEY=VALUE` statements (separated by
 * `;`, `&&`, or newlines). `pure` is true only when every statement is such an
 * export; otherwise the string carries shell logic v2 cannot express as env.
 */
function parseExports(preLaunch: string): { pure: boolean; pairs: Array<[string, string]> } {
  const statements = preLaunch
    .split(/;|&&|\n/u)
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
  if (statements.length === 0) {
    return { pure: false, pairs: [] };
  }

  const pairs: Array<[string, string]> = [];
  for (const statement of statements) {
    const match = /^export\s+([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(statement);
    if (match?.[1] === undefined) {
      return { pure: false, pairs: [] };
    }

    pairs.push([match[1], unquote(match[2] ?? "")]);
  }

  return { pure: true, pairs };
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

async function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise<string>((resolve) => {
      rl.question(question, (answer) => {
        resolve(answer);
      });
    });
  } finally {
    rl.close();
  }
}
