import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

import { run } from "./cli.ts";
import { cleanupWorkspaceCli } from "./commands/cleanupWorkspace.ts";
import { doctor } from "./commands/doctor.ts";
import { interruptWorkspaceCli } from "./commands/interruptWorkspace.ts";
import { orchestrate } from "./commands/orchestrator.ts";
import { resumeWorkspaceCli } from "./commands/resumeWorkspace.ts";
import { setupWorkspaceCli } from "./commands/setupWorkspace.ts";
import { statusCli } from "./commands/status.ts";
import { taskCli } from "./commands/task.ts";
import {
  createDefaultUpgradeCliOptions,
  upgradeCli,
  type UpgradeCliOptions,
  type UpgradeCliOptionsInput,
} from "./commands/upgrade.ts";
import {
  captureConsoleError,
  captureConsoleLog,
  type ConsoleCapture,
} from "./testHelpers/consoleCapture.ts";
import { isVerbose, setVerbose } from "./lib/util.ts";

vi.mock(import("./commands/cleanupWorkspace.ts"), () => ({
  cleanupWorkspaceCli: vi.fn<typeof cleanupWorkspaceCli>(),
}));
vi.mock(import("./commands/doctor.ts"), () => ({
  doctor: vi.fn<typeof doctor>(),
}));
vi.mock(import("./commands/interruptWorkspace.ts"), () => ({
  interruptWorkspaceCli: vi.fn<typeof interruptWorkspaceCli>(),
}));
vi.mock(import("./commands/orchestrator.ts"), () => ({
  orchestrate: vi.fn<typeof orchestrate>(),
}));
vi.mock(import("./commands/resumeWorkspace.ts"), () => ({
  resumeWorkspaceCli: vi.fn<typeof resumeWorkspaceCli>(),
}));
vi.mock(import("./commands/setupWorkspace.ts"), () => ({
  setupWorkspaceCli: vi.fn<typeof setupWorkspaceCli>(),
}));
vi.mock(import("./commands/status.ts"), () => ({
  statusCli: vi.fn<typeof statusCli>(),
}));
vi.mock(import("./commands/task.ts"), () => ({
  taskCli: vi.fn<typeof taskCli>(),
}));
vi.mock(import("./commands/upgrade.ts"), () => ({
  upgradeCli: vi.fn<typeof upgradeCli>(),
  createDefaultUpgradeCliOptions: vi.fn<typeof createDefaultUpgradeCliOptions>(),
}));

const orchestrateMock = vi.mocked(orchestrate);
const doctorMock = vi.mocked(doctor);
const interruptMock = vi.mocked(interruptWorkspaceCli);
const resumeMock = vi.mocked(resumeWorkspaceCli);
const setupMock = vi.mocked(setupWorkspaceCli);
const cleanupMock = vi.mocked(cleanupWorkspaceCli);
const statusMock = vi.mocked(statusCli);
const taskMock = vi.mocked(taskCli);
const upgradeCliMock = vi.mocked(upgradeCli);
const createDefaultUpgradeCliOptionsMock = vi.mocked(createDefaultUpgradeCliOptions);
const requireFromTest = createRequire(import.meta.url);
const PACKAGE_VERSION = readPackageVersion();
const README_TEXT = readFileSync(new URL("../README.md", import.meta.url), "utf8");

function packageMetadataHasVersion(value: unknown): value is { version: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "version" in value &&
    typeof value.version === "string"
  );
}

function readPackageVersion(): string {
  const packageMetadata: unknown = requireFromTest("../package.json");
  if (!packageMetadataHasVersion(packageMetadata)) {
    throw new Error("Unable to read package version");
  }
  return packageMetadata.version;
}

function makeFakeUpgradeOptions(): UpgradeCliOptions {
  return {
    packageName: "@clipboard-health/groundcrew",
    resolveInstall: async () => ({
      installKind: "global",
      installPath: "/install",
      npmBin: "/usr/local/bin/npm",
    }),
    runInstall: vi.fn<UpgradeCliOptions["runInstall"]>(),
    readInstalledVersion: vi.fn<UpgradeCliOptions["readInstalledVersion"]>(),
  };
}

