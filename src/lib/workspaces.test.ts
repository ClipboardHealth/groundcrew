import { deleteEnvironmentVariable, setEnvironmentVariable } from "../testHelpers/env.ts";
import { probeError } from "../testHelpers/workspaceProbe.ts";
import type { RunCommandOptions } from "./commandRunner.ts";
import type { ResolvedConfig, WorkspaceKindSetting } from "./config.ts";
import type * as hostModule from "./host.ts";
import { detectHostCapabilities, type HostCapabilities } from "./host.ts";
import type * as utilModule from "./util.ts";
import { resolveWorkspaceKind, workspaces } from "./workspaces.ts";

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
    hasHerdr: false,
    hasTmux: false,
    isMacOS: true,
    isLinux: false,
    isSafehouseSupported: true,
    isSdxSupported: true,
    ...overrides,
  };
}

function makeConfig(workspaceKind: WorkspaceKindSetting = "auto"): ResolvedConfig {
  return {
    linear: {
      projectSlug: "x-aaaaaaaaaaaa",
      slugId: "aaaaaaaaaaaa",
      statuses: { todo: "Todo", inProgress: "In Progress", done: "Done", terminal: ["Done"] },
    },
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
    logging: { file: "/tmp/groundcrew-test.log" },
  };
}

function commonBeforeEach(): void {
  runMock.mockReturnValue("");
  detectHostMock.mockResolvedValue(makeHost());
  // Tests assume an unscoped local cmux. CMUX_WORKSPACE_ID is set in any
  // shell launched inside cmux (including the one running the test
  // suite); leaving it would make every open() probe the current
  // workspace's remote first and shift the mock call order.
  deleteEnvironmentVariable("CMUX_WORKSPACE_ID");
}

