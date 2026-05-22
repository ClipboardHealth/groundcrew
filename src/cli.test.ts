import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { run } from "./cli.ts";
import { cleanupWorkspaceCli } from "./commands/cleanupWorkspace.ts";
import { doctor } from "./commands/doctor.ts";
import { interruptWorkspaceCli } from "./commands/interruptWorkspace.ts";
import { orchestrate } from "./commands/orchestrator.ts";
import { resumeWorkspaceCli } from "./commands/resumeWorkspace.ts";
import { sandboxCli } from "./commands/sandbox/index.ts";
import { setupReposCli } from "./commands/setupRepos.ts";
import { setupWorkspaceCli } from "./commands/setupWorkspace.ts";
import {
  captureConsoleError,
  captureConsoleLog,
  type ConsoleCapture,
} from "./testHelpers/consoleCapture.ts";

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
vi.mock(import("./commands/sandbox/index.ts"), () => ({
  sandboxCli: vi.fn<typeof sandboxCli>(),
}));
vi.mock(import("./commands/setupWorkspace.ts"), () => ({
  setupWorkspaceCli: vi.fn<typeof setupWorkspaceCli>(),
}));
vi.mock(import("./commands/setupRepos.ts"), () => ({
  setupReposCli: vi.fn<typeof setupReposCli>(),
}));

