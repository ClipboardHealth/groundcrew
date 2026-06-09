import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type * as nodeFs from "node:fs";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { ensureClearance } from "@clipboard-health/clearance";
import type { RunCommandOptions } from "../lib/commandRunner.ts";
import { loadConfig, type ResolvedConfig } from "../lib/config.ts";
import { detectHostCapabilities, type HostCapabilities } from "../lib/host.ts";
import { recordRunState } from "../lib/runState.ts";
import { canonicalLinearIssue } from "../lib/testing/canonicalFixtures.ts";
import { createBoard, type Board } from "../lib/board.ts";
import type * as boardModule from "../lib/board.ts";
import { buildSources } from "../lib/buildSources.ts";
import type * as buildSourcesModule from "../lib/buildSources.ts";
import type { BoardState, Issue } from "../lib/taskSource.ts";
import type * as utilModule from "../lib/util.ts";
import { debug, log } from "../lib/util.ts";
import { WorktreeAlreadyExistsError, type WorktreeEntry, worktrees } from "../lib/worktrees.ts";
import { deleteEnvironmentVariable, setEnvironmentVariable } from "../testHelpers/env.ts";
import { emptyTeardownResult } from "../testHelpers/teardownResult.ts";
import {
  setupWorkspace,
  setupWorkspaceCli,
  type SetupWorkspaceOptions,
  type TaskDetails,
} from "./setupWorkspace.ts";

interface NodeFsMock extends Omit<
  typeof nodeFs,
  "existsSync" | "mkdtempSync" | "rmSync" | "writeFileSync"
> {
  existsSync: ReturnType<typeof vi.fn<typeof existsSync>>;
  mkdtempSync: ReturnType<typeof vi.fn<typeof mkdtempSync>>;
  rmSync: ReturnType<typeof vi.fn<typeof rmSync>>;
  writeFileSync: ReturnType<typeof vi.fn<typeof writeFileSync>>;
}

vi.mock("node:fs", async (importOriginal): Promise<NodeFsMock> => {
  const actual = await importOriginal<typeof nodeFs>();
  return {
    ...actual,
    existsSync: vi.fn<typeof existsSync>().mockReturnValue(true),
    mkdtempSync: vi.fn<typeof mkdtempSync>(),
    rmSync: vi.fn<typeof rmSync>(),
    writeFileSync: vi.fn<typeof writeFileSync>(),
  };
});
vi.mock(import("../lib/config.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, loadConfig: vi.fn<typeof loadConfig>() };
});
vi.mock(import("../lib/host.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, detectHostCapabilities: vi.fn<typeof detectHostCapabilities>() };
});
vi.mock(import("@clipboard-health/clearance"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    ensureClearance: vi.fn<typeof ensureClearance>(),
  };
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
vi.mock(import("../lib/runState.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, recordRunState: vi.fn<typeof recordRunState>() };
});
vi.mock(import("../lib/util.ts"), async (importOriginal) => {
  const actual = await importOriginal<typeof utilModule>();
  return {
    ...actual,
    log: vi.fn<typeof actual.log>(),
    debug: vi.fn<typeof actual.debug>(),
  };
});
vi.mock(import("../lib/worktrees.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    worktrees: {
      ...actual.worktrees,
      create: vi.fn<typeof actual.worktrees.create>(),
      teardown: vi.fn<typeof actual.worktrees.teardown>(),
    },
  };
});
vi.mock(import("../lib/board.ts"), async (importOriginal) => {
  const actual = await importOriginal<typeof boardModule>();
  return {
    ...actual,
    createBoard: vi.fn<typeof actual.createBoard>(() => ({
      verify: vi.fn<() => Promise<void>>().mockResolvedValue(),
      fetch: vi.fn<() => Promise<BoardState>>(),
      resolveOne: vi.fn<(id: string) => Promise<Issue | undefined>>().mockResolvedValue(
        canonicalLinearIssue({
          naturalId: "team-1",
          repository: "repo-a",
          model: "claude",
          title: "Title",
          description: "Body for repo-a",
        }),
      ),
      markInProgress: vi.fn<(issue: Issue) => Promise<void>>().mockResolvedValue(),
      markInReview: vi.fn<Board["markInReview"]>().mockResolvedValue({ outcome: "applied" }),
      markDone: vi.fn<Board["markDone"]>().mockResolvedValue({ outcome: "applied" }),
    })),
  };
});
vi.mock(import("../lib/buildSources.ts"), async (importOriginal) => {
  const actual = await importOriginal<typeof buildSourcesModule>();
  return { ...actual, buildSources: vi.fn<typeof actual.buildSources>().mockResolvedValue([]) };
});

const mkdtempMock = vi.mocked(mkdtempSync);
const existsMock = vi.mocked(existsSync);
const writeFileMock = vi.mocked(writeFileSync);
const rmMock = vi.mocked(rmSync);
const loadConfigMock = vi.mocked(loadConfig);
const detectHostMock = vi.mocked(detectHostCapabilities);
const ensureClearanceMock = vi.mocked(ensureClearance);
const logMock = vi.mocked(log);
const debugMock = vi.mocked(debug);
const recordRunStateMock = vi.mocked(recordRunState);
const createMock = vi.mocked(worktrees.create);
const teardownMock = vi.mocked(worktrees.teardown);

type RecordedRunState = Parameters<typeof recordRunState>[0]["state"];

function lastRecordedRunState(): RecordedRunState {
  const input = recordRunStateMock.mock.calls.at(-1)?.[0];
  if (input === undefined) {
    throw new Error("recordRunState was not called");
  }
  return input.state;
}

function host(overrides: Partial<HostCapabilities> = {}): HostCapabilities {
  return {
    hasSafehouse: true,
    hasSbx: false,
    hasCmux: true,
    hasTmux: false,
    hasZellij: false,
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

function hostEntry(): WorktreeEntry {
  return {
    repository: "repo-a",
    task: "team-1",
    branchName: "dev-team-1",
    dir: "/work/repo-a-team-1",
    kind: "host",
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
        claude: { cmd: "claude --auto", color: "#fff" },
        codex: { cmd: "codex", color: "#000" },
      },
      ...overrides,
    },
    prompts: {
      initial: "Begin {{task}} ({{title}}) in {{worktree}}\n{{description}}",
    },
    workspaceKind: "auto",
    local: { runner: "auto" },
    logging: { file: "/tmp/groundcrew-test.log" },
  };
}

function makeConfigWithPrepareWorktree(command = "npm ci"): ResolvedConfig {
  return {
    ...makeConfig(),
    defaults: { hooks: { prepareWorktree: command } },
  };
}

function isCmuxNewWorkspace(cmd: string, arguments_: readonly string[]): boolean {
  return cmd === "cmux" && arguments_.includes("new-workspace");
}

function mockCmuxNewWorkspaceOutput(output: string): void {
  runCommandMock.mockImplementation((cmd, arguments_) =>
    isCmuxNewWorkspace(cmd, arguments_) ? output : "",
  );
}

function mockCmuxFailure(): void {
  runCommandMock.mockImplementation((cmd) => {
    if (cmd === "cmux") {
      throw new Error("cmux down");
    }
    return "";
  });
}

function sdxHost(): HostCapabilities {
  return host({
    hasSafehouse: false,
    hasSbx: true,
    hasCmux: false,
    hasTmux: true,
    isMacOS: false,
    isLinux: true,
    isSafehouseSupported: false,
  });
}

