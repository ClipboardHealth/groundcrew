import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { deleteEnvironmentVariable, setEnvironmentVariable } from "../testHelpers/env.ts";
import { probeError } from "../testHelpers/workspaceProbe.ts";
import type { RunCommandOptions } from "./commandRunner.ts";
import type { ResolvedConfig, WorkspaceKindSetting } from "./config.ts";
import type * as hostModule from "./host.ts";
import { detectHostCapabilities, type HostCapabilities } from "./host.ts";
import { log, writeError } from "./util.ts";
import type * as utilModule from "./util.ts";
import { AGENT_LOG_PIPE_COMMAND, prepareAgentLog, resolveAgentLogTarget } from "./tmuxAdapter.ts";
import {
  resolveWorkspaceKind,
  type WorkspaceCloseResult,
  type WorkspaceInterruptResult,
  workspaces,
} from "./workspaces.ts";

const logMock = vi.mocked(log);

type RunCommandMock = (
  command: string,
  arguments_: readonly string[],
  options?: RunCommandOptions,
) => string;

const runMock = vi.hoisted(() => vi.fn<RunCommandMock>());

vi.mock(import("./commandRunner.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    runCommand: runMock,
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test mock intentionally shares one recorder across sync and async command APIs.
    runCommandAsync: runMock as unknown as typeof actual.runCommandAsync,
  };
});
vi.mock(import("./util.ts"), async (importOriginal) => {
  const actual = await importOriginal<typeof utilModule>();
  return {
    ...actual,
    log: vi.fn<typeof actual.log>(),
    writeError: vi.fn<typeof actual.writeError>(),
  };
});
vi.mock(import("./host.ts"), async (importOriginal) => {
  const actual = await importOriginal<typeof hostModule>();
  return {
    ...actual,
    detectHostCapabilities: vi.fn<typeof detectHostCapabilities>(),
  };
});

const detectHostMock = vi.mocked(detectHostCapabilities);

function makeHost(overrides: Partial<HostCapabilities> = {}): HostCapabilities {
  return {
    hasSafehouse: false,
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

// Module-scope so makeConfig's default agentLogDir can fall through to it.
// Only the tmux open describe block assigns it; other describes leave it
// undefined and makeConfig falls back to `false` (capture disabled). Option B
// from the followup task — Option A would have required updating ~47 call
// sites to pass an explicit second arg, well past the documented threshold.
let agentLogSandbox: string | undefined;

function requireAgentLogSandbox(): string {
  if (agentLogSandbox === undefined) {
    throw new Error("agentLogSandbox is unset — this test must run inside the tmux open describe.");
  }
  return agentLogSandbox;
}

function makeConfig(
  workspaceKind: WorkspaceKindSetting = "auto",
  agentLogDirOverride?: string | false,
): ResolvedConfig {
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
        claude: { cmd: "claude", color: "#fff" },
      },
    },
    prompts: { initial: "x" },
    workspaceKind,
    local: { runner: "auto" },
    logging: {
      file: "/tmp/groundcrew-test.log",
      agentLogDir: agentLogDirOverride ?? agentLogSandbox ?? false,
    },
  };
}

function commonBeforeEach(): void {
  runMock.mockReturnValue("");
  detectHostMock.mockResolvedValue(makeHost());
}

function commonAfterEach(): void {
  vi.resetAllMocks();
}

function workspaceInterruptError(result: WorkspaceInterruptResult): unknown {
  if (!("error" in result)) {
    throw new Error("Expected workspace interrupt result to include error details");
  }
  return result.error;
}

function workspaceCloseError(result: WorkspaceCloseResult): unknown {
  if (result.kind !== "unavailable" || !("error" in result)) {
    throw new Error("Expected workspace close result to include error details");
  }
  return result.error;
}

