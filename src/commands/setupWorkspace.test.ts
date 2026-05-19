import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";

import { ensureClearance } from "@clipboard-health/clearance";

import type { RunCommandOptions } from "../lib/commandRunner.ts";
import { loadConfig, type ResolvedConfig } from "../lib/config.ts";
import { detectHostCapabilities, type HostCapabilities } from "../lib/host.ts";
import type * as utilModule from "../lib/util.ts";
import { getLinearClient, log } from "../lib/util.ts";
import { WorktreeAlreadyExistsError, type WorktreeEntry, worktrees } from "../lib/worktrees.ts";
import { deleteEnvironmentVariable, setEnvironmentVariable } from "../testHelpers/env.ts";
import { emptyTeardownResult } from "../testHelpers/teardownResult.ts";
import { setupWorkspace, setupWorkspaceCli } from "./setupWorkspace.ts";

interface NodeFsMock {
  existsSync: ReturnType<typeof vi.fn<typeof existsSync>>;
  mkdtempSync: ReturnType<typeof vi.fn<typeof mkdtempSync>>;
  rmSync: ReturnType<typeof vi.fn<typeof rmSync>>;
  writeFileSync: ReturnType<typeof vi.fn<typeof writeFileSync>>;
}

vi.mock(
  "node:fs",
  (): NodeFsMock => ({
    existsSync: vi.fn<typeof existsSync>().mockReturnValue(true),
    mkdtempSync: vi.fn<typeof mkdtempSync>(),
    rmSync: vi.fn<typeof rmSync>(),
    writeFileSync: vi.fn<typeof writeFileSync>(),
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
vi.mock(import("../lib/util.ts"), async (importOriginal) => {
  const actual = await importOriginal<typeof utilModule>();
  return {
    ...actual,
    getLinearClient: vi.fn<typeof getLinearClient>(),
    log: vi.fn<typeof actual.log>(),
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

const mkdtempMock = vi.mocked(mkdtempSync);
const existsMock = vi.mocked(existsSync);
const writeFileMock = vi.mocked(writeFileSync);
const rmMock = vi.mocked(rmSync);
const loadConfigMock = vi.mocked(loadConfig);
const detectHostMock = vi.mocked(detectHostCapabilities);
const ensureClearanceMock = vi.mocked(ensureClearance);
const linearClientMock = vi.mocked(getLinearClient);
const logMock = vi.mocked(log);
const createMock = vi.mocked(worktrees.create);
const teardownMock = vi.mocked(worktrees.teardown);

interface MockedLabel {
  name: string;
}
interface MockedIssue {
  title: string;
  description?: string | undefined;
}
const issueResolver = vi.fn<(id: string) => Promise<MockedIssue>>();
const rawRequestMock =
  vi.fn<(query: string, variables?: Record<string, unknown>) => Promise<unknown>>();
const teamStatesMock = vi.fn<() => Promise<{ nodes: { id: string; name: string }[] }>>();
const teamMock =
  vi.fn<
    (id: string) => Promise<{ states: () => Promise<{ nodes: { id: string; name: string }[] }> }>
  >();
const updateIssueMock =
  vi.fn<(id: string, input: { stateId: string }) => Promise<Record<string, never>>>();

function buildMockedIssue(overrides: {
  title?: string;
  description?: string | undefined;
}): MockedIssue {
  return {
    title: overrides.title ?? "Title",
    description: "description" in overrides ? overrides.description : "Body",
  };
}

function buildResolveIssueResponse(overrides: {
  uuid?: string;
  teamId?: string;
  title?: string;
  description?: string | null | undefined;
  labels?: MockedLabel[];
}): unknown {
  return {
    data: {
      issue: {
        id: overrides.uuid ?? "uuid-1",
        title: overrides.title ?? "Title",
        description: "description" in overrides ? overrides.description : "Body for repo-a",
        labels: { nodes: overrides.labels ?? [] },
        team: { id: overrides.teamId ?? "team-1" },
      },
    },
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

function hostEntry(): WorktreeEntry {
  return {
    repository: "repo-a",
    ticket: "team-1",
    branchName: "rocky-team-1",
    dir: "/work/repo-a-team-1",
    kind: "host",
  };
}

function makeConfig(overrides: Partial<ResolvedConfig["models"]> = {}): ResolvedConfig {
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
        claude: { cmd: "claude --auto", color: "#fff" },
        codex: { cmd: "codex", color: "#000" },
      },
      ...overrides,
    },
    prompts: {
      initial: "Begin {{ticket}} ({{title}}) in {{worktree}}\n{{description}}",
    },
    workspaceKind: "auto",
    local: { runner: "auto" },
    logging: { file: "/tmp/groundcrew-test.log" },
  };
}

function mockLinearClient(): void {
  teamStatesMock.mockResolvedValue({ nodes: [{ id: "state-in-progress", name: "In Progress" }] });
  teamMock.mockResolvedValue({ states: teamStatesMock });
  updateIssueMock.mockResolvedValue({});
  const linearClient = {
    issue: issueResolver,
    team: teamMock,
    updateIssue: updateIssueMock,
    client: { rawRequest: rawRequestMock },
  };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- tests stub only the surfaces touched by setupWorkspace + fetchResolvedIssue
  const typedLinearClient = linearClient as unknown as ReturnType<typeof getLinearClient>;
  linearClientMock.mockReturnValue(typedLinearClient);
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

interface SdxRunMockOptions {
  existingSandboxes?: readonly string[];
  sbxCreateThrows?: Error;
}

function mockSdxRun(options: SdxRunMockOptions = {}): void {
  const lsOutput = [
    "NAME STATUS",
    ...(options.existingSandboxes ?? []).map((n) => `${n} running`),
    "",
  ].join("\n");
  runCommandMock.mockImplementation((cmd, arguments_) => {
    if (isCmuxNewWorkspace(cmd, arguments_)) {
      return JSON.stringify({ ref: "workspace:42" });
    }
    if (cmd === "sbx" && arguments_[0] === "ls") {
      return lsOutput;
    }
    if (cmd === "sbx" && arguments_[0] === "create" && options.sbxCreateThrows !== undefined) {
      throw options.sbxCreateThrows;
    }
    return "";
  });
}

function findSbxCreateCall(): readonly string[] | undefined {
  const call = runCommandMock.mock.calls.find(
    ([cmd, arguments_]) => cmd === "sbx" && arguments_[0] === "create",
  );
  return call?.[1];
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

describe(setupWorkspace, () => {
  beforeEach(() => {
    existsMock.mockReturnValue(true);
    mockLinearClient();
    issueResolver.mockResolvedValue(buildMockedIssue({ title: "Test Title", description: "Body" }));
    detectHostMock.mockResolvedValue(host());
    createMock.mockImplementation(async () => hostEntry());
    ensureClearanceMock.mockResolvedValue({
      logPath: "/tmp/clearance/clearance.log",
      pidPath: "/tmp/clearance/clearance.pid",
      port: 19_999,
      status: "already-running",
    });
    mkdtempMock.mockReturnValue("/tmp/groundcrew-team-1-x");
    runCommandMock.mockReturnValue("");
    teardownMock.mockResolvedValue(emptyTeardownResult());
    // Tests assume a local (non-SSH) cmux. CMUX_WORKSPACE_ID is set in any
    // shell launched inside cmux (including the one running the test
    // suite); leaving it would make every open() probe current-workspace
    // first and shift the mock call order.
    deleteEnvironmentVariable("CMUX_WORKSPACE_ID");
  });

  afterEach(() => {
    // resetAllMocks (not clearAllMocks) so module-scoped mock implementations
    // set inside one test don't leak into the next.
    vi.resetAllMocks();
  });

  it("provisions the worktree, writes the prompt, and launches cmux", async () => {
    const config = makeConfig();
    mockCmuxNewWorkspaceOutput(JSON.stringify({ ref: "workspace:42" }));

    await setupWorkspace(config, { ticket: "team-1", repository: "repo-a", model: "claude" });

    expect(createMock).toHaveBeenCalledWith(
      config,
      expect.objectContaining({ repository: "repo-a", ticket: "team-1" }),
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
  });

  it("keeps the local cmux command short by staging the full launcher in a local script", async () => {
    const config = makeConfig();
    mockCmuxNewWorkspaceOutput(JSON.stringify({ ref: "workspace:42" }));

    await setupWorkspace(config, {
      ticket: "team-1",
      repository: "repo-a",
      model: "claude",
    });

    const command = lastRunArgumentFromCallWithArgument("new-workspace");
    const launchScript = writtenFileContent("/tmp/groundcrew-team-1-x/launch.sh");

    expect(command).toBe("bash '/tmp/groundcrew-team-1-x/launch.sh'");
    expect(command).not.toContain("safehouse-clearance");
    expect(command).not.toContain("prompt.txt");
    expect(launchScript).toContain("safehouse-clearance");
    expect(launchScript).toContain("_p=$(cat '/tmp/groundcrew-team-1-x/prompt.txt')");
  });

  it("passes an AbortSignal into worktree creation and workspace launch", async () => {
    const config = makeConfig();
    const { signal } = new AbortController();
    mockCmuxNewWorkspaceOutput(JSON.stringify({ ref: "workspace:42" }));

    await setupWorkspace(
      config,
      { ticket: "team-1", repository: "repo-a", model: "claude" },
      { signal },
    );

    expect(createMock).toHaveBeenCalledWith(
      config,
      expect.objectContaining({ repository: "repo-a", ticket: "team-1" }),
      signal,
    );
    expect(runCommandMock).toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining(["new-workspace", "--name", "team-1"]),
      { signal },
    );
  });

  it("uses provided ticket details without fetching from Linear", async () => {
    const config = makeConfig();
    mockCmuxNewWorkspaceOutput(JSON.stringify({ ref: "workspace:42" }));

    await setupWorkspace(config, {
      ticket: "team-1",
      repository: "repo-a",
      model: "claude",
      details: { title: "Provided Title", description: "Provided Body" },
    });

    expect(issueResolver).not.toHaveBeenCalled();
    expect(writeFileMock).toHaveBeenCalledWith(
      "/tmp/groundcrew-team-1-x/prompt.txt",
      expect.stringContaining("Provided Title"),
    );
  });

  it("wraps the agent command with Safehouse and runs the host setup script for local runs", async () => {
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

    await setupWorkspace(config, { ticket: "team-1", repository: "repo-a", model: "claude" });

    expect(ensureClearanceMock).toHaveBeenCalledTimes(1);
    expect(firstInvocationOrder(ensureClearanceMock)).toBeLessThan(
      firstInvocationOrder(createMock),
    );
    const command = lastRunArgumentFromCallWithArgument("new-workspace");
    const launchScript = writtenFileContent("/tmp/groundcrew-team-1-x/launch.sh");
    expect(command).toBe("bash '/tmp/groundcrew-team-1-x/launch.sh'");
    expect(launchScript).toContain("cd '/work/repo-a-team-1'");
    expect(launchScript).toContain("./.claude/setup.sh --deps-only");
    expect(launchScript).toContain("exec '/");
    expect(launchScript).toContain(
      "/node_modules/@clipboard-health/clearance/safehouse/safehouse-clearance' claude",
    );
    expect(launchScript).toContain('claude --permission-mode auto "$_p"');
    // setup-status guard so a failed install still launches the agent
    expect(launchScript).toContain('"$setup_status" -ne 0');
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

    await setupWorkspace(config, { ticket: "team-1", repository: "repo-a", model: "claude" });

    expect(ensureClearanceMock).not.toHaveBeenCalled();
    const launchScript = writtenFileContent("/tmp/groundcrew-team-1-x/launch.sh");
    expect(launchScript).toMatch(
      /exec sbx exec -it (?:-e [A-Z_]+ )*-w '\/work\/repo-a-team-1' 'groundcrew-claude' sh -lc/,
    );
    expect(launchScript).toContain("exec claude --permission-mode auto");
    expect(launchScript).not.toContain("safehouse-clearance");
  });

  it("auto-creates the sandbox via `sbx create` when it does not exist", async () => {
    detectHostMock.mockResolvedValue(sdxHost());
    const config = makeConfig({
      definitions: {
        claude: { cmd: "claude --auto", color: "#fff", sandbox: { agent: "claude" } },
        codex: { cmd: "codex", color: "#000" },
      },
    });
    mockSdxRun();

    await setupWorkspace(config, { ticket: "team-1", repository: "repo-a", model: "claude" });

    expect(runCommandMock).toHaveBeenCalledWith(
      "sbx",
      ["create", "--name", "groundcrew-claude", "claude", "/work"],
      expect.any(Object),
    );
  });

  it("skips `sbx create` when the sandbox already exists", async () => {
    detectHostMock.mockResolvedValue(sdxHost());
    const config = makeConfig({
      definitions: {
        claude: { cmd: "claude --auto", color: "#fff", sandbox: { agent: "claude" } },
        codex: { cmd: "codex", color: "#000" },
      },
    });
    mockSdxRun({ existingSandboxes: ["groundcrew-claude"] });

    await setupWorkspace(config, { ticket: "team-1", repository: "repo-a", model: "claude" });

    expect(findSbxCreateCall()).toBeUndefined();
  });

  it("forwards sandbox template and kits to `sbx create`", async () => {
    detectHostMock.mockResolvedValue(sdxHost());
    const config = makeConfig({
      definitions: {
        claude: {
          cmd: "claude --auto",
          color: "#fff",
          sandbox: { agent: "claude", template: "node-22", kits: ["npm-cache", "tools"] },
        },
        codex: { cmd: "codex", color: "#000" },
      },
    });
    mockSdxRun();

    await setupWorkspace(config, { ticket: "team-1", repository: "repo-a", model: "claude" });

    expect(runCommandMock).toHaveBeenCalledWith(
      "sbx",
      [
        "create",
        "--name",
        "groundcrew-claude",
        "--template",
        "node-22",
        "--kit",
        "npm-cache",
        "--kit",
        "tools",
        "claude",
        "/work",
      ],
      expect.any(Object),
    );
  });

  it("rolls back the worktree when sandbox creation fails", async () => {
    detectHostMock.mockResolvedValue(sdxHost());
    const config = makeConfig({
      definitions: {
        claude: { cmd: "claude --auto", color: "#fff", sandbox: { agent: "claude" } },
        codex: { cmd: "codex", color: "#000" },
      },
    });
    mockSdxRun({ sbxCreateThrows: new Error("sbx create failed") });

    await expect(
      setupWorkspace(config, { ticket: "team-1", repository: "repo-a", model: "claude" }),
    ).rejects.toThrow("sbx create failed");
    expect(teardownMock).toHaveBeenCalledWith(config, expect.any(Array), { force: true });
  });

  it("does not create a worktree when the safehouse clearance cannot start", async () => {
    detectHostMock.mockResolvedValue(host());
    ensureClearanceMock.mockRejectedValue(new Error("proxy unavailable"));
    const config = makeConfig();

    await expect(
      setupWorkspace(config, { ticket: "team-1", repository: "repo-a", model: "claude" }),
    ).rejects.toThrow("proxy unavailable");

    expect(createMock).not.toHaveBeenCalled();
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

    await setupWorkspace(config, { ticket: "team-1", repository: "repo-a", model: "claude" });

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

      await setupWorkspace(makeConfig(), {
        ticket: "team-1",
        repository: "repo-a",
        model: "claude",
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

      await setupWorkspace(makeConfig(), {
        ticket: "team-1",
        repository: "repo-a",
        model: "claude",
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

      await setupWorkspace(makeConfig(), {
        ticket: "team-1",
        repository: "repo-a",
        model: "claude",
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
        ticket: "team-1",
        repository: "repo-a",
        model: "claude",
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
  });

  it("logs the tmux access hint after launch so the user knows how to reach the workspace", async () => {
    mockTmuxHost();
    const config = makeConfig();

    await setupWorkspace(config, { ticket: "team-1", repository: "repo-a", model: "claude" });

    expect(logMock).toHaveBeenCalledWith("  Attach:   tmux attach -t groundcrew:team-1");
  });

  it("omits the access hint when the backend has no external hint (cmux)", async () => {
    const config = makeConfig();
    mockCmuxNewWorkspaceOutput(JSON.stringify({ ref: "workspace:42" }));

    await setupWorkspace(config, { ticket: "team-1", repository: "repo-a", model: "claude" });

    expect(logMock).not.toHaveBeenCalledWith(expect.stringMatching(/^ {2}Attach:/));
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
      setupWorkspace(config, { ticket: "team-1", repository: "repo-a", model: "claude" }),
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
      setupWorkspace(config, { ticket: "team-1", repository: "repo-a", model: "claude" }),
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
      setupWorkspace(config, { ticket: "team-1", repository: "repo-a", model: "claude" }),
    ).rejects.toThrow(/sdx runner require a sandbox config on model 'claude'/);

    expect(createMock).not.toHaveBeenCalled();
    expect(ensureClearanceMock).not.toHaveBeenCalled();
  });

  it("fails before creating a worktree when safehouse is missing on macOS", async () => {
    detectHostMock.mockResolvedValue(host({ hasSafehouse: false }));
    const config = makeConfig();

    await expect(
      setupWorkspace(config, { ticket: "team-1", repository: "repo-a", model: "claude" }),
    ).rejects.toThrow(/require `safehouse` on PATH/);

    expect(createMock).not.toHaveBeenCalled();
    expect(ensureClearanceMock).not.toHaveBeenCalled();
  });

  it("propagates worktree-creation errors without launching cmux", async () => {
    createMock.mockRejectedValue(new Error("git fetch failed"));

    await expect(
      setupWorkspace(makeConfig(), {
        ticket: "team-1",
        repository: "repo-a",
        model: "claude",
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
        ticket: "team-1",
        repository: "repo-a",
        model: "claude",
      }),
    ).rejects.toThrow(/Worktree already exists/);

    expect(logMock).toHaveBeenCalledWith("  Attach:   tmux attach -t groundcrew:team-1");
  });

  it("does not log an access hint when the worktree exists but no live workspace remains", async () => {
    mockTmuxHost();
    mockExistingWorktree();
    mockTmuxWindows([]);

    await expect(
      setupWorkspace(makeConfig(), {
        ticket: "team-1",
        repository: "repo-a",
        model: "claude",
      }),
    ).rejects.toThrow(/Worktree already exists/);

    expect(logMock).not.toHaveBeenCalledWith(expect.stringMatching(/^ {2}Attach:/));
  });

  it("does not probe for an existing workspace when the backend has no external hint", async () => {
    mockExistingWorktree();

    await expect(
      setupWorkspace(makeConfig(), {
        ticket: "team-1",
        repository: "repo-a",
        model: "claude",
      }),
    ).rejects.toThrow(/Worktree already exists/);

    expect(runCommandMock).not.toHaveBeenCalled();
    expect(logMock).not.toHaveBeenCalledWith(expect.stringMatching(/^ {2}Attach:/));
  });

  it("rejects unknown models", async () => {
    await expect(
      setupWorkspace(makeConfig(), { ticket: "team-1", repository: "repo-a", model: "ghost" }),
    ).rejects.toThrow(/Unknown model: ghost/);
  });

  it("rolls back the worktree, branch, and cmux workspace when cmux launch fails", async () => {
    const config = makeConfig();
    mockCmuxNewWorkspaceOutput("garbage that has no ref");

    await expect(
      setupWorkspace(config, { ticket: "team-1", repository: "repo-a", model: "claude" }),
    ).rejects.toThrow(/Unexpected cmux output/);

    expect(teardownMock).toHaveBeenCalledWith(
      config,
      [
        expect.objectContaining({
          repository: "repo-a",
          ticket: "team-1",
          kind: "host",
          dir: "/work/repo-a-team-1",
          branchName: "rocky-team-1",
        }),
      ],
      { force: true },
    );
    expect(rmMock).toHaveBeenCalledWith("/tmp/groundcrew-team-1-x", expect.anything());
  });

  it("falls back to extracting workspace:N from non-JSON cmux output", async () => {
    const config = makeConfig();
    mockCmuxNewWorkspaceOutput("Created workspace:99 successfully");

    await setupWorkspace(config, { ticket: "team-1", repository: "repo-a", model: "claude" });

    expect(runCommandMock).toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining(["set-status", "model", "claude", "--workspace", "workspace:99"]),
    );
  });

  it("falls back to the regex match when JSON is parseable but lacks ref/id", async () => {
    mockCmuxNewWorkspaceOutput(JSON.stringify({ name: "no-ref", info: "see workspace:55" }));

    await setupWorkspace(makeConfig(), {
      ticket: "team-1",
      repository: "repo-a",
      model: "claude",
    });

    expect(runCommandMock).toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining(["--workspace", "workspace:55"]),
    );
  });

  it("rolls back without touching the prompt dir when Linear fails before mkdtemp", async () => {
    issueResolver.mockRejectedValue(new Error("linear unreachable"));

    await expect(
      setupWorkspace(makeConfig(), {
        ticket: "team-1",
        repository: "repo-a",
        model: "claude",
      }),
    ).rejects.toThrow(/linear unreachable/);

    expect(rmMock).not.toHaveBeenCalled();
    expect(teardownMock).toHaveBeenCalledWith(
      expect.anything(),
      [expect.objectContaining({ ticket: "team-1" })],
      { force: true },
    );
  });

  it("uses the JSON id field when ref is missing", async () => {
    mockCmuxNewWorkspaceOutput(JSON.stringify({ id: "workspace:7" }));

    await setupWorkspace(makeConfig(), {
      ticket: "team-1",
      repository: "repo-a",
      model: "claude",
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
      setupWorkspace(config, { ticket: "team-1", repository: "repo-a", model: "claude" }),
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
      setupWorkspace(config, { ticket: "team-1", repository: "repo-a", model: "claude" }),
    ).rejects.toThrow(/cmux down/);
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
      setupWorkspace(config, { ticket: "team-1", repository: "repo-a", model: "claude" }),
    ).rejects.toThrow(/cmux down/);
  });

  it("keeps the original setup error and cleans promptDir when teardown rejects", async () => {
    const config = makeConfig();
    mockCmuxFailure();
    teardownMock.mockRejectedValue(new Error("teardown failed"));

    await expect(
      setupWorkspace(config, { ticket: "team-1", repository: "repo-a", model: "claude" }),
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
      setupWorkspace(config, { ticket: "team-1", repository: "repo-a", model: "claude" }),
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
      setupWorkspace(config, { ticket: "team-1", repository: "repo-a", model: "claude" }),
    ).rejects.toThrow(/cmux down/);

    expect(logMock).toHaveBeenCalledWith(
      expect.stringContaining("Workspace adapter unavailable during rollback;"),
    );
  });

  it("renders an empty description when Linear returns no description", async () => {
    issueResolver.mockResolvedValue(buildMockedIssue({ title: "T", description: undefined }));
    mockCmuxNewWorkspaceOutput(JSON.stringify({ ref: "workspace:1" }));

    await setupWorkspace(makeConfig(), {
      ticket: "team-1",
      repository: "repo-a",
      model: "claude",
    });

    const [writeCall] = writeFileMock.mock.calls;
    expect(writeCall?.[1]).toContain("(T)");
    expect(writeCall?.[1]).not.toContain("undefined");
  });

  it("escapes single quotes in the launch script path and prompt path", async () => {
    mkdtempMock.mockReturnValue("/tmp/with'quote-1");
    mockCmuxNewWorkspaceOutput(JSON.stringify({ ref: "workspace:1" }));

    await setupWorkspace(makeConfig(), {
      ticket: "team-1",
      repository: "repo-a",
      model: "claude",
    });

    const cmd = lastRunArgumentFromCallWithArgument("new-workspace");
    const launchScript = writtenFileContent("/tmp/with'quote-1/launch.sh");
    expect(cmd).toContain(String.raw`'\''`);
    expect(launchScript).toContain(String.raw`_p=$(cat '/tmp/with'\''quote-1/prompt.txt')`);
  });
});

describe(setupWorkspaceCli, () => {
  beforeEach(() => {
    existsMock.mockReturnValue(true);
    mockLinearClient();
    rawRequestMock.mockResolvedValue(buildResolveIssueResponse({}));
    detectHostMock.mockResolvedValue(host());
    createMock.mockImplementation(async () => hostEntry());
    mkdtempMock.mockReturnValue("/tmp/groundcrew-team-1-x");
    runCommandMock.mockReturnValue(JSON.stringify({ ref: "workspace:1" }));
    loadConfigMock.mockResolvedValue(makeConfig());
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it("uses the repository hint and default model when the ticket has no agent label", async () => {
    await setupWorkspaceCli("team-1");

    expect(createMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ repository: "repo-a", ticket: "team-1" }),
    );
    expect(runCommandMock).toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining(["set-status", "model", "claude"]),
    );
  });

  it("marks the ticket In Progress after launching the workspace", async () => {
    rawRequestMock.mockResolvedValue(
      buildResolveIssueResponse({ uuid: "issue-uuid-1", teamId: "linear-team-1" }),
    );

    await setupWorkspaceCli("team-1");

    expect(teamMock).toHaveBeenCalledWith("linear-team-1");
    expect(updateIssueMock).toHaveBeenCalledWith("issue-uuid-1", {
      stateId: "state-in-progress",
    });
    expect(firstInvocationOrder(runCommandMock)).toBeLessThan(
      firstInvocationOrder(updateIssueMock),
    );
  });

  it("does not mark the ticket In Progress in dry-run mode", async () => {
    await setupWorkspaceCli("team-1", { dryRun: true });

    expect(createMock).not.toHaveBeenCalled();
    expect(teamMock).not.toHaveBeenCalled();
    expect(updateIssueMock).not.toHaveBeenCalled();
  });

  it("fails clearly when the configured In Progress status is missing", async () => {
    teamStatesMock.mockResolvedValue({ nodes: [{ id: "state-other", name: "Other" }] });

    await expect(setupWorkspaceCli("team-1")).rejects.toThrow(
      /Could not find "In Progress" state for team-1/,
    );
    expect(updateIssueMock).not.toHaveBeenCalled();
  });

  it("does not mark the ticket In Progress when workspace setup fails", async () => {
    createMock.mockRejectedValue(new Error("worktree failed"));

    await expect(setupWorkspaceCli("team-1")).rejects.toThrow(/worktree failed/);
    expect(teamMock).not.toHaveBeenCalled();
    expect(updateIssueMock).not.toHaveBeenCalled();
  });

  it("rejects when the ticket description has no known repository", async () => {
    rawRequestMock.mockResolvedValue(buildResolveIssueResponse({ description: "Body" }));

    await expect(setupWorkspaceCli("team-1")).rejects.toThrow(
      /No known repository found in ticket TEAM-1 description/,
    );
    expect(createMock).not.toHaveBeenCalled();
  });

  it("infers the repository from the Linear description", async () => {
    const config = makeConfig();
    config.workspace.knownRepositories = ["repo-a", "repo-b"];
    loadConfigMock.mockResolvedValue(config);
    rawRequestMock.mockResolvedValue(
      buildResolveIssueResponse({ description: "Touches repo-b for the migration." }),
    );

    await setupWorkspaceCli("team-1");

    expect(createMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ repository: "repo-b" }),
    );
  });

  it("picks the model from the ticket's agent-* label", async () => {
    rawRequestMock.mockResolvedValue(
      buildResolveIssueResponse({ labels: [{ name: "agent-codex" }, { name: "priority/low" }] }),
    );

    await setupWorkspaceCli("team-1");

    expect(runCommandMock).toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining(["set-status", "model", "codex"]),
    );
  });

  it("collapses agent-any to the configured default model", async () => {
    rawRequestMock.mockResolvedValue(
      buildResolveIssueResponse({ labels: [{ name: "agent-any" }] }),
    );

    await setupWorkspaceCli("team-1");

    expect(runCommandMock).toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining(["set-status", "model", "claude"]),
    );
  });

  it("falls back to the default model for unknown agent-* labels", async () => {
    rawRequestMock.mockResolvedValue(
      buildResolveIssueResponse({ labels: [{ name: "agent-ghost" }] }),
    );

    await setupWorkspaceCli("team-1");

    expect(runCommandMock).toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining(["set-status", "model", "claude"]),
    );
  });

  it("lowercases an uppercase ticket arg before provisioning", async () => {
    await setupWorkspaceCli("STAFF-508");

    expect(createMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ ticket: "staff-508" }),
    );
    expect(runCommandMock).toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining(["new-workspace", "--name", "staff-508"]),
    );
  });

  it("queries Linear with the upper-case ticket identifier", async () => {
    await setupWorkspaceCli("staff-508");

    expect(rawRequestMock).toHaveBeenCalledWith(
      expect.stringContaining("ResolveIssue"),
      expect.objectContaining({ id: "STAFF-508" }),
    );
  });

  it("rejects when resolving the repository from a null description", async () => {
    rawRequestMock.mockResolvedValue(buildResolveIssueResponse({ description: null }));

    await expect(setupWorkspaceCli("team-1")).rejects.toThrow(
      /No known repository found in ticket TEAM-1 description/,
    );
    expect(createMock).not.toHaveBeenCalled();
  });

  it("throws a clear error when Linear has no issue with that id", async () => {
    rawRequestMock.mockResolvedValue({ data: { issue: null } });

    await expect(setupWorkspaceCli("ghost-999")).rejects.toThrow(
      /Ticket GHOST-999 not found in Linear/,
    );
    expect(createMock).not.toHaveBeenCalled();
  });

  it("does not re-fetch from Linear once fetchResolvedIssue has the details", async () => {
    await setupWorkspaceCli("team-1");

    expect(rawRequestMock).toHaveBeenCalledTimes(1);
    expect(issueResolver).not.toHaveBeenCalled();
  });

  it("resolves and reports without provisioning when dryRun is true", async () => {
    rawRequestMock.mockResolvedValue(
      buildResolveIssueResponse({
        description: "Body for repo-a",
        labels: [{ name: "agent-codex" }],
      }),
    );

    await setupWorkspaceCli("team-1", { dryRun: true });

    expect(createMock).not.toHaveBeenCalled();
    expect(runCommandMock).not.toHaveBeenCalled();
    const logged = logMock.mock.calls.map(([message]) => message).join("\n");
    expect(logged).toContain("[dry-run] Would launch team-1 in repo-a (codex)");
  });
});
