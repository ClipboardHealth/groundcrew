import { loadConfig } from "../../lib/config.ts";
import {
  captureConsoleError,
  captureConsoleLog,
  type ConsoleCapture,
} from "../../testHelpers/consoleCapture.ts";
import {
  makeSandboxConfig,
  mockSbxLs,
  type RunCommandMock,
  type SbxCall,
} from "../../testHelpers/sandboxFixtures.ts";
import { sandboxCli } from "./index.ts";

const runCommandMock = vi.hoisted(() => vi.fn<RunCommandMock>());

vi.mock(import("../../lib/commandRunner.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- mock shares one recorder across runCommandAsync overloads.
    runCommandAsync: runCommandMock as unknown as typeof actual.runCommandAsync,
  };
});

vi.mock(import("../../lib/config.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, loadConfig: vi.fn<typeof loadConfig>() };
});

const loadConfigMock = vi.mocked(loadConfig);

function isLoginExec(call: SbxCall): boolean {
  return call[0] === "sbx" && call[1][0] === "exec" && call[1][1] === "-it";
}

function isStatusExec(call: SbxCall): boolean {
  return call[0] === "sbx" && call[1][0] === "exec" && call[1][1] !== "-it";
}

function mockAuthFlow(opts: { statusOutput: string; statusThrows?: boolean }): void {
  runCommandMock.mockImplementation(async (command, arguments_) => {
    if (command !== "sbx") {
      return "";
    }
    if (arguments_[0] === "ls") {
      return "NAME\n";
    }
    if (arguments_[0] === "exec" && arguments_[1] !== "-it") {
      if (opts.statusThrows === true) {
        throw new Error("sbx exec failed");
      }
      return opts.statusOutput;
    }
    return "";
  });
}

describe("crew sandbox auth", () => {
  let consoleLog: ConsoleCapture;
  let consoleError: ConsoleCapture;

  beforeEach(() => {
    consoleLog = captureConsoleLog();
    consoleError = captureConsoleError();
    loadConfigMock.mockResolvedValue(makeSandboxConfig());
    mockSbxLs(runCommandMock, []);
  });

  afterEach(() => {
    consoleLog.restore();
    consoleError.restore();
    vi.resetAllMocks();
  });

  it("requires a model argument", async () => {
    await expect(sandboxCli(["auth"])).rejects.toThrow(/Usage: crew sandbox auth <model>/);
  });

  it("invokes 'claude auth login' interactively then runs 'claude auth status' to verify", async () => {
    mockAuthFlow({ statusOutput: '{"loggedIn": true}' });

    await sandboxCli(["auth", "claude"]);

    const loginCall = runCommandMock.mock.calls.find((call) => isLoginExec(call));
    expect(loginCall?.[1]).toStrictEqual([
      "exec",
      "-it",
      "groundcrew-claude",
      "claude",
      "auth",
      "login",
    ]);
    expect(loginCall?.[2]).toMatchObject({ stdio: "inherit" });

    const statusCall = runCommandMock.mock.calls.find((call) => isStatusExec(call));
    expect(statusCall?.[1]).toStrictEqual([
      "exec",
      "groundcrew-claude",
      "claude",
      "auth",
      "status",
    ]);
  });

  it("reports authenticated when claude status shows loggedIn:true", async () => {
    mockAuthFlow({ statusOutput: '{"loggedIn": true, "email": "x@y.com"}' });

    await sandboxCli(["auth", "claude"]);

    expect(consoleLog.output()).toContain("groundcrew-claude: authenticated");
  });

  it("warns when claude status does not indicate logged in", async () => {
    mockAuthFlow({ statusOutput: '{"loggedIn": false}' });

    await sandboxCli(["auth", "claude"]);

    const output = consoleLog.output();
    expect(output).toContain("could not confirm authentication");
    expect(output).toContain("crew sandbox auth claude");
  });

  it("treats a probe failure as not authenticated", async () => {
    mockAuthFlow({ statusOutput: "", statusThrows: true });

    await sandboxCli(["auth", "claude"]);

    expect(consoleLog.output()).toContain("could not confirm authentication");
  });

  it("uses 'codex login' / 'codex login status' for codex", async () => {
    mockAuthFlow({ statusOutput: "Logged in using ChatGPT" });

    await sandboxCli(["auth", "codex"]);

    const loginCall = runCommandMock.mock.calls.find((call) => isLoginExec(call));
    expect(loginCall?.[1]).toStrictEqual(["exec", "-it", "groundcrew-codex", "codex", "login"]);

    const statusCall = runCommandMock.mock.calls.find((call) => isStatusExec(call));
    expect(statusCall?.[1]).toStrictEqual(["exec", "groundcrew-codex", "codex", "login", "status"]);
    expect(consoleLog.output()).toContain("authenticated");
  });

  it("uses the cursor-agent binary (not the sbx agent name) for cursor", async () => {
    mockAuthFlow({ statusOutput: "Logged in as user@example.com" });

    await sandboxCli(["auth", "cursor"]);

    const loginCall = runCommandMock.mock.calls.find((call) => isLoginExec(call));
    expect(loginCall?.[1]).toStrictEqual([
      "exec",
      "-it",
      "groundcrew-cursor",
      "cursor-agent",
      "login",
    ]);

    const statusCall = runCommandMock.mock.calls.find((call) => isStatusExec(call));
    expect(statusCall?.[1]).toStrictEqual(["exec", "groundcrew-cursor", "cursor-agent", "status"]);
  });

  it("falls back to interactive launch + manual verification for unknown agents", async () => {
    const customConfig = makeSandboxConfig();
    customConfig.models.definitions = {
      odd: { cmd: "odd --auto", color: "#000", sandbox: { agent: "odd" } },
    };
    loadConfigMock.mockResolvedValue(customConfig);

    await sandboxCli(["auth", "odd"]);

    const output = consoleLog.output();
    expect(output).toContain("Unknown agent 'odd'");
    expect(output).toContain("verify 'odd' authentication manually");

    const loginCall = runCommandMock.mock.calls.find((call) => isLoginExec(call));
    expect(loginCall?.[1]).toStrictEqual(["exec", "-it", "groundcrew-odd", "odd"]);
  });
});
