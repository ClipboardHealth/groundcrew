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
import { statusCli } from "./commands/status.ts";
import { createDefaultUpgradeCliOptions, upgradeCli } from "./commands/upgrade.ts";
import {
  computeUpgradeNudge,
  defaultUpgradeCheckCachePath,
  fetchLatestVersion,
} from "./lib/upgrade.ts";
import {
  errorMessage,
  parseDryRunPositionals,
  readEnvironmentVariable,
  readTicketArgument,
  writeError,
  writeOutput,
} from "./lib/util.ts";

const NUDGE_TTL_MS = 6 * 60 * 60 * 1000;
const NUDGE_FETCH_TIMEOUT_MS = 1000;

interface PackageMetadata {
  name: string;
  version: string;
}

interface Subcommand {
  summary: string;
  usage: string;
  invoke: (argv: string[]) => Promise<void>;
  // Deprecated aliases keep working but are hidden from `crew --help`.
  deprecated?: boolean;
}

const requireFromCli = createRequire(import.meta.url);

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
  warnDeprecated({ oldForm: "run --ticket", newForm: "start" });
  await setupWorkspaceCli(ticket, { dryRun });
}

const START_USAGE = "crew start <ticket> [--dry-run]";

async function startCli(argv: string[]): Promise<void> {
  const { dryRun, positionals } = parseDryRunPositionals(argv, START_USAGE);
  const [ticket, ...extras] = positionals;
  if (ticket === undefined || ticket.length === 0 || extras.length > 0) {
    throw new Error(`Usage: ${START_USAGE}`);
  }
  await setupWorkspaceCli(ticket, { dryRun });
}

async function upgradeCliInvoke(argv: string[]): Promise<void> {
  const metadata = packageMetadata();
  await upgradeCli(
    argv,
    async () =>
      await createDefaultUpgradeCliOptions({
        currentVersion: metadata.version,
        packageName: metadata.name,
        cliMetaUrl: import.meta.url,
      }),
  );
}

async function maybeRunUpgradeNudge(metadata: PackageMetadata): Promise<void> {
  const message = await computeUpgradeNudge({
    currentVersion: metadata.version,
    packageName: metadata.name,
    cachePath: defaultUpgradeCheckCachePath(),
    ttlMs: NUDGE_TTL_MS,
    fetchTimeoutMs: NUDGE_FETCH_TIMEOUT_MS,
    registry: readEnvironmentVariable("npm_config_registry"),
    noUpgradeCheck: readEnvironmentVariable("GROUNDCREW_NO_UPGRADE_CHECK") === "1",
    now: Date.now,
    fetcher: fetchLatestVersion,
  });
  if (message !== undefined) {
    writeError(message);
  }
}

function doctorTicketAlias(argv: string[]): string | undefined {
  if (argv[0] !== "--ticket") {
    return undefined;
  }
  const ticket = readTicketArgument(argv, 0, "doctor");
  if (argv.length > 2) {
    throw new Error("Usage: crew status [<ticket>]");
  }
  return ticket;
}

async function doctorCli(argv: string[]): Promise<void> {
  const aliasTicket = doctorTicketAlias(argv);
  if (aliasTicket !== undefined) {
    warnDeprecated({ oldForm: "doctor --ticket", newForm: "status" });
    await statusCli([aliasTicket]);
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
    usage: "[--global | --local] [--force] [--dry-run]",
    invoke: initConfigCli,
  },
  run: {
    summary: "Run the orchestrator: poll sources and start eligible tickets (one-shot by default)",
    usage: "[--watch] [--dry-run]",
    invoke: runCli,
  },
  start: {
    summary: "Provision and launch one ticket immediately, bypassing eligibility",
    usage: "<ticket> [--dry-run]",
    invoke: startCli,
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
  stop: {
    summary: "Stop a live ticket workspace while preserving its worktree",
    usage: "<ticket> [--reason <text>]",
    invoke: interruptWorkspaceCli,
  },
  interrupt: {
    summary: "Deprecated alias for `crew stop`",
    usage: "<ticket> [--reason <text>]",
    deprecated: true,
    invoke: async (argv) => {
      warnDeprecated({ oldForm: "interrupt", newForm: "stop" });
      await interruptWorkspaceCli(argv);
    },
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
  upgrade: {
    summary: "Install the latest version of crew (or pin to a specific version)",
    usage: "[<version>] [--check]",
    invoke: upgradeCliInvoke,
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
    if (command.deprecated === true) {
      continue;
    }
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

  if (subcommand !== "upgrade") {
    try {
      await maybeRunUpgradeNudge(packageMetadata());
    } catch {
      // Passive nudge is never load-bearing; never block the user's command.
    }
  }

  try {
    await command.invoke(rest);
  } catch (error) {
    writeError(errorMessage(error));
    process.exitCode = 1;
  }
}
