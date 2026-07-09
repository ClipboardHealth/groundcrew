#!/usr/bin/env node

import { homedir } from "node:os";

import {
  formatAgentTrustList,
  formatTrustActionResults,
  shortenTrustPath,
} from "./lib/agentWorkspaceTrustFormat.ts";
import {
  resolveAgentTrustPath,
  resolveSeedTrustPaths,
  seedAgentWorkspaceTrust,
} from "./lib/agentWorkspaceTrust.ts";
import {
  deleteAgentWorkspaceTrust,
  listAgentWorkspaceTrust,
  pruneAgentWorkspaceTrust,
  type AgentTrustAgent,
} from "./lib/agentWorkspaceTrustAdmin.ts";
import { writeOutput } from "./lib/util.ts";

const USAGE = `Usage:
  node --run trust:admin -- list [--agent cursor|claude|codex] [--missing] [--home <dir>]
  node --run trust:admin -- seed --agent <agent> [--dir <abs>] [--trust-root <abs>] [--home <dir>]
  node --run trust:admin -- delete (--all | --path <abs> | --prefix <dir>)
    [--agent cursor|claude|codex] [--groundcrew-only] [--home <dir>]
  node --run trust:admin -- prune [--agent cursor|claude|codex] [--home <dir>]

Examples:
  node --run trust:admin -- list
  node --run trust:admin -- list --missing
  node --run trust:admin -- seed --agent claude --dir "$PWD" --trust-root "$HOME/groundcrew/workspaces"
  node --run trust:admin -- seed --agent codex --dir "$PWD"
  node --run trust:admin -- delete --path "$HOME/groundcrew/workspaces/repo-team-1"
  node --run trust:admin -- prune`;

interface ParsedArguments {
  command?: "list" | "delete" | "prune" | "seed";
  agent?: AgentTrustAgent;
  homeDir: string;
  launchDir?: string;
  trustRootPath?: string;
  path?: string;
  pathPrefix?: string;
  all: boolean;
  groundcrewOnly: boolean;
  missingOnly: boolean;
}

function parseAgent(value: string): AgentTrustAgent {
  if (value === "cursor" || value === "claude" || value === "codex") {
    return value;
  }
  throw new Error(`Unknown agent: ${value}`);
}

function seedAgentCommandName(agent: AgentTrustAgent): "cursor-agent" | "claude" | "codex" {
  return agent === "cursor" ? "cursor-agent" : agent;
}

function readFlagValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function applyArgument(
  parsed: ParsedArguments,
  arg: string,
  argv: readonly string[],
  index: number,
): number {
  switch (arg) {
    case "list":
    case "delete":
    case "prune":
    case "seed": {
      parsed.command = arg;
      return index;
    }
    case "--agent": {
      parsed.agent = parseAgent(readFlagValue(argv, index, arg));
      return index + 1;
    }
    case "--home": {
      parsed.homeDir = readFlagValue(argv, index, arg);
      return index + 1;
    }
    case "--path": {
      parsed.path = readFlagValue(argv, index, arg);
      return index + 1;
    }
    case "--dir": {
      parsed.launchDir = readFlagValue(argv, index, arg);
      return index + 1;
    }
    case "--trust-root": {
      parsed.trustRootPath = readFlagValue(argv, index, arg);
      return index + 1;
    }
    case "--prefix": {
      parsed.pathPrefix = readFlagValue(argv, index, arg);
      return index + 1;
    }
    case "--all": {
      parsed.all = true;
      return index;
    }
    case "--groundcrew-only": {
      parsed.groundcrewOnly = true;
      return index;
    }
    case "--missing": {
      parsed.missingOnly = true;
      return index;
    }
    case "--help":
    case "-h": {
      throw new Error(USAGE);
    }
    default: {
      throw new Error(`Unknown argument: ${arg}\n\n${USAGE}`);
    }
  }
}

function parseArguments(argv: readonly string[]): ParsedArguments {
  const parsed: ParsedArguments = {
    homeDir: homedir(),
    all: false,
    groundcrewOnly: false,
    missingOnly: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      continue;
    }
    index = applyArgument(parsed, arg, argv, index);
  }

  if (parsed.command === undefined) {
    throw new Error(USAGE);
  }
  return parsed;
}

function main(): void {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.command === "list") {
    const entries = listAgentWorkspaceTrust({
      homeDir: parsed.homeDir,
      missingOnly: parsed.missingOnly,
      ...(parsed.agent === undefined ? {} : { agent: parsed.agent }),
    });
    writeOutput(
      formatAgentTrustList(entries, {
        homeDir: parsed.homeDir,
        missingOnly: parsed.missingOnly,
      }),
    );
    return;
  }

  if (parsed.command === "seed") {
    if (parsed.agent === undefined) {
      throw new Error("seed requires --agent");
    }
    const { launchDir, trustRootPath } = resolveSeedTrustPaths({
      ...(parsed.launchDir === undefined ? {} : { launchDir: parsed.launchDir }),
      ...(parsed.trustRootPath === undefined ? {} : { trustRootPath: parsed.trustRootPath }),
    });
    const agentCommandName = seedAgentCommandName(parsed.agent);
    seedAgentWorkspaceTrust({
      agentCommandName,
      launchDir,
      trustRootPath,
      homeDir: parsed.homeDir,
    });
    const seededPath = resolveAgentTrustPath({
      agentCommandName,
      launchDir,
      trustRootPath,
    });
    writeOutput(`Seeded ${parsed.agent} trust for ${shortenTrustPath(seededPath, parsed.homeDir)}`);
    return;
  }

  if (parsed.command === "prune") {
    const results = pruneAgentWorkspaceTrust({
      homeDir: parsed.homeDir,
      ...(parsed.agent === undefined ? {} : { agent: parsed.agent }),
    });
    writeOutput(formatTrustActionResults(results, { homeDir: parsed.homeDir, action: "prune" }));
    return;
  }

  const results = deleteAgentWorkspaceTrust({
    homeDir: parsed.homeDir,
    all: parsed.all,
    groundcrewOnly: parsed.groundcrewOnly,
    ...(parsed.agent === undefined ? {} : { agent: parsed.agent }),
    ...(parsed.path === undefined ? {} : { path: parsed.path }),
    ...(parsed.pathPrefix === undefined ? {} : { pathPrefix: parsed.pathPrefix }),
  });
  writeOutput(formatTrustActionResults(results, { homeDir: parsed.homeDir, action: "delete" }));
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
