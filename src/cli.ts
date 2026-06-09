import { createRequire } from "node:module";

import { cleanupWorkspaceCli } from "./commands/cleanupWorkspace.ts";
import { doctor } from "./commands/doctor.ts";
import { initConfigCli } from "./commands/init.ts";
import { interruptWorkspaceCli } from "./commands/interruptWorkspace.ts";
import { orchestrate } from "./commands/orchestrator.ts";
import { resumeWorkspaceCli } from "./commands/resumeWorkspace.ts";
import { setupWorkspaceCli } from "./commands/setupWorkspace.ts";
import { sourceCli } from "./commands/source.ts";
import { statusCli } from "./commands/status.ts";
import { taskCli } from "./commands/task.ts";
import { createDefaultUpgradeCliOptions, upgradeCli } from "./commands/upgrade.ts";
import {
  errorMessage,
  parseDryRunPositionals,
  readEnvironmentVariable,
  readTaskArgument,
  setVerbose,
  writeError,
  writeOutput,
} from "./lib/util.ts";

const REMOVED_SANDBOX_COMMAND_MESSAGE = [
  "`crew sandbox` is no longer supported.",
  "Groundcrew now launches agents inside existing sbx sandboxes but does not list, create, regenerate, authenticate, or remove them.",
  "Use the manual `sbx` workflow in README.md#docker-sandboxes-sdx-setup, then keep `agents.definitions.<agent>.sandbox.agent` in crew.config.ts so launches can address the existing sandbox.",
].join("\n");

interface PackageMetadata {
  name: string;
  version: string;
}

interface Subcommand {
  summary: string;
  usage: string;
  hidden?: boolean;
  invoke: (argv: string[]) => Promise<void>;
  // Deprecated aliases keep working but are hidden from `crew --help`.
  deprecated?: boolean;
}

const requireFromCli = createRequire(import.meta.url);

const SETUP_REPOS_REMOVED_MESSAGE = [
  "crew setup repos was removed.",
  "Clone repositories manually with git clone into workspace.projectDir (or each repo's workspace.knownRepositories `projectDirOverride`).",
  "See README.md#manual-repository-bootstrap for the replacement workflow.",
].join(" ");

/**
 * Prints a deprecation warning to stderr naming the canonical command and that
 * the old form is removed in the next major, then lets the caller proceed.
 */
function warnDeprecated(forms: { oldForm: string; newForm: string }): void {
  writeError(
    `crew ${forms.oldForm} is deprecated and will be removed in the next major version; use crew ${forms.newForm} instead.`,
  );
}

function setupUsage(): string {
  return `Usage: crew setup repos\n\n${SETUP_REPOS_REMOVED_MESSAGE}`;
}

async function setupCli(argv: string[]): Promise<void> {
  const [verb] = argv;
  if (verb === "repos") {
    throw new Error(SETUP_REPOS_REMOVED_MESSAGE);
  }
  throw new Error(setupUsage());
}

async function runCli(argv: string[]): Promise<void> {
  let watch = false;
  let dryRun = false;
  let task: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--watch") {
      watch = true;
      continue;
    }
    if (argument === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (argument === "--task") {
      task = readTaskArgument(argv, index, "run");
      index += 1;
      continue;
    }
    throw new Error(`crew run: unknown argument: ${argument}`);
  }

  if (task !== undefined && watch) {
    throw new Error("crew run: --watch and --task are mutually exclusive");
  }

  if (task === undefined) {
    await orchestrate({ watch, dryRun });
    return;
  }
  warnDeprecated({ oldForm: "run --task", newForm: "start" });
  await setupWorkspaceCli(task, { dryRun });
}

const START_USAGE = "crew start <task> [--dry-run]";

async function startCli(argv: string[]): Promise<void> {
  const { dryRun, positionals } = parseDryRunPositionals(argv, START_USAGE);
  const [task, ...extras] = positionals;
  if (task === undefined || task.length === 0 || extras.length > 0) {
    throw new Error(`Usage: ${START_USAGE}`);
  }
  await setupWorkspaceCli(task, { dryRun });
}

async function upgradeCliInvoke(argv: string[]): Promise<void> {
  const metadata = packageMetadata();
  await upgradeCli(
    argv,
    async () =>
      await createDefaultUpgradeCliOptions({
        packageName: metadata.name,
        cliMetaUrl: import.meta.url,
      }),
  );
}

function doctorTaskAlias(argv: string[]): string | undefined {
  if (argv[0] !== "--task") {
    return undefined;
  }
  const task = readTaskArgument(argv, 0, "doctor");
  if (argv.length > 2) {
    throw new Error("Usage: crew status [<task>]");
  }
  return task;
}

async function doctorCli(argv: string[]): Promise<void> {
  const aliasTask = doctorTaskAlias(argv);
  if (aliasTask !== undefined) {
    warnDeprecated({ oldForm: "doctor --task", newForm: "status" });
    await statusCli([aliasTask]);
    return;
  }
  if (argv.length > 0) {
    throw new Error("Usage: crew doctor");
  }
  const ok = await doctor();
  process.exitCode = ok ? process.exitCode : 1;
}

