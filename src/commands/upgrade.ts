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
import {
  compareVersions,
  defaultUpgradeCheckCachePath,
  fetchAndPrimeUpgradeCheckCache,
  fetchLatestVersion,
  parseVersion,
  type VersionFetcher,
} from "../lib/upgrade.ts";
import { errorMessage, readEnvironmentVariable, writeError, writeOutput } from "../lib/util.ts";

const EXPLICIT_FETCH_TIMEOUT_MS = 5000;

export interface UpgradeCliOptions {
  currentVersion: string;
  packageName: string;
  resolveInstall: () => Promise<UpgradeInstallDetails>;
  fetcher: VersionFetcher;
  runInstall: (options: {
    packageName: string;
    version: string;
    npmBin: string;
  }) => Promise<NpmRunResult>;
  registry?: string | undefined;
  fetchTimeoutMs: number;
  /** Path of the upgrade-availability cache that the nudge reads. We prime
   * it from `--check` and the default install path so the next non-upgrade
   * subcommand can render the nudge without paying the network cost. */
  cachePath: string;
  now: () => number;
}

export interface UpgradeInstallDetails {
  installKind: InstallKind;
  installPath: string;
  npmBin: string | undefined;
}

type ParsedArgs =
  | { kind: "help" }
  | { kind: "check" }
  | { kind: "install"; pinnedVersion?: string | undefined }
  | { kind: "error"; message: string };

export type UpgradeCliOptionsInput = UpgradeCliOptions | (() => Promise<UpgradeCliOptions>);

function parseArgs(argv: string[]): ParsedArgs {
  let check = false;
  let pinnedVersion: string | undefined;
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      return { kind: "help" };
    }
    if (arg === "--check") {
      check = true;
      continue;
    }
    if (arg.startsWith("-")) {
      return { kind: "error", message: `crew upgrade: unknown argument: ${arg}` };
    }
    if (pinnedVersion !== undefined) {
      return { kind: "error", message: "crew upgrade: too many positional arguments" };
    }
    pinnedVersion = arg;
  }
  if (check && pinnedVersion !== undefined) {
    return { kind: "error", message: "crew upgrade: --check does not accept a version argument" };
  }
  if (check) {
    return { kind: "check" };
  }
  return { kind: "install", pinnedVersion };
}

function printHelp(): void {
  writeOutput("Usage: crew upgrade [<version>] [--check]");
  writeOutput("");
  writeOutput("Install the latest version of crew.");
  writeOutput("");
  writeOutput("Arguments:");
  writeOutput("  <version>      Install an exact version (upgrade or downgrade)");
  writeOutput("");
  writeOutput("Options:");
  writeOutput("  --check        Report availability without installing");
  writeOutput("  -h, --help     Show this help");
}

function refusalMessage(
  kind: Exclude<InstallKind, "global">,
  installPath: string,
  packageName: string,
): string {
  switch (kind) {
    case "linked": {
      return `crew is installed via 'npm link' at ${installPath}. Use 'node --run' from the source checkout instead of 'crew upgrade'.`;
    }
    case "npx": {
      return `crew is running from an npx temp install. Run 'npm install -g ${packageName}' for a stable global install before using 'crew upgrade'.`;
    }
    case "project": {
      return `crew is installed as a project dependency at ${installPath}, not installed globally. Run 'npm install -g ${packageName}' to use 'crew upgrade'.`;
    }
    case "unknown": {
      return `crew is not installed globally — detected at ${installPath}. Run 'npm install -g ${packageName}' to use 'crew upgrade'.`;
    }
    /* v8 ignore next 3 @preserve */
    default: {
      throw new Error(`unhandled install kind: ${kind as string}`);
    }
  }
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
  if (parsed.kind === "check") {
    await runCheck(options);
    return;
  }

  let targetVersion: string;
  if (parsed.pinnedVersion === undefined) {
    const fetched = await fetchOrFail(options);
    if (fetched === undefined) {
      return;
    }
    if (compareVersions(options.currentVersion, fetched) >= 0) {
      writeOutput(`crew is up to date (${fetched})`);
      return;
    }
    targetVersion = fetched;
  } else {
    const resolved = resolvePinnedVersion(options, parsed.pinnedVersion);
    if (resolved === undefined) {
      return;
    }
    targetVersion = resolved;
  }

  const npmBin = await resolveGlobalNpmBin(options);
  if (npmBin === undefined) {
    return;
  }
  await runInstallAndReport(options, npmBin, targetVersion);
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

async function runCheck(options: UpgradeCliOptions): Promise<void> {
  const latest = await fetchOrFail(options);
  if (latest === undefined) {
    return;
  }
  if (compareVersions(options.currentVersion, latest) >= 0) {
    writeOutput(`crew is up to date (${latest})`);
    return;
  }
  writeOutput(`${latest} available (you are on ${options.currentVersion}); run \`crew upgrade\``);
}

async function fetchOrFail(options: UpgradeCliOptions): Promise<string | undefined> {
  let latest: string;
  try {
    latest = await fetchAndPrimeUpgradeCheckCache({
      packageName: options.packageName,
      cachePath: options.cachePath,
      fetchTimeoutMs: options.fetchTimeoutMs,
      registry: options.registry,
      now: options.now,
      fetcher: options.fetcher,
    });
  } catch (error) {
    writeError(`crew upgrade: could not reach npm registry: ${errorMessage(error)}`);
    process.exitCode = 1;
    return undefined;
  }
  return latest;
}

function resolvePinnedVersion(
  options: UpgradeCliOptions,
  pinnedVersion: string,
): string | undefined {
  try {
    parseVersion(pinnedVersion);
  } catch (error) {
    writeError(`crew upgrade: ${errorMessage(error)}`);
    process.exitCode = 1;
    return undefined;
  }
  if (options.currentVersion === pinnedVersion) {
    writeOutput(`crew is already on ${pinnedVersion}`);
    return undefined;
  }
  const cmp = compareVersions(options.currentVersion, pinnedVersion);
  if (cmp > 0) {
    writeOutput(`downgrading ${options.currentVersion} → ${pinnedVersion}`);
  }
  return pinnedVersion;
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
      "crew upgrade: install failed with EACCES (permission denied). Your global npm prefix may require elevated permissions — see https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally",
    );
  }
  process.exitCode = result.exitCode;
}

export interface CreateUpgradeOptionsArgs {
  currentVersion: string;
  packageName: string;
  cliMetaUrl: string;
}

export async function createDefaultUpgradeCliOptions(
  args: CreateUpgradeOptionsArgs,
): Promise<UpgradeCliOptions> {
  return {
    currentVersion: args.currentVersion,
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
    fetcher: fetchLatestVersion,
    runInstall: async (options) =>
      await runNpmInstallGlobal({
        ...options,
        spawner: createDefaultNpmSpawner(process.stderr),
      }),
    fetchTimeoutMs: EXPLICIT_FETCH_TIMEOUT_MS,
    registry: readEnvironmentVariable("npm_config_registry"),
    cachePath: defaultUpgradeCheckCachePath(),
    now: Date.now,
  };
}
