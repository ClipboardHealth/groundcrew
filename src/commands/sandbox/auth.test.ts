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

interface MockAuthFlowOptions {
  /** Status outputs in call order. Last one repeats if more calls happen. */
  statusOutputs: readonly string[];
  /** When true, every status probe throws. */
  statusThrows?: boolean;
}

function mockAuthFlow(opts: MockAuthFlowOptions): void {
  let statusCallIndex = 0;
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
      const output = opts.statusOutputs[statusCallIndex] ?? opts.statusOutputs.at(-1) ?? "";
      statusCallIndex += 1;
      return output;
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
    await expect(sandboxCli(["auth"])).rejects.toThrow(/Usage: crew sandbox auth/);
  });

  it("rejects an unknown flag", async () => {
    await expect(sandboxCli(["auth", "--bogus", "claude"])).rejects.toThrow(
      /unknown option '--bogus'/,
    );
  });

  it("skips the login flow when the pre-check shows already authenticated", async () => {
    mockAuthFlow({ statusOutputs: ['{"loggedIn": true}'] });

    await sandboxCli(["auth", "claude"]);

    const loginCall = runCommandMock.mock.calls.find((call) => isLoginExec(call));
    expect(loginCall).toBeUndefined();
    expect(consoleLog.output()).toContain("'Claude' already authenticated — skipping login");
  });

  it("re-runs the login flow when --force is set even if already authenticated", async () => {
    mockAuthFlow({ statusOutputs: ['{"loggedIn": true}'] });

    await sandboxCli(["auth", "claude", "--force"]);

    const loginCall = runCommandMock.mock.calls.find((call) => isLoginExec(call));
    expect(loginCall).toBeDefined();
    expect(consoleLog.output()).toContain("re-authenticating (--force)");
  });

  it("accepts --force placed before the model name", async () => {
    mockAuthFlow({ statusOutputs: ['{"loggedIn": true}'] });

    await sandboxCli(["auth", "--force", "claude"]);

    const loginCall = runCommandMock.mock.calls.find((call) => isLoginExec(call));
    expect(loginCall).toBeDefined();
  });

  it("invokes 'claude auth login' interactively then runs 'claude auth status' to verify", async () => {
    // Pre-probe missing → login runs → post-probe authenticated.
    mockAuthFlow({ statusOutputs: ["", '{"loggedIn": true}'] });

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
      "sh",
      "-c",
      "claude auth status 2>&1",
    ]);
  });

  it("reports authenticated after a successful login flow", async () => {
    mockAuthFlow({ statusOutputs: ["", '{"loggedIn": true, "email": "x@y.com"}'] });

    await sandboxCli(["auth", "claude"]);

    expect(consoleLog.output()).toContain("groundcrew-claude: 'Claude' authenticated.");
  });

  it("warns when post-login status still does not indicate logged in", async () => {
    mockAuthFlow({ statusOutputs: ['{"loggedIn": false}'] });

    await sandboxCli(["auth", "claude"]);

    const output = consoleLog.output();
    expect(output).toContain("could not confirm 'Claude' authentication");
    expect(output).toContain("crew sandbox auth claude");
  });

  it("treats a probe failure as not authenticated", async () => {
    mockAuthFlow({ statusOutputs: [""], statusThrows: true });

    await sandboxCli(["auth", "claude"]);

    expect(consoleLog.output()).toContain("could not confirm 'Claude' authentication");
  });

  it("uses 'codex login --device-auth' and 'codex login status' for codex", async () => {
    // Pre-probe missing, post-probe authenticated.
    mockAuthFlow({ statusOutputs: ["", "Logged in using ChatGPT"] });

    await sandboxCli(["auth", "codex"]);

    const loginCall = runCommandMock.mock.calls.find((call) => isLoginExec(call));
    expect(loginCall?.[1]).toStrictEqual([
      "exec",
      "-it",
      "groundcrew-codex",
      "codex",
      "login",
      "--device-auth",
    ]);

    const statusCall = runCommandMock.mock.calls.find((call) => isStatusExec(call));
    expect(statusCall?.[1]).toStrictEqual([
      "exec",
      "groundcrew-codex",
      "sh",
      "-c",
      "codex login status 2>&1",
    ]);
    expect(consoleLog.output()).toContain("authenticated");
  });

  it("uses the cursor-agent binary (not the sbx agent name) for cursor", async () => {
    // Pre-probe missing, post-probe authenticated.
    mockAuthFlow({ statusOutputs: ["", "Logged in as user@example.com"] });

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
    expect(statusCall?.[1]).toStrictEqual([
      "exec",
      "groundcrew-cursor",
      "sh",
      "-c",
      "cursor-agent status 2>&1",
    ]);
  });

  it("authenticates a user-defined tool inside the model's sandbox", async () => {
    const customConfig = makeSandboxConfig();
    customConfig.sandbox = {
      authRecipes: {
        github: {
          displayName: "GitHub CLI",
          binary: "gh",
          loginArgs: ["auth", "login"],
          statusArgs: ["auth", "status"],
          authenticatedPattern: /Logged in to github\.com/i,
        },
      },
    };
    loadConfigMock.mockResolvedValue(customConfig);
    mockAuthFlow({ statusOutputs: ["", "Logged in to github.com as someone"] });

    await sandboxCli(["auth", "claude", "github"]);

    const loginCall = runCommandMock.mock.calls.find((call) => isLoginExec(call));
    expect(loginCall?.[1]).toStrictEqual([
      "exec",
      "-it",
      "groundcrew-claude",
      "gh",
      "auth",
      "login",
    ]);
    expect(consoleLog.output()).toContain("'GitHub CLI' authenticated");
  });

  it("user-config recipe overrides the built-in for the same key", async () => {
    const customConfig = makeSandboxConfig();
    customConfig.sandbox = {
      authRecipes: {
        claude: {
          displayName: "Claude (override)",
          binary: "claude-edge",
          loginArgs: ["custom-login"],
          statusArgs: ["custom-status"],
          authenticatedPattern: /OK/,
        },
      },
    };
    loadConfigMock.mockResolvedValue(customConfig);
    mockAuthFlow({ statusOutputs: ["", "OK"] });

    await sandboxCli(["auth", "claude"]);

    const loginCall = runCommandMock.mock.calls.find((call) => isLoginExec(call));
    expect(loginCall?.[1]).toStrictEqual([
      "exec",
      "-it",
      "groundcrew-claude",
      "claude-edge",
      "custom-login",
    ]);
  });

  it("falls back to interactive launch + manual verification for unknown agents", async () => {
    const customConfig = makeSandboxConfig();
    customConfig.models.definitions = {
      odd: { cmd: "odd --auto", color: "#000", sandbox: { agent: "odd" } },
    };
    loadConfigMock.mockResolvedValue(customConfig);

    await sandboxCli(["auth", "odd"]);

    const output = consoleLog.output();
    expect(output).toContain("No login recipe for 'odd'");
    expect(output).toContain("verify 'odd' authentication manually");

    const loginCall = runCommandMock.mock.calls.find((call) => isLoginExec(call));
    expect(loginCall?.[1]).toStrictEqual(["exec", "-it", "groundcrew-odd", "odd"]);
  });
});
