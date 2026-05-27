import { pathToFileURL } from "node:url";

import { runCommand, type RunCommandOptions } from "../lib/commandRunner.ts";
import { which } from "../lib/host.ts";
import { createDefaultNpmSpawner, type NpmSpawner, runNpmInstallGlobal } from "../lib/npmGlobal.ts";
import { captureConsoleError, captureConsoleLog } from "../testHelpers/consoleCapture.ts";

import {
  createDefaultUpgradeCliOptions,
  upgradeCli,
  type UpgradeCliOptions,
  type UpgradeInstallDetails,
} from "./upgrade.ts";

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

type RunInstallFn = UpgradeCliOptions["runInstall"];
type ResolveInstallFn = UpgradeCliOptions["resolveInstall"];
type MakeOptionsOverrides = Partial<Omit<UpgradeCliOptions, "resolveInstall">> &
  Partial<UpgradeInstallDetails> & {
    resolveInstall?: ResolveInstallFn;
  };

function makeOptions(overrides: MakeOptionsOverrides = {}): UpgradeCliOptions {
  const { installKind, installPath, npmBin, resolveInstall, ...optionOverrides } = overrides;
  const resolvedInstall =
    resolveInstall ??
    vi.fn<ResolveInstallFn>().mockResolvedValue({
      installKind: installKind ?? "global",
      installPath: installPath ?? "/usr/local/lib/node_modules/@clipboard-health/groundcrew",
      npmBin: Object.hasOwn(overrides, "npmBin") ? npmBin : "/usr/local/bin/npm",
    });
  return {
    packageName: PACKAGE_NAME,
    resolveInstall: resolvedInstall,
    runInstall: vi.fn<RunInstallFn>().mockResolvedValue({ exitCode: 0, sawEacces: false }),
    ...optionOverrides,
  };
}

