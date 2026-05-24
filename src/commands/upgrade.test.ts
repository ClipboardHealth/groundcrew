import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { runCommand, type RunCommandOptions } from "../lib/commandRunner.ts";
import { which } from "../lib/host.ts";
import { createDefaultNpmSpawner, type NpmSpawner, runNpmInstallGlobal } from "../lib/npmGlobal.ts";
import { captureConsoleError, captureConsoleLog } from "../testHelpers/consoleCapture.ts";

import { createDefaultUpgradeCliOptions, upgradeCli, type UpgradeCliOptions } from "./upgrade.ts";

type RunCommandFn = (
  command: string,
  args: readonly string[],
  options?: RunCommandOptions,
) => string;

vi.mock(import("../lib/commandRunner.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- overload-collapsing cast; tests only exercise the captured-stdio signature
    runCommand: vi.fn<RunCommandFn>() as unknown as typeof actual.runCommand,
  };
});
vi.mock(import("../lib/host.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, which: vi.fn<typeof which>() };
});
vi.mock(import("../lib/npmGlobal.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    runNpmInstallGlobal: vi.fn<typeof runNpmInstallGlobal>(),
    createDefaultNpmSpawner: vi.fn<typeof createDefaultNpmSpawner>(),
  };
});

const runCommandMock = vi.mocked(runCommand);
const whichMock = vi.mocked(which);
const runNpmInstallGlobalMock = vi.mocked(runNpmInstallGlobal);
const createDefaultNpmSpawnerMock = vi.mocked(createDefaultNpmSpawner);

const PACKAGE_NAME = "@clipboard-health/groundcrew";

type FetcherFn = UpgradeCliOptions["fetcher"];
type RunInstallFn = UpgradeCliOptions["runInstall"];

let testCacheDir: string;
let testCachePath: string;

function makeOptions(overrides: Partial<UpgradeCliOptions> = {}): UpgradeCliOptions {
  return {
    currentVersion: "3.1.8",
    packageName: PACKAGE_NAME,
    installKind: "global",
    installPath: "/usr/local/lib/node_modules/@clipboard-health/groundcrew",
    npmBin: "/usr/local/bin/npm",
    fetcher: vi.fn<FetcherFn>().mockResolvedValue("3.1.8"),
    runInstall: vi.fn<RunInstallFn>().mockResolvedValue({ exitCode: 0, sawEacces: false }),
    fetchTimeoutMs: 5000,
    cachePath: testCachePath,
    now: () => 1_700_000_000_000,
    ...overrides,
  };
}

