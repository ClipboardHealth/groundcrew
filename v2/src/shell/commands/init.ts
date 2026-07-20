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
  readonly environment?: Record<string, string>;
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
}

/**
 * Best-effort v1 → v2 conversion by textual key detection (the v1 config is TS,
 * not data). Maps the keys that survive and names every dropped/renamed key with
 * why (design §11). Value extraction is limited to simple string literals.
 */
export function convertV1Config(text: string): ConvertedV1 {
  const notes: string[] = [];
  const projectDir = extractString(text, "projectDir");
  const baseDirectory = extractString(text, "baseDirectory") ?? projectDir;
  const worktreeDirectory =
    extractString(text, "worktreesDirectory") ?? extractString(text, "worktreeDirectory");

  if (projectDir !== undefined) {
    notes.push(`renamed projectDir → workspace.baseDirectory (${projectDir})`);
  } else if (baseDirectory !== undefined) {
    notes.push(`kept workspace.baseDirectory = ${baseDirectory}`);
  }

  if (/definitions/u.test(text)) {
    notes.push("renamed agents.definitions → agents.profiles");
  }

  if (worktreeDirectory !== undefined) {
    notes.push(`kept workspace.worktreeDirectory = ${worktreeDirectory}`);
  }

  if (/prepareWorktree/u.test(text)) {
    notes.push("kept per-repo prepareWorktree hooks");
  }

  const renames: Array<[RegExp, string]> = [
    [/multiplexer/u, "renamed multiplexer → presenter (config field rename, DEVOP-5976)"],
  ];
  for (const [pattern, note] of renames) {
    if (pattern.test(text)) {
      notes.push(note);
    }
  }

  const drops: Array<[RegExp, string]> = [
    [/knownRepositories/u, "dropped knownRepositories: the disk under baseDirectory is the repo universe (DEVOP-5967)"],
    [/networkEgress/u, "dropped networkEgress: egress moved into source manifests (DEVOP-5973)"],
    [/safehouse/u, "dropped safehouse.*: srt is the only runner (DEVOP-5973)"],
    [/\brunner\b/u, "dropped local.runner: srt is the only runner"],
    [/clearance/u, "dropped clearance/crew-clearance-ensure: the bin is gone"],
    [/kind:\s*["']shell["']/u, "dropped shell sources: bring-your-own-scripts is now a user-dir bundle"],
  ];
  for (const [pattern, note] of drops) {
    if (pattern.test(text)) {
      notes.push(note);
    }
  }

  if (notes.length === 0) {
    notes.push("no recognizable v1 keys found; wrote defaults");
  }

  return { notes, baseDirectory, worktreeDirectory };
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
  readonly sources: readonly InitSource[];
  readonly presenter: string | undefined;
}

function buildConfig(input: {
  readonly environment: ContextEnvironment;
  readonly baseDirectory: string;
  readonly converted: ConvertedV1 | undefined;
}): InitConfig {
  const pathValue = input.environment.PATH ?? "";
  const presenter = ["cmux", "tmux", "zellij"].find((name) => onPath({ name, pathValue }));
  const sources = detectSources(input.environment);
  return {
    baseDirectory: input.baseDirectory,
    sources,
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
  const object: Record<string, unknown> = {
    $schema: SCHEMA_URL,
    workspace: { baseDirectory: config.baseDirectory },
    sources: config.sources,
  };
  if (config.presenter !== undefined) {
    object["presenter"] = config.presenter;
  }

  return (
    "// crew.config.jsonc — generated by `crew init`. JSONC: comments allowed.\n" +
    `${JSON.stringify(object, undefined, 2)}\n`
  );
}

function extractString(text: string, key: string): string | undefined {
  const match = new RegExp(`${key}\\s*:\\s*["'\`]([^"'\`]+)["'\`]`, "u").exec(text);
  return match?.[1];
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
