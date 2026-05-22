import { loadConfig } from "../../lib/config.ts";
import {
  captureConsoleError,
  captureConsoleLog,
  type ConsoleCapture,
} from "../../testHelpers/consoleCapture.ts";
import {
  findSbxCall,
  makeSandboxConfig,
  mockSbxLs,
  type RunCommandMock,
  sbxCallsForVerb,
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

describe("crew sandbox ensure / regenerate / rm", () => {
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

  describe("ensure", () => {
    it("creates the sandbox for one model by name", async () => {
      await sandboxCli(["ensure", "claude"]);

      const createCall = findSbxCall(runCommandMock, "create");
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
      await sandboxCli(["ensure"]);

      const createdNames = sbxCallsForVerb(runCommandMock, "create").map(
        (arguments_) => arguments_[2],
      );
      expect(createdNames).toStrictEqual([
        "groundcrew-claude",
        "groundcrew-codex",
        "groundcrew-cursor",
      ]);
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

    it("narrates the create lifecycle when the sandbox does not yet exist", async () => {
      await sandboxCli(["ensure", "claude"]);

      const output = consoleLog.output();
      expect(output).toContain("groundcrew-claude: creating");
      expect(output).toContain("groundcrew-claude: created");
    });

    it("reports 'already exists' without re-creating when the sandbox is present", async () => {
      mockSbxLs(runCommandMock, ["groundcrew-claude"]);

      await sandboxCli(["ensure", "claude"]);

      expect(consoleLog.output()).toContain("groundcrew-claude: already exists");
      expect(findSbxCall(runCommandMock, "create")).toBeUndefined();
    });

    it("reports 'No sandbox models configured.' when no model declares a sandbox", async () => {
      const bareConfig = makeSandboxConfig();
      bareConfig.models.definitions = { plain: { cmd: "agent --noop", color: "#abc" } };
      loadConfigMock.mockResolvedValue(bareConfig);

      await sandboxCli(["ensure"]);

      expect(consoleLog.output()).toContain("No sandbox models configured.");
    });
  });

  describe("regenerate", () => {
    it("removes then recreates a single model's sandbox", async () => {
      await sandboxCli(["regenerate", "claude"]);

      const sbxVerbs = runCommandMock.mock.calls
        .filter((call) => call[0] === "sbx")
        .map((call) => call[1][0]);
      expect(sbxVerbs).toContain("rm");
      expect(sbxVerbs).toContain("create");
      expect(sbxVerbs.indexOf("rm")).toBeLessThan(sbxVerbs.indexOf("create"));

      const rmCall = findSbxCall(runCommandMock, "rm");
      expect(rmCall?.[1]).toStrictEqual(["rm", "--force", "groundcrew-claude"]);
    });

    it("regenerates every sandbox model with --all", async () => {
      await sandboxCli(["regenerate", "--all"]);

      const rmTargets = sbxCallsForVerb(runCommandMock, "rm").map((arguments_) => arguments_[2]);
      expect(rmTargets).toStrictEqual([
        "groundcrew-claude",
        "groundcrew-codex",
        "groundcrew-cursor",
      ]);
    });

    it("rejects regenerate without a target", async () => {
      await expect(sandboxCli(["regenerate"])).rejects.toThrow(
        /Usage: crew sandbox regenerate <model>/,
      );
    });

    it("narrates the remove and create lifecycle per model", async () => {
      await sandboxCli(["regenerate", "claude"]);

      const output = consoleLog.output();
      expect(output).toContain("groundcrew-claude: removing existing sandbox");
      expect(output).toContain("groundcrew-claude: creating");
      expect(output).toContain("groundcrew-claude: regenerated");
    });

    it("reports 'No sandbox models configured.' on --all when none declare a sandbox", async () => {
      const bareConfig = makeSandboxConfig();
      bareConfig.models.definitions = { plain: { cmd: "agent --noop", color: "#abc" } };
      loadConfigMock.mockResolvedValue(bareConfig);

      await sandboxCli(["regenerate", "--all"]);

      expect(consoleLog.output()).toContain("No sandbox models configured.");
    });
  });

  describe("rm", () => {
    it("invokes sbx rm --force <name> for the resolved model", async () => {
      await sandboxCli(["rm", "claude"]);

      const rmCall = findSbxCall(runCommandMock, "rm");
      expect(rmCall?.[1]).toStrictEqual(["rm", "--force", "groundcrew-claude"]);
    });

    it("requires a model argument", async () => {
      await expect(sandboxCli(["rm"])).rejects.toThrow(/Usage: crew sandbox rm <model>/);
    });

    it("narrates the remove lifecycle", async () => {
      await sandboxCli(["rm", "claude"]);

      const output = consoleLog.output();
      expect(output).toContain("groundcrew-claude: removing");
      expect(output).toContain("groundcrew-claude: removed");
    });
  });
});
