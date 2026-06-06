import { existsSync, statSync } from "node:fs";

import { type Board, createBoard } from "../lib/board.ts";
import { buildSources, type sourcesFromConfig } from "../lib/buildSources.ts";
import type { RunCommandOptions } from "../lib/commandRunner.ts";
import {
  type ConfigSource,
  type LoadedConfig,
  loadConfigWithSource,
  type ResolvedConfig,
} from "../lib/config.ts";
import { detectHostCapabilities, type HostCapabilities } from "../lib/host.ts";
import type { TicketSource } from "../lib/ticketSource.ts";
import { captureConsoleLog, type ConsoleCapture } from "../testHelpers/consoleCapture.ts";
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
  return {
    ...actual,
    loadConfigWithSource: vi.fn<typeof loadConfigWithSource>(),
  };
});
vi.mock(import("../lib/host.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, detectHostCapabilities: vi.fn<typeof detectHostCapabilities>() };
});
// Full replacements (no importOriginal): pulling in the real buildSources/board
// would load the adapter registry, which scans the adapters directory and
// imports each adapter — dragging the real config module into the graph and
// defeating the config.ts mock when this suite runs alongside others.
vi.mock(import("../lib/buildSources.ts"), () => ({
  buildSources: vi.fn<typeof buildSources>(),
  sourcesFromConfig: vi.fn<typeof sourcesFromConfig>(() => []),
}));
vi.mock(import("../lib/board.ts"), () => ({
  createBoard: vi.fn<typeof createBoard>(),
}));
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
const buildSourcesMock = vi.mocked(buildSources);
const createBoardMock = vi.mocked(createBoard);
const loadConfigWithSourceMock = vi.mocked(loadConfigWithSource);
const detectHostMock = vi.mocked(detectHostCapabilities);
const boardVerifyMock = vi.fn<Board["verify"]>();
const DEFAULT_CONFIG_SOURCE: ConfigSource = { kind: "project", filepath: "/work/crew.config.ts" };

/**
 * A minimal Board whose `verify()` is the controllable mock. The other
 * Board methods are unused by the source-probe check, so they're stubbed.
 */
function stubBoard(): Board {
  return {
    verify: boardVerifyMock,
    fetch: vi.fn<Board["fetch"]>(),
    resolveOne: vi.fn<Board["resolveOne"]>(),
    markInProgress: vi.fn<Board["markInProgress"]>(),
    markInReview: vi.fn<Board["markInReview"]>(),
  };
}

function stubSource(name: string): TicketSource {
  return {
    name,
    verify: vi.fn<TicketSource["verify"]>(),
    fetch: vi.fn<TicketSource["fetch"]>(),
    resolveOne: vi.fn<TicketSource["resolveOne"]>(),
    markInProgress: vi.fn<TicketSource["markInProgress"]>(),
    markInReview: vi.fn<TicketSource["markInReview"]>(),
  };
}