function mockTmuxHost(): void {
  detectHostMock.mockResolvedValue(host({ hasCmux: false, hasTmux: true }));
}

function mockTmuxWindows(names: readonly string[]): void {
  const lines = ["_groundcrew_idle\t0", ...names.map((name) => `${name}\t0`)];
  runCommandMock.mockReturnValue(`${lines.join("\n")}\n`);
}

function mockExistingWorktree(): void {
  createMock.mockRejectedValue(new WorktreeAlreadyExistsError("/work/repo-a-team-1"));
}

function lastRunArgumentFromCallWithArgument(argument: string): string {
  const call = runCommandMock.mock.calls.find((candidate) => candidate[1].includes(argument));
  const lastArgument = call?.[1].at(-1);
  return typeof lastArgument === "string" ? lastArgument : "";
}

function writtenFileContent(path: string): string {
  const call = writeFileMock.mock.calls.find(([candidate]) => String(candidate) === path);
  const content = call?.[1];
  return typeof content === "string" ? content : "";
}

interface InvocationOrderRecorder {
  mock: { invocationCallOrder: readonly number[] };
}

function firstInvocationOrder(recorder: InvocationOrderRecorder): number {
  const [order] = recorder.mock.invocationCallOrder;
  if (order === undefined) {
    throw new Error("expected invocation order");
  }
  return order;
}

function lastEnsureClearanceInput(): NonNullable<Parameters<typeof ensureClearance>[0]> {
  const input = ensureClearanceMock.mock.calls.at(-1)?.[0];
  if (input === undefined) {
    throw new Error("expected ensureClearance input");
  }
  return input;
}

function lastEnsureClearanceSleep(): (ms: number) => Promise<void> {
  const clearanceSleep = lastEnsureClearanceInput().sleep;
  if (clearanceSleep === undefined) {
    throw new Error("expected clearance sleep");
  }
  return clearanceSleep;
}

function createDeferred(): {
  promise: Promise<boolean>;
  resolve: () => void;
} {
  let resolvePromise: ((value: boolean) => void) | undefined;
  const promise = new Promise<boolean>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve() {
      if (resolvePromise === undefined) {
        throw new Error("deferred promise resolver was not initialized");
      }
      resolvePromise(true);
    },
  };
}

function clearanceResult(): Awaited<ReturnType<typeof ensureClearance>> {
  return {
    logPath: "/tmp/clearance/clearance.log",
    pidPath: "/tmp/clearance/clearance.pid",
    port: 19_999,
    status: "already-running",
  };
}

async function waitForClearanceSleep(input: Parameters<typeof ensureClearance>[0]): Promise<void> {
  const clearanceSleep = input?.sleep;
  if (clearanceSleep === undefined) {
    throw new Error("expected clearance sleep");
  }
  await clearanceSleep(1000);
}