const SUBCOMMANDS: Record<string, Subcommand> = {
  init: {
    summary: "Create a crew.config.ts in the cwd (or --global into the XDG config dir)",
    usage:
      "[--global | --local] [--force] [--dry-run] [--project-dir <dir>] [--repo <repo>]... [--runner <runner>] [--agent <agent>]",
    invoke: initConfigCli,
  },
  run: {
    summary: "Run the orchestrator: poll sources and start eligible tasks (one-shot by default)",
    usage: "[--watch] [--dry-run]",
    invoke: runCli,
  },
  start: {
    summary: "Launch one task immediately, bypassing eligibility",
    usage: "<task> [--dry-run]",
    invoke: startCli,
  },
  doctor: {
    summary: "Verify host prerequisites (PATH tools, config validity, Linear reachability)",
    usage: "",
    invoke: doctorCli,
  },
  source: {
    summary: "Inspect configured task sources",
    usage: "<list|verify> [...]",
    invoke: sourceCli,
  },
  task: {
    summary: "List, get, and create tasks across configured sources",
    usage: "<list|get|create> [...]",
    invoke: taskCli,
  },
  status: {
    summary: "Print read-only groundcrew state, or one task's local/Linear status",
    usage: "[<task>]",
    invoke: statusCli,
  },
  cleanup: {
    summary: "Tear down a worktree",
    usage: "[--force] <task>",
    invoke: cleanupWorkspaceCli,
  },
  stop: {
    summary: "Stop a live task workspace while preserving its worktree",
    usage: "<task> [--reason <text>]",
    invoke: interruptWorkspaceCli,
  },
  interrupt: {
    summary: "Deprecated alias for `crew stop`",
    usage: "<task> [--reason <text>]",
    deprecated: true,
    invoke: async (argv) => {
      warnDeprecated({ oldForm: "interrupt", newForm: "stop" });
      await interruptWorkspaceCli(argv);
    },
  },
  resume: {
    summary: "Reopen an existing task worktree with a continuation prompt",
    usage: "<task>",
    invoke: resumeWorkspaceCli,
  },
  setup: {
    summary: "Removed repository bootstrap command",
    usage: "repos",
    hidden: true,
    invoke: setupCli,
  },
  upgrade: {
    summary: "Install the latest version of crew (or pin to a specific version)",
    usage: "[<version>]",
    invoke: upgradeCliInvoke,
  },
};

function printHelp(): void {
  const visibleCommands = Object.entries(SUBCOMMANDS).filter(
    ([, command]) => command.hidden !== true && command.deprecated !== true,
  );
  const width = Math.max(...visibleCommands.map(([key]) => key.length));
  writeOutput("Usage: crew <command> [...args]\n");
  writeOutput("Options:");
  writeOutput("  -h, --help     Show help");
  writeOutput("  -v, --version  Print version");
  writeOutput("      --verbose  Show diagnostic output (or set GROUNDCREW_VERBOSE)");
  writeOutput("");
  writeOutput("Commands:");
  for (const [name, command] of visibleCommands) {
    writeOutput(`  ${name.padEnd(width)}  ${command.summary}`);
    writeOutput(`  ${" ".repeat(width)}  → crew ${name} ${command.usage}`);
  }
  writeOutput("\nSee README.md for full configuration and behavior.");
}

function packageMetadata(): PackageMetadata {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-assignment -- package.json is shipped with this package and is the metadata source of truth.
  const metadata: PackageMetadata = requireFromCli("../package.json");
  return metadata;
}

function packageVersion(): string {
  return packageMetadata().version;
}

const VERBOSE_FLAG = "--verbose";

function environmentVerbose(): boolean {
  const raw = readEnvironmentVariable("GROUNDCREW_VERBOSE");
  return raw !== undefined && raw !== "" && raw !== "0" && raw.toLowerCase() !== "false";
}

/**
 * Pulls the global `--verbose` flag out of argv before subcommand dispatch so
 * every command supports it and the strict per-command parsers never see it.
 * GROUNDCREW_VERBOSE enables it without the flag.
 */
function extractVerbose(argv: string[]): { verbose: boolean; commandArgv: string[] } {
  const commandArgv = argv.filter((argument) => argument !== VERBOSE_FLAG);
  const verbose = commandArgv.length !== argv.length || environmentVerbose();
  return { verbose, commandArgv };
}

export async function run(argv: string[]): Promise<void> {
  const { verbose, commandArgv } = extractVerbose(argv);
  if (verbose) {
    setVerbose(true);
  }
  const [subcommand, ...rest] = commandArgv;

  if (subcommand === undefined || subcommand === "-h" || subcommand === "--help") {
    printHelp();
    if (subcommand === undefined) {
      process.exitCode = 1;
    }
    return;
  }

  if (subcommand === "-v" || subcommand === "--version") {
    writeOutput(packageVersion());
    return;
  }

  if (subcommand === "sandbox") {
    writeError(REMOVED_SANDBOX_COMMAND_MESSAGE);
    process.exitCode = 1;
    return;
  }

  const command = SUBCOMMANDS[subcommand];
  if (!command) {
    writeError(`Unknown command: ${subcommand}\n`);
    printHelp();
    process.exitCode = 1;
    return;
  }

  try {
    await command.invoke(rest);
  } catch (error) {
    writeError(errorMessage(error));
    process.exitCode = 1;
  }
}
