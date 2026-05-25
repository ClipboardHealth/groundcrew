import type { RunCommandOptions } from "./commandRunner.ts";
import { ensureSandbox, sandboxExists, sandboxNameFor } from "./dockerSandbox.ts";

type RunCommandMock = (
  command: string,
  arguments_: readonly string[],
  options?: RunCommandOptions,
) => string;

const runCommandMock = vi.hoisted(() => vi.fn<RunCommandMock>());

vi.mock(import("./commandRunner.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    runCommand: runCommandMock,
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test mock intentionally shares one recorder across sync and async command APIs.
    runCommandAsync: runCommandMock as unknown as typeof actual.runCommandAsync,
  };
});

describe(sandboxNameFor, () => {
  it("composes `groundcrew-<agent>` in lowercase", () => {
    expect(sandboxNameFor({ agent: "Claude" })).toBe("groundcrew-claude");
  });

  it("normalises unsafe characters to single dashes", () => {
    expect(sandboxNameFor({ agent: "my/agent_v2!" })).toBe("groundcrew-my-agent-v2");
  });

  it("collapses runs of dashes and strips leading/trailing dashes", () => {
    expect(sandboxNameFor({ agent: "--cursor--" })).toBe("groundcrew-cursor");
  });
});

describe(sandboxExists, () => {
  beforeEach(() => {
    runCommandMock.mockReset();
  });

  it("returns true when the first column of an sbx ls row matches the name", async () => {
    runCommandMock.mockReturnValue("NAME STATUS\ngroundcrew-claude running\n");

    await expect(sandboxExists("groundcrew-claude")).resolves.toBe(true);
  });

  it("returns false when no row's first column matches", async () => {
    runCommandMock.mockReturnValue("NAME STATUS\nother-sandbox running\n");

    await expect(sandboxExists("groundcrew-claude")).resolves.toBe(false);
  });

  it("passes the AbortSignal to runCommandAsync", async () => {
    const controller = new AbortController();
    runCommandMock.mockReturnValue("");

    await sandboxExists("foo", controller.signal);

    expect(runCommandMock).toHaveBeenCalledWith("sbx", ["ls"], { signal: controller.signal });
  });
});

