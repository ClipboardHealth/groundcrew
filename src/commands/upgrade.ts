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
}

export interface UpgradeInstallDetails {
  installKind: InstallKind;
  installPath: string;
  npmBin: string | undefined;
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
  const npmBin = await resolveGlobalNpmBin(options);
  if (npmBin === undefined) {
    return;
  }
  await runInstallAndReport(options, npmBin, parsed.version);
}

async function resolveGlobalNpmBin(options: UpgradeCliOptions): Promise<string | undefined> {
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
  return install.npmBin;
}

async function runInstallAndReport(
  options: UpgradeCliOptions,
  npmBin: string,
  version: string,
): Promise<void> {
  const result = await options.runInstall({
    packageName: options.packageName,
    version,
    npmBin,
  });
  if (result.exitCode === 0) {
    return;
  }
  if (result.sawEacces) {
    writeError(
      "crew upgrade: install failed with EACCES (permission denied). Your global npm prefix may require elevated permissions - see https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally",
    );
  }
  process.exitCode = result.exitCode;
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
        spawner: createDefaultNpmSpawner(process.stderr),
      }),
  };
}