describe(setupWorkspace, () => {
  beforeEach(() => {
    existsMock.mockReturnValue(true);
    detectHostMock.mockResolvedValue(host());
    createMock.mockImplementation(async () => hostEntry());
    ensureClearanceMock.mockResolvedValue(clearanceResult());
    mkdtempMock.mockReturnValue("/tmp/groundcrew-team-1-x");
    runCommandMock.mockReturnValue("");
    teardownMock.mockResolvedValue(emptyTeardownResult());
  });

  afterEach(() => {
    // resetAllMocks (not clearAllMocks) so module-scoped mock implementations
    // set inside one test don't leak into the next.
    vi.resetAllMocks();
  });

  it("provisions the worktree, writes the prompt, and launches cmux", async () => {
    const config = makeConfig();
    mockCmuxNewWorkspaceOutput(JSON.stringify({ ref: "workspace:42" }));

    await setupWorkspace(config, {
      task: "team-1",
      repository: "repo-a",
      model: "claude",
      details: { title: "Test Title", description: "Body" },
    });

    expect(createMock).toHaveBeenCalledWith(
      config,
      expect.objectContaining({ repository: "repo-a", task: "team-1" }),
    );
    expect(writeFileMock).toHaveBeenCalledWith(
      "/tmp/groundcrew-team-1-x/prompt.txt",
      expect.stringContaining("Begin team-1 (Test Title) in repo-a-team-1"),
    );
    expect(runCommandMock).toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining(["new-workspace", "--name", "team-1"]),
    );
    expect(runCommandMock).toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining(["set-status", "model", "claude", "--workspace", "workspace:42"]),
    );
    expect(lastRecordedRunState()).toMatchObject({
      task: "team-1",
      repository: "repo-a",
      model: "claude",
      worktreeDir: "/work/repo-a-team-1",
      branchName: "dev-team-1",
      workspaceName: "team-1",
      state: "running",
      title: "Test Title",
    });
  });

  it("records the task url in RunState when the source provides one", async () => {
    const config = makeConfig();
    mockCmuxNewWorkspaceOutput(JSON.stringify({ ref: "workspace:42" }));

    await setupWorkspace(config, {
      task: "team-1",
      repository: "repo-a",
      model: "claude",
      details: {
        title: "Test Title",
        description: "Body",
        url: "https://linear.app/example/issue/TEAM-1",
      },
    });

    expect(lastRecordedRunState()).toMatchObject({
      state: "running",
      url: "https://linear.app/example/issue/TEAM-1",
    });
  });

  it("records the task url even on the failed-to-launch rollback path", async () => {
    const config = makeConfig();
    mockCmuxFailure();

    await expect(
      setupWorkspace(config, {
        task: "team-1",
        repository: "repo-a",
        model: "claude",
        details: {
          title: "Test Title",
          description: "Body",
          url: "https://linear.app/example/issue/TEAM-1",
        },
      }),
    ).rejects.toThrow(/cmux down/);

    expect(lastRecordedRunState()).toMatchObject({
      state: "failed-to-launch",
      url: "https://linear.app/example/issue/TEAM-1",
    });
  });

  it("keeps the local cmux command short by staging the full launcher in a local script", async () => {
    const config = makeConfig();
    mockCmuxNewWorkspaceOutput(JSON.stringify({ ref: "workspace:42" }));

    await setupWorkspace(config, {
      task: "team-1",
      repository: "repo-a",
      model: "claude",
      details: { title: "Test Title", description: "Body" },
    });

    const command = lastRunArgumentFromCallWithArgument("new-workspace");
    const launchScript = writtenFileContent("/tmp/groundcrew-team-1-x/launch.sh");

    expect(command).toBe("bash '/tmp/groundcrew-team-1-x/launch.sh'");
    expect(command).not.toContain("safehouse-clearance");
    expect(command).not.toContain("prompt.txt");
    expect(launchScript).toContain("safehouse-clearance");
    expect(launchScript).toContain("_p=$(cat '/tmp/groundcrew-team-1-x/prompt.txt')");
  });

  it("stages neutral prepare + full agent srt settings and wraps the agent under the agent policy when runner=srt", async () => {
    const config = makeConfig();
    config.local = { runner: "srt" };
    mockCmuxNewWorkspaceOutput(JSON.stringify({ ref: "workspace:42" }));

    await setupWorkspace(config, {
      task: "team-1",
      repository: "repo-a",
      model: "claude",
      details: { title: "Test Title", description: "Body" },
    });

    const launchScript = writtenFileContent("/tmp/groundcrew-team-1-x/launch.sh");
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- staged settings are SandboxRuntimeConfig JSON
    const agent = JSON.parse(
      writtenFileContent("/tmp/groundcrew-team-1-x/agent-settings.json"),
    ) as SandboxRuntimeConfig;
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- staged settings are SandboxRuntimeConfig JSON
    const prepare = JSON.parse(
      writtenFileContent("/tmp/groundcrew-team-1-x/prepare-settings.json"),
    ) as SandboxRuntimeConfig;

    expect(launchScript).toContain("--settings '/tmp/groundcrew-team-1-x/agent-settings.json'");
    expect(launchScript).toMatch(/sandbox-runtime\/dist\/cli\.js/);
    expect(launchScript).toContain(`exec claude --auto "$@"`);
    expect(launchScript).not.toContain("safehouse-clearance");
    // The agent policy gives claude a writable home but denies the executable
    // persistence surfaces (work item 1): ~/.claude.json (mcpServers) is denied
    // even though the surrounding home is writable. The profile-neutral prepare
    // policy gets neither read nor write, so a repo-controlled prepareWorktree
    // hook can't touch the agent's config.
    expect(agent.filesystem.allowRead?.some((p) => p.endsWith("/.claude"))).toBe(true);
    expect(agent.filesystem.allowWrite.some((p) => p.endsWith("/.claude"))).toBe(true);
    expect(agent.filesystem.denyWrite.some((p) => p.endsWith("/.claude.json"))).toBe(true);
    expect(agent.allowPty).toBe(true);
    expect(prepare.filesystem.allowWrite.some((p) => p.endsWith("/.claude"))).toBe(false);
    expect(prepare.filesystem.allowRead?.some((p) => p.endsWith("/.claude"))).toBe(false);
  });

  it("passes an AbortSignal into worktree creation and workspace launch", async () => {
    const config = makeConfig();
    const { signal } = new AbortController();
    mockCmuxNewWorkspaceOutput(JSON.stringify({ ref: "workspace:42" }));

    await setupWorkspace(
      config,
      {
        task: "team-1",
        repository: "repo-a",
        model: "claude",
        details: { title: "Test Title", description: "Body" },
      },
      { signal },
    );

    expect(lastEnsureClearanceSleep()).toStrictEqual(expect.any(Function));
    expect(createMock).toHaveBeenCalledWith(
      config,
      expect.objectContaining({ repository: "repo-a", task: "team-1" }),
      signal,
    );
    expect(runCommandMock).toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining(["new-workspace", "--name", "team-1"]),
      { signal },
    );
  });

  it("makes Safehouse clearance polling abortable", async () => {
    const config = makeConfig();
    const controller = new AbortController();
    const sleepStarted = createDeferred();
    mockCmuxNewWorkspaceOutput(JSON.stringify({ ref: "workspace:42" }));
    ensureClearanceMock.mockImplementationOnce(async (input) => {
      sleepStarted.resolve();
      await waitForClearanceSleep(input);
      return clearanceResult();
    });

    const setupPromise = setupWorkspace(
      config,
      {
        task: "team-1",
        repository: "repo-a",
        model: "claude",
        details: { title: "Test Title", description: "Body" },
      },
      { signal: controller.signal },
    );

    await sleepStarted.promise;
    controller.abort(new Error("stop setup"));
    await expect(setupPromise).rejects.toThrow("stop setup");
    expect(createMock).toHaveBeenCalledWith(
      config,
      expect.objectContaining({ repository: "repo-a", task: "team-1" }),
      controller.signal,
    );
    expect(teardownMock).toHaveBeenCalledWith(config, [expect.objectContaining(hostEntry())], {
      force: true,
    });
    expect(runCommandMock).not.toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining(["new-workspace"]),
    );
  });

  it("starts worktree creation before waiting for Safehouse clearance", async () => {
    const config = makeConfig();
    const clearanceStarted = createDeferred();
    const releaseClearance = createDeferred();
    mockCmuxNewWorkspaceOutput(JSON.stringify({ ref: "workspace:42" }));
    ensureClearanceMock.mockImplementationOnce(async () => {
      clearanceStarted.resolve();
      await releaseClearance.promise;
      return clearanceResult();
    });

    const setupPromise = setupWorkspace(config, {
      task: "team-1",
      repository: "repo-a",
      model: "claude",
      details: { title: "Test Title", description: "Body" },
    });

    try {
      await clearanceStarted.promise;
      await Promise.resolve();

      expect(createMock).toHaveBeenCalledWith(
        config,
        expect.objectContaining({ repository: "repo-a", task: "team-1" }),
      );
      expect(runCommandMock).not.toHaveBeenCalledWith(
        "cmux",
        expect.arrayContaining(["new-workspace"]),
      );
    } finally {
      releaseClearance.resolve();
      await setupPromise.catch((error: unknown) => error);
    }

    await setupPromise;
  });

  it("uses provided task details for prompt rendering", async () => {
    const config = makeConfig();
    mockCmuxNewWorkspaceOutput(JSON.stringify({ ref: "workspace:42" }));

    await setupWorkspace(config, {
      task: "team-1",
      repository: "repo-a",
      model: "claude",
      details: { title: "Provided Title", description: "Provided Body" },
    });

    expect(writeFileMock).toHaveBeenCalledWith(
      "/tmp/groundcrew-team-1-x/prompt.txt",
      expect.stringContaining("Provided Title"),
    );
  });

  it("renders a tmux continuation instruction with the command in backticks", async () => {
    mockTmuxHost();
    const config = {
      ...makeConfig(),
      prompts: {
        initial: "Before\n{{workspaceContinuationInstruction}}\nAfter",
      },
    };

    await setupWorkspace(config, {
      task: "team-1",
      repository: "repo-a",
      model: "claude",
      details: { title: "Test Title", description: "Body" },
    });

    const prompt = writtenFileContent("/tmp/groundcrew-team-1-x/prompt.txt");
    expect(prompt).toContain("Workspace attach: `tmux attach -t groundcrew:team-1`");
    expect(prompt).not.toContain("{{workspaceContinuationInstruction}}");
  });

  it("omits the workspace continuation instruction when the backend has no access hint", async () => {
    const config = {
      ...makeConfig(),
      prompts: {
        initial: "Before\n{{workspaceContinuationInstruction}}\nAfter",
      },
    };
    mockCmuxNewWorkspaceOutput(JSON.stringify({ ref: "workspace:42" }));

    await setupWorkspace(config, {
      task: "team-1",
      repository: "repo-a",
      model: "claude",
      details: { title: "Test Title", description: "Body" },
    });

    expect(writtenFileContent("/tmp/groundcrew-team-1-x/prompt.txt")).toBe("Before\n\nAfter");
  });

  it("wraps the agent command with Safehouse and runs the default prepareWorktree hook", async () => {
    detectHostMock.mockResolvedValue(host());
    const config = {
      ...makeConfig({
        definitions: {
          claude: {
            cmd: "claude --permission-mode auto",
            color: "#fff",
          },
        },
      }),
      defaults: { hooks: { prepareWorktree: "npm ci" } },
    };
    mockCmuxNewWorkspaceOutput(JSON.stringify({ ref: "workspace:42" }));

    await setupWorkspace(config, {
      task: "team-1",
      repository: "repo-a",
      model: "claude",
      details: { title: "Test Title", description: "Body" },
    });

    expect(ensureClearanceMock).toHaveBeenCalledTimes(1);
    expect(firstInvocationOrder(createMock)).toBeLessThan(
      firstInvocationOrder(ensureClearanceMock),
    );
    const command = lastRunArgumentFromCallWithArgument("new-workspace");
    const launchScript = writtenFileContent("/tmp/groundcrew-team-1-x/launch.sh");
    expect(command).toBe("bash '/tmp/groundcrew-team-1-x/launch.sh'");
    expect(launchScript).toContain("cd '/work/repo-a-team-1'");
    expect(launchScript).toContain("npm ci");
    expect(launchScript).not.toContain(".groundcrew/setup.sh");
    expect(launchScript).toContain(
      "/node_modules/@clipboard-health/clearance/safehouse/safehouse-clearance' sh -c",
    );
    // The agent runs inside the wrap (after prepareWorktree), so the prompt is the sh -c arg.
    expect(launchScript).toContain(
      '/node_modules/@clipboard-health/clearance/safehouse/safehouse-clearance\' "$_safehouse_shim" -c',
    );
    expect(launchScript).toContain('_safehouse_shim="$_safehouse_shim_dir/claude"');
    expect(launchScript).not.toContain("--enable=all-agents");
    expect(launchScript).toContain('exec claude --permission-mode auto "$@"');
    expect(launchScript).toContain('sh "$_p"');
    // prepareWorktree status guard so a failed install still launches the agent
    expect(launchScript).toContain('"$prepare_status" -ne 0');
  });

  it("skips prepareWorktree when neither repo config nor defaults define it", async () => {
    detectHostMock.mockResolvedValue(host());
    const config = makeConfig({
      definitions: {
        claude: {
          cmd: "claude --permission-mode auto",
          color: "#fff",
        },
      },
    });
    mockCmuxNewWorkspaceOutput(JSON.stringify({ ref: "workspace:42" }));

    await setupWorkspace(config, {
      task: "team-1",
      repository: "repo-a",
      model: "claude",
      details: { title: "Test Title", description: "Body" },
    });

    const launchScript = writtenFileContent("/tmp/groundcrew-team-1-x/launch.sh");
    expect(launchScript).not.toContain("groundcrew prepareWorktree hook exited");
    expect(launchScript).not.toContain(".groundcrew/setup.sh");
    expect(launchScript).toContain(
      '/node_modules/@clipboard-health/clearance/safehouse/safehouse-clearance\' "$_safehouse_shim" -c',
    );
  });

  it("wraps the agent in an sbx exec call and skips ensureClearance when runner='sdx'", async () => {
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
    const config = makeConfig({
      definitions: {
        claude: {
          cmd: "claude --permission-mode auto",
          color: "#fff",
          sandbox: { agent: "claude" },
        },
        codex: { cmd: "codex", color: "#000" },
      },
    });
    mockCmuxNewWorkspaceOutput(JSON.stringify({ ref: "workspace:42" }));

    await setupWorkspace(config, {
      task: "team-1",
      repository: "repo-a",
      model: "claude",
      details: { title: "Test Title", description: "Body" },
    });

    expect(ensureClearanceMock).not.toHaveBeenCalled();
    const launchScript = writtenFileContent("/tmp/groundcrew-team-1-x/launch.sh");
    expect(launchScript).toMatch(
      /exec sbx exec -it (?:-e [A-Z_]+ )*-w '\/work\/repo-a-team-1' 'groundcrew-claude' sh -c/,
    );
    expect(launchScript).toContain("exec claude --permission-mode auto");
    expect(launchScript).not.toContain("safehouse-clearance");
  });

  it("does not probe or provision the sandbox when runner='sdx'", async () => {
    detectHostMock.mockResolvedValue(sdxHost());
    const config = makeConfig({
      definitions: {
        claude: { cmd: "claude --auto", color: "#fff", sandbox: { agent: "claude" } },
        codex: { cmd: "codex", color: "#000" },
      },
    });

    await setupWorkspace(config, {
      task: "team-1",
      repository: "repo-a",
      model: "claude",
      details: { title: "Test Title", description: "Body" },
    });

    expect(runCommandMock.mock.calls.filter(([command]) => command === "sbx")).toStrictEqual([]);
    expect(teardownMock).not.toHaveBeenCalled();
    expect(writtenFileContent("/tmp/groundcrew-team-1-x/launch.sh")).toContain("exec sbx exec -it");
  });

  it("rolls back the worktree when the safehouse clearance cannot start", async () => {
    detectHostMock.mockResolvedValue(host());
    ensureClearanceMock.mockRejectedValue(new Error("proxy unavailable"));
    const config = makeConfig();

    await expect(
      setupWorkspace(config, {
        task: "team-1",
        repository: "repo-a",
        model: "claude",
        details: { title: "Test Title", description: "Body" },
      }),
    ).rejects.toThrow("proxy unavailable");

    expect(createMock).toHaveBeenCalledWith(
      config,
      expect.objectContaining({ repository: "repo-a", task: "team-1" }),
    );
    expect(teardownMock).toHaveBeenCalledWith(config, [expect.objectContaining(hostEntry())], {
      force: true,
    });
    expect(runCommandMock).not.toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining(["new-workspace"]),
    );
  });

  it("does not double-wrap when the cmd already starts with safehouse", async () => {
    detectHostMock.mockResolvedValue(host());
    const config = makeConfig({
      definitions: {
        claude: {
          // A user upgrading from main has `safehouse` baked into their cmd;
          // local wrapping must not produce `safehouse safehouse claude ...`.
          cmd: "safehouse claude --permission-mode auto",
          color: "#fff",
        },
      },
    });
    mockCmuxNewWorkspaceOutput(JSON.stringify({ ref: "workspace:42" }));

    await setupWorkspace(config, {
      task: "team-1",
      repository: "repo-a",
      model: "claude",
      details: { title: "Test Title", description: "Body" },
    });

    const command = lastRunArgumentFromCallWithArgument("new-workspace");
    const launchScript = writtenFileContent("/tmp/groundcrew-team-1-x/launch.sh");
    expect(command).toBe("bash '/tmp/groundcrew-team-1-x/launch.sh'");
    expect(launchScript).toContain('exec safehouse claude --permission-mode auto "$_p"');
    expect(launchScript).not.toContain("safehouse safehouse");
  });

  describe("build-time secret shuttling", () => {
    afterEach(() => {
      deleteEnvironmentVariable("NPM_TOKEN");
      deleteEnvironmentVariable("BUF_TOKEN");
    });

    it("stages secrets.env (mode 0600) and references it in the launch command when NPM_TOKEN is set", async () => {
      setEnvironmentVariable("NPM_TOKEN", "npm_test_token");
      deleteEnvironmentVariable("BUF_TOKEN");
      mockCmuxNewWorkspaceOutput(JSON.stringify({ ref: "workspace:1" }));

      await setupWorkspace(makeConfigWithPrepareWorktree(), {
        task: "team-1",
        repository: "repo-a",
        model: "claude",
        details: { title: "Test Title", description: "Body" },
      });

      expect(writeFileMock).toHaveBeenCalledWith(
        "/tmp/groundcrew-team-1-x/secrets.env",
        "NPM_TOKEN='npm_test_token'\n",
        { mode: 0o600 },
      );
      const command = lastRunArgumentFromCallWithArgument("new-workspace");
      const launchScript = writtenFileContent("/tmp/groundcrew-team-1-x/launch.sh");
      expect(command).toBe("bash '/tmp/groundcrew-team-1-x/launch.sh'");
      expect(launchScript).toContain(". '/tmp/groundcrew-team-1-x/secrets.env'");
      expect(launchScript).toContain("unset NPM_TOKEN BUF_TOKEN");
    });

    it("escapes single quotes in secret values so the file is sourceable", async () => {
      setEnvironmentVariable("NPM_TOKEN", "npm_with'quote");
      deleteEnvironmentVariable("BUF_TOKEN");
      mockCmuxNewWorkspaceOutput(JSON.stringify({ ref: "workspace:1" }));

      await setupWorkspace(makeConfigWithPrepareWorktree(), {
        task: "team-1",
        repository: "repo-a",
        model: "claude",
        details: { title: "Test Title", description: "Body" },
      });

      expect(writeFileMock).toHaveBeenCalledWith(
        "/tmp/groundcrew-team-1-x/secrets.env",
        `${String.raw`NPM_TOKEN='npm_with'\''quote'`}\n`,
        { mode: 0o600 },
      );
    });

    it("stages both NPM_TOKEN and BUF_TOKEN when both are set", async () => {
      setEnvironmentVariable("NPM_TOKEN", "npm_test");
      setEnvironmentVariable("BUF_TOKEN", "buf_test");
      mockCmuxNewWorkspaceOutput(JSON.stringify({ ref: "workspace:1" }));

      await setupWorkspace(makeConfigWithPrepareWorktree(), {
        task: "team-1",
        repository: "repo-a",
        model: "claude",
        details: { title: "Test Title", description: "Body" },
      });

      expect(writeFileMock).toHaveBeenCalledWith(
        "/tmp/groundcrew-team-1-x/secrets.env",
        "NPM_TOKEN='npm_test'\nBUF_TOKEN='buf_test'\n",
        { mode: 0o600 },
      );
    });

    it("skips secrets.env entirely when no build secrets are set", async () => {
      deleteEnvironmentVariable("NPM_TOKEN");
      deleteEnvironmentVariable("BUF_TOKEN");
      mockCmuxNewWorkspaceOutput(JSON.stringify({ ref: "workspace:1" }));

      await setupWorkspace(makeConfig(), {
        task: "team-1",
        repository: "repo-a",
        model: "claude",
        details: { title: "Test Title", description: "Body" },
      });

      expect(writeFileMock).not.toHaveBeenCalledWith(
        expect.stringContaining("secrets.env"),
        expect.anything(),
        expect.anything(),
      );
      const command = lastRunArgumentFromCallWithArgument("new-workspace");
      const launchScript = writtenFileContent("/tmp/groundcrew-team-1-x/launch.sh");
      expect(command).not.toContain("secrets.env");
      expect(command).not.toContain("unset NPM_TOKEN");
      expect(launchScript).not.toContain("secrets.env");
      expect(launchScript).not.toContain("unset NPM_TOKEN");
    });

    it("skips secrets.env when build secrets are set but no prepareWorktree hook is configured", async () => {
      setEnvironmentVariable("NPM_TOKEN", "npm_test_token");
      deleteEnvironmentVariable("BUF_TOKEN");
      mockCmuxNewWorkspaceOutput(JSON.stringify({ ref: "workspace:1" }));

      await setupWorkspace(makeConfig(), {
        task: "team-1",
        repository: "repo-a",
        model: "claude",
        details: { title: "Test Title", description: "Body" },
      });

      expect(writeFileMock).not.toHaveBeenCalledWith(
        expect.stringContaining("secrets.env"),
        expect.anything(),
        expect.anything(),
      );
      const launchScript = writtenFileContent("/tmp/groundcrew-team-1-x/launch.sh");
      expect(launchScript).not.toContain("secrets.env");
      expect(launchScript).not.toContain("unset NPM_TOKEN");
    });
  });

  it("logs the tmux access hint after launch so the user knows how to reach the workspace", async () => {
    mockTmuxHost();
    const config = makeConfig();

    await setupWorkspace(config, {
      task: "team-1",
      repository: "repo-a",
      model: "claude",
      details: { title: "Test Title", description: "Body" },
    });

    expect(debugMock).toHaveBeenCalledWith("  Attach:   tmux attach -t groundcrew:team-1");
  });

  it("collapses the launch into a single success line naming model and worktree", async () => {
    mockTmuxHost();
    const config = makeConfig();

    await setupWorkspace(config, {
      task: "team-1",
      repository: "repo-a",
      model: "claude",
      details: { title: "Test Title", description: "Body" },
    });

    expect(logMock).toHaveBeenCalledWith('✓ "team-1" launched (claude)  worktree repo-a-team-1');
    // The verbose-only detail lines must not reach the important (log) tier.
    expect(logMock).not.toHaveBeenCalledWith(expect.stringMatching(/^ {2}(?:Worktree|Branch):/));
    expect(logMock).not.toHaveBeenCalledWith("Opening workspace...");
  });

  it("omits the access hint when the backend has no external hint (cmux)", async () => {
    const config = makeConfig();
    mockCmuxNewWorkspaceOutput(JSON.stringify({ ref: "workspace:42" }));

    await setupWorkspace(config, {
      task: "team-1",
      repository: "repo-a",
      model: "claude",
      details: { title: "Test Title", description: "Body" },
    });

    expect(debugMock).not.toHaveBeenCalledWith(expect.stringMatching(/^ {2}Attach:/));
  });

  it("fails before creating a worktree when safehouse is requested off macOS", async () => {
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
    const config = makeConfig();
    config.local = { runner: "safehouse" };

    await expect(
      setupWorkspace(config, {
        task: "team-1",
        repository: "repo-a",
        model: "claude",
        details: { title: "Test Title", description: "Body" },
      }),
    ).rejects.toThrow(/Local groundcrew runs with the safehouse runner require macOS/);

    expect(createMock).not.toHaveBeenCalled();
    expect(ensureClearanceMock).not.toHaveBeenCalled();
  });

  it("fails before creating a worktree when sdx is selected but sbx is missing", async () => {
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
    const config = makeConfig({
      definitions: {
        claude: { cmd: "claude --auto", color: "#fff", sandbox: { agent: "claude" } },
        codex: { cmd: "codex", color: "#000" },
      },
    });

    await expect(
      setupWorkspace(config, {
        task: "team-1",
        repository: "repo-a",
        model: "claude",
        details: { title: "Test Title", description: "Body" },
      }),
    ).rejects.toThrow(/sdx runner require `sbx`/);

    expect(createMock).not.toHaveBeenCalled();
    expect(ensureClearanceMock).not.toHaveBeenCalled();
  });

  it("fails before creating a worktree when sdx is selected but the model has no sandbox config", async () => {
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
    const config = makeConfig();

    await expect(
      setupWorkspace(config, {
        task: "team-1",
        repository: "repo-a",
        model: "claude",
        details: { title: "Test Title", description: "Body" },
      }),
    ).rejects.toThrow(/sdx runner require a sandbox config on model 'claude'/);

    expect(createMock).not.toHaveBeenCalled();
    expect(ensureClearanceMock).not.toHaveBeenCalled();
  });

  it("fails before creating a worktree when sdx is selected and the model has preLaunch", async () => {
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
    const config = makeConfig({
      definitions: {
        claude: {
          cmd: "claude --auto",
          color: "#fff",
          sandbox: { agent: "claude" },
          preLaunch: "export FOO=bar",
        },
        codex: { cmd: "codex", color: "#000" },
      },
    });

    await expect(
      setupWorkspace(config, {
        task: "team-1",
        repository: "repo-a",
        model: "claude",
        details: { title: "Test Title", description: "Body" },
      }),
    ).rejects.toThrow(/sdx runner do not support preLaunch on model 'claude'/);

    expect(createMock).not.toHaveBeenCalled();
    expect(ensureClearanceMock).not.toHaveBeenCalled();
  });

  it("fails before creating a worktree when sdx is selected and the model has preLaunchEnv", async () => {
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
    const config = makeConfig({
      definitions: {
        claude: {
          cmd: "claude --auto",
          color: "#fff",
          sandbox: { agent: "claude" },
          preLaunchEnv: ["SESSION_TOKEN"],
        },
        codex: { cmd: "codex", color: "#000" },
      },
    });

    await expect(
      setupWorkspace(config, {
        task: "team-1",
        repository: "repo-a",
        model: "claude",
        details: { title: "Test Title", description: "Body" },
      }),
    ).rejects.toThrow(/sdx runner do not support preLaunchEnv on model 'claude'/);

    expect(createMock).not.toHaveBeenCalled();
    expect(ensureClearanceMock).not.toHaveBeenCalled();
  });

  it("treats preLaunchEnv: [] as a no-op under sdx and proceeds with the normal launch", async () => {
    // An empty list forwards zero names, so the unsupported-runner guard
    // should not fire — locks the "empty is a uniform no-op in every runner"
    // contract so it can't regress per-site.
    detectHostMock.mockResolvedValue(sdxHost());
    const config = makeConfig({
      definitions: {
        claude: {
          cmd: "claude --auto",
          color: "#fff",
          sandbox: { agent: "claude" },
          preLaunchEnv: [],
        },
        codex: { cmd: "codex", color: "#000" },
      },
    });

    await setupWorkspace(config, {
      task: "team-1",
      repository: "repo-a",
      model: "claude",
      details: { title: "Test Title", description: "Body" },
    });

    expect(ensureClearanceMock).not.toHaveBeenCalled();
    expect(writtenFileContent("/tmp/groundcrew-team-1-x/launch.sh")).toContain("exec sbx exec -it");
  });

  it("fails before creating a worktree when safehouse cmd uses preLaunchEnv with a safehouse-prefixed cmd", async () => {
    // safehouse-prefixed cmd owns its own --env-pass flag, so groundcrew can't
    // splice preLaunchEnv into a wrap it does not control. Fail at prepare-
    // launch time so the operator sees it before the workspace is created
    // (mirror of the duplicate defense in buildLaunchCommand).
    detectHostMock.mockResolvedValue(host({ hasSafehouse: true, isMacOS: true }));
    const config = makeConfig({
      definitions: {
        claude: {
          cmd: "safehouse --env-pass=OTHER claude --auto",
          color: "#fff",
          preLaunchEnv: ["SESSION_TOKEN"],
        },
        codex: { cmd: "codex", color: "#000" },
      },
    });

    await expect(
      setupWorkspace(config, {
        task: "team-1",
        repository: "repo-a",
        model: "claude",
        details: { title: "Test Title", description: "Body" },
      }),
    ).rejects.toThrow(/cannot inject preLaunchEnv when 'cmd' already starts with 'safehouse'/);

    expect(createMock).not.toHaveBeenCalled();
  });

  it("fails before creating a worktree when safehouse is missing on macOS", async () => {
    detectHostMock.mockResolvedValue(host({ hasSafehouse: false }));
    const config = makeConfig();

    await expect(
      setupWorkspace(config, {
        task: "team-1",
        repository: "repo-a",
        model: "claude",
        details: { title: "Test Title", description: "Body" },
      }),
    ).rejects.toThrow(/require `safehouse` on PATH/);

    expect(createMock).not.toHaveBeenCalled();
    expect(ensureClearanceMock).not.toHaveBeenCalled();
  });

  it("propagates worktree-creation errors without launching cmux", async () => {
    createMock.mockRejectedValue(new Error("git fetch failed"));

    await expect(
      setupWorkspace(makeConfig(), {
        task: "team-1",
        repository: "repo-a",
        model: "claude",
        details: { title: "Test Title", description: "Body" },
      }),
    ).rejects.toThrow(/git fetch failed/);
    expect(runCommandMock).not.toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining(["new-workspace"]),
    );
  });

  it("logs the tmux access hint when the worktree already exists and the previous workspace is still live", async () => {
    mockTmuxHost();
    mockExistingWorktree();
    mockTmuxWindows(["team-1"]);

    await expect(
      setupWorkspace(makeConfig(), {
        task: "team-1",
        repository: "repo-a",
        model: "claude",
        details: { title: "Test Title", description: "Body" },
      }),
    ).rejects.toThrow(/Worktree already exists/);

    expect(debugMock).toHaveBeenCalledWith("  Attach:   tmux attach -t groundcrew:team-1");
  });

  it("does not log an access hint when the worktree exists but no live workspace remains", async () => {
    mockTmuxHost();
    mockExistingWorktree();
    mockTmuxWindows([]);

    await expect(
      setupWorkspace(makeConfig(), {
        task: "team-1",
        repository: "repo-a",
        model: "claude",
        details: { title: "Test Title", description: "Body" },
      }),
    ).rejects.toThrow(/Worktree already exists/);

    expect(debugMock).not.toHaveBeenCalledWith(expect.stringMatching(/^ {2}Attach:/));
  });

  it("does not probe for an existing workspace when the backend has no external hint", async () => {
    mockExistingWorktree();

    await expect(
      setupWorkspace(makeConfig(), {
        task: "team-1",
        repository: "repo-a",
        model: "claude",
        details: { title: "Test Title", description: "Body" },
      }),
    ).rejects.toThrow(/Worktree already exists/);

    expect(runCommandMock).not.toHaveBeenCalled();
    expect(debugMock).not.toHaveBeenCalledWith(expect.stringMatching(/^ {2}Attach:/));
  });

  it("rejects unknown models", async () => {
    await expect(
      setupWorkspace(makeConfig(), {
        task: "team-1",
        repository: "repo-a",
        model: "ghost",
        details: { title: "Test Title", description: "Body" },
      }),
    ).rejects.toThrow(/Unknown model: ghost/);
  });

  it("rolls back the worktree, branch, and cmux workspace when cmux launch fails", async () => {
    const config = makeConfig();
    mockCmuxNewWorkspaceOutput("garbage that has no ref");

    await expect(
      setupWorkspace(config, {
        task: "team-1",
        repository: "repo-a",
        model: "claude",
        details: { title: "Test Title", description: "Body" },
      }),
    ).rejects.toThrow(/Unexpected cmux output/);

    expect(teardownMock).toHaveBeenCalledWith(
      config,
      [
        expect.objectContaining({
          repository: "repo-a",
          task: "team-1",
          kind: "host",
          dir: "/work/repo-a-team-1",
          branchName: "dev-team-1",
        }),
      ],
      { force: true },
    );
    expect(rmMock).toHaveBeenCalledWith("/tmp/groundcrew-team-1-x", expect.anything());
  });

  it("falls back to extracting workspace:N from non-JSON cmux output", async () => {
    const config = makeConfig();
    mockCmuxNewWorkspaceOutput("Created workspace:99 successfully");

    await setupWorkspace(config, {
      task: "team-1",
      repository: "repo-a",
      model: "claude",
      details: { title: "Test Title", description: "Body" },
    });

    expect(runCommandMock).toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining(["set-status", "model", "claude", "--workspace", "workspace:99"]),
    );
  });

  it("falls back to the regex match when JSON is parseable but lacks ref/id", async () => {
    mockCmuxNewWorkspaceOutput(JSON.stringify({ name: "no-ref", info: "see workspace:55" }));

    await setupWorkspace(makeConfig(), {
      task: "team-1",
      repository: "repo-a",
      model: "claude",
      details: { title: "Test Title", description: "Body" },
    });

    expect(runCommandMock).toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining(["--workspace", "workspace:55"]),
    );
  });

  it("uses the JSON id field when ref is missing", async () => {
    mockCmuxNewWorkspaceOutput(JSON.stringify({ id: "workspace:7" }));

    await setupWorkspace(makeConfig(), {
      task: "team-1",
      repository: "repo-a",
      model: "claude",
      details: { title: "Test Title", description: "Body" },
    });

    expect(runCommandMock).toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining(["--workspace", "workspace:7"]),
    );
  });

  it("treats cmux set-status failure as non-fatal (status painting is best-effort)", async () => {
    const config = makeConfig();
    // new-workspace returns ref, set-status throws — the workspace stays
    // up, no worktree rollback, and setupWorkspace resolves cleanly.
    runCommandMock
      .mockReturnValueOnce(JSON.stringify({ ref: "workspace:42" }))
      .mockImplementationOnce(() => {
        throw new Error("set-status failed");
      });

    await expect(
      setupWorkspace(config, {
        task: "team-1",
        repository: "repo-a",
        model: "claude",
        details: { title: "Test Title", description: "Body" },
      }),
    ).resolves.toBeUndefined();

    expect(runCommandMock).not.toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining(["close-workspace"]),
    );
    expect(teardownMock).not.toHaveBeenCalled();
  });

  it("ignores rmSync failures during rollback", async () => {
    const config = makeConfig();
    mockCmuxFailure();
    rmMock.mockImplementation(() => {
      throw new Error("rm failed");
    });

    await expect(
      setupWorkspace(config, {
        task: "team-1",
        repository: "repo-a",
        model: "claude",
        details: { title: "Test Title", description: "Body" },
      }),
    ).rejects.toThrow(/cmux down/);
  });

  it("records failed launch state after rollback", async () => {
    const config = makeConfig();
    mockCmuxFailure();

    await expect(
      setupWorkspace(config, {
        task: "team-1",
        repository: "repo-a",
        model: "claude",
        details: { title: "Test Title", description: "Body" },
      }),
    ).rejects.toThrow(/cmux down/);

    expect(lastRecordedRunState()).toMatchObject({
      task: "team-1",
      repository: "repo-a",
      model: "claude",
      state: "failed-to-launch",
      title: "Test Title",
    });
    expect(lastRecordedRunState().detail).toContain("cmux down");
  });

  it("logs and continues when recording run state fails after launch", async () => {
    const config = makeConfig();
    mockCmuxNewWorkspaceOutput(JSON.stringify({ ref: "workspace:42" }));
    recordRunStateMock.mockImplementation(() => {
      throw new Error("disk full");
    });

    await setupWorkspace(config, {
      task: "team-1",
      repository: "repo-a",
      model: "claude",
      details: { title: "Test Title", description: "Body" },
    });

    expect(logMock).toHaveBeenCalledWith(expect.stringContaining("Run state update failed"));
  });

  it("ignores worktree remove failures reported by teardown during rollback", async () => {
    const config = makeConfig();
    mockCmuxFailure();
    teardownMock.mockResolvedValue(
      emptyTeardownResult({
        failures: [{ entry: hostEntry(), step: "worktree_remove", error: new Error("busy") }],
      }),
    );

    await expect(
      setupWorkspace(config, {
        task: "team-1",
        repository: "repo-a",
        model: "claude",
        details: { title: "Test Title", description: "Body" },
      }),
    ).rejects.toThrow(/cmux down/);
  });

  it("keeps the original setup error and cleans promptDir when teardown rejects", async () => {
    const config = makeConfig();
    mockCmuxFailure();
    teardownMock.mockRejectedValue(new Error("teardown failed"));

    await expect(
      setupWorkspace(config, {
        task: "team-1",
        repository: "repo-a",
        model: "claude",
        details: { title: "Test Title", description: "Body" },
      }),
    ).rejects.toThrow(/cmux down/);

    expect(rmMock).toHaveBeenCalledWith("/tmp/groundcrew-team-1-x", expect.anything());
    expect(logMock).toHaveBeenCalledWith(
      expect.stringContaining("Worktree teardown failed during rollback: teardown failed"),
    );
  });

  it("warns about an orphaned workspace when teardown reports the adapter unavailable", async () => {
    const config = makeConfig();
    mockCmuxFailure();
    teardownMock.mockResolvedValue(
      emptyTeardownResult({
        workspaceProbe: { kind: "unavailable", error: new Error("cmux exploded") },
      }),
    );

    await expect(
      setupWorkspace(config, {
        task: "team-1",
        repository: "repo-a",
        model: "claude",
        details: { title: "Test Title", description: "Body" },
      }),
    ).rejects.toThrow(/cmux down/);

    expect(logMock).toHaveBeenCalledWith(
      expect.stringContaining("Workspace adapter unavailable during rollback: cmux exploded"),
    );
  });

  it("still warns when teardown reports the adapter unavailable without an error", async () => {
    const config = makeConfig();
    mockCmuxFailure();
    teardownMock.mockResolvedValue(
      emptyTeardownResult({ workspaceProbe: { kind: "unavailable" } }),
    );

    await expect(
      setupWorkspace(config, {
        task: "team-1",
        repository: "repo-a",
        model: "claude",
        details: { title: "Test Title", description: "Body" },
      }),
    ).rejects.toThrow(/cmux down/);

    expect(logMock).toHaveBeenCalledWith(
      expect.stringContaining("Workspace adapter unavailable during rollback;"),
    );
  });

  it("renders an empty description when details has empty description", async () => {
    mockCmuxNewWorkspaceOutput(JSON.stringify({ ref: "workspace:1" }));

    await setupWorkspace(makeConfig(), {
      task: "team-1",
      repository: "repo-a",
      model: "claude",
      details: { title: "T", description: "" },
    });

    const [writeCall] = writeFileMock.mock.calls;
    expect(writeCall?.[1]).toContain("(T)");
    expect(writeCall?.[1]).not.toContain("undefined");
  });

  it("rolls back worktree without rmSync when mkdtemp fails before promptDir is set", async () => {
    mkdtempMock.mockImplementation(() => {
      throw new Error("mkdtemp failed");
    });

    await expect(
      setupWorkspace(makeConfig(), {
        task: "team-1",
        repository: "repo-a",
        model: "claude",
        details: { title: "Test Title", description: "Body" },
      }),
    ).rejects.toThrow("mkdtemp failed");

    expect(teardownMock).toHaveBeenCalledWith(makeConfig(), expect.any(Array), { force: true });
    expect(rmMock).not.toHaveBeenCalled();
  });

  it("escapes single quotes in the launch script path and prompt path", async () => {
    mkdtempMock.mockReturnValue("/tmp/with'quote-1");
    mockCmuxNewWorkspaceOutput(JSON.stringify({ ref: "workspace:1" }));

    await setupWorkspace(makeConfig(), {
      task: "team-1",
      repository: "repo-a",
      model: "claude",
      details: { title: "Test Title", description: "Body" },
    });

    const cmd = lastRunArgumentFromCallWithArgument("new-workspace");
    const launchScript = writtenFileContent("/tmp/with'quote-1/launch.sh");
    expect(cmd).toContain(String.raw`'\''`);
    expect(launchScript).toContain(String.raw`_p=$(cat '/tmp/with'\''quote-1/prompt.txt')`);
  });

  it("requires details from the caller (no Linear re-fetch)", () => {
    // Type-level test: SetupWorkspaceOptions.details is non-optional.
    type _DetailsRequired = SetupWorkspaceOptions["details"] extends TaskDetails ? true : never;
    const _check: _DetailsRequired = true;
    expect(_check).toBe(true);
  });
});