describe("workspaces.open (cmux)", () => {
  beforeEach(commonBeforeEach);
  afterEach(commonAfterEach);

  it("calls cmux new-workspace with the spec's name, working directory, and command", async () => {
    runMock.mockReturnValue(JSON.stringify({ ref: "workspace:42" }));

    await workspaces.open(makeConfig(), {
      name: "TEAM-1",
      cwd: "/work/repo-a-TEAM-1",
      command: "exec claude",
    });

    expect(runMock).toHaveBeenCalledWith("cmux", [
      "--json",
      "new-workspace",
      "--name",
      "TEAM-1",
      "--cwd",
      "/work/repo-a-TEAM-1",
      "--command",
      "exec claude",
    ]);
  });

  it("calls cmux set-status with status text, color, icon when status is provided", async () => {
    runMock.mockReturnValue(JSON.stringify({ ref: "workspace:42" }));

    await workspaces.open(makeConfig(), {
      name: "TEAM-1",
      cwd: "/work/repo-a-TEAM-1",
      command: "exec claude",
      status: { text: "claude", color: "#C15F3C", icon: "sparkle" },
    });

    expect(runMock).toHaveBeenCalledWith("cmux", [
      "set-status",
      "model",
      "claude",
      "--icon",
      "sparkle",
      "--color",
      "#C15F3C",
      "--workspace",
      "workspace:42",
    ]);
  });

  it("does not call set-status when status is omitted", async () => {
    runMock.mockReturnValue(JSON.stringify({ ref: "workspace:42" }));

    await workspaces.open(makeConfig(), {
      name: "TEAM-1",
      cwd: "/work/repo-a-TEAM-1",
      command: "exec claude",
    });

    expect(runMock).not.toHaveBeenCalledWith("cmux", expect.arrayContaining(["set-status"]));
  });

  it("uses the JSON id field when ref is missing", async () => {
    runMock.mockReturnValue(JSON.stringify({ id: "abc123" }));

    await workspaces.open(makeConfig(), {
      name: "TEAM-1",
      cwd: "/cwd",
      command: "x",
      status: { text: "claude" },
    });

    expect(runMock).toHaveBeenCalledWith("cmux", expect.arrayContaining(["--workspace", "abc123"]));
  });

  it("falls back to extracting workspace:N from non-JSON cmux output", async () => {
    runMock.mockReturnValue("Created workspace:99 successfully");

    await workspaces.open(makeConfig(), {
      name: "TEAM-1",
      cwd: "/cwd",
      command: "x",
      status: { text: "claude" },
    });

    expect(runMock).toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining(["--workspace", "workspace:99"]),
    );
  });

  it("throws when cmux output yields no recognizable ref", async () => {
    runMock.mockReturnValue("garbage that has no ref");

    await expect(
      workspaces.open(makeConfig(), {
        name: "TEAM-1",
        cwd: "/cwd",
        command: "x",
      }),
    ).rejects.toThrow(/Unexpected cmux output/);
  });

  it("does not auto-close on unrecognized cmux output (avoids closing a same-named sibling)", async () => {
    runMock.mockReturnValueOnce("garbage that has no ref");

    await expect(
      workspaces.open(makeConfig(), { name: "TEAM-1", cwd: "/cwd", command: "x" }),
    ).rejects.toThrow(/Unexpected cmux output/);

    expect(runMock).not.toHaveBeenCalledWith("cmux", expect.arrayContaining(["close-workspace"]));
    expect(runMock).not.toHaveBeenCalledWith("cmux", expect.arrayContaining(["list-workspaces"]));
  });

  it("keeps the workspace when set-status fails (status painting is best-effort)", async () => {
    runMock
      .mockReturnValueOnce(JSON.stringify({ ref: "workspace:42" }))
      .mockImplementationOnce(() => {
        throw new Error("paint failed");
      })
      .mockReturnValue("");

    await expect(
      workspaces.open(makeConfig(), {
        name: "TEAM-1",
        cwd: "/cwd",
        command: "x",
        status: { text: "claude" },
      }),
    ).resolves.toStrictEqual({});

    expect(runMock).not.toHaveBeenCalledWith("cmux", expect.arrayContaining(["close-workspace"]));
    expect(logMock).toHaveBeenCalledWith(expect.stringContaining("cmux set-status failed"));
  });

  it("silently swallows set-status when the cmux build reports `unknown command`", async () => {
    runMock
      .mockReturnValueOnce(JSON.stringify({ ref: "workspace:42" }))
      .mockImplementationOnce(() => {
        throw new Error(
          'Command failed: cmux set-status model claude\nExit status: 2\nStderr:\ncmux: unknown command "set-status"\nCause: Command exited unsuccessfully',
        );
      })
      .mockReturnValue("");

    await expect(
      workspaces.open(makeConfig(), {
        name: "TEAM-1",
        cwd: "/cwd",
        command: "x",
        status: { text: "claude" },
      }),
    ).resolves.toStrictEqual({});

    expect(runMock).not.toHaveBeenCalledWith("cmux", expect.arrayContaining(["close-workspace"]));
    expect(logMock).not.toHaveBeenCalledWith(expect.stringContaining("set-status"));
  });

  it("caches the resolved adapter per config so detectHostCapabilities is not re-run", async () => {
    const config = makeConfig();
    runMock.mockReturnValue(JSON.stringify({ workspaces: [] }));

    await workspaces.probe(config);
    await workspaces.probe(config);
    await workspaces.probe(config);

    expect(detectHostMock).toHaveBeenCalledTimes(1);
  });
});

describe("workspaces.probe (cmux)", () => {
  beforeEach(commonBeforeEach);
  afterEach(commonAfterEach);

  it("returns kind=ok with the workspaces' titles as names", async () => {
    runMock.mockReturnValue(
      JSON.stringify({
        workspaces: [
          { title: "TEAM-1", id: "id-1" },
          { title: "TEAM-2", id: "id-2" },
        ],
      }),
    );

    await expect(workspaces.probe(makeConfig())).resolves.toStrictEqual({
      kind: "ok",
      names: new Set(["TEAM-1", "TEAM-2"]),
    });
    expect(runMock).toHaveBeenCalledWith("cmux", ["--json", "list-workspaces"]);
  });

  it("returns kind=ok with an empty name set when cmux reports no workspaces", async () => {
    runMock.mockReturnValue(JSON.stringify({ workspaces: [] }));
    await expect(workspaces.probe(makeConfig())).resolves.toStrictEqual({
      kind: "ok",
      names: new Set(),
    });
  });

  it("returns kind=unavailable when the cmux probe fails (adapter swallows; no error attached)", async () => {
    runMock.mockImplementation(() => {
      throw new Error("cmux down");
    });
    await expect(workspaces.probe(makeConfig())).resolves.toStrictEqual({ kind: "unavailable" });
  });

  it("rethrows cmux probe failures after the shutdown signal fires", async () => {
    const controller = new AbortController();
    controller.abort();
    runMock.mockImplementation(() => {
      throw new Error("cmux interrupted");
    });

    await expect(workspaces.probe(makeConfig(), controller.signal)).rejects.toThrow(
      "cmux interrupted",
    );
  });

  it("skips entries that lack a title", async () => {
    runMock.mockReturnValue(
      JSON.stringify({
        workspaces: [{ title: "TEAM-1", id: "id-1" }, { ref: "workspace:9" }],
      }),
    );
    await expect(workspaces.probe(makeConfig())).resolves.toStrictEqual({
      kind: "ok",
      names: new Set(["TEAM-1"]),
    });
  });

  it("skips workspaces that have a title but no usable id or ref (cmux v2 close requires a stable handle)", async () => {
    runMock.mockReturnValue(
      JSON.stringify({
        workspaces: [{ title: "TEAM-1", id: "id-1" }, { title: "TEAM-2" }],
      }),
    );
    await expect(workspaces.probe(makeConfig())).resolves.toStrictEqual({
      kind: "ok",
      names: new Set(["TEAM-1"]),
    });
  });
});