function expectUpgradeOptionsFactory(
  optionsInput: UpgradeCliOptionsInput,
): () => Promise<UpgradeCliOptions> {
  if (typeof optionsInput !== "function") {
    throw new TypeError("expected lazy upgrade options factory");
  }
  return optionsInput;
}

describe(run, () => {
  let consoleLog: ConsoleCapture;
  let consoleError: ConsoleCapture;

  beforeEach(() => {
    consoleLog = captureConsoleLog();
    consoleError = captureConsoleError();
    process.exitCode = undefined;
    orchestrateMock.mockResolvedValue();
    doctorMock.mockResolvedValue(true);
    interruptMock.mockResolvedValue();
    resumeMock.mockResolvedValue();
    setupMock.mockResolvedValue();
    cleanupMock.mockResolvedValue();
    statusMock.mockResolvedValue();
    taskMock.mockResolvedValue();
    upgradeCliMock.mockResolvedValue();
    createDefaultUpgradeCliOptionsMock.mockResolvedValue(makeFakeUpgradeOptions());
  });

  afterEach(() => {
    consoleLog.restore();
    consoleError.restore();
    process.exitCode = undefined;
    setVerbose(false);
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("prints help and exits with code 1 when no subcommand is provided", async () => {
    await run([]);

    expect(consoleLog.calls.length).toBeGreaterThan(0);
    const helpOutput = consoleLog.output();
    expect(helpOutput).toContain("Usage: crew <command>");
    expect(helpOutput).toContain("-v, --version");
    expect(helpOutput).toContain("run");
    expect(helpOutput).toContain("--project-dir <dir>");
    expect(helpOutput).toContain("[--repo <repo>]...");
    expect(helpOutput).toContain("--runner <runner>");
    expect(helpOutput).toContain("--agent <agent>");
    expect(helpOutput).toContain("crew task <list|get|create|done|validate>");
    expect(helpOutput).not.toContain("sandbox");
    expect(process.exitCode).toBe(1);
  });

  it("prints help on -h without setting exit code", async () => {
    await run(["-h"]);

    expect(consoleLog.calls.length).toBeGreaterThan(0);
    expect(process.exitCode).toBeUndefined();
  });

  it("prints help on --help without setting exit code", async () => {
    await run(["--help"]);

    expect(consoleLog.calls.length).toBeGreaterThan(0);
    expect(process.exitCode).toBeUndefined();
  });

  it("prints the package version on -v without setting exit code", async () => {
    await run(["-v"]);

    expect(consoleLog.output()).toBe(PACKAGE_VERSION);
    expect(process.exitCode).toBeUndefined();
    expect(orchestrateMock).not.toHaveBeenCalled();
  });

  it("prints the package version on --version without setting exit code", async () => {
    await run(["--version"]);

    expect(consoleLog.output()).toBe(PACKAGE_VERSION);
    expect(process.exitCode).toBeUndefined();
    expect(orchestrateMock).not.toHaveBeenCalled();
  });

  it("reports unknown subcommands and exits with code 1", async () => {
    await run(["bogus"]);

    expect(consoleError.output()).toContain("Unknown command: bogus");
    expect(process.exitCode).toBe(1);
  });

  it("hard-fails `sandbox <verb> [args...]` with the manual sbx workflow", async () => {
    await run(["sandbox", "auth", "claude"]);

    expect(consoleError.output()).toContain("`crew sandbox` is no longer supported");
    expect(consoleError.output()).toContain("manual `sbx` workflow");
    expect(consoleError.output()).toContain("agents.definitions.<agent>.sandbox.agent");
    expect(process.exitCode).toBe(1);
  });

  it("dispatches `run` (no flags) to a one-shot orchestrator tick", async () => {
    await run(["run"]);

    expect(orchestrateMock).toHaveBeenCalledWith({ watch: false, dryRun: false });
    expect(setupMock).not.toHaveBeenCalled();
  });

  it("dispatches `run --watch` to the orchestrator with watch=true", async () => {
    await run(["run", "--watch"]);

    expect(orchestrateMock).toHaveBeenCalledWith({ watch: true, dryRun: false });
  });

  it("dispatches `run --dry-run` to the orchestrator with dryRun=true", async () => {
    await run(["run", "--dry-run"]);

    expect(orchestrateMock).toHaveBeenCalledWith({ watch: false, dryRun: true });
  });

  it("dispatches `run --watch --dry-run` with both flags forwarded", async () => {
    await run(["run", "--watch", "--dry-run"]);

    expect(orchestrateMock).toHaveBeenCalledWith({ watch: true, dryRun: true });
  });

  it("enables verbose and strips --verbose before subcommand dispatch", async () => {
    await run(["run", "--verbose", "--dry-run"]);

    expect(isVerbose()).toBe(true);
    expect(orchestrateMock).toHaveBeenCalledWith({ watch: false, dryRun: true });
  });

  it("enables verbose from GROUNDCREW_VERBOSE without the flag", async () => {
    vi.stubEnv("GROUNDCREW_VERBOSE", "1");

    await run(["run"]);

    expect(isVerbose()).toBe(true);
    expect(orchestrateMock).toHaveBeenCalledWith({ watch: false, dryRun: false });
  });

  it("leaves verbose off by default", async () => {
    await run(["run"]);

    expect(isVerbose()).toBe(false);
  });

  it("documents --verbose in the help output", async () => {
    await run(["--help"]);

    expect(consoleLog.output()).toContain("--verbose");
    expect(consoleLog.output()).toContain("GROUNDCREW_VERBOSE");
  });

  it("dispatches the deprecated `run --task <id>` alias to setupWorkspaceCli with a warning", async () => {
    await run(["run", "--task", "team-220"]);

    expect(setupMock).toHaveBeenCalledWith("team-220", { dryRun: false });
    expect(orchestrateMock).not.toHaveBeenCalled();
    expect(consoleError.output()).toContain("crew run --task is deprecated");
    expect(consoleError.output()).toContain("use crew start");
    expect(consoleError.output()).toContain("next major");
  });

  it("documents `crew start <TASK>` as the manual task setup command", () => {
    expect(README_TEXT).toContain("crew start <TASK>");
    expect(README_TEXT).not.toContain("crew setup <TASK>");
  });

  it("forwards --dry-run to setupWorkspaceCli on the --task path", async () => {
    await run(["run", "--task", "team-220", "--dry-run"]);

    expect(setupMock).toHaveBeenCalledWith("team-220", { dryRun: true });
    expect(orchestrateMock).not.toHaveBeenCalled();
  });

  it("rejects `run --task` combined with --watch", async () => {
    await run(["run", "--watch", "--task", "team-220"]);

    expect(consoleError.output()).toContain("--watch and --task are mutually exclusive");
    expect(process.exitCode).toBe(1);
    expect(setupMock).not.toHaveBeenCalled();
    expect(orchestrateMock).not.toHaveBeenCalled();
  });

  it("rejects `run --task` with no value", async () => {
    await run(["run", "--task"]);

    expect(consoleError.output()).toContain("task id is required");
    expect(process.exitCode).toBe(1);
    expect(setupMock).not.toHaveBeenCalled();
  });

  it("rejects `run --task --dry-run` (flag value missing, dash-prefixed value)", async () => {
    await run(["run", "--task", "--dry-run"]);

    expect(consoleError.output()).toContain("task id is required");
    expect(process.exitCode).toBe(1);
    expect(setupMock).not.toHaveBeenCalled();
  });

  it("rejects `run --task` with an empty-string value", async () => {
    await run(["run", "--task", ""]);

    expect(consoleError.output()).toContain("task id is required");
    expect(process.exitCode).toBe(1);
    expect(setupMock).not.toHaveBeenCalled();
  });

  it("rejects unknown args under `run` (e.g. --help) instead of swallowing them", async () => {
    await run(["run", "--help"]);

    expect(consoleError.output()).toContain("unknown argument: --help");
    expect(process.exitCode).toBe(1);
    expect(orchestrateMock).not.toHaveBeenCalled();
    expect(setupMock).not.toHaveBeenCalled();
  });

  it("rejects extra positional args after `run --task <id>`", async () => {
    await run(["run", "--task", "team-220", "extra"]);

    expect(consoleError.output()).toContain("unknown argument: extra");
    expect(process.exitCode).toBe(1);
    expect(setupMock).not.toHaveBeenCalled();
  });

  it("dispatches `start <task>` to setupWorkspaceCli with no deprecation warning", async () => {
    await run(["start", "team-220"]);

    expect(setupMock).toHaveBeenCalledWith("team-220", { dryRun: false });
    expect(orchestrateMock).not.toHaveBeenCalled();
    expect(consoleError.calls).toStrictEqual([]);
  });

  it("forwards --dry-run to setupWorkspaceCli under `start`", async () => {
    await run(["start", "team-220", "--dry-run"]);

    expect(setupMock).toHaveBeenCalledWith("team-220", { dryRun: true });
  });

  it("rejects `start` with no task", async () => {
    await run(["start"]);

    expect(consoleError.output()).toContain("Usage: crew start <task>");
    expect(process.exitCode).toBe(1);
    expect(setupMock).not.toHaveBeenCalled();
  });

  it("rejects unknown flags under `start`", async () => {
    await run(["start", "team-220", "--watch"]);

    expect(consoleError.output()).toContain("Unknown option: --watch");
    expect(process.exitCode).toBe(1);
    expect(setupMock).not.toHaveBeenCalled();
  });

  it("rejects extra positional args under `start`", async () => {
    await run(["start", "team-220", "extra"]);

    expect(consoleError.output()).toContain("Usage: crew start <task>");
    expect(process.exitCode).toBe(1);
    expect(setupMock).not.toHaveBeenCalled();
  });

  it("dispatches `stop` to interruptWorkspaceCli with no deprecation warning", async () => {
    await run(["stop", "TEAM-1", "--reason", "wrong direction"]);

    expect(interruptMock).toHaveBeenCalledWith(["TEAM-1", "--reason", "wrong direction"]);
    expect(consoleError.calls).toStrictEqual([]);
  });

  it("calls doctor and leaves exit code untouched on success", async () => {
    doctorMock.mockResolvedValue(true);

    await run(["doctor"]);

    expect(doctorMock).toHaveBeenCalledWith();
    expect(process.exitCode).toBeUndefined();
  });

  it("dispatches status with a task", async () => {
    await run(["status", "team-220"]);

    expect(statusMock).toHaveBeenCalledWith(["team-220"]);
    expect(process.exitCode).toBeUndefined();
  });

  it("dispatches status inventory mode with no task", async () => {
    await run(["status"]);

    expect(statusMock).toHaveBeenCalledWith([]);
    expect(process.exitCode).toBeUndefined();
  });

  it("dispatches task namespace arguments to taskCli", async () => {
    await run(["task", "list", "--source", "todo"]);

    expect(taskMock).toHaveBeenCalledWith(["list", "--source", "todo"]);
    expect(process.exitCode).toBeUndefined();
  });

  it("routes the deprecated `doctor --task <id>` alias to status with a warning", async () => {
    await run(["doctor", "--task", "team-220"]);

    expect(statusMock).toHaveBeenCalledWith(["team-220"]);
    expect(doctorMock).not.toHaveBeenCalled();
    expect(consoleError.output()).toContain("crew doctor --task is deprecated");
    expect(consoleError.output()).toContain("use crew status");
    expect(consoleError.output()).toContain("next major");
    expect(process.exitCode).toBeUndefined();
  });

  it("rejects `doctor --task` with no value", async () => {
    await run(["doctor", "--task"]);

    expect(consoleError.output()).toContain("task id is required");
    expect(process.exitCode).toBe(1);
    expect(statusMock).not.toHaveBeenCalled();
    expect(doctorMock).not.toHaveBeenCalled();
  });

  it("rejects extra args after `doctor --task <id>`", async () => {
    await run(["doctor", "--task", "team-220", "extra"]);

    expect(consoleError.output()).toContain("Usage: crew status");
    expect(process.exitCode).toBe(1);
    expect(statusMock).not.toHaveBeenCalled();
    expect(doctorMock).not.toHaveBeenCalled();
  });

  it("rejects unknown args under `doctor`", async () => {
    await run(["doctor", "--bogus"]);

    expect(consoleError.output()).toContain("Usage: crew doctor");
    expect(process.exitCode).toBe(1);
    expect(doctorMock).not.toHaveBeenCalled();
  });

  it("rejects removed task-mode flags under `doctor`", async () => {
    await run(["doctor", "--no-linear"]);

    expect(consoleError.output()).toContain("Usage: crew doctor");
    expect(process.exitCode).toBe(1);
    expect(doctorMock).not.toHaveBeenCalled();
  });

  it("sets exit code to 1 when doctor fails", async () => {
    doctorMock.mockResolvedValue(false);

    await run(["doctor"]);

    expect(process.exitCode).toBe(1);
  });

  it("dispatches cleanup to cleanupWorkspaceCli with the remaining argv", async () => {
    await run(["cleanup", "--force", "TEAM-1"]);

    expect(cleanupMock).toHaveBeenCalledWith(["--force", "TEAM-1"]);
  });

  it("routes the deprecated `interrupt` alias to interruptWorkspaceCli with a warning", async () => {
    await run(["interrupt", "TEAM-1", "--reason", "wrong direction"]);

    expect(interruptMock).toHaveBeenCalledWith(["TEAM-1", "--reason", "wrong direction"]);
    expect(consoleError.output()).toContain("crew interrupt is deprecated");
    expect(consoleError.output()).toContain("use crew stop");
    expect(consoleError.output()).toContain("next major");
  });

  it("dispatches resume to resumeWorkspaceCli with the remaining argv", async () => {
    await run(["resume", "TEAM-1"]);

    expect(resumeMock).toHaveBeenCalledWith(["TEAM-1"]);
  });

  it("hard-fails removed `setup repos` with a README-backed manual clone pointer", async () => {
    await run(["setup", "repos", "--dry-run", "owner/repo"]);

    expect(consoleError.output()).toContain("crew setup repos was removed");
    expect(consoleError.output()).toContain("git clone");
    expect(consoleError.output()).toContain("README.md#manual-repository-bootstrap");
    expect(process.exitCode).toBe(1);
  });

  it("hard-fails bare `setup repos` with the same replacement workflow", async () => {
    await run(["setup", "repos"]);

    expect(consoleError.output()).toContain("crew setup repos was removed");
    expect(consoleError.output()).toContain("README.md#manual-repository-bootstrap");
    expect(process.exitCode).toBe(1);
  });

  it("reports an unknown `setup` verb with the removed command usage", async () => {
    await run(["setup", "bogus"]);

    expect(consoleError.output()).toContain("Usage: crew setup repos");
    expect(consoleError.output()).toContain("README.md#manual-repository-bootstrap");
    expect(process.exitCode).toBe(1);
  });

  it("prints the setup usage when no verb is given", async () => {
    await run(["setup"]);

    expect(consoleError.output()).toContain("Usage: crew setup repos");
    expect(consoleError.output()).toContain("README.md#manual-repository-bootstrap");
    expect(process.exitCode).toBe(1);
  });

  it("prints the error message and sets exit code 1 when a subcommand throws", async () => {
    setupMock.mockRejectedValue(new Error("boom"));

    await run(["start", "team-1"]);

    expect(consoleError.output()).toBe("boom");
    expect(process.exitCode).toBe(1);
  });

  it("dispatches `upgrade` to upgradeCli with lazy default options", async () => {
    const assembled = makeFakeUpgradeOptions();
    createDefaultUpgradeCliOptionsMock.mockResolvedValue(assembled);
    upgradeCliMock.mockImplementationOnce(async (_argv, optionsInput) => {
      const optionsFactory = expectUpgradeOptionsFactory(optionsInput);
      const options = await optionsFactory();
      expect(options).toBe(assembled);
    });

    await run(["upgrade", "3.2.0"]);

    const call = createDefaultUpgradeCliOptionsMock.mock.calls[0]?.[0];
    expect(call?.packageName).toBe("@clipboard-health/groundcrew");
    expect(call?.cliMetaUrl).toMatch(/cli\.ts$/);
    expect(upgradeCliMock).toHaveBeenCalledWith(["3.2.0"], expect.any(Function));
  });

  it("does not perform passive upgrade checks before non-upgrade subcommands", async () => {
    const cacheDir = mkdtempSync(path.join(tmpdir(), "groundcrew-no-passive-upgrade-"));
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubEnv("XDG_CACHE_HOME", cacheDir);
    vi.stubGlobal("fetch", fetchMock);
    try {
      await run(["doctor"]);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(consoleError.calls).toStrictEqual([]);
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      rmSync(cacheDir, { recursive: true, force: true });
    }

    expect(doctorMock).toHaveBeenCalledWith();
    expect(process.exitCode).toBeUndefined();
  });
});