const createBoardMock = vi.mocked(createBoard);
const buildSourcesMock = vi.mocked(buildSources);

interface FakeBoard extends ReturnType<typeof createBoard> {
  resolveOne: ReturnType<typeof vi.fn<(id: string) => Promise<Issue | undefined>>>;
  markInProgress: ReturnType<typeof vi.fn<(issue: Issue) => Promise<void>>>;
  markInReview: ReturnType<typeof vi.fn<Board["markInReview"]>>;
}

function fakeBoard(resolvedIssue: Issue | undefined): FakeBoard {
  return {
    verify: vi.fn<() => Promise<void>>().mockResolvedValue(),
    fetch: vi.fn<() => Promise<BoardState>>(),
    resolveOne: vi
      .fn<(id: string) => Promise<Issue | undefined>>()
      .mockResolvedValue(resolvedIssue),
    markInProgress: vi.fn<(issue: Issue) => Promise<void>>().mockResolvedValue(),
    markInReview: vi.fn<Board["markInReview"]>().mockResolvedValue({ outcome: "applied" }),
    markDone: vi.fn<Board["markDone"]>().mockResolvedValue({ outcome: "applied" }),
  };
}

describe(setupWorkspaceCli, () => {
  let defaultBoard: FakeBoard;

  beforeEach(() => {
    existsMock.mockReturnValue(true);
    detectHostMock.mockResolvedValue(host());
    createMock.mockImplementation(async () => hostEntry());
    mkdtempMock.mockReturnValue("/tmp/groundcrew-team-1-x");
    runCommandMock.mockReturnValue(JSON.stringify({ ref: "workspace:1" }));
    loadConfigMock.mockResolvedValue(makeConfig());
    defaultBoard = fakeBoard(
      canonicalLinearIssue({
        naturalId: "team-1",
        repository: "repo-a",
        model: "claude",
        title: "Title",
        description: "Body for repo-a",
      }),
    );
    createBoardMock.mockReturnValue(defaultBoard);
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it("resolves the task via Board and provisions the workspace", async () => {
    await setupWorkspaceCli("team-1");

    expect(createBoardMock).toHaveBeenCalledTimes(1);
    expect(defaultBoard.resolveOne).toHaveBeenCalledWith("team-1");
    expect(createMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ repository: "repo-a", task: "team-1" }),
    );
    expect(runCommandMock).toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining(["set-status", "model", "claude"]),
    );
  });

  it("forwards the resolved task url into RunState when the source supplied one", async () => {
    const boardWithUrl = fakeBoard(
      canonicalLinearIssue({
        naturalId: "team-1",
        repository: "repo-a",
        model: "claude",
        title: "Title",
        description: "Body for repo-a",
        url: "https://linear.app/example/issue/TEAM-1",
      }),
    );
    createBoardMock.mockReturnValue(boardWithUrl);

    await setupWorkspaceCli("team-1");

    expect(lastRecordedRunState().url).toBe("https://linear.app/example/issue/TEAM-1");
  });

  it("marks the task In Progress via board.markInProgress after launching the workspace", async () => {
    await setupWorkspaceCli("team-1");

    expect(defaultBoard.markInProgress).toHaveBeenCalledTimes(1);
    expect(firstInvocationOrder(runCommandMock)).toBeLessThan(
      firstInvocationOrder(defaultBoard.markInProgress),
    );
  });

  it("does not provision or mark In Progress in dry-run mode", async () => {
    await setupWorkspaceCli("team-1", { dryRun: true });

    expect(createMock).not.toHaveBeenCalled();
    expect(runCommandMock).not.toHaveBeenCalled();
    expect(defaultBoard.markInProgress).not.toHaveBeenCalled();
    const logged = logMock.mock.calls.map(([message]) => message).join("\n");
    expect(logged).toContain("[dry-run] Would launch team-1 in repo-a (claude)");
  });

  it("does not mark the task In Progress when workspace setup fails", async () => {
    createMock.mockRejectedValue(new Error("worktree failed"));

    await expect(setupWorkspaceCli("team-1")).rejects.toThrow(/worktree failed/);

    expect(defaultBoard.markInProgress).not.toHaveBeenCalled();
  });

  it("throws a clear error when the task is not found", async () => {
    // oxlint-disable-next-line unicorn/no-useless-undefined -- explicit signal that resolveOne returns no match
    createBoardMock.mockReturnValueOnce(fakeBoard(undefined));

    await expect(setupWorkspaceCli("ghost-999")).rejects.toThrow(
      /Task ghost-999 not found across configured sources/,
    );
    expect(createMock).not.toHaveBeenCalled();
  });

  it("throws a clear error when the task is not groundcrew-eligible", async () => {
    createBoardMock.mockReturnValueOnce(fakeBoard(canonicalLinearIssue({ naturalId: "team-1" })));

    await expect(setupWorkspaceCli("team-1")).rejects.toThrow(/isn't groundcrew-eligible/);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("wraps buildSources errors with CLI context", async () => {
    buildSourcesMock.mockRejectedValueOnce(new Error("unknown source kind 'wat'"));

    await expect(setupWorkspaceCli("eng-1")).rejects.toThrow(
      /Could not initialize task sources for 'crew setup eng-1': unknown source kind 'wat'/,
    );
  });

  it("strips the source prefix when passing the natural id to setupWorkspace", async () => {
    createBoardMock.mockReturnValueOnce(
      fakeBoard(
        canonicalLinearIssue({
          naturalId: "staff-508",
          repository: "repo-a",
          model: "claude",
          title: "Title",
          description: "Body",
        }),
      ),
    );

    await setupWorkspaceCli("staff-508");

    expect(createMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ task: "staff-508" }),
    );
  });

  it("passes title and description from the resolved issue as details", async () => {
    createBoardMock.mockReturnValueOnce(
      fakeBoard(
        canonicalLinearIssue({
          naturalId: "team-1",
          repository: "repo-a",
          model: "claude",
          title: "Resolved Title",
          description: "Resolved Body",
        }),
      ),
    );

    await setupWorkspaceCli("team-1");

    expect(writeFileMock).toHaveBeenCalledWith(
      "/tmp/groundcrew-team-1-x/prompt.txt",
      expect.stringContaining("Resolved Title"),
    );
  });

  it("uses the full id as the task when there is no colon prefix", async () => {
    createBoardMock.mockReturnValueOnce(
      fakeBoard({
        ...canonicalLinearIssue({
          naturalId: "team-1",
          repository: "repo-a",
          model: "claude",
          title: "Title",
          description: "Body",
        }),
        id: "team-1",
      }),
    );

    await setupWorkspaceCli("team-1");

    expect(createMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ task: "team-1" }),
    );
  });
});