describe("workspaces.close (cmux)", () => {
  beforeEach(commonBeforeEach);
  afterEach(commonAfterEach);

  it("looks up the ref by name and calls close-workspace", async () => {
    runMock.mockReturnValue(
      JSON.stringify({ workspaces: [{ title: "TEAM-1", ref: "workspace:42" }] }),
    );

    await expect(workspaces.close(makeConfig(), "TEAM-1")).resolves.toStrictEqual({
      kind: "closed",
    });

    expect(runMock).toHaveBeenCalledWith("cmux", [
      "close-workspace",
      "--workspace",
      "workspace:42",
    ]);
  });

  it("falls back to the workspace id when ref is omitted", async () => {
    runMock.mockReturnValue(JSON.stringify({ workspaces: [{ title: "TEAM-1", id: "abc123" }] }));

    await expect(workspaces.close(makeConfig(), "TEAM-1")).resolves.toStrictEqual({
      kind: "closed",
    });

    expect(runMock).toHaveBeenCalledWith("cmux", ["close-workspace", "--workspace", "abc123"]);
  });

  it("is a no-op when no workspace exists for the name", async () => {
    runMock.mockReturnValue(JSON.stringify({ workspaces: [] }));

    await expect(workspaces.close(makeConfig(), "TEAM-1")).resolves.toStrictEqual({
      kind: "missing",
    });

    expect(runMock).not.toHaveBeenCalledWith("cmux", expect.arrayContaining(["close-workspace"]));
  });

  it("skips close-workspace entirely when the cmux list itself fails (v2 close rejects titles)", async () => {
    runMock.mockImplementationOnce(() => {
      throw new Error("cmux down");
    });

    await expect(workspaces.close(makeConfig(), "TEAM-1")).resolves.toStrictEqual({
      kind: "unavailable",
    });
    expect(runMock).not.toHaveBeenCalledWith("cmux", expect.arrayContaining(["close-workspace"]));
  });

  it("is a no-op when the workspace disappears between cmux list and close", async () => {
    runMock
      .mockReturnValueOnce(
        JSON.stringify({ workspaces: [{ title: "TEAM-1", ref: "workspace:42" }] }),
      )
      .mockImplementationOnce(() => {
        throw new Error("workspace not found");
      })
      .mockReturnValueOnce(JSON.stringify({ workspaces: [] }));

    await expect(workspaces.close(makeConfig(), "TEAM-1")).resolves.toStrictEqual({
      kind: "closed",
    });
  });

  it("rethrows cmux close failures when the workspace is still present", async () => {
    runMock
      .mockReturnValueOnce(
        JSON.stringify({ workspaces: [{ title: "TEAM-1", ref: "workspace:42" }] }),
      )
      .mockImplementationOnce(() => {
        throw new Error("permission denied");
      })
      .mockReturnValueOnce(
        JSON.stringify({ workspaces: [{ title: "TEAM-1", ref: "workspace:42" }] }),
      );

    await expect(workspaces.close(makeConfig(), "TEAM-1")).rejects.toThrow("permission denied");
  });

  it("returns unavailable when a failed close cannot be confirmed by a follow-up list", async () => {
    runMock
      .mockReturnValueOnce(
        JSON.stringify({ workspaces: [{ title: "TEAM-1", ref: "workspace:42" }] }),
      )
      .mockImplementationOnce(() => {
        throw new Error("permission denied");
      })
      .mockImplementationOnce(() => {
        throw new Error("cmux down");
      });

    const result = await workspaces.close(makeConfig(), "TEAM-1");

    expect(result.kind).toBe("unavailable");
    expect(workspaceCloseError(result)).toBeInstanceOf(Error);
  });

  it("rethrows cmux close failures after the shutdown signal fires", async () => {
    const controller = new AbortController();
    controller.abort();
    runMock
      .mockReturnValueOnce(
        JSON.stringify({ workspaces: [{ title: "TEAM-1", ref: "workspace:42" }] }),
      )
      .mockImplementationOnce(() => {
        throw new Error("close interrupted");
      });

    await expect(workspaces.close(makeConfig(), "TEAM-1", controller.signal)).rejects.toThrow(
      "close interrupted",
    );
    expect(runMock).toHaveBeenCalledTimes(2);
  });
});

