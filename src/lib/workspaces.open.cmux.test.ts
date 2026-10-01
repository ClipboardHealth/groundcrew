import { makeCmuxConfig } from "../testHelpers/cmuxConfig.ts";
import { makeLocalConfig } from "../testHelpers/localConfig.ts";
import type { RunCommandOptions } from "./commandRunner.ts";
import type { ResolvedConfig, WorkspaceKindSetting } from "./config.ts";
import type * as hostModule from "./host.ts";
import { detectHostCapabilities, type HostCapabilities } from "./host.ts";
import { debug, log } from "./util.ts";
import type * as utilModule from "./util.ts";
import { workspaces } from "./workspaces.ts";

const debugMock = vi.mocked(debug);
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
    runCommandAsync: runMock as unknown as typeof actual.runCommandAsync,
  };
});
vi.mock(import("./util.ts"), async (importOriginal) => {
  const actual = await importOriginal<typeof utilModule>();
  return {
    ...actual,
    log: vi.fn<typeof actual.log>(),
    debug: vi.fn<typeof actual.debug>(),
    logEvent: vi.fn<typeof actual.logEvent>(),
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
    hasZellij: false,
    isMacOS: true,
    isLinux: false,
    isSafehouseSupported: true,
    isSdxSupported: true,
    ...overrides,
  };
}

function makeConfig(workspaceKind: WorkspaceKindSetting = "auto"): ResolvedConfig {
  return {
    sources: [],
    defaults: { hooks: {} },
    git: { remote: "origin", defaultBranch: "main" },
    workspace: {
      projectDir: "/work",
      knownRepositories: ["repo-a"],
      repositories: [{ name: "repo-a" }],
    },
    orchestrator: {
      maximumInProgress: 4,
      pollIntervalMilliseconds: 1000,
      sessionLimitPercentage: 85,
    },
    agents: {
      default: "claude",
      definitions: {
        claude: { cmd: "claude", color: "#fff" },
      },
    },
    prompts: { initial: "x" },
    workspaceKind,
    local: makeLocalConfig(),
    cmux: makeCmuxConfig(),
    logging: { file: "/tmp/groundcrew-test.log" },
  };
}

function commonBeforeEach(): void {
  runMock.mockReturnValue("");
  detectHostMock.mockResolvedValue(makeHost());
}

function commonAfterEach(): void {
  vi.resetAllMocks();
}

// Mirrors the error `runCommandAsync` rejects with on a non-zero exit: the
// normalized message embeds the captured stdout under a `Stdout:` section,
// which is what the adapter parses the leaked workspace id back out of.
function cmuxNewWorkspaceFailure(stdout: string): Error {
  return new Error(
    `Command failed: cmux --json new-workspace\nExit status: 1\nStdout:\n${stdout}\nCause: Command exited unsuccessfully`,
  );
}

// Signature-agnostic: matches a close-workspace invocation regardless of how
// many arguments (e.g. a trailing signal) accompany it.
function closeWorkspaceWasCalled(): boolean {
  return runMock.mock.calls.some(
    ([command, arguments_]) =>
      command === "cmux" && Array.isArray(arguments_) && arguments_.includes("close-workspace"),
  );
}

describe("workspaces.open (cmux)", () => {
  beforeEach(commonBeforeEach);
  afterEach(commonAfterEach);

  it("uses displayName for --name and keeps groundcrew: marker in --description", async () => {
    runMock.mockReturnValue(JSON.stringify({ ref: "workspace:42" }));

    await workspaces.open(makeConfig(), {
      name: "TEAM-1",
      displayName: "Fix the login bug",
      cwd: "/work/repo-a-TEAM-1",
      command: "exec claude",
    });

    expect(runMock).toHaveBeenCalledWith("cmux", [
      "--json",
      "new-workspace",
      "--name",
      "Fix the login bug",
      "--cwd",
      "/work/repo-a-TEAM-1",
      "--command",
      "exec claude",
      "--description",
      "groundcrew:TEAM-1",
    ]);
  });

  it("falls back to name for --name when displayName is absent", async () => {
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
      "--description",
      "groundcrew:TEAM-1",
    ]);
  });

  it("links the task metadata to the exact source URL when provided", async () => {
    runMock.mockReturnValue(JSON.stringify({ ref: "workspace:42" }));

    await workspaces.open(makeConfig(), {
      name: "TEAM-1",
      url: "https://linear.app/example/issue/TEAM-1/source-slug",
      cwd: "/work/repo-a-TEAM-1",
      command: "exec claude",
    });

    expect(runMock).toHaveBeenCalledWith("cmux", [
      "set-status",
      "task",
      "[Linear ↗](https://linear.app/example/issue/TEAM-1/source-slug)",
      "--format",
      "markdown",
      "--workspace",
      "workspace:42",
    ]);
  });

  it.each([
    {
      character: "closing parenthesis",
      url: "https://linear.app/example/issue/TEAM-1/source)-slug",
      expected: "[Linear ↗](https://linear.app/example/issue/TEAM-1/source\\)-slug)",
    },
    {
      character: "backslash",
      url: "https://linear.app/example/issue/TEAM-1/source\\slug",
      expected: "[Linear ↗](https://linear.app/example/issue/TEAM-1/source\\\\slug)",
    },
    {
      character: "line break",
      url: "https://linear.app/example/issue/TEAM-1/source\nslug",
      expected: "[Linear ↗](https://linear.app/example/issue/TEAM-1/source%0Aslug)",
    },
  ])("escapes a $character in the task URL Markdown destination", async ({ url, expected }) => {
    runMock.mockReturnValue(JSON.stringify({ ref: "workspace:42" }));

    await workspaces.open(makeConfig(), {
      name: "TEAM-1",
      url,
      cwd: "/work/repo-a-TEAM-1",
      command: "exec claude",
    });

    expect(runMock).toHaveBeenCalledWith("cmux", [
      "set-status",
      "task",
      expected,
      "--format",
      "markdown",
      "--workspace",
      "workspace:42",
    ]);
  });

  it("uses a source-neutral label for non-Linear task URLs", async () => {
    runMock.mockReturnValue(JSON.stringify({ ref: "workspace:42" }));

    await workspaces.open(makeConfig(), {
      name: "ENG-1",
      url: "https://acme.atlassian.net/browse/ENG-1",
      cwd: "/work/repo-a-ENG-1",
      command: "exec claude",
    });

    expect(runMock).toHaveBeenCalledWith("cmux", [
      "set-status",
      "task",
      "[Issue ↗](https://acme.atlassian.net/browse/ENG-1)",
      "--format",
      "markdown",
      "--workspace",
      "workspace:42",
    ]);
  });

  it("uses a source-neutral label when a source provides a non-standard URL", async () => {
    runMock.mockReturnValue(JSON.stringify({ ref: "workspace:42" }));

    await workspaces.open(makeConfig(), {
      name: "CUSTOM-1",
      url: "open-custom-issue",
      cwd: "/work/repo-a-CUSTOM-1",
      command: "exec claude",
    });

    expect(runMock).toHaveBeenCalledWith("cmux", [
      "set-status",
      "task",
      "[Issue ↗](open-custom-issue)",
      "--format",
      "markdown",
      "--workspace",
      "workspace:42",
    ]);
  });

  it("does not add task metadata when the source URL is absent", async () => {
    runMock.mockReturnValue(JSON.stringify({ ref: "workspace:42" }));

    await workspaces.open(makeConfig(), {
      name: "TEAM-1",
      cwd: "/work/repo-a-TEAM-1",
      command: "exec claude",
    });

    expect(runMock).not.toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining(["set-status", "task"]),
    );
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
      "agent",
      "claude",
      "--icon",
      "sparkle",
      "--color",
      "#C15F3C",
      "--workspace",
      "workspace:42",
    ]);
  });

  it("does not call set-status for agent/task status when both are omitted", async () => {
    runMock.mockReturnValue(JSON.stringify({ ref: "workspace:42" }));

    await workspaces.open(makeConfig(), {
      name: "TEAM-1",
      cwd: "/work/repo-a-TEAM-1",
      command: "exec claude",
    });

    expect(runMock).not.toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining(["set-status", "agent"]),
    );
    expect(runMock).not.toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining(["set-status", "task"]),
    );
  });

  it("writes crew_ticket from the task id on every open, even when status and url are both omitted", async () => {
    runMock.mockReturnValue(JSON.stringify({ ref: "workspace:42" }));

    await workspaces.open(makeConfig(), {
      name: "TEAM-1",
      cwd: "/work/repo-a-TEAM-1",
      command: "exec claude",
    });

    expect(runMock).toHaveBeenCalledWith("cmux", [
      "set-status",
      "crew_ticket",
      "TEAM-1",
      "--priority",
      "-11",
      "--workspace",
      "workspace:42",
    ]);
  });

  it("keeps the workspace when the crew_ticket write fails (best-effort, like other sidebar painting)", async () => {
    runMock
      .mockReturnValueOnce(JSON.stringify({ ref: "workspace:42" }))
      .mockImplementationOnce(() => {
        throw new Error("ticket write failed");
      });

    await expect(
      workspaces.open(makeConfig(), {
        name: "TEAM-1",
        cwd: "/work/repo-a-TEAM-1",
        command: "exec claude",
      }),
    ).resolves.toBeUndefined();

    expect(runMock).not.toHaveBeenCalledWith("cmux", expect.arrayContaining(["close-workspace"]));
    expect(debugMock).toHaveBeenCalledWith(
      expect.stringContaining("cmux crew_ticket write failed"),
    );
  });

  it("silently swallows a crew_ticket write when the cmux build reports `unknown command`", async () => {
    runMock
      .mockReturnValueOnce(JSON.stringify({ ref: "workspace:42" }))
      .mockImplementationOnce(() => {
        throw new Error(
          'Command failed: cmux set-status crew_ticket TEAM-1\nExit status: 2\nStderr:\ncmux: unknown command "set-status"\nCause: Command exited unsuccessfully',
        );
      });

    await expect(
      workspaces.open(makeConfig(), {
        name: "TEAM-1",
        cwd: "/work/repo-a-TEAM-1",
        command: "exec claude",
      }),
    ).resolves.toBeUndefined();

    expect(runMock).not.toHaveBeenCalledWith("cmux", expect.arrayContaining(["close-workspace"]));
    expect(debugMock).not.toHaveBeenCalledWith(expect.stringContaining("crew_ticket"));
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
    expect(runMock).not.toHaveBeenCalledWith("cmux", expect.arrayContaining(["workspace", "list"]));
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
    expect(debugMock).toHaveBeenCalledWith(expect.stringContaining("cmux set-status failed"));
  });

  it("silently swallows set-status when the cmux build reports `unknown command`", async () => {
    runMock
      .mockReturnValueOnce(JSON.stringify({ ref: "workspace:42" }))
      .mockImplementationOnce(() => {
        throw new Error(
          'Command failed: cmux set-status agent claude\nExit status: 2\nStderr:\ncmux: unknown command "set-status"\nCause: Command exited unsuccessfully',
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
    ).resolves.toBeUndefined();

    expect(runMock).not.toHaveBeenCalledWith("cmux", expect.arrayContaining(["close-workspace"]));
    expect(debugMock).not.toHaveBeenCalledWith(expect.stringContaining("set-status"));
  });

  it("closes the leaked workspace by id when new-workspace exits non-zero but emitted an id, without re-enumerating", async () => {
    // new-workspace fails carrying an id; the follow-up close-workspace succeeds
    // (the default ""). A re-enumeration via workspace list is never attempted,
    // so a concurrent list failure can't strand the orphan.
    runMock.mockImplementationOnce(() => {
      throw cmuxNewWorkspaceFailure(JSON.stringify({ workspace_id: "leaked-id" }));
    });

    await expect(
      workspaces.open(makeConfig(), { name: "TEAM-1", cwd: "/cwd", command: "x" }),
    ).rejects.toThrow(/Command failed: cmux/);

    expect(runMock).toHaveBeenCalledWith("cmux", ["close-workspace", "--workspace", "leaked-id"]);
    expect(runMock).not.toHaveBeenCalledWith("cmux", expect.arrayContaining(["workspace", "list"]));
  });

  it("closes the leaked workspace by the workspace:N ref parsed from a non-JSON failure", async () => {
    runMock.mockImplementationOnce(() => {
      throw cmuxNewWorkspaceFailure("Created workspace:99 then failed");
    });

    await expect(
      workspaces.open(makeConfig(), { name: "TEAM-1", cwd: "/cwd", command: "x" }),
    ).rejects.toThrow(/Command failed: cmux/);

    expect(runMock).toHaveBeenCalledWith("cmux", [
      "close-workspace",
      "--workspace",
      "workspace:99",
    ]);
  });

  it("rethrows without attempting a close when the failed new-workspace stdout carries no id", async () => {
    runMock.mockImplementationOnce(() => {
      throw cmuxNewWorkspaceFailure("no recognizable id here");
    });

    await expect(
      workspaces.open(makeConfig(), { name: "TEAM-1", cwd: "/cwd", command: "x" }),
    ).rejects.toThrow(/Command failed: cmux/);

    expect(closeWorkspaceWasCalled()).toBe(false);
  });

  it("does not let a stray workspace id in stderr trigger a close", async () => {
    // The real workspace id lives in stdout; an unrelated `workspace:7` in
    // stderr must not be parsed as the leaked workspace.
    runMock.mockImplementationOnce(() => {
      throw new Error(
        "Command failed: cmux --json new-workspace\nExit status: 1\nStderr:\nconflict with workspace:7\nCause: Command exited unsuccessfully",
      );
    });

    await expect(
      workspaces.open(makeConfig(), { name: "TEAM-1", cwd: "/cwd", command: "x" }),
    ).rejects.toThrow(/Command failed: cmux/);

    expect(closeWorkspaceWasCalled()).toBe(false);
  });

  it("does not fight an already-aborted signal by trying to close the leaked workspace", async () => {
    const controller = new AbortController();
    controller.abort();
    runMock.mockImplementationOnce(() => {
      throw cmuxNewWorkspaceFailure(JSON.stringify({ workspace_id: "leaked-id" }));
    });

    await expect(
      workspaces.open(
        makeConfig(),
        { name: "TEAM-1", cwd: "/cwd", command: "x" },
        controller.signal,
      ),
    ).rejects.toThrow(/Command failed: cmux/);

    expect(closeWorkspaceWasCalled()).toBe(false);
  });

  it("logs a manual-close hint when closing the leaked workspace itself fails", async () => {
    runMock
      .mockImplementationOnce(() => {
        throw cmuxNewWorkspaceFailure(JSON.stringify({ workspace_id: "leaked-id" }));
      })
      .mockImplementationOnce(() => {
        throw new Error("close refused");
      });

    await expect(
      workspaces.open(makeConfig(), { name: "TEAM-1", cwd: "/cwd", command: "x" }),
    ).rejects.toThrow(/Command failed: cmux/);

    const actual = logMock.mock.calls.map(([message]) => message).join("\n");

    expect(actual).toContain("Run 'cmux close-workspace --workspace leaked-id' by hand.");
    expect(actual).not.toContain("`");
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
