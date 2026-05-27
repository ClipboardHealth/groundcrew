import { existsSync, statSync } from "node:fs";

import { createBoardSource, type BoardSource } from "../lib/boardSource.ts";
import type { RunCommandOptions } from "../lib/commandRunner.ts";
import { loadConfig, type ResolvedConfig } from "../lib/config.ts";
import { detectHostCapabilities, type HostCapabilities } from "../lib/host.ts";
import { readEnvironmentVariable } from "../lib/util.ts";
import { captureConsoleLog, type ConsoleCapture } from "../testHelpers/consoleCapture.ts";
import { deleteEnvironmentVariable, setEnvironmentVariable } from "../testHelpers/env.ts";
import { doctor } from "./doctor.ts";

interface NodeFsMock {
  existsSync: ReturnType<typeof vi.fn<typeof existsSync>>;
  statSync: ReturnType<typeof vi.fn<typeof statSync>>;
}

vi.mock(
  "node:fs",
  (): NodeFsMock => ({
    existsSync: vi.fn<typeof existsSync>(),
    statSync: vi.fn<typeof statSync>(),
  }),
);
vi.mock(import("../lib/config.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, loadConfig: vi.fn<typeof loadConfig>() };
});
vi.mock(import("../lib/host.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, detectHostCapabilities: vi.fn<typeof detectHostCapabilities>() };
});
vi.mock(import("../lib/boardSource.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, createBoardSource: vi.fn<typeof createBoardSource>() };
});
type RunCommandMock = (
  command: string,
  arguments_: readonly string[],
  options?: RunCommandOptions,
) => string;

const runCommandMock = vi.hoisted(() => vi.fn<RunCommandMock>());

vi.mock(import("../lib/commandRunner.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    runCommand: runCommandMock,
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test mock intentionally shares one recorder across sync and async command APIs.
    runCommandAsync: runCommandMock as unknown as typeof actual.runCommandAsync,
  };
});

const existsMock = vi.mocked(existsSync);
const statMock = vi.mocked(statSync);
const createBoardSourceMock = vi.mocked(createBoardSource);
const loadConfigMock = vi.mocked(loadConfig);
const detectHostMock = vi.mocked(detectHostCapabilities);
const linearVerifyMock = vi.fn<BoardSource["verify"]>();

function makeConfig(overrides: Partial<ResolvedConfig["models"]> = {}): ResolvedConfig {
  return {
    sources: [],
    git: { remote: "origin", defaultBranch: "main" },
    workspace: {
      projectDir: "/work",
      knownRepositories: ["repo-a"],
    },
    orchestrator: {
      maximumInProgress: 4,
      pollIntervalMilliseconds: 1000,
      sessionLimitPercentage: 85,
    },
    models: {
      default: "claude",
      definitions: {
        claude: { cmd: "safehouse claude --permission-mode auto", color: "#fff" },
      },
      ...overrides,
    },
    prompts: { initial: "x" },
    workspaceKind: "auto",
    local: { runner: "auto" },
    logging: { file: "/tmp/groundcrew-test.log" },
  };
}

function host(overrides: Partial<HostCapabilities> = {}): HostCapabilities {
  return {
    hasSafehouse: true,
    hasSbx: false,
    hasCmux: true,
    hasTmux: false,
    isMacOS: true,
    isLinux: false,
    isSafehouseSupported: true,
    isSdxSupported: true,
    ...overrides,
  };
}

function statsWithDirectoryValue(isDirectory: boolean): ReturnType<typeof statSync> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- tests only need the statSync isDirectory surface
  return { isDirectory: () => isDirectory } as ReturnType<typeof statSync>;
}

function firstArgument(arguments_: unknown): string {
  if (Array.isArray(arguments_) && typeof arguments_[0] === "string") {
    return arguments_[0];
  }
  return "";
}

function checkedCommands(): string[] {
  return runCommandMock.mock.calls
    .map((call) => firstArgument(call[1]))
    .filter((token) => token.length > 0);
}