describe("workspaces.open (tmux)", () => {
  beforeEach(() => {
    commonBeforeEach();
    detectHostMock.mockResolvedValue(makeHost({ hasCmux: false, hasTmux: true }));
    deleteEnvironmentVariable("GROUNDCREW_KEEP_DEAD_WINDOWS");
    agentLogSandbox = mkdtempSync(join(tmpdir(), "groundcrew-agents-it-"));
  });
  afterEach(() => {
    commonAfterEach();
    // Restore real timers in afterEach so a failed assertion mid-test can't
    // leak vi.useFakeTimers() state into the next test.
    vi.useRealTimers();
    if (agentLogSandbox !== undefined) {
      rmSync(agentLogSandbox, { recursive: true, force: true });
      agentLogSandbox = undefined;
    }
  });

  it("ensures the groundcrew session exists, then opens a window with atomic option chain (including pipe-pane)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-17T15:02:34.000Z"));

    await workspaces.open(makeConfig("tmux"), {
      name: "TEAM-1",
      cwd: "/work/repo-a-TEAM-1",
      command: "exec claude",
    });

    expect(runMock).toHaveBeenCalledWith("tmux", ["has-session", "-t", "groundcrew"]);
    expect(runMock).toHaveBeenCalledWith("tmux", [
      "new-window",
      "-d",
      "-t",
      "groundcrew",
      "-n",
      "TEAM-1",
      "-c",
      "/work/repo-a-TEAM-1",
      "exec claude",
      ";",
      "set-window-option",
      "-t",
      "groundcrew:TEAM-1",
      "remain-on-exit",
      "off",
      ";",
      "set-window-option",
      "-t",
      "groundcrew:TEAM-1",
      "allow-rename",
      "off",
      ";",
      "pipe-pane",
      "-o",
      "-t",
      "groundcrew:TEAM-1",
      `${AGENT_LOG_PIPE_COMMAND} >> '${requireAgentLogSandbox()}/TEAM-1-20260517-150234.log'`,
    ]);
  });

  it("sets remain-on-exit on instead of off when GROUNDCREW_KEEP_DEAD_WINDOWS is set", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-17T15:02:34.000Z"));
    setEnvironmentVariable("GROUNDCREW_KEEP_DEAD_WINDOWS", "1");

    await workspaces.open(makeConfig("tmux"), {
      name: "TEAM-1",
      cwd: "/work/repo-a-TEAM-1",
      command: "exec claude",
    });

    expect(runMock).toHaveBeenCalledWith("tmux", [
      "new-window",
      "-d",
      "-t",
      "groundcrew",
      "-n",
      "TEAM-1",
      "-c",
      "/work/repo-a-TEAM-1",
      "exec claude",
      ";",
      "set-window-option",
      "-t",
      "groundcrew:TEAM-1",
      "remain-on-exit",
      "on",
      ";",
      "set-window-option",
      "-t",
      "groundcrew:TEAM-1",
      "allow-rename",
      "off",
      ";",
      "pipe-pane",
      "-o",
      "-t",
      "groundcrew:TEAM-1",
      `${AGENT_LOG_PIPE_COMMAND} >> '${requireAgentLogSandbox()}/TEAM-1-20260517-150234.log'`,
    ]);
  });

  it("creates the groundcrew session with a named idle window when has-session fails", async () => {
    runMock
      .mockImplementationOnce(() => {
        throw new Error("can't find session: groundcrew");
      })
      .mockReturnValue("");

    await workspaces.open(makeConfig("tmux"), { name: "TEAM-1", cwd: "/cwd", command: "x" });

    expect(runMock).toHaveBeenCalledWith("tmux", [
      "new-session",
      "-d",
      "-s",
      "groundcrew",
      "-n",
      "_groundcrew_idle",
    ]);
  });

  it("treats duplicate tmux session creation as success when a re-probe finds the session", async () => {
    runMock
      .mockImplementationOnce(() => {
        throw new Error("can't find session: groundcrew");
      })
      .mockImplementationOnce(() => {
        throw new Error("duplicate session: groundcrew");
      })
      .mockReturnValue("");

    await workspaces.open(makeConfig("tmux"), { name: "TEAM-1", cwd: "/cwd", command: "x" });

    expect(runMock).toHaveBeenNthCalledWith(3, "tmux", ["has-session", "-t", "groundcrew"]);
    expect(runMock).toHaveBeenCalledWith("tmux", expect.arrayContaining(["new-window"]));
  });

  it("rethrows tmux session creation failures when the re-probe still fails", async () => {
    runMock
      .mockImplementationOnce(() => {
        throw new Error("can't find session: groundcrew");
      })
      .mockImplementationOnce(() => {
        throw new Error("duplicate session: groundcrew");
      })
      .mockImplementationOnce(() => {
        throw new Error("can't find session: groundcrew");
      });

    await expect(
      workspaces.open(makeConfig("tmux"), { name: "TEAM-1", cwd: "/cwd", command: "x" }),
    ).rejects.toThrow("duplicate session: groundcrew");
    expect(runMock).toHaveBeenCalledTimes(3);
  });

  it("rethrows tmux session creation failures after the shutdown signal fires", async () => {
    const controller = new AbortController();
    runMock
      .mockImplementationOnce(() => {
        throw new Error("can't find session: groundcrew");
      })
      .mockImplementationOnce(() => {
        controller.abort();
        throw new Error("create interrupted");
      });

    await expect(
      workspaces.open(
        makeConfig("tmux"),
        { name: "TEAM-1", cwd: "/cwd", command: "x" },
        controller.signal,
      ),
    ).rejects.toThrow("create interrupted");
    expect(runMock).toHaveBeenCalledTimes(2);
  });

  it("rethrows tmux session probes after the shutdown signal fires", async () => {
    const controller = new AbortController();
    controller.abort();
    runMock.mockImplementation(() => {
      throw new Error("tmux interrupted");
    });

    await expect(
      workspaces.open(
        makeConfig("tmux"),
        { name: "TEAM-1", cwd: "/cwd", command: "x" },
        controller.signal,
      ),
    ).rejects.toThrow("tmux interrupted");
    expect(runMock).not.toHaveBeenCalledWith("tmux", expect.arrayContaining(["new-session"]));
  });

  it("silently drops the status field (tmux can't paint pills)", async () => {
    await workspaces.open(makeConfig("tmux"), {
      name: "TEAM-1",
      cwd: "/cwd",
      command: "x",
      status: { text: "claude", color: "#fff", icon: "sparkle" },
    });

    expect(runMock).not.toHaveBeenCalledWith("tmux", expect.arrayContaining(["set-status"]));
  });

  it("creates the agents directory and writes a header line before invoking tmux", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-17T15:02:34.000Z"));

    await workspaces.open(makeConfig("tmux"), {
      name: "TEAM-1",
      cwd: "/work/repo-a-TEAM-1",
      command: "exec claude --prompt /tmp/p",
    });

    const logPath = join(requireAgentLogSandbox(), "TEAM-1-20260517-150234.log");
    expect(existsSync(logPath)).toBe(true);
    const header = readFileSync(logPath, "utf8");
    expect(header).toMatch(
      /^\[groundcrew\] TEAM-1 launch at \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z backend=tmux command=exec claude --prompt \/tmp\/p\n$/,
    );
  });

  it("creates and refreshes the <TICKET>.log symlink", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-17T15:02:34.000Z"));

    await workspaces.open(makeConfig("tmux"), {
      name: "TEAM-1",
      cwd: "/work/repo-a-TEAM-1",
      command: "exec claude",
    });

    const symlinkPath = join(requireAgentLogSandbox(), "TEAM-1.log");
    expect(lstatSync(symlinkPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(symlinkPath)).toBe("TEAM-1-20260517-150234.log");
  });

  it("overwrites the symlink atomically when re-launching the same ticket", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-17T15:02:34.000Z"));
    await workspaces.open(makeConfig("tmux"), {
      name: "TEAM-1",
      cwd: "/work/repo-a-TEAM-1",
      command: "exec claude one",
    });

    vi.setSystemTime(new Date("2026-05-17T15:03:00.000Z"));
    await workspaces.open(makeConfig("tmux"), {
      name: "TEAM-1",
      cwd: "/work/repo-a-TEAM-1",
      command: "exec claude two",
    });

    const sandbox = requireAgentLogSandbox();
    const firstLogPath = join(sandbox, "TEAM-1-20260517-150234.log");
    const secondLogPath = join(sandbox, "TEAM-1-20260517-150300.log");
    const symlinkPath = join(sandbox, "TEAM-1.log");
    expect(existsSync(firstLogPath)).toBe(true);
    expect(existsSync(secondLogPath)).toBe(true);
    expect(readlinkSync(symlinkPath)).toBe("TEAM-1-20260517-150300.log");
  });

  it("omits pipe-pane when logging.agentLogDir is false", async () => {
    await workspaces.open(makeConfig("tmux", false), {
      name: "TEAM-1",
      cwd: "/work/repo-a-TEAM-1",
      command: "exec claude",
    });

    expect(runMock).not.toHaveBeenCalledWith("tmux", expect.arrayContaining(["pipe-pane"]));
  });

  it("uses logging.agentLogDir override when set to a custom path", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-17T15:02:34.000Z"));
    const customDir = mkdtempSync(join(tmpdir(), "groundcrew-agents-custom-"));
    try {
      await workspaces.open(makeConfig("tmux", customDir), {
        name: "TEAM-1",
        cwd: "/work/repo-a-TEAM-1",
        command: "exec claude",
      });

      const logPath = join(customDir, "TEAM-1-20260517-150234.log");
      expect(existsSync(logPath)).toBe(true);
      expect(runMock).toHaveBeenCalledWith(
        "tmux",
        expect.arrayContaining([
          "pipe-pane",
          "-o",
          "-t",
          "groundcrew:TEAM-1",
          `${AGENT_LOG_PIPE_COMMAND} >> '${logPath}'`,
        ]),
      );
    } finally {
      // afterEach restores real timers; only the custom dir cleanup is local.
      rmSync(customDir, { recursive: true, force: true });
    }
  });

  it("proceeds without pipe-pane and warns once when mkdir fails", async () => {
    // Plant a regular file where the parent directory should be — mkdirSync
    // recursively will throw because the path component exists and is not a dir.
    const blockingFile = join(requireAgentLogSandbox(), "blocker");
    writeFileSync(blockingFile, "not a directory");
    const nestedAgentDir = join(blockingFile, "agents");

    await workspaces.open(makeConfig("tmux", nestedAgentDir), {
      name: "TEAM-1",
      cwd: "/work/repo-a-TEAM-1",
      command: "exec claude",
    });

    expect(runMock).not.toHaveBeenCalledWith("tmux", expect.arrayContaining(["pipe-pane"]));
    expect(vi.mocked(writeError)).toHaveBeenCalledTimes(1);
  });
});