const orchestrateMock = vi.mocked(orchestrate);
const doctorMock = vi.mocked(doctor);
const interruptMock = vi.mocked(interruptWorkspaceCli);
const resumeMock = vi.mocked(resumeWorkspaceCli);
const sandboxMock = vi.mocked(sandboxCli);
const setupMock = vi.mocked(setupWorkspaceCli);
const setupReposMock = vi.mocked(setupReposCli);
const cleanupMock = vi.mocked(cleanupWorkspaceCli);
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
    sandboxMock.mockResolvedValue();
    setupMock.mockResolvedValue();
    setupReposMock.mockResolvedValue();
    cleanupMock.mockResolvedValue();
  });

  afterEach(() => {
    consoleLog.restore();
    consoleError.restore();
    process.exitCode = undefined;
    vi.clearAllMocks();
  });

  it("prints help and exits with code 1 when no subcommand is provided", async () => {
    await run([]);

    expect(consoleLog.calls.length).toBeGreaterThan(0);
    const helpOutput = consoleLog.output();
    expect(helpOutput).toContain("Usage: crew <command>");
    expect(helpOutput).toContain("-v, --version");
    expect(helpOutput).toContain("run");
    expect(helpOutput).toContain("sandbox");
    expect(helpOutput).not.toContain("crew ticket");
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

  it("dispatches `sandbox <verb> [args...]` to sandboxCli with the remaining argv", async () => {
    await run(["sandbox", "auth", "claude"]);

    expect(sandboxMock).toHaveBeenCalledWith(["auth", "claude"]);
    expect(process.exitCode).toBeUndefined();
  });

  it("sets exit code to 1 when sandboxCli throws and surfaces the error message", async () => {
    sandboxMock.mockRejectedValueOnce(new Error("crew sandbox: unknown model 'ghost'"));

    await run(["sandbox", "ensure", "ghost"]);

    expect(consoleError.output()).toContain("crew sandbox: unknown model 'ghost'");
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

  it("dispatches `run --ticket <id>` to setupWorkspaceCli", async () => {
    await run(["run", "--ticket", "team-220"]);

    expect(setupMock).toHaveBeenCalledWith("team-220", { dryRun: false });
    expect(orchestrateMock).not.toHaveBeenCalled();
  });

  it("documents `run --ticket <TICKET>` as the manual ticket setup command", () => {
    expect(README_TEXT).toContain("crew run --ticket <TICKET>");
    expect(README_TEXT).not.toContain("crew setup <TICKET>");
  });

  it("forwards --dry-run to setupWorkspaceCli on the --ticket path", async () => {
    await run(["run", "--ticket", "team-220", "--dry-run"]);

    expect(setupMock).toHaveBeenCalledWith("team-220", { dryRun: true });
    expect(orchestrateMock).not.toHaveBeenCalled();
  });

  it("rejects `run --ticket` combined with --watch", async () => {
    await run(["run", "--watch", "--ticket", "team-220"]);

    expect(consoleError.output()).toContain("--watch and --ticket are mutually exclusive");
    expect(process.exitCode).toBe(1);
    expect(setupMock).not.toHaveBeenCalled();
    expect(orchestrateMock).not.toHaveBeenCalled();
  });

  it("rejects `run --ticket` with no value", async () => {
    await run(["run", "--ticket"]);

    expect(consoleError.output()).toContain("ticket id is required");
    expect(process.exitCode).toBe(1);
    expect(setupMock).not.toHaveBeenCalled();
  });

  it("rejects `run --ticket --dry-run` (flag value missing, dash-prefixed value)", async () => {
    await run(["run", "--ticket", "--dry-run"]);

    expect(consoleError.output()).toContain("ticket id is required");
    expect(process.exitCode).toBe(1);
    expect(setupMock).not.toHaveBeenCalled();
  });

  it("rejects `run --ticket` with an empty-string value", async () => {
    await run(["run", "--ticket", ""]);

    expect(consoleError.output()).toContain("ticket id is required");
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

  it("rejects extra positional args after `run --ticket <id>`", async () => {
    await run(["run", "--ticket", "team-220", "extra"]);

    expect(consoleError.output()).toContain("unknown argument: extra");
    expect(process.exitCode).toBe(1);
    expect(setupMock).not.toHaveBeenCalled();
  });

  it("calls doctor and leaves exit code untouched on success", async () => {
    doctorMock.mockResolvedValue(true);

    await run(["doctor"]);

    expect(doctorMock).toHaveBeenCalledWith();
    expect(process.exitCode).toBeUndefined();
  });

  it("dispatches `doctor --ticket <id>` to ticket diagnostics", async () => {
    doctorMock.mockResolvedValue(true);

    await run(["doctor", "--ticket", "team-220"]);

    expect(doctorMock).toHaveBeenCalledWith({ ticket: "team-220", ticketArgv: [] });
    expect(process.exitCode).toBeUndefined();
  });

  it("forwards --no-linear and --no-fetch to the ticket diagnostic", async () => {
    doctorMock.mockResolvedValue(true);

    await run(["doctor", "--ticket", "team-220", "--no-linear", "--no-fetch"]);

    expect(doctorMock).toHaveBeenCalledWith({
      ticket: "team-220",
      ticketArgv: ["--no-linear", "--no-fetch"],
    });
  });

  it("accepts ticket-mode flags interleaved before --ticket", async () => {
    doctorMock.mockResolvedValue(true);

    await run(["doctor", "--no-fetch", "--ticket", "team-220"]);

    expect(doctorMock).toHaveBeenCalledWith({
      ticket: "team-220",
      ticketArgv: ["--no-fetch"],
    });
  });

  it("sets exit code to 1 when `doctor --ticket` fails", async () => {
    doctorMock.mockResolvedValue(false);

    await run(["doctor", "--ticket", "team-220"]);

    expect(process.exitCode).toBe(1);
  });

  it("rejects `doctor --ticket` with no value", async () => {
    await run(["doctor", "--ticket"]);

    expect(consoleError.output()).toContain("ticket id is required");
    expect(process.exitCode).toBe(1);
    expect(doctorMock).not.toHaveBeenCalled();
  });

  it("rejects unknown args under `doctor`", async () => {
    await run(["doctor", "--bogus"]);

    expect(consoleError.output()).toContain("unknown argument: --bogus");
    expect(process.exitCode).toBe(1);
    expect(doctorMock).not.toHaveBeenCalled();
  });

  it("rejects ticket-mode flags without --ticket (host doctor has no flags)", async () => {
    await run(["doctor", "--no-linear"]);

    expect(consoleError.output()).toContain("--no-linear requires --ticket");
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

  it("dispatches interrupt to interruptWorkspaceCli with the remaining argv", async () => {
    await run(["interrupt", "TEAM-1", "--reason", "wrong direction"]);

    expect(interruptMock).toHaveBeenCalledWith(["TEAM-1", "--reason", "wrong direction"]);
  });

  it("dispatches resume to resumeWorkspaceCli with the remaining argv", async () => {
    await run(["resume", "TEAM-1"]);

    expect(resumeMock).toHaveBeenCalledWith(["TEAM-1"]);
  });
  it("dispatches `setup repos` to setupReposCli with the remaining argv", async () => {
    await run(["setup", "repos", "--dry-run", "owner/repo"]);

    expect(setupReposMock).toHaveBeenCalledWith(["--dry-run", "owner/repo"]);
  });

  it("dispatches bare `setup repos` (no args) to setupReposCli", async () => {
    await run(["setup", "repos"]);

    expect(setupReposMock).toHaveBeenCalledWith([]);
  });

  it("reports an unknown `setup` verb instead of routing it", async () => {
    await run(["setup", "bogus"]);

    expect(setupReposMock).not.toHaveBeenCalled();
    expect(consoleError.output()).toContain("Usage: crew setup repos");
    expect(process.exitCode).toBe(1);
  });

  it("prints the setup usage when no verb is given", async () => {
    await run(["setup"]);

    expect(setupReposMock).not.toHaveBeenCalled();
    expect(consoleError.output()).toContain("Usage: crew setup repos");
    expect(process.exitCode).toBe(1);
  });

  it("prints the error message and sets exit code 1 when a subcommand throws", async () => {
    setupMock.mockRejectedValue(new Error("boom"));

    await run(["run", "--ticket", "team-1"]);

    expect(consoleError.output()).toBe("boom");
    expect(process.exitCode).toBe(1);
  });
});
