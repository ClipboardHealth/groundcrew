/**
 * `crew init` — create a `crew.config.ts` in the current working directory or,
 * with `--global`, in the XDG groundcrew config dir. The contents come from
 * the shipped `crew.config.example.ts` so a fresh install skips the manual
 * `cp` dance documented in the README.
 */

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { log, writeOutput } from "../lib/util.ts";
import { xdgConfigPath } from "../lib/xdg.ts";

const CONFIG_FILE_NAME = "crew.config.ts";
const EXAMPLE_FILE_NAME = "crew.config.example.ts";

type InitConfigScope = "global" | "local";

interface InitConfigOptions {
  /** Where to write the config. Defaults to "local" (cwd). */
  scope?: InitConfigScope;
  /** Overwrite an existing destination. */
  force?: boolean;
  /** Report the planned action without touching the filesystem. */
  dryRun?: boolean;
  /** Override for the working directory; defaults to `process.cwd()`. */
  cwd?: string;
}

type InitConfigOutcome = "dry-run-would-write" | "exists" | "wrote";

interface InitConfigResult {
  destination: string;
  outcome: InitConfigOutcome;
}

export function initConfig(options: InitConfigOptions = {}): InitConfigResult {
  const scope = options.scope ?? "local";
  const cwd = options.cwd ?? process.cwd();
  const source = resolveExamplePath();
  const destination = destinationFor({ scope, cwd });

  if (existsSync(destination) && options.force !== true) {
    log(`[exists] ${destination} — pass --force to overwrite`);
    return { destination, outcome: "exists" };
  }

  if (options.dryRun === true) {
    log(`[dry-run] would write ${destination}`);
    return { destination, outcome: "dry-run-would-write" };
  }

  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
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
    writeOutput("");
    writeOutput("Next steps:");
    writeOutput(`  - Edit ${result.destination}`);
    writeOutput(
      "  - Set linear.projects[].projectSlug, workspace.projectDir, workspace.knownRepositories",
    );
    writeOutput("  - Export GROUNDCREW_LINEAR_API_KEY (or LINEAR_API_KEY)");
    writeOutput("  - Verify with `crew doctor`");
  }
}

function parseArguments(argv: string[]): InitConfigOptions {
  let scope: InitConfigScope | undefined;
  let force = false;
  let dryRun = false;

  for (const argument of argv) {
    if (argument === "--global" || argument === "--local") {
      const next: InitConfigScope = argument === "--global" ? "global" : "local";
      if (scope !== undefined && scope !== next) {
        throw new Error(
          "crew init: --global and --local are mutually exclusive.\nUsage: crew init [--global | --local] [--force] [--dry-run]",
        );
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
    throw new Error(
      `Unknown option: ${argument}\nUsage: crew init [--global | --local] [--force] [--dry-run]`,
    );
  }

  return { scope: scope ?? "local", force, dryRun };
}

function destinationFor(args: { scope: InitConfigScope; cwd: string }): string {
  if (args.scope === "global") {
    return xdgConfigPath("groundcrew", CONFIG_FILE_NAME);
  }
  return resolve(args.cwd, CONFIG_FILE_NAME);
}

function resolveExamplePath(): string {
  // `init.ts` lives at src/commands/init.ts in source and dist/commands/init.js
  // after build; the example ships at the package root in both cases.
  return resolve(import.meta.dirname, "..", "..", EXAMPLE_FILE_NAME);
}