describe("workspaces.probe (tmux)", () => {
  beforeEach(() => {
    commonBeforeEach();
    detectHostMock.mockResolvedValue(makeHost({ hasCmux: false, hasTmux: true }));
  });
  afterEach(commonAfterEach);

  it("returns kind=ok with live windows and filters out zombies (pane_dead != 0) and the idle sentinel", async () => {
    runMock.mockReturnValue("_groundcrew_idle\t0\nTEAM-1\t0\nTEAM-2\t1\nTEAM-3\t0\n");

    await expect(workspaces.probe(makeConfig("tmux"))).resolves.toStrictEqual({
      kind: "ok",
      names: new Set(["TEAM-1", "TEAM-3"]),
    });
    expect(runMock).toHaveBeenCalledWith("tmux", [
      "list-windows",
      "-t",
      "groundcrew",
      "-F",
      "#{window_name}\t#{pane_dead}",
    ]);
  });

  it("returns kind=ok with empty names when the groundcrew session does not exist", async () => {
    runMock.mockImplementation(() => {
      throw new Error("can't find session: groundcrew");
    });
    await expect(workspaces.probe(makeConfig("tmux"))).resolves.toStrictEqual({
      kind: "ok",
      names: new Set(),
    });
  });

  it("returns kind=ok with empty names when the tmux server is down", async () => {
    runMock.mockImplementation(() => {
      throw new Error("no server running on /tmp/tmux-501/default");
    });
    await expect(workspaces.probe(makeConfig("tmux"))).resolves.toStrictEqual({
      kind: "ok",
      names: new Set(),
    });
  });

  it("returns kind=unavailable when tmux fails for an unknown reason", async () => {
    runMock.mockImplementation(() => {
      throw new Error("permission denied or whatever");
    });
    await expect(workspaces.probe(makeConfig("tmux"))).resolves.toStrictEqual({
      kind: "unavailable",
    });
  });

  it("rethrows tmux list failures after the shutdown signal fires", async () => {
    const controller = new AbortController();
    controller.abort();
    runMock.mockImplementation(() => {
      throw new Error("tmux list interrupted");
    });

    await expect(workspaces.probe(makeConfig("tmux"), controller.signal)).rejects.toThrow(
      "tmux list interrupted",
    );
  });
});