function commonAfterEach(): void {
  vi.resetAllMocks();
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
      "--working-directory",
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

  it("wraps the agent command in `ssh -t <destination>` when crew runs inside an SSH workspace", async () => {
    setEnvironmentVariable("CMUX_WORKSPACE_ID", "current-ws-id");
    runMock
      .mockReturnValueOnce(
        JSON.stringify({
          workspace: {
            remote: {
              connected: true,
              transport: "ssh",
              destination: "server.internal",
              port: 22,
              identity_file: "/home/user/.ssh/id_ed25519",
              ssh_options: ["StrictHostKeyChecking=no"],
            },
          },
        }),
      )
      .mockReturnValueOnce(
        JSON.stringify({ workspace_id: "new-ws-id", workspace_ref: "workspace:99" }),
      )
      .mockReturnValue("");

    await workspaces.open(makeConfig(), {
      name: "TEAM-1",
      cwd: "/srv/repo-a-TEAM-1",
      command: "bash '/tmp/launch.sh'",
    });

    expect(runMock).toHaveBeenCalledWith("cmux", ["--json", "current-workspace"]);
    expect(runMock).toHaveBeenCalledWith("cmux", [
      "--json",
      "new-workspace",
      "--name",
      "TEAM-1",
      "--command",
      String.raw`ssh -t -p 22 -i '/home/user/.ssh/id_ed25519' -o 'StrictHostKeyChecking=no' 'server.internal' -- 'cd '\''/srv/repo-a-TEAM-1'\'' && bash '\''/tmp/launch.sh'\'''`,
    ]);
  });

  it("omits ssh -p / -i / -o flags when the remote exposes only a destination", async () => {
    setEnvironmentVariable("CMUX_WORKSPACE_ID", "current-ws-id");
    runMock
      .mockReturnValueOnce(
        JSON.stringify({
          workspace: {
            remote: { connected: true, transport: "ssh", destination: "server.internal" },
          },
        }),
      )
      .mockReturnValueOnce(JSON.stringify({ workspace_id: "new-ws-id" }))
      .mockReturnValue("");

    await workspaces.open(makeConfig(), {
      name: "TEAM-1",
      cwd: "/srv/x",
      command: "exec claude",
    });

    expect(runMock).toHaveBeenCalledWith("cmux", [
      "--json",
      "new-workspace",
      "--name",
      "TEAM-1",
      "--command",
      String.raw`ssh -t 'server.internal' -- 'cd '\''/srv/x'\'' && exec claude'`,
    ]);
  });

  it("does not wrap or pass --working-directory when no SSH remote is detected", async () => {
    runMock.mockReturnValueOnce(JSON.stringify({ workspace_id: "new-ws-id" })).mockReturnValue("");

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
      "--working-directory",
      "/work/repo-a-TEAM-1",
      "--command",
      "exec claude",
    ]);
  });

  it("rejects malformed current-workspace output while CMUX_WORKSPACE_ID is set", async () => {
    setEnvironmentVariable("CMUX_WORKSPACE_ID", "current-ws-id");
    runMock.mockReturnValueOnce("garbage that is not JSON").mockReturnValue("");

    await expect(
      workspaces.open(makeConfig(), {
        name: "TEAM-1",
        cwd: "/srv/x",
        command: "exec claude",
      }),
    ).rejects.toThrow(/cmux current-workspace returned malformed output while CMUX_WORKSPACE_ID/);

    expect(runMock).not.toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining(["new-workspace", "--name", "TEAM-1"]),
    );
  });

  it("rejects a current-workspace probe failure while CMUX_WORKSPACE_ID is set", async () => {
    setEnvironmentVariable("CMUX_WORKSPACE_ID", "current-ws-id");
    runMock
      .mockImplementationOnce(() => {
        throw new Error("current-workspace failed");
      })
      .mockReturnValue("");

    await expect(
      workspaces.open(makeConfig(), {
        name: "TEAM-1",
        cwd: "/srv/x",
        command: "exec claude",
      }),
    ).rejects.toThrow(/cmux current-workspace probe failed while CMUX_WORKSPACE_ID/);

    expect(runMock).not.toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining(["new-workspace", "--name", "TEAM-1"]),
    );
  });

  it("rethrows current-workspace failures after the shutdown signal fires", async () => {
    setEnvironmentVariable("CMUX_WORKSPACE_ID", "current-ws-id");
    const controller = new AbortController();
    controller.abort();
    runMock.mockImplementation(() => {
      throw new Error("current-workspace interrupted");
    });

    await expect(
      workspaces.open(
        makeConfig(),
        { name: "TEAM-1", cwd: "/srv/x", command: "exec claude" },
        controller.signal,
      ),
    ).rejects.toThrow("current-workspace interrupted");
  });

  it("ignores remote without an SSH destination string", async () => {
    setEnvironmentVariable("CMUX_WORKSPACE_ID", "current-ws-id");
    runMock
      .mockReturnValueOnce(
        JSON.stringify({
          workspace: {
            remote: { connected: true, transport: "ssh", destination: null },
          },
        }),
      )
      .mockReturnValueOnce(JSON.stringify({ workspace_id: "new-ws-id" }))
      .mockReturnValue("");

    await workspaces.open(makeConfig(), {
      name: "TEAM-1",
      cwd: "/srv/x",
      command: "exec claude",
    });

    expect(runMock).toHaveBeenCalledWith("cmux", [
      "--json",
      "new-workspace",
      "--name",
      "TEAM-1",
      "--working-directory",
      "/srv/x",
      "--command",
      "exec claude",
    ]);
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
    ).resolves.toBeUndefined();

    expect(runMock).not.toHaveBeenCalledWith("cmux", expect.arrayContaining(["close-workspace"]));
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

    await workspaces.close(makeConfig(), "TEAM-1");

    expect(runMock).toHaveBeenCalledWith("cmux", [
      "close-workspace",
      "--workspace",
      "workspace:42",
    ]);
  });

  it("falls back to the workspace id when ref is omitted", async () => {
    runMock.mockReturnValue(JSON.stringify({ workspaces: [{ title: "TEAM-1", id: "abc123" }] }));

    await workspaces.close(makeConfig(), "TEAM-1");

    expect(runMock).toHaveBeenCalledWith("cmux", ["close-workspace", "--workspace", "abc123"]);
  });

  it("is a no-op when no workspace exists for the name", async () => {
    runMock.mockReturnValue(JSON.stringify({ workspaces: [] }));

    await workspaces.close(makeConfig(), "TEAM-1");

    expect(runMock).not.toHaveBeenCalledWith("cmux", expect.arrayContaining(["close-workspace"]));
  });

  it("skips close-workspace entirely when the cmux list itself fails (v2 close rejects titles)", async () => {
    runMock.mockImplementationOnce(() => {
      throw new Error("cmux down");
    });

    await expect(workspaces.close(makeConfig(), "TEAM-1")).resolves.toBeUndefined();
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

    await expect(workspaces.close(makeConfig(), "TEAM-1")).resolves.toBeUndefined();
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

  it("rethrows cmux close failures when the follow-up list is unavailable", async () => {
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

    await expect(workspaces.close(makeConfig(), "TEAM-1")).rejects.toThrow("permission denied");
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
  });
  afterEach(commonAfterEach);

  it("ensures the groundcrew session exists, then opens a window with atomic option chain", async () => {
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
    ]);
  });

  it("sets remain-on-exit on instead of off when GROUNDCREW_KEEP_DEAD_WINDOWS is set", async () => {
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
    await workspaces.close(makeConfig("tmux"), "TEAM-1");

    expect(runMock).toHaveBeenCalledWith("tmux", ["kill-window", "-t", "groundcrew:TEAM-1"]);
    expect(runMock).not.toHaveBeenCalledWith("tmux", expect.arrayContaining(["list-windows"]));
  });

  it("is a no-op when tmux reports the window is missing", async () => {
    runMock.mockImplementation(() => {
      throw new Error("can't find window: TEAM-1");
    });

    await expect(workspaces.close(makeConfig("tmux"), "TEAM-1")).resolves.toBeUndefined();
  });

  it("is a no-op when the session does not exist", async () => {
    runMock.mockImplementation(() => {
      throw new Error("can't find session: groundcrew");
    });

    await expect(workspaces.close(makeConfig("tmux"), "TEAM-1")).resolves.toBeUndefined();
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

function herdrCreateEnvelope(args: {
  workspaceId: string;
  paneId: string;
  label?: string;
}): string {
  return JSON.stringify({
    id: "cli:workspace:create",
    result: {
      type: "workspace_created",
      workspace: { workspace_id: args.workspaceId, label: args.label ?? "stub" },
      root_pane: { pane_id: args.paneId, workspace_id: args.workspaceId },
      tab: { tab_id: `${args.workspaceId}:1` },
    },
  });
}

function herdrListEnvelope(entries: { workspaceId: string; label: string }[]): string {
  return JSON.stringify({
    id: "cli:workspace:list",
    result: {
      type: "workspace_list",
      workspaces: entries.map((ws) => ({ workspace_id: ws.workspaceId, label: ws.label })),
    },
  });
}

describe("workspaces.open (herdr)", () => {
  beforeEach(() => {
    commonBeforeEach();
    detectHostMock.mockResolvedValue(makeHost({ hasCmux: false, hasHerdr: true }));
  });
  afterEach(commonAfterEach);

  it("creates the workspace, runs the command in the root pane, and reports agent state", async () => {
    runMock
      .mockReturnValueOnce(herdrCreateEnvelope({ workspaceId: "w-42", paneId: "w-42-1" }))
      .mockReturnValue("");

    await workspaces.open(makeConfig("herdr"), {
      name: "TEAM-1",
      cwd: "/work/repo-a-TEAM-1",
      command: "exec claude",
      status: { text: "claude", state: "working" },
    });

    expect(runMock).toHaveBeenNthCalledWith(1, "herdr", [
      "workspace",
      "create",
      "--cwd",
      "/work/repo-a-TEAM-1",
      "--label",
      "TEAM-1",
      "--no-focus",
    ]);
    expect(runMock).toHaveBeenNthCalledWith(2, "herdr", ["pane", "run", "w-42-1", "exec claude"]);
    expect(runMock).toHaveBeenNthCalledWith(3, "herdr", [
      "pane",
      "report-agent",
      "w-42-1",
      "--source",
      "groundcrew",
      "--agent",
      "groundcrew",
      "--state",
      "working",
      "--custom-status",
      "claude",
    ]);
  });

  it("defaults the agent state to working when WorkspaceStatus.state is omitted", async () => {
    runMock
      .mockReturnValueOnce(herdrCreateEnvelope({ workspaceId: "w-1", paneId: "w-1-1" }))
      .mockReturnValue("");

    await workspaces.open(makeConfig("herdr"), {
      name: "TEAM-1",
      cwd: "/work/repo-a-TEAM-1",
      command: "exec claude",
      status: { text: "claude" },
    });

    expect(runMock).toHaveBeenNthCalledWith(3, "herdr", [
      "pane",
      "report-agent",
      "w-1-1",
      "--source",
      "groundcrew",
      "--agent",
      "groundcrew",
      "--state",
      "working",
      "--custom-status",
      "claude",
    ]);
  });

  it("skips report-agent when no status is provided", async () => {
    runMock
      .mockReturnValueOnce(herdrCreateEnvelope({ workspaceId: "w-1", paneId: "w-1-1" }))
      .mockReturnValue("");

    await workspaces.open(makeConfig("herdr"), {
      name: "TEAM-1",
      cwd: "/work/repo-a-TEAM-1",
      command: "exec claude",
    });

    expect(runMock).toHaveBeenCalledTimes(2);
  });

  it("throws when workspace create returns an envelope without a workspace_id", async () => {
    runMock.mockReturnValueOnce(
      JSON.stringify({
        id: "cli:workspace:create",
        result: { type: "workspace_created", root_pane: { pane_id: "w-1-1" } },
      }),
    );

    await expect(
      workspaces.open(makeConfig("herdr"), {
        name: "TEAM-1",
        cwd: "/work/repo-a-TEAM-1",
        command: "exec claude",
      }),
    ).rejects.toThrow(/Unexpected herdr output/);
  });

  it("throws when workspace create returns an envelope without a root_pane", async () => {
    runMock.mockReturnValueOnce(
      JSON.stringify({
        id: "cli:workspace:create",
        result: { type: "workspace_created", workspace: { workspace_id: "w-1" } },
      }),
    );

    await expect(
      workspaces.open(makeConfig("herdr"), {
        name: "TEAM-1",
        cwd: "/work/repo-a-TEAM-1",
        command: "exec claude",
      }),
    ).rejects.toThrow(/Unexpected herdr output/);
  });

  it("throws when workspace create stdout is not parseable JSON", async () => {
    runMock.mockReturnValueOnce("not json");

    await expect(
      workspaces.open(makeConfig("herdr"), {
        name: "TEAM-1",
        cwd: "/work/repo-a-TEAM-1",
        command: "exec claude",
      }),
    ).rejects.toThrow(SyntaxError);
  });
});

describe("workspaces.probe (herdr)", () => {
  beforeEach(() => {
    commonBeforeEach();
    detectHostMock.mockResolvedValue(makeHost({ hasCmux: false, hasHerdr: true }));
  });
  afterEach(commonAfterEach);

  it("returns workspace labels as names when the list query succeeds", async () => {
    runMock.mockReturnValueOnce(
      herdrListEnvelope([
        { workspaceId: "w-1", label: "TEAM-1" },
        { workspaceId: "w-2", label: "TEAM-2" },
      ]),
    );

    await expect(workspaces.probe(makeConfig("herdr"))).resolves.toStrictEqual({
      kind: "ok",
      names: new Set(["TEAM-1", "TEAM-2"]),
    });
  });

  it("treats an envelope without a workspaces field as an empty list", async () => {
    runMock.mockReturnValueOnce(JSON.stringify({ id: "cli:workspace:list", result: {} }));

    await expect(workspaces.probe(makeConfig("herdr"))).resolves.toStrictEqual({
      kind: "ok",
      names: new Set(),
    });
  });

  it("skips entries missing a workspace_id and entries missing a label", async () => {
    runMock.mockReturnValueOnce(
      JSON.stringify({
        id: "cli:workspace:list",
        result: {
          workspaces: [
            { workspace_id: "", label: "ignored" },
            { workspace_id: "w-2", label: "" },
            { workspace_id: "w-3", label: "TEAM-3" },
          ],
        },
      }),
    );

    await expect(workspaces.probe(makeConfig("herdr"))).resolves.toStrictEqual({
      kind: "ok",
      names: new Set(["TEAM-3"]),
    });
  });

  it("returns unavailable when the list command fails", async () => {
    runMock.mockImplementationOnce(() => {
      throw new Error("herdr socket unavailable");
    });

    await expect(workspaces.probe(makeConfig("herdr"))).resolves.toStrictEqual({
      kind: "unavailable",
    });
  });

  it("propagates an aborted signal instead of swallowing it", async () => {
    const controller = new AbortController();
    controller.abort();
    runMock.mockImplementationOnce(() => {
      throw new Error("interrupted");
    });

    await expect(workspaces.probe(makeConfig("herdr"), controller.signal)).rejects.toThrow(
      "interrupted",
    );
  });
});

describe("workspaces.close (herdr)", () => {
  beforeEach(() => {
    commonBeforeEach();
    detectHostMock.mockResolvedValue(makeHost({ hasCmux: false, hasHerdr: true }));
  });
  afterEach(commonAfterEach);

  it("closes the workspace whose label matches the ticket name", async () => {
    runMock
      .mockReturnValueOnce(
        herdrListEnvelope([
          { workspaceId: "w-1", label: "TEAM-1" },
          { workspaceId: "w-2", label: "TEAM-2" },
        ]),
      )
      .mockReturnValue("");

    await workspaces.close(makeConfig("herdr"), "TEAM-2");

    expect(runMock).toHaveBeenLastCalledWith("herdr", ["workspace", "close", "w-2"]);
  });

  it("is a no-op when no workspace matches the requested name", async () => {
    runMock.mockReturnValueOnce(herdrListEnvelope([{ workspaceId: "w-1", label: "OTHER" }]));

    await workspaces.close(makeConfig("herdr"), "TEAM-1");

    expect(runMock).toHaveBeenCalledTimes(1);
  });

  it("bails out silently when the list probe fails so we don't shell a wrong id", async () => {
    runMock.mockImplementationOnce(() => {
      throw new Error("herdr socket unavailable");
    });

    await workspaces.close(makeConfig("herdr"), "TEAM-1");

    expect(runMock).toHaveBeenCalledTimes(1);
  });
});

describe("workspaces.accessHint (herdr)", () => {
  beforeEach(() => {
    commonBeforeEach();
    detectHostMock.mockResolvedValue(makeHost({ hasCmux: false, hasHerdr: true }));
  });
  afterEach(commonAfterEach);

  it("returns undefined; herdr has no concise shell command to attach to a workspace", async () => {
    await expect(workspaces.accessHint(makeConfig("herdr"), "TEAM-1")).resolves.toBeUndefined();
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

  it("auto throws when no workspace backend is on PATH", () => {
    expect(() => {
      resolveWorkspaceKind({
        config: makeConfig("auto"),
        host: makeHost({ hasCmux: false, hasHerdr: false, hasTmux: false }),
      });
    }).toThrow(/none of \[cmux, herdr, tmux\] are on PATH/);
  });

  it("auto prefers herdr when cmux is missing and herdr is on PATH", () => {
    const result = resolveWorkspaceKind({
      config: makeConfig("auto"),
      host: makeHost({ hasCmux: false, hasHerdr: true, hasTmux: true }),
    });
    expect(result.resolved).toBe("herdr");
    expect(result.reason).toMatch(/falling back to herdr/);
  });

  it("returns herdr when explicitly set and herdr is on PATH", () => {
    const result = resolveWorkspaceKind({
      config: makeConfig("herdr"),
      host: makeHost({ hasCmux: false, hasHerdr: true }),
    });
    expect(result.resolved).toBe("herdr");
    expect(result.requested).toBe("herdr");
  });

  it("throws when herdr is set but the binary is missing", () => {
    expect(() => {
      resolveWorkspaceKind({
        config: makeConfig("herdr"),
        host: makeHost({ hasHerdr: false }),
      });
    }).toThrow(/herdr binary is not on PATH/);
  });
});