function makeConfig(overrides: Partial<ResolvedConfig["models"]> = {}): ResolvedConfig {
  return {
    sources: [],
    defaults: { hooks: {} },
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

function makeLoadedConfig(
  config: ResolvedConfig,
  source: ConfigSource = DEFAULT_CONFIG_SOURCE,
): LoadedConfig {
  return {
    config,
    source,
  };
}

const loadConfigMock = {
  mockResolvedValue(config: ResolvedConfig): void {
    loadConfigWithSourceMock.mockResolvedValue(makeLoadedConfig(config));
  },
  mockRejectedValue(error: unknown): void {
    loadConfigWithSourceMock.mockRejectedValue(error);
  },
};

function host(overrides: Partial<HostCapabilities> = {}): HostCapabilities {
  return {
    hasSafehouse: true,
    hasSbx: false,
    hasCmux: true,
    hasTmux: false,
    hasBubblewrap: false,
    hasSocat: false,
    hasRipgrep: false,
    isMacOS: true,
    isLinux: false,
    isSafehouseSupported: true,
    isSrtSupported: true,
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

  beforeEach(() => {
    consoleLog = captureConsoleLog();
    existsMock.mockReturnValue(true);
    statMock.mockReturnValue(statsWithDirectoryValue(true));
    detectHostMock.mockResolvedValue(host());
    buildSourcesMock.mockResolvedValue([stubSource("linear")]);
    createBoardMock.mockReturnValue(stubBoard());
    boardVerifyMock.mockResolvedValue();
    runCommandMock.mockImplementation((_cmd, arguments_) => {
      const target = firstArgument(arguments_);
      return `/usr/bin/${target}\n`;
    });
  });

  afterEach(() => {
    consoleLog.restore();
    vi.resetAllMocks();
  });

  it("renders the config source with the load verdict", async () => {
    loadConfigWithSourceMock.mockResolvedValue(
      makeLoadedConfig(makeConfig(), { kind: "env", filepath: "/work/crew.config.ts" }),
    );

    const actual = await doctor();

    expect(actual).toBe(true);
    const output = consoleLog.output();
    expect(output).toContain("[ok] config loaded — /work/crew.config.ts (GROUNDCREW_CONFIG)");
  });

  it("returns false when config loading fails", async () => {
    loadConfigMock.mockRejectedValue(new Error("GROUNDCREW_CONFIG=/missing.ts not found"));

    const actual = await doctor();

    expect(actual).toBe(false);
    expect(consoleLog.output()).toContain("config: GROUNDCREW_CONFIG=/missing.ts not found");
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
    expect(buildSourcesMock).toHaveBeenCalledTimes(1);
    expect(boardVerifyMock).toHaveBeenCalledTimes(1);
    const output = consoleLog.output();
    expect(output).toContain("[ok] source probe");
    expect(output).toContain("1 source(s) verified");
    expect(output).toContain("All required checks passed");
  });

  it("reports a source probe failure when board verification throws", async () => {
    loadConfigMock.mockResolvedValue(makeConfig());
    boardVerifyMock.mockRejectedValue(new Error("viewer lookup failed"));

    const actual = await doctor();

    expect(actual).toBe(false);
    const output = consoleLog.output();
    expect(output).toContain("[--] source probe");
    expect(output).toContain("viewer lookup failed");
  });

  it("returns false when a required CLI tool is missing", async () => {
    loadConfigMock.mockResolvedValue(makeConfig());
    mockWhichFailure("git", "not found");

    const actual = await doctor();

    expect(actual).toBe(false);
    expect(consoleLog.output()).toContain("[--] git");
  });

  it("explains how to stop probing a missing built-in model CLI", async () => {
    loadConfigMock.mockResolvedValue(
      makeConfig({
        default: "claude",
        definitions: {
          claude: { cmd: "claude", color: "#fff" },
          codex: { cmd: "codex --dangerously-bypass-approvals-and-sandbox", color: "#3267e3" },
        },
      }),
    );
    mockWhichFailure("codex", "not installed");

    const actual = await doctor();

    expect(actual).toBe(false);
    expect(consoleLog.output()).toContain(
      "[--] codex  — install codex or remove `models.definitions.codex` from crew.config.ts",
    );
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

  it("reports a failing worktreeDir check when worktreeDir is configured but missing", async () => {
    loadConfigMock.mockResolvedValue({
      ...makeConfig(),
      workspace: { projectDir: "/work", worktreeDir: "/wt", knownRepositories: ["repo-a"] },
    });
    mockMissingPath("/wt");

    const actual = await doctor();

    expect(actual).toBe(false);
    expect(consoleLog.output()).toContain("workspace.worktreeDir");
    expect(consoleLog.output()).toContain('mkdir -p "/wt"');
  });

  it("emits no separate worktreeDir check when worktreeDir is unset", async () => {
    loadConfigMock.mockResolvedValue(makeConfig());

    await doctor();

    expect(consoleLog.output()).not.toContain("workspace.worktreeDir");
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

  it("does not probe a built-in model that is not enabled", async () => {
    // The default makeConfig fixture has only `claude` in `definitions`.
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

  it("reports the srt runner as ready on macOS for an explicit local.runner='srt'", async () => {
    detectHostMock.mockResolvedValue(host());
    loadConfigMock.mockResolvedValue({ ...makeConfig(), local: { runner: "srt" } });

    const actual = await doctor();

    expect(actual).toBe(true);
    expect(consoleLog.output()).toContain("requested: srt → resolved: srt");
    expect(consoleLog.output()).toContain("local runner (srt)");
    expect(consoleLog.output()).toContain("research preview");
  });

  it("reports the srt runner as missing Linux deps when bubblewrap/socat/rg are absent", async () => {
    detectHostMock.mockResolvedValue(
      host({
        hasSafehouse: false,
        isMacOS: false,
        isLinux: true,
        isSafehouseSupported: false,
        hasBubblewrap: false,
        hasSocat: false,
        hasRipgrep: false,
      }),
    );
    loadConfigMock.mockResolvedValue({ ...makeConfig(), local: { runner: "srt" } });

    const actual = await doctor();

    expect(actual).toBe(true);
    expect(consoleLog.output()).toContain("local runner (srt)");
    expect(consoleLog.output()).toContain(
      "srt runner on Linux requires bubblewrap, socat, ripgrep (rg)",
    );
  });

  it("reports the srt runner as ready on Linux when bubblewrap/socat/rg are present", async () => {
    detectHostMock.mockResolvedValue(
      host({
        hasSafehouse: false,
        isMacOS: false,
        isLinux: true,
        isSafehouseSupported: false,
        hasBubblewrap: true,
        hasSocat: true,
        hasRipgrep: true,
      }),
    );
    loadConfigMock.mockResolvedValue({ ...makeConfig(), local: { runner: "srt" } });

    const actual = await doctor();

    expect(actual).toBe(true);
    expect(consoleLog.output()).toContain("local runner (srt)");
    expect(consoleLog.output()).not.toContain("srt runner on Linux requires");
  });

  it("reports the srt runner as unsupported on a non-macOS/Linux platform", async () => {
    detectHostMock.mockResolvedValue(
      host({
        isMacOS: false,
        isLinux: false,
        isSafehouseSupported: false,
        isSrtSupported: false,
        isSdxSupported: false,
      }),
    );
    loadConfigMock.mockResolvedValue({ ...makeConfig(), local: { runner: "srt" } });

    const actual = await doctor();

    expect(actual).toBe(true);
    expect(consoleLog.output()).toContain("srt runner requires macOS or Linux/WSL");
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

  it("does not use shipped-default disable guidance for custom model names", async () => {
    loadConfigMock.mockResolvedValue(
      makeConfig({
        default: "cursor",
        definitions: {
          cursor: { cmd: "cursor", color: "#fff" },
        },
      }),
    );
    mockWhichFailure("cursor", "missing");

    await doctor();

    expect(consoleLog.output()).toMatch(/\[--] cursor\s*$/m);
  });

  it("keeps the first useful hint when multiple models share a command token", async () => {
    loadConfigMock.mockResolvedValue(
      makeConfig({
        default: "claude",
        definitions: {
          claude: { cmd: "claude", color: "#fff" },
          alias: { cmd: "claude", color: "#fff" },
        },
      }),
    );
    mockWhichFailure("claude", "missing");

    await doctor();

    expect(consoleLog.output()).toContain(
      "[--] claude  — install claude or remove `models.definitions.claude` from crew.config.ts",
    );
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