describe("workspaces.probe (adapter resolution failure)", () => {
  beforeEach(commonBeforeEach);
  afterEach(commonAfterEach);

  // Auto resolution throws when neither cmux nor tmux is installed; the
  // probe wrapper must capture that as an `unavailable` verdict so callers
  // see the adapter failure as data rather than a thrown exception.
  it("captures a thrown adapter resolution error on the probe verdict", async () => {
    detectHostMock.mockResolvedValue(makeHost({ hasCmux: false, hasTmux: false }));

    const result = await workspaces.probe(makeConfig("auto"));

    expect(result.kind).toBe("unavailable");
    expect(probeError(result)).toBeInstanceOf(Error);
  });

  it("rethrows adapter resolution errors after the shutdown signal fires", async () => {
    const controller = new AbortController();
    controller.abort();
    detectHostMock.mockRejectedValue(new Error("host probe interrupted"));

    await expect(workspaces.probe(makeConfig("auto"), controller.signal)).rejects.toThrow(
      "host probe interrupted",
    );
  });
});

describe("workspaces.close (tmux)", () => {
  beforeEach(() => {
    commonBeforeEach();
    detectHostMock.mockResolvedValue(makeHost({ hasCmux: false, hasTmux: true }));
  });
  afterEach(commonAfterEach);

  it("calls kill-window directly without a pre-probe list", async () => {
    await expect(workspaces.close(makeConfig("tmux"), "TEAM-1")).resolves.toStrictEqual({
      kind: "closed",
    });

    expect(runMock).toHaveBeenCalledWith("tmux", ["kill-window", "-t", "groundcrew:TEAM-1"]);
    expect(runMock).not.toHaveBeenCalledWith("tmux", expect.arrayContaining(["list-windows"]));
  });

  it("is a no-op when tmux reports the window is missing", async () => {
    runMock.mockImplementation(() => {
      throw new Error("can't find window: TEAM-1");
    });

    await expect(workspaces.close(makeConfig("tmux"), "TEAM-1")).resolves.toStrictEqual({
      kind: "missing",
    });
  });

  it("is a no-op when the session does not exist", async () => {
    runMock.mockImplementation(() => {
      throw new Error("can't find session: groundcrew");
    });

    await expect(workspaces.close(makeConfig("tmux"), "TEAM-1")).resolves.toStrictEqual({
      kind: "missing",
    });
  });

  it("rethrows tmux close failures after the shutdown signal fires", async () => {
    const controller = new AbortController();
    controller.abort();
    runMock.mockImplementation(() => {
      throw new Error("close interrupted");
    });

    await expect(workspaces.close(makeConfig("tmux"), "TEAM-1", controller.signal)).rejects.toThrow(
      "close interrupted",
    );
  });

  it("propagates non-NotFound kill-window errors so callers see them (parity with cmux)", async () => {
    runMock.mockImplementation(() => {
      throw new Error("permission denied");
    });

    await expect(workspaces.close(makeConfig("tmux"), "TEAM-1")).rejects.toThrow(
      /permission denied/,
    );
  });
});

