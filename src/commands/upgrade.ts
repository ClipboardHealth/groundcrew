import { readFileSync } from "node:fs";
import path from "node:path";

import { runCommand } from "../lib/commandRunner.ts";
import { which } from "../lib/host.ts";
import {
  classifyInstall,
  createDefaultNpmSpawner,
  detectInstallPath,
  detectIsSymlink,
  detectNpmRootGlobal,
  type InstallKind,
  type NpmRunResult,
  runNpmInstallGlobal,
} from "../lib/npmGlobal.ts";
import { writeError, writeOutput } from "../lib/util.ts";

const DEFAULT_UPGRADE_TARGET = "latest";

export interface UpgradeCliOptions {
  packageName: string;
  resolveInstall: () => Promise<UpgradeInstallDetails>;
  runInstall: (options: {
    packageName: string;
    version: string;
    npmBin: string;
  }) => Promise<NpmRunResult>;
  readInstalledVersion: (installPath: string) => string | undefined;
}

export interface UpgradeInstallDetails {
  installKind: InstallKind;
  installPath: string;
  npmBin: string | undefined;
}

interface GlobalInstall {
  installPath: string;
  npmBin: string;
}

type ParsedArgs =
  | { kind: "help" }
  | { kind: "install"; version: string }
  | { kind: "error"; message: string };

export type UpgradeCliOptionsInput = UpgradeCliOptions | (() => Promise<UpgradeCliOptions>);

function parseArgs(argv: string[]): ParsedArgs {
  let version: string | undefined;
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      return { kind: "help" };
    }
    if (arg.startsWith("-")) {
      return { kind: "error", message: `crew upgrade: unknown argument: ${arg}` };
    }
    if (arg.length === 0) {
      return { kind: "error", message: "crew upgrade: version cannot be empty" };
    }
    if (version !== undefined) {
      return { kind: "error", message: "crew upgrade: too many positional arguments" };
    }
    version = arg;
  }
  return { kind: "install", version: version ?? DEFAULT_UPGRADE_TARGET };
}

function printHelp(): void {
  writeOutput("Usage: crew upgrade [<version>]");
  writeOutput("");
  writeOutput("Install crew globally through npm.");
  writeOutput("");
  writeOutput("Arguments:");
  writeOutput("  <version>      Install an exact version or npm tag (default: latest)");
  writeOutput("");
  writeOutput("Options:");
  writeOutput("  -h, --help     Show this help");
}

function refusalMessage(
  kind: Exclude<InstallKind, "global">,
  installPath: string,
  packageName: string,
): string {
  return `crew is not installed globally (${kind} at ${installPath}). Run 'npm install -g ${packageName}' to use 'crew upgrade'.`;
}

async function resolveOptions(options: UpgradeCliOptionsInput): Promise<UpgradeCliOptions> {
  if (typeof options === "function") {
    return await options();
  }
  return options;
}

export async function upgradeCli(
  argv: string[],
  optionsInput: UpgradeCliOptionsInput,
): Promise<void> {
  const parsed = parseArgs(argv);
  if (parsed.kind === "error") {
    writeError(parsed.message);
    process.exitCode = 1;
    return;
  }
  if (parsed.kind === "help") {
    printHelp();
    return;
  }

  const options = await resolveOptions(optionsInput);
  const install = await resolveGlobalInstall(options);
  if (install === undefined) {
    return;
  }
  await runInstallAndReport(options, install, parsed.version);
}

async function resolveGlobalInstall(
  options: UpgradeCliOptions,
): Promise<GlobalInstall | undefined> {
  const install = await options.resolveInstall();
  if (install.installKind !== "global") {
    writeError(refusalMessage(install.installKind, install.installPath, options.packageName));
    process.exitCode = 1;
    return undefined;
  }
  if (install.npmBin === undefined) {
    writeError("crew upgrade: npm is required on PATH but was not found.");
    process.exitCode = 1;
    return undefined;
  }
  return { installPath: install.installPath, npmBin: install.npmBin };
}

async function runInstallAndReport(
  options: UpgradeCliOptions,
  install: GlobalInstall,
  version: string,
): Promise<void> {
  const fromVersion = options.readInstalledVersion(install.installPath);
  writeOutput("Upgrading crew…");
  const result = await options.runInstall({
    packageName: options.packageName,
    version,
    npmBin: install.npmBin,
  });
  if (result.exitCode === 0) {
    const toVersion = options.readInstalledVersion(install.installPath);
    writeOutput(formatUpgradeSuccess({ fromVersion, toVersion }));
    return;
  }
  if (result.outputText.length > 0) {
    process.stderr.write(result.outputText);
    if (!result.outputText.endsWith("\n")) {
      process.stderr.write("\n");
    }
  }
  if (result.sawEacces) {
    writeError(
      "crew upgrade: install failed with EACCES (permission denied). Your global npm prefix may require elevated permissions - see https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally",
    );
  }
  process.exitCode = result.exitCode;
}

function formatUpgradeSuccess(versions: {
  fromVersion: string | undefined;
  toVersion: string | undefined;
}): string {
  const { fromVersion, toVersion } = versions;
  if (toVersion === undefined) {
    return "crew upgrade complete";
  }
  if (fromVersion === undefined) {
    return `crew is now on version ${toVersion}`;
  }
  if (fromVersion === toVersion) {
    return `crew is already on version ${toVersion}`;
  }
  return `Upgraded crew from ${fromVersion} to ${toVersion}`;
}

export interface CreateUpgradeOptionsArgs {
  packageName: string;
  cliMetaUrl: string;
}

export async function createDefaultUpgradeCliOptions(
  args: CreateUpgradeOptionsArgs,
): Promise<UpgradeCliOptions> {
  return {
    packageName: args.packageName,
    resolveInstall: async () => {
      const installPath = detectInstallPath(args.cliMetaUrl);
      const npmBin = await which("npm");
      const npmRootGlobal =
        npmBin === undefined ? undefined : detectNpmRootGlobal(npmBin, runCommand);
      const installKind = classifyInstall({
        installPath,
        npmRootGlobal,
        isSymlink: detectIsSymlink,
      });
      return { installKind, installPath, npmBin };
    },
    runInstall: async (options) =>
      await runNpmInstallGlobal({
        ...options,
        spawner: createDefaultNpmSpawner(),
      }),
    readInstalledVersion: readInstalledVersionFromDisk,
  };
}

function readInstalledVersionFromDisk(installPath: string): string | undefined {
  let raw: string;
  try {
    raw = readFileSync(path.join(installPath, "package.json"), "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "version" in parsed &&
    typeof parsed.version === "string"
  ) {
    return parsed.version;
  }
  return undefined;
}
