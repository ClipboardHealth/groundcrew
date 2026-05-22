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
import { pickTools } from "./picker.ts";

vi.mock(import("./picker.ts"), () => ({
  pickTools: vi.fn<typeof pickTools>(),
}));

const pickToolsMock = vi.mocked(pickTools);

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

function mockClaudeLoggedInOnly(): void {
  // Claude reports authenticated, every other status probe says "not logged in".
  runCommandMock.mockImplementation(async (command, arguments_) => {
    if (command !== "sbx") {
      return "";
    }
    if (arguments_[0] === "ls") {
      return "NAME\n";
    }
    if (arguments_[0] === "exec" && arguments_[1] !== "-it") {
      const probeCommand = arguments_.at(-1) ?? "";
      if (probeCommand.startsWith("claude")) {
        return '{"loggedIn": true}';
      }
      return "not logged in";
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
    pickToolsMock.mockResolvedValue([]);
  });

  afterEach(() => {
    consoleLog.restore();
    consoleError.restore();
    vi.resetAllMocks();
  });

  it("requires a model argument", async () => {
    await expect(sandboxCli(["auth"])).rejects.toThrow(/Usage: crew sandbox auth/);
  });

  it("rejects unknown trailing positionals", async () => {
    await expect(sandboxCli(["auth", "claude", "extra"])).rejects.toThrow(
      /Usage: crew sandbox auth/,
    );
  });

  it("rejects an unknown model", async () => {
    await expect(sandboxCli(["auth", "ghost"])).rejects.toThrow(/unknown model 'ghost'/);
  });

  it("rejects a model without a sandbox config", async () => {
    await expect(sandboxCli(["auth", "unsandboxed"])).rejects.toThrow(
      /model 'unsandboxed' has no sandbox config/,
    );
  });

  it("rejects --all combined with a model name", async () => {
    await expect(sandboxCli(["auth", "--all", "claude"])).rejects.toThrow(
      /--all cannot be combined with a model name/,
    );
  });

  it("rejects an unknown flag", async () => {
    await expect(sandboxCli(["auth", "--bogus"])).rejects.toThrow(/unknown option '--bogus'/);
  });

  it("rejects --all when no model declares a sandbox", async () => {
    const bareConfig = makeSandboxConfig();
    bareConfig.models.definitions = { plain: { cmd: "agent --noop", color: "#abc" } };
    loadConfigMock.mockResolvedValue(bareConfig);

    await expect(sandboxCli(["auth", "--all"])).rejects.toThrow(
      /no sandbox-bearing models configured/,
    );
  });

  it("shows the current agent + every tool, hiding agent recipes for other sandboxes", async () => {
    mockClaudeLoggedInOnly();

    await sandboxCli(["auth", "codex"]);

    const choices = pickToolsMock.mock.calls[0]?.[0];
    // codex (current agent) + github (built-in tool). Hide claude + cursor.
    expect(choices?.map((c) => c.key).toSorted()).toStrictEqual(["codex", "github"]);
  });

  it("ships GitHub CLI as a built-in tool recipe available in every sandbox", async () => {
    mockClaudeLoggedInOnly();

    await sandboxCli(["auth", "cursor"]);

    const choices = pickToolsMock.mock.calls[0]?.[0];
    expect(choices?.map((c) => c.key)).toContain("github");
  });

  it("annotates the current agent with its actual auth status", async () => {
    mockClaudeLoggedInOnly();

    await sandboxCli(["auth", "claude"]);

    const choices = pickToolsMock.mock.calls[0]?.[0];
    const claudeChoice = choices?.find((c) => c.key === "claude");
    expect(claudeChoice?.authenticated).toBe(true);
    const githubChoice = choices?.find((c) => c.key === "github");
    expect(githubChoice?.authenticated).toBe(false);
  });

  it("exits without authenticating when the engineer selects nothing", async () => {
    pickToolsMock.mockResolvedValueOnce([]);
    mockAuthFlow({ statusOutputs: [""] });

    await sandboxCli(["auth", "claude"]);

    expect(consoleLog.output()).toContain("Nothing selected");
    const loginCall = runCommandMock.mock.calls.find((call) => isLoginExec(call));
    expect(loginCall).toBeUndefined();
  });

  it("invokes 'claude auth login' then 'claude auth status' for the selected tool", async () => {
    pickToolsMock.mockResolvedValueOnce(["claude"]);
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
    expect(consoleLog.output()).toContain("'Claude' authenticated.");
  });

  it("uses 'codex login --device-auth' for codex when selected", async () => {
    pickToolsMock.mockResolvedValueOnce(["codex"]);
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
  });

  it("uses the cursor-agent binary for cursor when selected", async () => {
    pickToolsMock.mockResolvedValueOnce(["cursor"]);
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
  });

  it("runs the login flow for each selected tool sequentially", async () => {
    pickToolsMock.mockResolvedValueOnce(["claude", "github"]);
    mockAuthFlow({
      statusOutputs: ["", "", '{"loggedIn": true}', "Logged in to github.com"],
    });

    await sandboxCli(["auth", "claude"]);

    const loginBinaries = runCommandMock.mock.calls
      .filter((call) => isLoginExec(call))
      .map((call) => call[1][3]);
    expect(loginBinaries).toStrictEqual(["claude", "gh"]);
  });

  it("warns when post-login status does not indicate logged in", async () => {
    pickToolsMock.mockResolvedValueOnce(["claude"]);
    mockAuthFlow({ statusOutputs: ["", '{"loggedIn": false}'] });

    await sandboxCli(["auth", "claude"]);

    const output = consoleLog.output();
    expect(output).toContain("could not confirm 'Claude' authentication");
    expect(output).toContain("crew sandbox auth claude");
  });

  it("treats a probe failure as not authenticated", async () => {
    pickToolsMock.mockResolvedValueOnce(["claude"]);
    mockAuthFlow({ statusOutputs: [""], statusThrows: true });

    await sandboxCli(["auth", "claude"]);

    expect(consoleLog.output()).toContain("could not confirm 'Claude' authentication");
  });

  it("treats user recipes without an explicit kind as cross-cutting tools", async () => {
    const customConfig = makeSandboxConfig();
    customConfig.sandbox = {
      authRecipes: {
        npm: {
          displayName: "npm",
          loginArgs: ["login"],
          statusArgs: ["whoami"],
          authenticatedPattern: /\w+/,
          // kind omitted on purpose — defaults to "tool"
        },
      },
    };
    loadConfigMock.mockResolvedValue(customConfig);

    await sandboxCli(["auth", "codex"]);

    const choices = pickToolsMock.mock.calls[0]?.[0];
    expect(choices?.map((c) => c.key)).toContain("npm");
  });

  it("--all opens the picker once per sandbox-bearing model in order", async () => {
    pickToolsMock.mockResolvedValue([]);
    mockSbxLs(runCommandMock, []);

    await sandboxCli(["auth", "--all"]);

    expect(pickToolsMock).toHaveBeenCalledTimes(3);
    const output = consoleLog.output();
    expect(output).toContain("claude (1/3)");
    expect(output).toContain("codex (2/3)");
    expect(output).toContain("cursor (3/3)");
  });

  it("user-config recipe overrides the built-in for the same key", async () => {
    const customConfig = makeSandboxConfig();
    customConfig.sandbox = {
      authRecipes: {
        github: {
          displayName: "GitHub (custom)",
          binary: "gh-custom",
          loginArgs: ["custom-login"],
          statusArgs: ["custom-status"],
          authenticatedPattern: /OK/,
          kind: "tool",
        },
      },
    };
    loadConfigMock.mockResolvedValue(customConfig);
    pickToolsMock.mockResolvedValueOnce(["github"]);
    mockAuthFlow({ statusOutputs: ["", "OK"] });

    await sandboxCli(["auth", "claude"]);

    const loginCall = runCommandMock.mock.calls.find((call) => isLoginExec(call));
    expect(loginCall?.[1]).toStrictEqual([
      "exec",
      "-it",
      "groundcrew-claude",
      "gh-custom",
      "custom-login",
    ]);
  });
});
