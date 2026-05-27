import { createRequire } from "node:module";

import { cleanupWorkspaceCli } from "./commands/cleanupWorkspace.ts";
import { doctor } from "./commands/doctor.ts";
import { initConfigCli } from "./commands/init.ts";
import { interruptWorkspaceCli } from "./commands/interruptWorkspace.ts";
import { orchestrate } from "./commands/orchestrator.ts";
import { resumeWorkspaceCli } from "./commands/resumeWorkspace.ts";
import { sandboxCli } from "./commands/sandbox/index.ts";
import { setupWorkspaceCli } from "./commands/setupWorkspace.ts";
import { statusCli } from "./commands/status.ts";
import { createDefaultUpgradeCliOptions, upgradeCli } from "./commands/upgrade.ts";
import { errorMessage, readTicketArgument, writeError, writeOutput } from "./lib/util.ts";

interface PackageMetadata {
  name: string;
  version: string;
}

interface Subcommand {
  summary: string;
  usage: string;
  hidden?: boolean;
  invoke: (argv: string[]) => Promise<void>;
}

const requireFromCli = createRequire(import.meta.url);

const SETUP_REPOS_REMOVED_MESSAGE = [
  "crew setup repos was removed.",
  "Clone repositories manually with git clone into workspace.projectDir.",
  "See README.md#manual-repository-bootstrap for the replacement workflow.",
].join(" ");

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

async function doctorCli(argv: string[]): Promise<void> {
  if (argv.length > 0) {
    throw new Error("Usage: crew doctor");
  }
  const ok = await doctor();
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
    summary: "Verify host prerequisites (PATH tools, config validity, Linear reachability)",
    usage: "",
    invoke: doctorCli,
  },
  status: {
    summary: "Print read-only groundcrew state, or one ticket's local/Linear status",
    usage: "[<ticket>]",
    invoke: statusCli,
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
  const visibleCommands = Object.entries(SUBCOMMANDS).filter(([, command]) => !command.hidden);
  const width = Math.max(...visibleCommands.map(([key]) => key.length));
  writeOutput("Usage: crew <command> [...args]\n");
  writeOutput("Options:");
  writeOutput("  -h, --help     Show help");
  writeOutput("  -v, --version  Print version");
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
