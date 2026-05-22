import type { RunCommandOptions } from "../lib/commandRunner.ts";
import { loadConfig, type ResolvedConfig } from "../lib/config.ts";
import {
  captureConsoleError,
  captureConsoleLog,
  type ConsoleCapture,
} from "../testHelpers/consoleCapture.ts";
import { sandboxCli } from "./sandbox.ts";

type RunCommandMock = (
  command: string,
  arguments_: readonly string[],
  options?: RunCommandOptions,
) => Promise<string>;

const runCommandMock = vi.hoisted(() => vi.fn<RunCommandMock>());

vi.mock(import("../lib/commandRunner.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- mock shares one recorder across runCommandAsync overloads.
    runCommandAsync: runCommandMock as unknown as typeof actual.runCommandAsync,
  };
});

vi.mock(import("../lib/config.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, loadConfig: vi.fn<typeof loadConfig>() };
});

const loadConfigMock = vi.mocked(loadConfig);

function makeConfig(): ResolvedConfig {
  return {
    linear: {
      projects: [
        {
          projectSlug: "x-aaaaaaaaaaaa",
          slugId: "aaaaaaaaaaaa",
          statuses: { todo: "Todo", inProgress: "In Progress", done: "Done", terminal: ["Done"] },
        },
      ],
    },
    git: { remote: "origin", defaultBranch: "main" },
    workspace: { projectDir: "/work", knownRepositories: ["repo-a"] },
    orchestrator: {
      maximumInProgress: 4,
      pollIntervalMilliseconds: 1000,
      sessionLimitPercentage: 85,
    },
    models: {
      default: "claude",
      definitions: {
        claude: {
          cmd: "claude --auto",
          color: "#fff",
          sandbox: { agent: "claude", template: "node-22", kits: ["npm-cache"] },
        },
        codex: {
          cmd: "codex --auto",
          color: "#0ff",
          sandbox: { agent: "codex" },
        },
        unsandboxed: {
          cmd: "agent --noop",
          color: "#abc",
        },
      },
    },
    prompts: { initial: "x" },
    workspaceKind: "auto",
    local: { runner: "auto" },
    logging: { file: "/tmp/groundcrew-sandbox-test.log" },
  };
}

type SbxCall = Parameters<RunCommandMock>;

function isSbxCall(call: SbxCall, verb: string): boolean {
  return call[0] === "sbx" && call[1][0] === verb;
}

function findSbxCall(verb: string): SbxCall | undefined {
  return runCommandMock.mock.calls.find((call) => isSbxCall(call, verb));
}

function sbxCallsForVerb(verb: string): readonly (readonly string[])[] {
  return runCommandMock.mock.calls.filter((call) => isSbxCall(call, verb)).map((call) => call[1]);
}

function mockSbxLs(rows: readonly string[]): void {
  const header = "NAME STATUS";
  const body = rows.map((row) => `${row} running`).join("\n");
  runCommandMock.mockImplementation(async (command, arguments_) => {
    if (command === "sbx" && arguments_[0] === "ls") {
      return `${header}\n${body}\n`;
    }
    return "";
  });
}