describe(upgradeCli, () => {
  let consoleLog: ReturnType<typeof captureConsoleLog>;
  let consoleErr: ReturnType<typeof captureConsoleError>;

  beforeEach(() => {
    consoleLog = captureConsoleLog();
    consoleErr = captureConsoleError();
    process.exitCode = undefined;
  });

  afterEach(() => {
    consoleLog.restore();
    consoleErr.restore();
    process.exitCode = undefined;
  });

  it("prints help and exits 0 on --help", async () => {
    await upgradeCli(["--help"], makeOptions());

    expect(consoleLog.output()).toMatch(/Usage: crew upgrade \[<version>\]/);
    expect(consoleLog.output()).not.toContain("--check");
    expect(process.exitCode).toBeUndefined();
  });

  it("does not resolve default options on --help", async () => {
    const optionsFactory = vi.fn<() => Promise<UpgradeCliOptions>>();

    await upgradeCli(["--help"], optionsFactory);

    expect(optionsFactory).not.toHaveBeenCalled();
  });

  it("does not resolve default options for argument errors", async () => {
    const optionsFactory = vi.fn<() => Promise<UpgradeCliOptions>>();

    await upgradeCli(["--check"], optionsFactory);

    expect(consoleErr.output()).toMatch(/unknown argument/i);
    expect(optionsFactory).not.toHaveBeenCalled();
  });

  it("resolves lazy options only after parsing succeeds", async () => {
    const options = makeOptions();
    const optionsFactory = vi.fn<() => Promise<UpgradeCliOptions>>().mockResolvedValue(options);

    await upgradeCli(["3.2.0"], optionsFactory);

    expect(optionsFactory).toHaveBeenCalledTimes(1);
  });

  it("refuses when not globally installed", async () => {
    const runInstall = vi.fn<RunInstallFn>();

    await upgradeCli(["3.2.0"], makeOptions({ installKind: "project", runInstall }));

    expect(consoleErr.output()).toMatch(/not installed globally/i);
    expect(consoleErr.output()).toContain(PACKAGE_NAME);
    expect(runInstall).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("refuses when npm is not on PATH", async () => {
    await upgradeCli(["3.2.0"], makeOptions({ npmBin: undefined }));

    expect(consoleErr.output()).toMatch(/npm/i);
    expect(process.exitCode).toBe(1);
  });

  it("installs latest when no version is provided", async () => {
    const runInstall = vi.fn<RunInstallFn>().mockResolvedValue({ exitCode: 0, sawEacces: false });

    await upgradeCli([], makeOptions({ runInstall }));

    expect(runInstall).toHaveBeenCalledWith({
      packageName: PACKAGE_NAME,
      version: "latest",
      npmBin: "/usr/local/bin/npm",
    });
    expect(process.exitCode).toBeUndefined();
  });

  it("installs a supplied npm version or tag", async () => {
    const runInstall = vi.fn<RunInstallFn>().mockResolvedValue({ exitCode: 0, sawEacces: false });

    await upgradeCli(["next"], makeOptions({ runInstall }));

    expect(runInstall).toHaveBeenCalledWith({
      packageName: PACKAGE_NAME,
      version: "next",
      npmBin: "/usr/local/bin/npm",
    });
    expect(process.exitCode).toBeUndefined();
  });

  it("forwards a non-zero install exit code", async () => {
    const runInstall = vi.fn<RunInstallFn>().mockResolvedValue({ exitCode: 7, sawEacces: false });

    await upgradeCli([], makeOptions({ runInstall }));

    expect(process.exitCode).toBe(7);
  });

  it("appends an EACCES hint when install fails with EACCES", async () => {
    const runInstall = vi.fn<RunInstallFn>().mockResolvedValue({ exitCode: 243, sawEacces: true });

    await upgradeCli([], makeOptions({ runInstall }));

    expect(consoleErr.output()).toMatch(/EACCES/i);
    expect(consoleErr.output()).toMatch(/permission/i);
    expect(process.exitCode).toBe(243);
  });

  it("rejects an unknown flag", async () => {
    await upgradeCli(["--bogus"], makeOptions());

    expect(consoleErr.output()).toMatch(/unknown argument/i);
    expect(process.exitCode).toBe(1);
  });

  it("rejects an empty version argument", async () => {
    await upgradeCli([""], makeOptions());

    expect(consoleErr.output()).toMatch(/version cannot be empty/i);
    expect(process.exitCode).toBe(1);
  });

  it("rejects two positional arguments", async () => {
    await upgradeCli(["3.1.5", "3.2.0"], makeOptions());

    expect(consoleErr.output()).toMatch(/too many positional arguments/i);
    expect(process.exitCode).toBe(1);
  });
});

describe(createDefaultUpgradeCliOptions, () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("wires real implementations when npm is on PATH", async () => {
    whichMock.mockResolvedValue("/usr/local/bin/npm");
    runCommandMock.mockReturnValue("/usr/local/lib/node_modules");

    const options = await createDefaultUpgradeCliOptions({
      packageName: PACKAGE_NAME,
      cliMetaUrl: pathToFileURL("/opt/pkg/dist/cli.js").toString(),
    });

    expect(options.packageName).toBe(PACKAGE_NAME);
    expect(whichMock).not.toHaveBeenCalled();

    const install = await options.resolveInstall();
    expect(install.installPath).toBe("/opt/pkg");
    expect(install.npmBin).toBe("/usr/local/bin/npm");
    expect(install.installKind).toBe("unknown");
    expect(whichMock).toHaveBeenCalledWith("npm");
    expect(runCommandMock).toHaveBeenCalledWith("/usr/local/bin/npm", ["root", "-g"]);
  });

  it("resolves npmBin=undefined and skips npm root -g when npm is missing", async () => {
    // oxlint-disable-next-line unicorn/no-useless-undefined -- exercises the npmBin === undefined branch
    whichMock.mockResolvedValue(undefined);

    const options = await createDefaultUpgradeCliOptions({
      packageName: PACKAGE_NAME,
      cliMetaUrl: pathToFileURL("/opt/pkg/dist/cli.js").toString(),
    });

    await expect(options.resolveInstall()).resolves.toMatchObject({ npmBin: undefined });
    expect(runCommandMock).not.toHaveBeenCalled();
  });

  it("wires runInstall to runNpmInstallGlobal with the default spawner", async () => {
    whichMock.mockResolvedValue("/usr/local/bin/npm");
    runCommandMock.mockReturnValue("/usr/local/lib/node_modules");
    const fakeSpawner = vi.fn<NpmSpawner>();
    createDefaultNpmSpawnerMock.mockReturnValue(fakeSpawner);
    runNpmInstallGlobalMock.mockResolvedValue({ exitCode: 0, sawEacces: false });

    const options = await createDefaultUpgradeCliOptions({
      packageName: PACKAGE_NAME,
      cliMetaUrl: pathToFileURL("/opt/pkg/dist/cli.js").toString(),
    });
    const result = await options.runInstall({
      packageName: PACKAGE_NAME,
      version: "latest",
      npmBin: "/usr/local/bin/npm",
    });

    expect(createDefaultNpmSpawnerMock).toHaveBeenCalledWith(process.stderr);
    expect(runNpmInstallGlobalMock).toHaveBeenCalledWith({
      packageName: PACKAGE_NAME,
      version: "latest",
      npmBin: "/usr/local/bin/npm",
      spawner: fakeSpawner,
    });
    expect(result).toStrictEqual({ exitCode: 0, sawEacces: false });
  });
});