describe("workspaces.interrupt", () => {
  beforeEach(commonBeforeEach);
  afterEach(commonAfterEach);

  it("returns missing without closing when the workspace is not live", async () => {
    runMock.mockReturnValue(JSON.stringify({ workspaces: [] }));

    await expect(workspaces.interrupt(makeConfig(), "TEAM-1")).resolves.toStrictEqual({
      kind: "missing",
    });

    expect(runMock).not.toHaveBeenCalledWith("cmux", expect.arrayContaining(["close-workspace"]));
  });

  it("closes a live cmux workspace by id", async () => {
    runMock.mockReturnValue(
      JSON.stringify({ workspaces: [{ title: "TEAM-1", id: "workspace-id" }] }),
    );

    await expect(workspaces.interrupt(makeConfig(), "TEAM-1")).resolves.toStrictEqual({
      kind: "interrupted",
    });

    expect(runMock).toHaveBeenCalledWith("cmux", [
      "close-workspace",
      "--workspace",
      "workspace-id",
    ]);
  });

  it("returns unavailable when the workspace backend cannot be probed", async () => {
    runMock.mockImplementation(() => {
      throw new Error("cmux down");
    });

    await expect(workspaces.interrupt(makeConfig(), "TEAM-1")).resolves.toStrictEqual({
      kind: "unavailable",
    });
  });

  it("returns unavailable with error details when adapter resolution fails", async () => {
    detectHostMock.mockResolvedValue(makeHost({ hasCmux: false, hasTmux: false }));

    const result = await workspaces.interrupt(makeConfig("auto"), "TEAM-1");

    expect(result.kind).toBe("unavailable");
    expect(workspaceInterruptError(result)).toBeInstanceOf(Error);
  });

  it("returns unavailable without error details when the adapter cannot list workspaces", async () => {
    runMock.mockReturnValueOnce("not json");

    await expect(workspaces.interrupt(makeConfig(), "TEAM-1")).resolves.toStrictEqual({
      kind: "unavailable",
    });
  });

  it("returns unavailable when cmux cannot confirm the close after the initial probe", async () => {
    runMock
      .mockReturnValueOnce(JSON.stringify({ workspaces: [{ title: "TEAM-1", id: "id-1" }] }))
      .mockReturnValueOnce(JSON.stringify({ workspaces: [{ title: "TEAM-1", id: "id-1" }] }))
      .mockImplementationOnce(() => {
        throw new Error("permission denied");
      })
      .mockImplementationOnce(() => {
        throw new Error("cmux down");
      });

    const result = await workspaces.interrupt(makeConfig(), "TEAM-1");

    expect(result.kind).toBe("unavailable");
    expect(workspaceInterruptError(result)).toBeInstanceOf(Error);
  });

  it("returns unavailable without error details when cmux cannot list during close", async () => {
    runMock
      .mockReturnValueOnce(JSON.stringify({ workspaces: [{ title: "TEAM-1", id: "id-1" }] }))
      .mockImplementationOnce(() => {
        throw new Error("cmux down");
      });

    await expect(workspaces.interrupt(makeConfig(), "TEAM-1")).resolves.toStrictEqual({
      kind: "unavailable",
    });
  });
});

describe("workspaces.accessHint (cmux)", () => {
  beforeEach(commonBeforeEach);
  afterEach(commonAfterEach);

  it("returns undefined (cmux has no concise external hint; workspace surfaces in the cmux UI)", async () => {
    await expect(workspaces.accessHint(makeConfig(), "TEAM-1")).resolves.toBeUndefined();
  });
});

describe("workspaces.accessHint (tmux)", () => {
  beforeEach(() => {
    commonBeforeEach();
    detectHostMock.mockResolvedValue(makeHost({ hasCmux: false, hasTmux: true }));
  });
  afterEach(commonAfterEach);

  it("returns an access hint for the ticket window inside the groundcrew tmux session", async () => {
    await expect(workspaces.accessHint(makeConfig("tmux"), "TEAM-1")).resolves.toStrictEqual({
      kind: "attachCommand",
      command: "tmux attach -t groundcrew:TEAM-1",
    });
  });
});

describe(resolveWorkspaceKind, () => {
  beforeEach(commonBeforeEach);
  afterEach(commonAfterEach);

  it("returns cmux when explicitly set and cmux is on PATH", () => {
    const result = resolveWorkspaceKind({
      config: makeConfig("cmux"),
      host: makeHost({ hasCmux: true }),
    });
    expect(result.resolved).toBe("cmux");
    expect(result.requested).toBe("cmux");
  });

  it("throws when cmux is set but the binary is missing", () => {
    expect(() => {
      resolveWorkspaceKind({
        config: makeConfig("cmux"),
        host: makeHost({ hasCmux: false }),
      });
    }).toThrow(/cmux binary is not on PATH/);
  });

  it("returns cmux when explicitly set on non-macOS hosts and cmux is on PATH", () => {
    const result = resolveWorkspaceKind({
      config: makeConfig("cmux"),
      host: makeHost({ isMacOS: false, hasCmux: true }),
    });

    expect(result.resolved).toBe("cmux");
    expect(result.requested).toBe("cmux");
  });

  it("returns tmux when explicitly set and tmux is on PATH", () => {
    const result = resolveWorkspaceKind({
      config: makeConfig("tmux"),
      host: makeHost({ hasCmux: false, hasTmux: true }),
    });
    expect(result.resolved).toBe("tmux");
  });

  it("throws when tmux is set but the binary is missing", () => {
    expect(() => {
      resolveWorkspaceKind({
        config: makeConfig("tmux"),
        host: makeHost({ hasTmux: false }),
      });
    }).toThrow(/tmux binary is not on PATH/);
  });

  it("auto prefers cmux when present", () => {
    const result = resolveWorkspaceKind({
      config: makeConfig("auto"),
      host: makeHost({ isMacOS: true, hasCmux: true, hasTmux: true }),
    });
    expect(result.resolved).toBe("cmux");
    expect(result.reason).toMatch(/cmux available/);
  });

  it("auto prefers cmux on non-macOS when the binary is on PATH", () => {
    const result = resolveWorkspaceKind({
      config: makeConfig("auto"),
      host: makeHost({ isMacOS: false, hasCmux: true, hasTmux: true }),
    });
    expect(result.resolved).toBe("cmux");
    expect(result.reason).toMatch(/cmux available/);
  });

  it("auto falls back to tmux when cmux is missing", () => {
    const result = resolveWorkspaceKind({
      config: makeConfig("auto"),
      host: makeHost({ hasCmux: false, hasTmux: true }),
    });
    expect(result.resolved).toBe("tmux");
    expect(result.reason).toMatch(/falling back to tmux/);
  });

  it("auto throws when neither cmux nor tmux is on PATH", () => {
    expect(() => {
      resolveWorkspaceKind({
        config: makeConfig("auto"),
        host: makeHost({ hasCmux: false, hasTmux: false }),
      });
    }).toThrow(/neither cmux nor tmux is on PATH/);
  });
});