describe(upgradeCli, () => {
  let consoleLog: ReturnType<typeof captureConsoleLog>;
  let consoleErr: ReturnType<typeof captureConsoleError>;

  beforeEach(() => {
    testCacheDir = mkdtempSync(join(tmpdir(), "groundcrew-upgrade-cli-"));
    testCachePath = join(testCacheDir, "upgrade-check.json");
    consoleLog = captureConsoleLog();
    consoleErr = captureConsoleError();
    process.exitCode = undefined;
  });

  afterEach(() => {
    consoleLog.restore();
    consoleErr.restore();
    process.exitCode = undefined;
    rmSync(testCacheDir, { recursive: true, force: true });
  });

  it("prints help and exits 0 on --help", async () => {
    await upgradeCli(["--help"], makeOptions());
    expect(consoleLog.output()).toMatch(/Usage: crew upgrade/);
    expect(process.exitCode).toBeUndefined();
  });

  it("refuses when not globally installed", async () => {
    const runInstall = vi.fn<RunInstallFn>();
    await upgradeCli([], makeOptions({ installKind: "project", runInstall }));
    expect(consoleErr.output()).toMatch(/not installed globally/i);
    expect(consoleErr.output()).toContain(PACKAGE_NAME);
    expect(runInstall).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("refuses when installation is a dev symlink (npm link)", async () => {
    await upgradeCli([], makeOptions({ installKind: "linked" }));
    expect(consoleErr.output()).toMatch(/npm link/i);
    expect(process.exitCode).toBe(1);
  });

  it("refuses when running from an npx temp install", async () => {
    await upgradeCli([], makeOptions({ installKind: "npx" }));
    expect(consoleErr.output()).toMatch(/npx/i);
    expect(process.exitCode).toBe(1);
  });

  it("refuses when install kind cannot be determined", async () => {
    await upgradeCli([], makeOptions({ installKind: "unknown", installPath: "/some/weird/place" }));
    expect(consoleErr.output()).toContain("/some/weird/place");
    expect(process.exitCode).toBe(1);
  });

  it("refuses when npm is not on PATH", async () => {
    await upgradeCli([], makeOptions({ npmBin: undefined }));
    expect(consoleErr.output()).toMatch(/npm/i);
    expect(process.exitCode).toBe(1);
  });

  it("prints 'up to date' and skips install when already on latest", async () => {
    const fetcher = vi.fn<FetcherFn>().mockResolvedValue("3.1.8");
    const runInstall = vi.fn<RunInstallFn>();
    await upgradeCli([], makeOptions({ currentVersion: "3.1.8", fetcher, runInstall }));
    expect(consoleLog.output()).toMatch(/up to date.*3\.1\.8/i);
    expect(runInstall).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("installs the latest version when behind", async () => {
    const fetcher = vi.fn<FetcherFn>().mockResolvedValue("3.2.0");
    const runInstall = vi.fn<RunInstallFn>().mockResolvedValue({ exitCode: 0, sawEacces: false });
    await upgradeCli([], makeOptions({ currentVersion: "3.1.8", fetcher, runInstall }));
    expect(runInstall).toHaveBeenCalledWith({
      packageName: PACKAGE_NAME,
      version: "3.2.0",
      npmBin: "/usr/local/bin/npm",
    });
    expect(process.exitCode).toBeUndefined();
  });

  it("forwards a non-zero install exit code", async () => {
    const runInstall = vi.fn<RunInstallFn>().mockResolvedValue({ exitCode: 7, sawEacces: false });
    await upgradeCli(
      [],
      makeOptions({
        currentVersion: "3.1.8",
        fetcher: vi.fn<FetcherFn>().mockResolvedValue("3.2.0"),
        runInstall,
      }),
    );
    expect(process.exitCode).toBe(7);
  });

  it("appends an EACCES hint when install fails with EACCES", async () => {
    const runInstall = vi.fn<RunInstallFn>().mockResolvedValue({ exitCode: 243, sawEacces: true });
    await upgradeCli(
      [],
      makeOptions({
        currentVersion: "3.1.8",
        fetcher: vi.fn<FetcherFn>().mockResolvedValue("3.2.0"),
        runInstall,
      }),
    );
    expect(consoleErr.output()).toMatch(/EACCES/i);
    expect(consoleErr.output()).toMatch(/permission/i);
    expect(process.exitCode).toBe(243);
  });

  it("installs a pinned version when given explicitly (upgrade)", async () => {
    const runInstall = vi.fn<RunInstallFn>().mockResolvedValue({ exitCode: 0, sawEacces: false });
    const fetcher = vi.fn<FetcherFn>();
    await upgradeCli(["3.2.0"], makeOptions({ currentVersion: "3.1.8", fetcher, runInstall }));
    expect(fetcher).not.toHaveBeenCalled();
    expect(runInstall).toHaveBeenCalledWith({
      packageName: PACKAGE_NAME,
      version: "3.2.0",
      npmBin: "/usr/local/bin/npm",
    });
  });

  it("prints downgrade notice and installs when pinned version is lower", async () => {
    const runInstall = vi.fn<RunInstallFn>().mockResolvedValue({ exitCode: 0, sawEacces: false });
    await upgradeCli(["3.1.5"], makeOptions({ currentVersion: "3.1.8", runInstall }));
    expect(consoleLog.output()).toMatch(/downgrading.*3\.1\.8.*3\.1\.5/i);
    expect(runInstall).toHaveBeenCalledWith({
      packageName: PACKAGE_NAME,
      version: "3.1.5",
      npmBin: "/usr/local/bin/npm",
    });
  });

  it("skips install when pinned version equals current", async () => {
    const runInstall = vi.fn<RunInstallFn>();
    await upgradeCli(["3.1.8"], makeOptions({ currentVersion: "3.1.8", runInstall }));
    expect(consoleLog.output()).toMatch(/already on 3\.1\.8/i);
    expect(runInstall).not.toHaveBeenCalled();
  });

  it("rejects a malformed pinned version", async () => {
    await upgradeCli(["not.a.version"], makeOptions());
    expect(consoleErr.output()).toMatch(/invalid version/i);
    expect(process.exitCode).toBe(1);
  });

  it("rejects an unknown flag", async () => {
    await upgradeCli(["--bogus"], makeOptions());
    expect(consoleErr.output()).toMatch(/unknown argument/i);
    expect(process.exitCode).toBe(1);
  });

  it("rejects two positional arguments", async () => {
    await upgradeCli(["3.1.5", "3.2.0"], makeOptions());
    expect(consoleErr.output()).toMatch(/too many positional arguments/i);
    expect(process.exitCode).toBe(1);
  });

  it("rejects --check combined with a version argument", async () => {
    await upgradeCli(["--check", "3.1.5"], makeOptions());
    expect(consoleErr.output()).toMatch(/--check does not accept a version/i);
    expect(process.exitCode).toBe(1);
  });

  it("--check prints availability and never installs (behind)", async () => {
    const fetcher = vi.fn<FetcherFn>().mockResolvedValue("3.2.0");
    const runInstall = vi.fn<RunInstallFn>();
    await upgradeCli(["--check"], makeOptions({ currentVersion: "3.1.8", fetcher, runInstall }));
    expect(consoleLog.output()).toMatch(/3\.2\.0 available/);
    expect(runInstall).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("--check prints up-to-date and never installs (current)", async () => {
    const fetcher = vi.fn<FetcherFn>().mockResolvedValue("3.1.8");
    const runInstall = vi.fn<RunInstallFn>();
    await upgradeCli(["--check"], makeOptions({ currentVersion: "3.1.8", fetcher, runInstall }));
    expect(consoleLog.output()).toMatch(/up to date.*3\.1\.8/i);
    expect(runInstall).not.toHaveBeenCalled();
  });

  it("exits non-zero on registry failure during fetch", async () => {
    const fetcher = vi.fn<FetcherFn>().mockRejectedValue(new Error("network down"));
    await upgradeCli([], makeOptions({ fetcher }));
    expect(consoleErr.output()).toMatch(/registry/i);
    expect(process.exitCode).toBe(1);
  });

  it("exits non-zero on registry failure during --check", async () => {
    const fetcher = vi.fn<FetcherFn>().mockRejectedValue(new Error("network down"));
    await upgradeCli(["--check"], makeOptions({ fetcher }));
    expect(consoleErr.output()).toMatch(/registry/i);
    expect(process.exitCode).toBe(1);
  });

  it("forwards the configured registry to the fetcher", async () => {
    const fetcher = vi.fn<FetcherFn>().mockResolvedValue("3.1.8");
    await upgradeCli(["--check"], makeOptions({ fetcher, registry: "https://my.mirror.example" }));
    expect(fetcher).toHaveBeenCalledWith(PACKAGE_NAME, {
      timeoutMs: 5000,
      registry: "https://my.mirror.example",
    });
  });

  it("primes the upgrade-check cache after a successful --check", async () => {
    const fetcher = vi.fn<FetcherFn>().mockResolvedValue("3.2.0");
    await upgradeCli(
      ["--check"],
      makeOptions({ currentVersion: "3.1.8", fetcher, now: () => 12_345 }),
    );
    expect(JSON.parse(readFileSync(testCachePath, "utf8"))).toStrictEqual({
      latest: "3.2.0",
      fetchedAt: 12_345,
    });
  });

  it("primes the upgrade-check cache after a successful no-arg install fetch", async () => {
    const fetcher = vi.fn<FetcherFn>().mockResolvedValue("3.2.0");
    await upgradeCli([], makeOptions({ currentVersion: "3.1.8", fetcher, now: () => 99_999 }));
    expect(JSON.parse(readFileSync(testCachePath, "utf8"))).toStrictEqual({
      latest: "3.2.0",
      fetchedAt: 99_999,
    });
  });

  it("does not prime the cache when the registry fetch fails", async () => {
    const fetcher = vi.fn<FetcherFn>().mockRejectedValue(new Error("network down"));
    await upgradeCli(["--check"], makeOptions({ fetcher }));
    expect(() => readFileSync(testCachePath, "utf8")).toThrow(/ENOENT/);
  });

  it("does not touch the cache when a pinned version skips the fetch", async () => {
    const fetcher = vi.fn<FetcherFn>();
    await upgradeCli(["3.2.0"], makeOptions({ currentVersion: "3.1.8", fetcher }));
    expect(fetcher).not.toHaveBeenCalled();
    expect(() => readFileSync(testCachePath, "utf8")).toThrow(/ENOENT/);
  });
});

describe(createDefaultUpgradeCliOptions, () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("wires real implementations when npm is on PATH", async () => {
    whichMock.mockResolvedValue("/usr/local/bin/npm");
    runCommandMock.mockReturnValue("/usr/local/lib/node_modules");
    vi.stubEnv("npm_config_registry", "https://npm.mirror.example");

    const options = await createDefaultUpgradeCliOptions({
      currentVersion: "3.1.8",
      cliMetaUrl: pathToFileURL("/opt/pkg/dist/cli.js").toString(),
    });

    expect(options.currentVersion).toBe("3.1.8");
    expect(options.packageName).toBe(PACKAGE_NAME);
    expect(options.installPath).toBe("/opt/pkg");
    expect(options.npmBin).toBe("/usr/local/bin/npm");
    expect(options.registry).toBe("https://npm.mirror.example");
    expect(options.fetchTimeoutMs).toBe(5000);
    expect(options.cachePath).toMatch(/groundcrew[/\\]upgrade-check\.json$/);
    expect(options.now()).toBeGreaterThan(1_700_000_000_000);
    expect(whichMock).toHaveBeenCalledWith("npm");
    expect(runCommandMock).toHaveBeenCalledWith("/usr/local/bin/npm", ["root", "-g"]);
  });

  it("returns npmBin=undefined and skips npm root -g when npm is missing", async () => {
    // oxlint-disable-next-line unicorn/no-useless-undefined -- exercises the npmBin === undefined branch
    whichMock.mockResolvedValue(undefined);

    const options = await createDefaultUpgradeCliOptions({
      currentVersion: "3.1.8",
      cliMetaUrl: pathToFileURL("/opt/pkg/dist/cli.js").toString(),
    });

    expect(options.npmBin).toBeUndefined();
    expect(runCommandMock).not.toHaveBeenCalled();
  });

  it("wires runInstall to runNpmInstallGlobal with the default spawner", async () => {
    whichMock.mockResolvedValue("/usr/local/bin/npm");
    runCommandMock.mockReturnValue("/usr/local/lib/node_modules");
    const fakeSpawner = vi.fn<NpmSpawner>();
    createDefaultNpmSpawnerMock.mockReturnValue(fakeSpawner);
    runNpmInstallGlobalMock.mockResolvedValue({ exitCode: 0, sawEacces: false });

    const options = await createDefaultUpgradeCliOptions({
      currentVersion: "3.1.8",
      cliMetaUrl: pathToFileURL("/opt/pkg/dist/cli.js").toString(),
    });
    const result = await options.runInstall({
      packageName: PACKAGE_NAME,
      version: "3.2.0",
      npmBin: "/usr/local/bin/npm",
    });

    expect(createDefaultNpmSpawnerMock).toHaveBeenCalledWith(process.stderr);
    expect(runNpmInstallGlobalMock).toHaveBeenCalledWith({
      packageName: PACKAGE_NAME,
      version: "3.2.0",
      npmBin: "/usr/local/bin/npm",
      spawner: fakeSpawner,
    });
    expect(result).toStrictEqual({ exitCode: 0, sawEacces: false });
  });
});