describe(ensureSandbox, () => {
  beforeEach(() => {
    runCommandMock.mockReset();
  });

  function mockExisting(names: readonly string[]): void {
    const header = "NAME STATUS";
    const rows = names.map((name) => `${name} running`).join("\n");
    runCommandMock.mockImplementation((command, arguments_) => {
      if (command === "sbx" && arguments_[0] === "ls") {
        return `${header}\n${rows}\n`;
      }
      return "";
    });
  }

  it("does nothing when the sandbox already exists", async () => {
    mockExisting(["groundcrew-claude"]);

    await ensureSandbox({
      sandboxName: "groundcrew-claude",
      sandbox: { agent: "claude" },
      mountPath: "/home/user/dev",
      gitDefaults: false,
    });

    expect(runCommandMock).toHaveBeenCalledTimes(1);
    expect(runCommandMock.mock.calls[0]?.[0]).toBe("sbx");
    expect(runCommandMock.mock.calls[0]?.[1]).toStrictEqual(["ls"]);
  });

  it("creates the sandbox when missing, passing the agent and mount path", async () => {
    mockExisting([]);

    await ensureSandbox({
      sandboxName: "groundcrew-claude",
      sandbox: { agent: "claude" },
      mountPath: "/home/user/dev",
      gitDefaults: false,
    });

    expect(runCommandMock).toHaveBeenCalledWith(
      "sbx",
      ["create", "--name", "groundcrew-claude", "claude", "/home/user/dev"],
      expect.any(Object),
    );
  });

  it("adds --template when the sandbox config sets one", async () => {
    mockExisting([]);

    await ensureSandbox({
      sandboxName: "groundcrew-claude",
      sandbox: { agent: "claude", template: "node-22" },
      mountPath: "/home/user/dev",
      gitDefaults: false,
    });

    expect(runCommandMock).toHaveBeenCalledWith(
      "sbx",
      [
        "create",
        "--name",
        "groundcrew-claude",
        "--template",
        "node-22",
        "claude",
        "/home/user/dev",
      ],
      expect.any(Object),
    );
  });

  it("adds one --kit flag per configured kit", async () => {
    mockExisting([]);

    await ensureSandbox({
      sandboxName: "groundcrew-claude",
      sandbox: { agent: "claude", kits: ["npm-cache", "tools"] },
      mountPath: "/home/user/dev",
      gitDefaults: false,
    });

    expect(runCommandMock).toHaveBeenCalledWith(
      "sbx",
      [
        "create",
        "--name",
        "groundcrew-claude",
        "--kit",
        "npm-cache",
        "--kit",
        "tools",
        "claude",
        "/home/user/dev",
      ],
      expect.any(Object),
    );
  });

  it("passes the AbortSignal through to both probe and create", async () => {
    const controller = new AbortController();
    mockExisting([]);

    await ensureSandbox(
      {
        sandboxName: "groundcrew-claude",
        sandbox: { agent: "claude" },
        mountPath: "/home/user/dev",
        gitDefaults: false,
      },
      controller.signal,
    );

    const { calls } = runCommandMock.mock;
    expect(calls[0]?.[2]).toMatchObject({ signal: controller.signal });
    expect(calls[1]?.[2]).toMatchObject({ signal: controller.signal });
  });

  it("treats a concurrent create as success when sbx create fails but the sandbox now exists", async () => {
    const counters = mockConcurrentCreate("groundcrew-claude");

    await expect(
      ensureSandbox({
        sandboxName: "groundcrew-claude",
        sandbox: { agent: "claude" },
        mountPath: "/home/user/dev",
        gitDefaults: false,
      }),
    ).resolves.toBeUndefined();
    expect(counters.createCalls).toBe(1);
    expect(counters.lsCalls).toBe(2);
  });

  it("rethrows the create error when the sandbox is still missing on the recheck", async () => {
    mockMissingThenFailingCreate(new Error("Error: sbx daemon unreachable"));

    await expect(
      ensureSandbox({
        sandboxName: "groundcrew-claude",
        sandbox: { agent: "claude" },
        mountPath: "/home/user/dev",
        gitDefaults: false,
      }),
    ).rejects.toThrow(/sbx daemon unreachable/);
  });

  it("applies git defaults inside an existing sandbox when gitDefaults is true", async () => {
    mockExisting(["groundcrew-claude"]);

    await ensureSandbox({
      sandboxName: "groundcrew-claude",
      sandbox: { agent: "claude" },
      mountPath: "/home/user/dev",
      gitDefaults: true,
    });

    const gitDefaultsCall = findGitDefaultsCall(runCommandMock.mock.calls);
    expect(gitDefaultsCall).toBeDefined();
    expect(gitDefaultsCall?.[1]?.[1]).toBe("groundcrew-claude");
  });

  it("applies git defaults after creating a missing sandbox", async () => {
    mockExisting([]);

    await ensureSandbox({
      sandboxName: "groundcrew-claude",
      sandbox: { agent: "claude" },
      mountPath: "/home/user/dev",
      gitDefaults: true,
    });

    const verbs = runCommandMock.mock.calls.map(([, arguments_]) => arguments_[0]);
    expect(verbs).toStrictEqual(["ls", "create", "exec"]);
  });

  it("passes the AbortSignal through to applyGitDefaults", async () => {
    const controller = new AbortController();
    mockExisting(["groundcrew-claude"]);

    await ensureSandbox(
      {
        sandboxName: "groundcrew-claude",
        sandbox: { agent: "claude" },
        mountPath: "/home/user/dev",
        gitDefaults: true,
      },
      controller.signal,
    );

    const gitDefaultsCall = findGitDefaultsCall(runCommandMock.mock.calls);
    expect(gitDefaultsCall?.[2]).toMatchObject({ signal: controller.signal });
  });

  it("skips git defaults when gitDefaults is false", async () => {
    mockExisting(["groundcrew-claude"]);

    await ensureSandbox({
      sandboxName: "groundcrew-claude",
      sandbox: { agent: "claude" },
      mountPath: "/home/user/dev",
      gitDefaults: false,
    });

    expect(findGitDefaultsCall(runCommandMock.mock.calls)).toBeUndefined();
  });

  it("skips the existence probe when alreadyExists is provided", async () => {
    mockExisting(["groundcrew-claude"]);

    await ensureSandbox({
      sandboxName: "groundcrew-claude",
      sandbox: { agent: "claude" },
      mountPath: "/home/user/dev",
      gitDefaults: false,
      alreadyExists: true,
    });

    const verbs = runCommandMock.mock.calls.map(([, arguments_]) => arguments_[0]);
    expect(verbs).not.toContain("ls");
    expect(verbs).not.toContain("create");
  });

  it("creates without probing when alreadyExists is false", async () => {
    mockExisting([]);

    await ensureSandbox({
      sandboxName: "groundcrew-claude",
      sandbox: { agent: "claude" },
      mountPath: "/home/user/dev",
      gitDefaults: false,
      alreadyExists: false,
    });

    const verbs = runCommandMock.mock.calls.map(([, arguments_]) => arguments_[0]);
    expect(verbs).toStrictEqual(["create"]);
  });
});

function findGitDefaultsCall(
  calls: readonly Parameters<RunCommandMock>[],
): Parameters<RunCommandMock> | undefined {
  return calls.find(([command, arguments_]) => {
    if (command !== "sbx" || arguments_[0] !== "exec") {
      return false;
    }
    const script = arguments_.at(4);
    return typeof script === "string" && script.includes("commit.gpgsign false");
  });
}

interface SbxCallCounters {
  readonly lsCalls: number;
  readonly createCalls: number;
}

/**
 * Simulate a concurrent creator winning the race: first `sbx ls` reports
 * missing, `sbx create` fails (already-exists race), and the post-create
 * `sbx ls` re-check reports the sandbox present. Returns a live counters
 * object so tests can assert call counts without inspecting the mock
 * directly.
 */
function mockConcurrentCreate(sandboxName: string): SbxCallCounters {
  const counters = { lsCalls: 0, createCalls: 0 };
  runCommandMock.mockImplementation((command, arguments_) => {
    const isLs = command === "sbx" && arguments_[0] === "ls";
    const isCreate = command === "sbx" && arguments_[0] === "create";
    if (isLs) {
      counters.lsCalls += 1;
      return counters.createCalls > 0 ? `NAME STATUS\n${sandboxName} running\n` : "NAME STATUS\n";
    }
    if (isCreate) {
      counters.createCalls += 1;
      throw new Error(`Error: sandbox '${sandboxName}' already exists`);
    }
    return "";
  });
  return counters;
}

/**
 * Simulate `sbx create` failing with `error` while `sbx ls` keeps reporting
 * the sandbox missing — verifies the recheck rethrows rather than swallowing
 * unrelated failures.
 */
function mockMissingThenFailingCreate(error: Error): void {
  runCommandMock.mockImplementation((command, arguments_) => {
    const isLs = command === "sbx" && arguments_[0] === "ls";
    const isCreate = command === "sbx" && arguments_[0] === "create";
    if (isLs) {
      return "NAME STATUS\n";
    }
    if (isCreate) {
      throw error;
    }
    return "";
  });
}