function mockWhichFailure(target: string, message: string): void {
  runCommandMock.mockImplementation((_cmd, arguments_) => {
    const candidate = firstArgument(arguments_);
    if (candidate === target) {
      throw new Error(message);
    }
    return `/usr/bin/${candidate}\n`;
  });
}

function mockWhichEmpty(target: string): void {
  runCommandMock.mockImplementation((_cmd, arguments_) => {
    const candidate = firstArgument(arguments_);
    return candidate === target ? "" : `/usr/bin/${candidate}\n`;
  });
}

function mockMissingPath(missingPath: string): void {
  existsMock.mockImplementation((path) => path !== missingPath);
}

describe(doctor, () => {
  let consoleLog: ConsoleCapture;
  const originalGroundcrewKey = readEnvironmentVariable("GROUNDCREW_LINEAR_API_KEY");
  const originalLinearKey = readEnvironmentVariable("LINEAR_API_KEY");

  beforeEach(() => {
    consoleLog = captureConsoleLog();
    deleteEnvironmentVariable("GROUNDCREW_LINEAR_API_KEY");
    setEnvironmentVariable("LINEAR_API_KEY", "lin_api_test");
    existsMock.mockReturnValue(true);
    statMock.mockReturnValue(statsWithDirectoryValue(true));
    detectHostMock.mockResolvedValue(host());
    createBoardSourceMock.mockReturnValue({
      verify: linearVerifyMock,
      fetch: vi.fn<BoardSource["fetch"]>(),
    });
    runCommandMock.mockImplementation((_cmd, arguments_) => {
      const target = firstArgument(arguments_);
      return `/usr/bin/${target}\n`;
    });
  });

  afterEach(() => {
    consoleLog.restore();
    if (originalGroundcrewKey === undefined) {
      deleteEnvironmentVariable("GROUNDCREW_LINEAR_API_KEY");
    } else {
      setEnvironmentVariable("GROUNDCREW_LINEAR_API_KEY", originalGroundcrewKey);
    }
    if (originalLinearKey === undefined) {
      deleteEnvironmentVariable("LINEAR_API_KEY");
    } else {
      setEnvironmentVariable("LINEAR_API_KEY", originalLinearKey);
    }
    vi.resetAllMocks();
  });

  it("returns false when config loading fails", async () => {
    loadConfigMock.mockRejectedValue(new Error("bad config"));

    const actual = await doctor();

    expect(actual).toBe(false);
    expect(consoleLog.output()).toContain("config: bad config");
  });

  it("returns false when host-capability probing throws", async () => {
    loadConfigMock.mockResolvedValue(makeConfig());
    detectHostMock.mockRejectedValue(new Error("probe blew up"));

    const actual = await doctor();

    expect(actual).toBe(false);
    expect(consoleLog.output()).toContain("host: probe blew up");
  });

  it("returns true when all required checks pass", async () => {
    loadConfigMock.mockResolvedValue(makeConfig());

    const actual = await doctor();

    expect(actual).toBe(true);
    expect(createBoardSourceMock).toHaveBeenCalledTimes(1);
    const createBoardSourceArguments = createBoardSourceMock.mock.calls[0]?.[0];
    expect(createBoardSourceArguments?.config.workspace.projectDir).toBe("/work");
    expect(createBoardSourceArguments?.client).toBeDefined();
    expect(linearVerifyMock).toHaveBeenCalledTimes(1);
    expect(consoleLog.output()).toContain("All required checks passed");
  });

  it("returns false and reports both env var names when neither key is set", async () => {
    deleteEnvironmentVariable("LINEAR_API_KEY");
    loadConfigMock.mockResolvedValue(makeConfig());

    const actual = await doctor();

    expect(actual).toBe(false);
    const output = consoleLog.output();
    expect(output).toContain("linear reachability");
    expect(output).toContain("$GROUNDCREW_LINEAR_API_KEY");
    expect(output).toContain("$LINEAR_API_KEY");
    expect(linearVerifyMock).not.toHaveBeenCalled();
  });

  it("reports the resolved env var when only GROUNDCREW_LINEAR_API_KEY is set", async () => {
    deleteEnvironmentVariable("LINEAR_API_KEY");
    setEnvironmentVariable("GROUNDCREW_LINEAR_API_KEY", "lin_api_groundcrew");
    loadConfigMock.mockResolvedValue(makeConfig());

    const actual = await doctor();

    expect(actual).toBe(true);
    const output = consoleLog.output();
    expect(output).toContain("linear reachability");
    expect(output).toContain("$GROUNDCREW_LINEAR_API_KEY");
  });

  it("prefers GROUNDCREW_LINEAR_API_KEY in doctor output when both env vars are set", async () => {
    setEnvironmentVariable("GROUNDCREW_LINEAR_API_KEY", "lin_api_groundcrew");
    setEnvironmentVariable("LINEAR_API_KEY", "lin_api_legacy");
    loadConfigMock.mockResolvedValue(makeConfig());

    const actual = await doctor();

    expect(actual).toBe(true);
    const output = consoleLog.output();
    expect(output).toContain("$GROUNDCREW_LINEAR_API_KEY");
    expect(output).not.toMatch(/set via \$LINEAR_API_KEY/);
  });

  it("returns false when Linear cannot be reached", async () => {
    loadConfigMock.mockResolvedValue(makeConfig());
    linearVerifyMock.mockRejectedValue(new Error("viewer lookup failed"));

    const actual = await doctor();

    expect(actual).toBe(false);
    const output = consoleLog.output();
    expect(output).toContain("[--] linear reachability");
    expect(output).toContain("viewer lookup failed");
  });

  it("returns false when a required CLI tool is missing", async () => {
    loadConfigMock.mockResolvedValue(makeConfig());
    mockWhichFailure("git", "not found");

    const actual = await doctor();

    expect(actual).toBe(false);
    expect(consoleLog.output()).toContain("[--] git");
  });

  it("treats an empty `which` result as missing", async () => {
    loadConfigMock.mockResolvedValue(makeConfig());
    mockWhichEmpty("cmux");

    const actual = await doctor();

    expect(actual).toBe(false);
  });

  it("hints to mkdir -p when the workspace dir is missing", async () => {
    loadConfigMock.mockResolvedValue(makeConfig());
    mockMissingPath("/work");

    const actual = await doctor();

    expect(actual).toBe(false);
    expect(consoleLog.output()).toContain('mkdir -p "/work"');
  });

  it("treats a non-directory project path as missing", async () => {
    loadConfigMock.mockResolvedValue(makeConfig());
    statMock.mockReturnValue(statsWithDirectoryValue(false));

    const actual = await doctor();

    expect(actual).toBe(false);
  });

  it("handles statSync throwing as a missing directory", async () => {
    loadConfigMock.mockResolvedValue(makeConfig());
    statMock.mockImplementation(() => {
      throw new Error("permission denied");
    });

    const actual = await doctor();

    expect(actual).toBe(false);
  });

  it("checks both wrapper and wrapped commands when the cmd is `safehouse claude --foo`", async () => {
    loadConfigMock.mockResolvedValue(makeConfig());

    await doctor();

    const checked = checkedCommands();
    expect(checked).toContain("safehouse");
    expect(checked).toContain("claude");
  });

  it("skips flag values when tokenizing model commands", async () => {
    loadConfigMock.mockResolvedValue(
      makeConfig({
        default: "node-cli",
        definitions: {
          "node-cli": { cmd: "node --inspect script.ts", color: "#fff" },
        },
      }),
    );

    await doctor();

    const checked = checkedCommands();
    expect(checked).toContain("node");
    expect(checked).not.toContain("script.ts");
  });

  it("does not probe a disabled shipped default's CLI binary", async () => {
    // The default makeConfig fixture has only `claude` in `definitions` — the
    // same shape `mergeDefinitions` produces for `codex: { disabled: true }`.
    // `gatherToolTokens` iterates `Object.values(definitions)`, so codex is
    // never gathered.
    loadConfigMock.mockResolvedValue(makeConfig());

    await doctor();

    const checked = checkedCommands();
    expect(checked).not.toContain("codex");
    expect(checked).toContain("claude");
  });

  it("reports missing Safehouse as a local runner warning", async () => {
    detectHostMock.mockResolvedValue(host({ hasSafehouse: false }));
    loadConfigMock.mockResolvedValue(makeConfig());

    const actual = await doctor();

    expect(actual).toBe(true);
    expect(consoleLog.output()).toContain("local runner (safehouse)");
    expect(consoleLog.output()).toContain(
      "safehouse runner requires macOS with `safehouse` on PATH",
    );
    expect(consoleLog.output().match(/local runner \(safehouse\)/g)).toHaveLength(1);
  });

  it("reports the sdx runner as ready when auto picks sdx on Linux and sbx is on PATH", async () => {
    detectHostMock.mockResolvedValue(
      host({
        hasSafehouse: false,
        hasSbx: true,
        hasCmux: false,
        hasTmux: true,
        isMacOS: false,
        isLinux: true,
        isSafehouseSupported: false,
      }),
    );
    loadConfigMock.mockResolvedValue(makeConfig());

    const actual = await doctor();

    expect(actual).toBe(true);
    expect(consoleLog.output()).toContain("requested: auto → resolved: sdx");
    expect(consoleLog.output()).toContain("local runner (sdx)");
    expect(consoleLog.output()).not.toContain("sdx runner requires `sbx`");
  });

  it("reports the sdx runner as missing when sbx is not on PATH", async () => {
    detectHostMock.mockResolvedValue(
      host({
        hasSafehouse: false,
        hasSbx: false,
        hasCmux: false,
        hasTmux: true,
        isMacOS: false,
        isLinux: true,
        isSafehouseSupported: false,
      }),
    );
    loadConfigMock.mockResolvedValue(makeConfig());

    const actual = await doctor();

    expect(actual).toBe(true);
    expect(consoleLog.output()).toContain("local runner (sdx)");
    expect(consoleLog.output()).toContain("sdx runner requires `sbx`");
  });

  it("surfaces a WARNING when local.runner is configured to 'none'", async () => {
    detectHostMock.mockResolvedValue(host());
    loadConfigMock.mockResolvedValue({ ...makeConfig(), local: { runner: "none" } });

    const actual = await doctor();

    expect(actual).toBe(true);
    expect(consoleLog.output()).toContain("requested: none → resolved: none");
    expect(consoleLog.output()).toContain("local runner (none)");
    expect(consoleLog.output()).toContain("WARNING: local.runner='none'");
  });

  it("honours an explicit local.runner='sdx' even on macOS, reflecting the requested vs resolved line", async () => {
    detectHostMock.mockResolvedValue(host({ hasSbx: true }));
    loadConfigMock.mockResolvedValue({ ...makeConfig(), local: { runner: "sdx" } });

    const actual = await doctor();

    expect(actual).toBe(true);
    expect(consoleLog.output()).toContain("requested: sdx → resolved: sdx");
    expect(consoleLog.output()).toContain("local runner (sdx)");
  });

  it("downgrades model command checks to optional when the local runner is unavailable", async () => {
    detectHostMock.mockResolvedValue(
      host({
        hasSafehouse: false,
        hasCmux: false,
        hasTmux: true,
        isMacOS: false,
        isLinux: true,
        isSafehouseSupported: false,
      }),
    );
    loadConfigMock.mockResolvedValue(
      makeConfig({
        definitions: {
          claude: { cmd: "missing-cli", color: "#fff" },
        },
      }),
    );
    mockWhichFailure("missing-cli", "not installed");

    const actual = await doctor();

    expect(actual).toBe(true);
    expect(consoleLog.output()).toContain("[? ] missing-cli");
    expect(consoleLog.output()).toContain("required for local runs");
  });

  it("fails doctor when codexbar is missing and an enabled model has usage configured", async () => {
    loadConfigMock.mockResolvedValue(
      makeConfig({
        default: "claude",
        definitions: {
          claude: {
            cmd: "claude",
            color: "#fff",
            usage: { codexbar: { provider: "claude", source: "oauth" } },
          },
        },
      }),
    );
    mockWhichFailure("codexbar", "not installed");

    const actual = await doctor();

    expect(actual).toBe(false);
    expect(consoleLog.output()).toContain(
      "[--] codexbar  — required for usage gating on `claude` — install codexbar, or set `models.definitions.<name>.usage` to disable gating",
    );
  });

  it("reports codexbar as ok when usage is configured and codexbar is on PATH", async () => {
    loadConfigMock.mockResolvedValue(
      makeConfig({
        default: "claude",
        definitions: {
          claude: {
            cmd: "claude",
            color: "#fff",
            usage: { codexbar: { provider: "claude", source: "oauth" } },
          },
        },
      }),
    );
    // Make every `which` succeed (no target throws), so codexbar resolves.
    mockWhichFailure("__never__", "unreachable");

    const actual = await doctor();

    expect(actual).toBe(true);
    expect(consoleLog.output()).toContain("[ok] codexbar");
  });

  it("omits the hint when both `which` and the caller produce nothing", async () => {
    loadConfigMock.mockResolvedValue(
      makeConfig({
        default: "bare",
        definitions: {
          bare: { cmd: "bare-cli", color: "#fff" },
        },
      }),
    );
    mockWhichFailure("bare-cli", "missing");

    await doctor();

    expect(consoleLog.output()).toMatch(/\[--] bare-cli\s*$/m);
  });

  it("treats the token after a leading flag as the flag's value and stops after MAX tokens", async () => {
    loadConfigMock.mockResolvedValue(
      makeConfig({
        default: "deep",
        definitions: {
          deep: { cmd: "--leading-flag a b c", color: "#fff" },
        },
      }),
    );

    await doctor();

    const checked = checkedCommands();
    expect(checked).not.toContain("a");
    expect(checked).toContain("b");
    expect(checked).toContain("c");
  });

  it("handles trailing flags whose value is missing", async () => {
    loadConfigMock.mockResolvedValue(
      makeConfig({
        default: "trailing",
        definitions: {
          trailing: { cmd: "alpha --tail", color: "#fff" },
        },
      }),
    );

    await doctor();

    const checked = checkedCommands();
    expect(checked).toContain("alpha");
  });

  it("reports the local-runner check as a warning while accepting cmux workspaces", async () => {
    detectHostMock.mockResolvedValue(
      host({ hasSafehouse: false, isMacOS: false, isLinux: true, isSafehouseSupported: false }),
    );
    loadConfigMock.mockResolvedValue(makeConfig());

    const actual = await doctor();

    expect(actual).toBe(true);
    const lines = consoleLog.output();
    expect(lines).toContain("Local runner");
    expect(lines).toContain("sdx runner requires `sbx`");
    expect(lines).toMatch(/requested=auto, resolved=cmux/);
    expect(checkedCommands()).toContain("cmux");
    expect(checkedCommands()).not.toContain("tmux");
    expect(lines).not.toContain("sbx diagnose");
  });

  it("checks tmux instead of cmux when workspaceKind resolves to tmux", async () => {
    detectHostMock.mockResolvedValue(host({ hasCmux: false, hasTmux: true }));
    loadConfigMock.mockResolvedValue({
      ...makeConfig(),
      workspaceKind: "tmux",
    });

    const actual = await doctor();

    expect(actual).toBe(true);
    const lines = consoleLog.output();
    expect(lines).toMatch(/requested=tmux, resolved=tmux/);
    expect(checkedCommands()).toContain("tmux");
    expect(checkedCommands()).not.toContain("cmux");
  });

  it("reports a workspaceKind failure when the chosen backend's binary is missing", async () => {
    detectHostMock.mockResolvedValue(host({ hasCmux: false }));
    loadConfigMock.mockResolvedValue({ ...makeConfig(), workspaceKind: "cmux" });

    const actual = await doctor();

    expect(actual).toBe(false);
    const lines = consoleLog.output();
    expect(lines).toMatch(/requested=cmux/);
    expect(lines).toContain("cmux binary is not on PATH");
  });
});
