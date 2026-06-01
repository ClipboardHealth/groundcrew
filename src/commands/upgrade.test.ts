import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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
type ReadInstalledVersionFn = UpgradeCliOptions["readInstalledVersion"];
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
    runInstall: vi
      .fn<RunInstallFn>()
      .mockResolvedValue({ exitCode: 0, sawEacces: false, outputText: "" }),
    readInstalledVersion: vi.fn<ReadInstalledVersionFn>().mockReturnValue("4.2.4"),
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
    const runInstall = vi
      .fn<RunInstallFn>()
      .mockResolvedValue({ exitCode: 0, sawEacces: false, outputText: "" });

    await upgradeCli([], makeOptions({ runInstall }));

    expect(runInstall).toHaveBeenCalledWith({
      packageName: PACKAGE_NAME,
      version: "latest",
      npmBin: "/usr/local/bin/npm",
    });
    expect(process.exitCode).toBeUndefined();
  });

  it("installs a supplied npm version or tag", async () => {
    const runInstall = vi
      .fn<RunInstallFn>()
      .mockResolvedValue({ exitCode: 0, sawEacces: false, outputText: "" });

    await upgradeCli(["next"], makeOptions({ runInstall }));

    expect(runInstall).toHaveBeenCalledWith({
      packageName: PACKAGE_NAME,
      version: "next",
      npmBin: "/usr/local/bin/npm",
    });
    expect(process.exitCode).toBeUndefined();
  });

  it("forwards a non-zero install exit code", async () => {
    const runInstall = vi
      .fn<RunInstallFn>()
      .mockResolvedValue({ exitCode: 7, sawEacces: false, outputText: "" });

    await upgradeCli([], makeOptions({ runInstall }));

    expect(process.exitCode).toBe(7);
  });

  it("appends an EACCES hint when install fails with EACCES", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const runInstall = vi
        .fn<RunInstallFn>()
        .mockResolvedValue({ exitCode: 243, sawEacces: true, outputText: "npm ERR! EACCES" });

      await upgradeCli([], makeOptions({ runInstall }));

      expect(stderrSpy).toHaveBeenCalledWith("npm ERR! EACCES");
      expect(stderrSpy).toHaveBeenCalledWith("\n");
      expect(consoleErr.output()).toMatch(/EACCES/i);
      expect(consoleErr.output()).toMatch(/permission/i);
      expect(process.exitCode).toBe(243);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("reports the from/to versions on a successful upgrade", async () => {
    const readInstalledVersion = vi
      .fn<ReadInstalledVersionFn>()
      .mockReturnValueOnce("4.2.4")
      .mockReturnValueOnce("4.3.0");

    await upgradeCli([], makeOptions({ readInstalledVersion }));

    expect(consoleLog.output()).toContain("Upgrading crew…");
    expect(consoleLog.output()).toContain("Upgraded crew from 4.2.4 to 4.3.0");
  });

  it("reports already-on-version when the install left the version unchanged", async () => {
    const readInstalledVersion = vi.fn<ReadInstalledVersionFn>().mockReturnValue("4.3.0");

    await upgradeCli([], makeOptions({ readInstalledVersion }));

    expect(consoleLog.output()).toContain("crew is already on version 4.3.0");
  });

  it("falls back to a generic success when the version reads fail", async () => {
    // oxlint-disable-next-line unicorn/no-useless-undefined -- exercises the fallback path
    const readInstalledVersion = vi.fn<ReadInstalledVersionFn>().mockReturnValue(undefined);

    await upgradeCli([], makeOptions({ readInstalledVersion }));

    expect(consoleLog.output()).toContain("crew upgrade complete");
    expect(consoleLog.output()).not.toMatch(/version/i);
  });

  it("reports the new version when only the post-install read succeeds", async () => {
    const readInstalledVersion = vi
      .fn<ReadInstalledVersionFn>()
      // oxlint-disable-next-line unicorn/no-useless-undefined -- first read fails, second succeeds
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce("4.3.0");

    await upgradeCli([], makeOptions({ readInstalledVersion }));

    expect(consoleLog.output()).toContain("crew is now on version 4.3.0");
  });

  it("replays captured npm output on stderr when the install fails", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const runInstall = vi.fn<RunInstallFn>().mockResolvedValue({
        exitCode: 1,
        sawEacces: false,
        outputText: "npm ERR! something went wrong\n",
      });

      await upgradeCli([], makeOptions({ runInstall }));

      expect(stderrSpy).toHaveBeenCalledWith("npm ERR! something went wrong\n");
      expect(process.exitCode).toBe(1);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("skips the stderr replay when the install produced no output", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const runInstall = vi
        .fn<RunInstallFn>()
        .mockResolvedValue({ exitCode: 1, sawEacces: false, outputText: "" });

      await upgradeCli([], makeOptions({ runInstall }));

      expect(stderrSpy).not.toHaveBeenCalled();
    } finally {
      stderrSpy.mockRestore();
    }
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
    runNpmInstallGlobalMock.mockResolvedValue({ exitCode: 0, sawEacces: false, outputText: "" });

    const options = await createDefaultUpgradeCliOptions({
      packageName: PACKAGE_NAME,
      cliMetaUrl: pathToFileURL("/opt/pkg/dist/cli.js").toString(),
    });
    const result = await options.runInstall({
      packageName: PACKAGE_NAME,
      version: "latest",
      npmBin: "/usr/local/bin/npm",
    });

    expect(createDefaultNpmSpawnerMock).toHaveBeenCalledWith();
    expect(runNpmInstallGlobalMock).toHaveBeenCalledWith({
      packageName: PACKAGE_NAME,
      version: "latest",
      npmBin: "/usr/local/bin/npm",
      spawner: fakeSpawner,
    });
    expect(result).toStrictEqual({ exitCode: 0, sawEacces: false, outputText: "" });
  });

  it("wires readInstalledVersion to read the version from package.json on disk", async () => {
    whichMock.mockResolvedValue("/usr/local/bin/npm");
    runCommandMock.mockReturnValue("/usr/local/lib/node_modules");

    const tmp = mkdtempSync(path.join(tmpdir(), "groundcrew-upgrade-"));
    try {
      writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ version: "4.3.0" }));

      const options = await createDefaultUpgradeCliOptions({
        packageName: PACKAGE_NAME,
        cliMetaUrl: pathToFileURL("/opt/pkg/dist/cli.js").toString(),
      });

      expect(options.readInstalledVersion(tmp)).toBe("4.3.0");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("returns undefined from readInstalledVersion when package.json is missing", async () => {
    whichMock.mockResolvedValue("/usr/local/bin/npm");
    runCommandMock.mockReturnValue("/usr/local/lib/node_modules");

    const tmp = mkdtempSync(path.join(tmpdir(), "groundcrew-upgrade-"));
    try {
      const options = await createDefaultUpgradeCliOptions({
        packageName: PACKAGE_NAME,
        cliMetaUrl: pathToFileURL("/opt/pkg/dist/cli.js").toString(),
      });

      expect(options.readInstalledVersion(tmp)).toBeUndefined();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("returns undefined from readInstalledVersion when package.json is malformed JSON", async () => {
    whichMock.mockResolvedValue("/usr/local/bin/npm");
    runCommandMock.mockReturnValue("/usr/local/lib/node_modules");

    const tmp = mkdtempSync(path.join(tmpdir(), "groundcrew-upgrade-"));
    try {
      writeFileSync(path.join(tmp, "package.json"), "{ this is not valid json");

      const options = await createDefaultUpgradeCliOptions({
        packageName: PACKAGE_NAME,
        cliMetaUrl: pathToFileURL("/opt/pkg/dist/cli.js").toString(),
      });

      expect(options.readInstalledVersion(tmp)).toBeUndefined();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("returns undefined from readInstalledVersion when package.json lacks a string version", async () => {
    whichMock.mockResolvedValue("/usr/local/bin/npm");
    runCommandMock.mockReturnValue("/usr/local/lib/node_modules");

    const tmp = mkdtempSync(path.join(tmpdir(), "groundcrew-upgrade-"));
    try {
      writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ name: "no-version" }));

      const options = await createDefaultUpgradeCliOptions({
        packageName: PACKAGE_NAME,
        cliMetaUrl: pathToFileURL("/opt/pkg/dist/cli.js").toString(),
      });

      expect(options.readInstalledVersion(tmp)).toBeUndefined();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
