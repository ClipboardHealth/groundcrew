import { createRequire } from "node:module";

import { cleanupWorkspaceCli } from "./commands/cleanupWorkspace.ts";
import { doctor } from "./commands/doctor.ts";
import { initConfigCli } from "./commands/init.ts";
import { interruptWorkspaceCli } from "./commands/interruptWorkspace.ts";
import { orchestrate } from "./commands/orchestrator.ts";
import { resumeWorkspaceCli } from "./commands/resumeWorkspace.ts";
import { sandboxCli } from "./commands/sandbox/index.ts";
import { setupReposCli } from "./commands/setupRepos.ts";
import { setupWorkspaceCli } from "./commands/setupWorkspace.ts";
import { errorMessage, readTicketArgument, writeError, writeOutput } from "./lib/util.ts";

interface PackageMetadata {
  version: string;
}

interface Subcommand {
  summary: string;
  usage: string;
  invoke: (argv: string[]) => Promise<void>;
}

const requireFromCli = createRequire(import.meta.url);

function setupUsage(): string {
  return "Usage: crew setup repos [--dry-run] [<repo>...]";
}

async function setupCli(argv: string[]): Promise<void> {
  const [verb, ...rest] = argv;
  if (verb === "repos") {
    await setupReposCli(rest);
    return;
  }
  throw new Error(setupUsage());
}

async function runCli(argv: string[]): Promise<void> {
  let watch = false;
  let dryRun = false;
  let ticket: string | undefined;

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
    if (argument === "--ticket") {
      ticket = readTicketArgument(argv, index, "run");
      index += 1;
      continue;
    }
    throw new Error(`crew run: unknown argument: ${argument}`);
  }

  if (ticket !== undefined && watch) {
    throw new Error("crew run: --watch and --ticket are mutually exclusive");
  }

  if (ticket === undefined) {
    await orchestrate({ watch, dryRun });
    return;
  }
  await setupWorkspaceCli(ticket, { dryRun });
}

async function doctorCli(argv: string[]): Promise<void> {
  let ticket: string | undefined;
  const remainingArgs: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--ticket") {
      ticket = readTicketArgument(argv, index, "doctor");
      index += 1;
      continue;
    }
    if (argument === "--no-linear" || argument === "--no-fetch") {
      remainingArgs.push(argument);
      continue;
    }
    throw new Error(`crew doctor: unknown argument: ${argument}`);
  }

  if (ticket === undefined) {
    if (remainingArgs.length > 0) {
      throw new Error(
        `crew doctor: ${remainingArgs[0]} requires --ticket (host doctor mode has no flags)`,
      );
    }
    const ok = await doctor();
    process.exitCode = ok ? process.exitCode : 1;
    return;
  }
  const ok = await doctor({ ticket, ticketArgv: remainingArgs });
  process.exitCode = ok ? process.exitCode : 1;
}

const SUBCOMMANDS: Record<string, Subcommand> = {
  init: {
    summary: "Create a crew.config.ts in the cwd (or --global into the XDG config dir)",
    usage: "[--global | --local] [--force] [--dry-run]",
    invoke: initConfigCli,
  },
  run: {
    summary: "Run the orchestrator (one-shot by default), or provision one ticket with --ticket",
    usage: "[--watch] [--dry-run] [--ticket <ticket>]",
    invoke: runCli,
  },
  doctor: {
    summary:
      "Verify prereqs, or diagnose one ticket with --ticket (full lifecycle: dispatch eligibility + local-state recovery)",
    usage: "[--ticket <ticket> [--no-linear] [--no-fetch]]",
    invoke: doctorCli,
  },
  cleanup: {
    summary: "Tear down a worktree",
    usage: "[--force] <ticket>",
    invoke: cleanupWorkspaceCli,
  },
  interrupt: {
    summary: "Stop a live ticket workspace while preserving its worktree",
    usage: "<ticket> [--reason <text>]",
    invoke: interruptWorkspaceCli,
  },
  resume: {
    summary: "Reopen an existing ticket worktree with a continuation prompt",
    usage: "<ticket>",
    invoke: resumeWorkspaceCli,
  },
  sandbox: {
    summary: "Manage Docker Sandboxes (sbx) for configured models",
    usage: "<list|ensure|regenerate|auth|rm> [...args]",
    invoke: sandboxCli,
  },
  setup: {
    summary: "Project-level setup commands (currently: repos)",
    usage: "repos [--dry-run] [<repo>...]",
    invoke: setupCli,
  },
};

function printHelp(): void {
  const width = Math.max(...Object.keys(SUBCOMMANDS).map((key) => key.length));
  writeOutput("Usage: crew <command> [...args]\n");
  writeOutput("Options:");
  writeOutput("  -h, --help     Show help");
  writeOutput("  -v, --version  Print version");
  writeOutput("");
  writeOutput("Commands:");
  for (const [name, command] of Object.entries(SUBCOMMANDS)) {
    writeOutput(`  ${name.padEnd(width)}  ${command.summary}`);
    writeOutput(`  ${" ".repeat(width)}  → crew ${name} ${command.usage}`);
  }
  writeOutput("\nSee README.md for full configuration and behavior.");
}

function packageVersion(): string {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-assignment -- package.json is shipped with this package and is the version source of truth.
  const packageMetadata: PackageMetadata = requireFromCli("../package.json");
  return packageMetadata.version;
}

export async function run(argv: string[]): Promise<void> {
  const [subcommand, ...rest] = argv;

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
