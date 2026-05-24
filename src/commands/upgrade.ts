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
  fetchLatestVersion,
  parseVersion,
  writeUpgradeCheckCache,
} from "../lib/upgrade.ts";
import { readEnvironmentVariable, writeError, writeOutput } from "../lib/util.ts";

const PACKAGE_NAME = "@clipboard-health/groundcrew";
const EXPLICIT_FETCH_TIMEOUT_MS = 5000;

interface FetchOptions {
  timeoutMs: number;
  registry?: string | undefined;
}

export interface UpgradeCliOptions {
  currentVersion: string;
  packageName: string;
  installKind: InstallKind;
  installPath: string;
  npmBin: string | undefined;
  fetcher: (packageName: string, options: FetchOptions) => Promise<string>;
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

interface ParsedArgs {
  kind: "help" | "check" | "install";
  pinnedVersion?: string | undefined;
  error?: string | undefined;
}

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
      return { kind: "install", error: `crew upgrade: unknown argument: ${arg}` };
    }
    if (pinnedVersion !== undefined) {
      return { kind: "install", error: "crew upgrade: too many positional arguments" };
    }
    pinnedVersion = arg;
  }
  if (check && pinnedVersion !== undefined) {
    return { kind: "install", error: "crew upgrade: --check does not accept a version argument" };
  }
  if (check) {
    return { kind: "check" };
  }
  return { kind: "install", pinnedVersion };
}

function printHelp(): void {
  writeOutput("Usage: crew upgrade [<version>] [--check]");
  writeOutput("");
  writeOutput("Install the latest version of crew (npm @clipboard-health/groundcrew).");
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

export async function upgradeCli(argv: string[], options: UpgradeCliOptions): Promise<void> {
  const parsed = parseArgs(argv);
  if (parsed.error !== undefined) {
    writeError(parsed.error);
    process.exitCode = 1;
    return;
  }
  if (parsed.kind === "help") {
    printHelp();
    return;
  }
  if (options.installKind !== "global") {
    writeError(refusalMessage(options.installKind, options.installPath, options.packageName));
    process.exitCode = 1;
    return;
  }
  const { npmBin } = options;
  if (npmBin === undefined) {
    writeError("crew upgrade: npm is required on PATH but was not found.");
    process.exitCode = 1;
    return;
  }

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

  await runInstallAndReport(options, npmBin, targetVersion);
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
    latest = await options.fetcher(options.packageName, {
      timeoutMs: options.fetchTimeoutMs,
      registry: options.registry,
    });
  } catch (error) {
    writeError(`crew upgrade: could not reach npm registry: ${String(error)}`);
    process.exitCode = 1;
    return undefined;
  }
  try {
    writeUpgradeCheckCache(options.cachePath, { latest, fetchedAt: options.now() });
  } catch {
    // Cache priming is best-effort; do not fail the command on disk errors.
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
    writeError(`crew upgrade: ${String(error)}`);
    process.exitCode = 1;
    return undefined;
  }
  const cmp = compareVersions(options.currentVersion, pinnedVersion);
  if (cmp === 0) {
    writeOutput(`crew is already on ${pinnedVersion}`);
    return undefined;
  }
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
  cliMetaUrl: string;
}

export async function createDefaultUpgradeCliOptions(
  args: CreateUpgradeOptionsArgs,
): Promise<UpgradeCliOptions> {
  const installPath = detectInstallPath(args.cliMetaUrl);
  const npmBin = await which("npm");
  const npmRootGlobal = npmBin === undefined ? undefined : detectNpmRootGlobal(npmBin, runCommand);
  const installKind = classifyInstall({
    installPath,
    npmRootGlobal,
    isSymlink: detectIsSymlink,
  });
  return {
    currentVersion: args.currentVersion,
    packageName: PACKAGE_NAME,
    installKind,
    installPath,
    npmBin,
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