describe(sandboxCli, () => {
  let consoleLog: ConsoleCapture;
  let consoleError: ConsoleCapture;

  beforeEach(() => {
    consoleLog = captureConsoleLog();
    consoleError = captureConsoleError();
    loadConfigMock.mockResolvedValue(makeConfig());
    mockSbxLs([]);
  });

  afterEach(() => {
    consoleLog.restore();
    consoleError.restore();
    vi.resetAllMocks();
  });

  it("prints usage and throws when no sub-verb is provided", async () => {
    await expect(sandboxCli([])).rejects.toThrow(/Usage: crew sandbox/);
  });

  it("rejects an unknown sub-verb", async () => {
    await expect(sandboxCli(["bogus"])).rejects.toThrow(/Unknown sandbox sub-verb: bogus/);
  });

  describe("list", () => {
    it("prints only groundcrew-prefixed sandboxes from sbx ls", async () => {
      mockSbxLs(["groundcrew-claude", "groundcrew-codex", "other-sandbox"]);

      await sandboxCli(["list"]);

      const output = consoleLog.output();
      expect(output).toContain("groundcrew-claude");
      expect(output).toContain("groundcrew-codex");
      expect(output).not.toContain("other-sandbox");
    });

    it("prints '(none)' when no groundcrew-owned sandbox is present", async () => {
      mockSbxLs(["unrelated"]);

      await sandboxCli(["list"]);

      expect(consoleLog.output()).toContain("(none)");
    });
  });

  describe("ensure", () => {
    it("creates the sandbox for one model by name", async () => {
      mockSbxLs([]);

      await sandboxCli(["ensure", "claude"]);

      const createCall = findSbxCall("create");
      expect(createCall?.[1]).toStrictEqual([
        "create",
        "--name",
        "groundcrew-claude",
        "--template",
        "node-22",
        "--kit",
        "npm-cache",
        "claude",
        "/work",
      ]);
    });

    it("ensures every model with a sandbox config when invoked with no model", async () => {
      mockSbxLs([]);

      await sandboxCli(["ensure"]);

      const createdNames = sbxCallsForVerb("create").map((arguments_) => arguments_[2]);
      expect(createdNames).toStrictEqual(["groundcrew-claude", "groundcrew-codex"]);
    });

    it("rejects an unknown model", async () => {
      await expect(sandboxCli(["ensure", "ghost"])).rejects.toThrow(/unknown model 'ghost'/);
    });

    it("rejects a model without a sandbox config", async () => {
      await expect(sandboxCli(["ensure", "unsandboxed"])).rejects.toThrow(
        /model 'unsandboxed' has no sandbox config/,
      );
    });

    it("rejects extra positional args after the model name", async () => {
      await expect(sandboxCli(["ensure", "claude", "extra"])).rejects.toThrow(
        /Usage: crew sandbox ensure/,
      );
    });
  });

  describe("regenerate", () => {
    it("removes then recreates a single model's sandbox", async () => {
      mockSbxLs([]);

      await sandboxCli(["regenerate", "claude"]);

      const sbxVerbs = runCommandMock.mock.calls
        .filter((call) => call[0] === "sbx")
        .map((call) => call[1][0]);
      expect(sbxVerbs).toContain("rm");
      expect(sbxVerbs).toContain("create");
      expect(sbxVerbs.indexOf("rm")).toBeLessThan(sbxVerbs.indexOf("create"));

      const rmCall = findSbxCall("rm");
      expect(rmCall?.[1]).toStrictEqual(["rm", "--force", "groundcrew-claude"]);
    });

    it("regenerates every sandbox model with --all", async () => {
      mockSbxLs([]);

      await sandboxCli(["regenerate", "--all"]);

      const rmTargets = sbxCallsForVerb("rm").map((arguments_) => arguments_[2]);
      expect(rmTargets).toStrictEqual(["groundcrew-claude", "groundcrew-codex"]);
    });

    it("rejects regenerate without a target", async () => {
      await expect(sandboxCli(["regenerate"])).rejects.toThrow(
        /Usage: crew sandbox regenerate <model>/,
      );
    });
  });

  describe("auth", () => {
    it("ensures the sandbox then execs the agent binary interactively", async () => {
      mockSbxLs([]);

      await sandboxCli(["auth", "claude"]);

      const execCall = findSbxCall("exec");
      expect(execCall?.[1]).toStrictEqual(["exec", "-it", "groundcrew-claude", "claude"]);
      expect(execCall?.[2]).toMatchObject({ stdio: "inherit" });
    });

    it("requires a model argument", async () => {
      await expect(sandboxCli(["auth"])).rejects.toThrow(/Usage: crew sandbox auth <model>/);
    });
  });

  describe("rm", () => {
    it("invokes sbx rm --force <name> for the resolved model", async () => {
      await sandboxCli(["rm", "claude"]);

      const rmCall = findSbxCall("rm");
      expect(rmCall?.[1]).toStrictEqual(["rm", "--force", "groundcrew-claude"]);
    });

    it("requires a model argument", async () => {
      await expect(sandboxCli(["rm"])).rejects.toThrow(/Usage: crew sandbox rm <model>/);
    });
  });

  describe("template show", () => {
    it("prints agent, template, kits, and resolved sandbox name per sandbox model", async () => {
      await sandboxCli(["template", "show"]);

      const output = consoleLog.output();
      expect(output).toContain("claude");
      expect(output).toContain("groundcrew-claude");
      expect(output).toContain("node-22");
      expect(output).toContain("npm-cache");
      expect(output).toContain("codex");
      expect(output).toContain("groundcrew-codex");
      expect(output).not.toContain("unsandboxed");
    });

    it("rejects template without a sub-verb", async () => {
      await expect(sandboxCli(["template"])).rejects.toThrow(/Usage: crew sandbox template show/);
    });

    it("reports '(no sandbox models configured)' when no model declares a sandbox", async () => {
      const bareConfig = makeConfig();
      bareConfig.models.definitions = {
        plain: { cmd: "agent --noop", color: "#abc" },
      };
      loadConfigMock.mockResolvedValue(bareConfig);

      await sandboxCli(["template", "show"]);

      expect(consoleLog.output()).toContain("(no sandbox models configured)");
    });
  });
});