describe(resolveAgentLogTarget, () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns disabled when agentLogDir is false", () => {
    const config = makeConfig("auto", false);
    expect(resolveAgentLogTarget(config, "TEAM-1")).toStrictEqual({ kind: "disabled" });
  });

  it("returns active with timestamped logPath and symlink path", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-17T15:02:34.000Z"));
    const config = makeConfig("auto", "/tmp/groundcrew-agents-test");

    const target = resolveAgentLogTarget(config, "TEAM-1");

    expect(target).toStrictEqual({
      kind: "active",
      logPath: "/tmp/groundcrew-agents-test/TEAM-1-20260517-150234.log",
      latestSymlink: "/tmp/groundcrew-agents-test/TEAM-1.log",
    });
  });
});

describe(prepareAgentLog, () => {
  let sandbox: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "groundcrew-prepareAgentLog-"));
    vi.mocked(writeError).mockClear();
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
    vi.mocked(writeError).mockClear();
  });

  it("returns disabled unchanged when input is disabled", () => {
    expect(prepareAgentLog({ kind: "disabled" }, "exec claude")).toStrictEqual({
      kind: "disabled",
    });
  });

  it("creates the dir, writes a header line, and creates the symlink for an active target", () => {
    const logDir = join(sandbox, "agents");
    const logPath = join(logDir, "TEAM-1-20260517-150234.log");
    const latestSymlink = join(logDir, "TEAM-1.log");

    const result = prepareAgentLog(
      { kind: "active", logPath, latestSymlink },
      "exec claude --prompt /tmp/p",
    );

    expect(result).toStrictEqual({ kind: "active", logPath, displayPath: latestSymlink });
    expect(existsSync(logPath)).toBe(true);
    const header = readFileSync(logPath, "utf8");
    expect(header).toMatch(
      /^\[groundcrew\] TEAM-1 launch at \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z backend=tmux command=exec claude --prompt \/tmp\/p\n$/,
    );
    expect(lstatSync(latestSymlink).isSymbolicLink()).toBe(true);
    expect(readlinkSync(latestSymlink)).toBe("TEAM-1-20260517-150234.log");
  });

  it("truncates the command summary to 120 chars in the header", () => {
    const logDir = join(sandbox, "agents");
    const logPath = join(logDir, "TEAM-1-20260517-150234.log");
    const latestSymlink = join(logDir, "TEAM-1.log");
    const longCommand = "x".repeat(500);

    prepareAgentLog({ kind: "active", logPath, latestSymlink }, longCommand);

    const header = readFileSync(logPath, "utf8");
    const match = /command=(.*)\n$/.exec(header);
    expect(match).not.toBeNull();
    // oxlint-disable-next-line typescript/no-non-null-assertion -- expect above asserts match exists
    expect(match![1]).toHaveLength(120);
  });

  it("refreshes the symlink atomically when called twice", () => {
    const logDir = join(sandbox, "agents");
    const firstLogPath = join(logDir, "TEAM-1-20260517-150234.log");
    const secondLogPath = join(logDir, "TEAM-1-20260517-150300.log");
    const latestSymlink = join(logDir, "TEAM-1.log");

    prepareAgentLog({ kind: "active", logPath: firstLogPath, latestSymlink }, "exec claude one");
    prepareAgentLog({ kind: "active", logPath: secondLogPath, latestSymlink }, "exec claude two");

    expect(existsSync(firstLogPath)).toBe(true);
    expect(existsSync(secondLogPath)).toBe(true);
    expect(readlinkSync(latestSymlink)).toBe("TEAM-1-20260517-150300.log");
  });

  it("warns but keeps capture active when the symlink refresh fails", () => {
    const logDir = join(sandbox, "agents");
    const logPath = join(logDir, "TEAM-1-20260517-150234.log");
    const latestSymlink = join(logDir, "TEAM-1.log");
    // Pre-create latestSymlink as a non-empty directory; renameSync over a
    // non-empty directory fails with ENOTEMPTY, hitting the symlink catch.
    mkdirSync(logDir, { recursive: true });
    mkdirSync(latestSymlink);
    writeFileSync(join(latestSymlink, "blocker"), "x");

    const result = prepareAgentLog({ kind: "active", logPath, latestSymlink }, "exec claude");

    // Symlink refresh failed → advertise the timestamped logPath instead of
    // a broken symlink so the user gets a path that actually resolves.
    expect(result).toStrictEqual({ kind: "active", logPath, displayPath: logPath });
    expect(existsSync(logPath)).toBe(true);
    expect(vi.mocked(writeError)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(writeError).mock.calls[0]?.[0]).toMatch(/symlink/);
  });

  it("returns disabled and warns when mkdir fails", () => {
    // Plant a regular file where the parent directory should be — mkdirSync
    // recursively will throw because the path component exists and is not a dir.
    const blockingFile = join(sandbox, "agents");
    writeFileSync(blockingFile, "not a directory");
    const logPath = join(blockingFile, "TEAM-1-20260517-150234.log");
    const latestSymlink = join(blockingFile, "TEAM-1.log");

    const result = prepareAgentLog({ kind: "active", logPath, latestSymlink }, "exec claude");

    expect(result).toStrictEqual({ kind: "disabled" });
    expect(vi.mocked(writeError)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(writeError).mock.calls[0]?.[0]).toMatch(/agent log/);
  });
});
